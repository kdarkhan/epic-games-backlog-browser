import { normTitle, PROTON_ORDER, PROTON_META, REVIEW_ORDER, reviewClass } from "./lib/util.js";

let EMBEDDED = {};
let ORDER_HISTORY = [];
let ORDER_HISTORY_FETCHED_AT = null;
let STEAM_CACHE = {};
let GAMES = [];
const REFRESHING = new Set();

const state = { q: "", genre: new Set(), review: new Set(), proton: new Set(), sort: "reviewscore" };

const el = id => document.getElementById(id);

function relTime(ms) {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function epicSearchUrl(title) {
  // Order history gives us a title only, not the product slug, so this is a
  // search results link rather than a direct product page.
  return `https://store.epicgames.com/en-US/browse?q=${encodeURIComponent(title)}&sortBy=relevancy&category=Game`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadEmbedded() {
  try {
    const res = await fetch(chrome.runtime.getURL("data/embedded_games.json"));
    EMBEDDED = await res.json();
  } catch {
    EMBEDDED = {};
  }
}

async function loadStorage() {
  const data = await chrome.storage.local.get(["orderHistory", "orderHistoryFetchedAt", "steamCache"]);
  ORDER_HISTORY = data.orderHistory || [];
  ORDER_HISTORY_FETCHED_AT = data.orderHistoryFetchedAt || null;
  STEAM_CACHE = data.steamCache || {};
}

function buildGames() {
  const byKey = new Map();
  for (const item of ORDER_HISTORY) {
    const key = normTitle(item.title);
    if (!byKey.has(key) || item.purchaseDateMillis < byKey.get(key).purchaseDateMillis) {
      byKey.set(key, item);
    }
  }
  GAMES = [...byKey.entries()].map(([key, item]) => {
    const info = STEAM_CACHE[key] || EMBEDDED[key] || null;
    return {
      key,
      title: item.title,
      purchaseDateMillis: item.purchaseDateMillis,
      pending: !info,
      ...(info || {}),
    };
  });
}

function pendingTitles() {
  return GAMES.filter(g => g.pending).map(g => g.title);
}

function protonKey(g) {
  if (g.pending) return "pending";
  if (!g.steam_appid) return "unlisted";
  if (g.linux_native) return "native";
  const t = (g.tier || "").toLowerCase();
  return PROTON_ORDER.includes(t) ? t : "pending";
}
function reviewKey(g) {
  if (g.pending) return "pending";
  if (!g.steam_appid) return "unlisted";
  if (!g.review_desc) return "sparse";
  return REVIEW_ORDER.includes(g.review_desc) ? g.review_desc : "sparse";
}

function toggleSelection(set, value, shiftKey) {
  if (shiftKey) {
    if (set.has(value)) set.delete(value); else set.add(value);
  } else if (set.size === 1 && set.has(value)) {
    set.clear();
  } else {
    set.clear();
    set.add(value);
  }
}

function buildChips(container, options, labelFn, stateKey) {
  container.innerHTML = "";
  options.forEach(opt => {
    const selected = state[stateKey];
    const chip = document.createElement("button");
    chip.className = "chip" + (selected.has(opt) ? " active" : "");
    chip.type = "button";
    chip.textContent = labelFn(opt);
    chip.title = "Click to select only this; Shift-click to add/remove from selection";
    chip.addEventListener("click", (e) => {
      toggleSelection(selected, opt, e.shiftKey);
      renderFilters();
      renderTable();
    });
    container.appendChild(chip);
  });
}

function renderFilters() {
  const genreCounts = new Map();
  GAMES.forEach(g => (g.genres || []).forEach(gen => genreCounts.set(gen, (genreCounts.get(gen) || 0) + 1)));
  const topGenres = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(e => e[0]);
  // keep a genre visible in the chip row while it's an active filter, even if it's too
  // uncommon to make the popularity cut on its own (e.g. clicked from a game's row)
  for (const g of state.genre) {
    if (!topGenres.includes(g)) topGenres.push(g);
  }

  const reviewPresent = new Set(GAMES.map(reviewKey));
  const reviewOptions = REVIEW_ORDER.filter(r => reviewPresent.has(r));
  const protonPresent = new Set(GAMES.map(protonKey));
  const protonOptions = PROTON_ORDER.filter(t => protonPresent.has(t));

  buildChips(el("genreChips"), topGenres, g => g, "genre");
  buildChips(el("reviewChips"), reviewOptions,
    r => r === "sparse" ? "Few reviews" : r === "unlisted" ? "Unlisted" : r === "pending" ? "Resolving…" : r, "review");
  buildChips(el("protonChips"), protonOptions,
    t => t === "pending" ? "Resolving…" : PROTON_META[t].label, "proton");
}

function renderStats(list) {
  const total = GAMES.length;
  const matched = GAMES.filter(g => g.steam_appid).length;
  const deckReady = GAMES.filter(g => ["native", "platinum", "gold"].includes(protonKey(g))).length;
  const wellReviewed = GAMES.filter(g => reviewClass(g.review_desc) === "good").length;
  const stats = [[total, "Claims"], [matched, "On Steam"], [deckReady, "Deck-ready"], [wellReviewed, "Well reviewed"]];
  el("stats").innerHTML = stats.map(([n, l]) =>
    `<div class="stat"><span class="n">${n}</span><span class="l">${l}</span></div>`).join("");
}

function rowHtml(g) {
  const refreshing = REFRESHING.has(g.key);
  if (g.pending || refreshing) {
    return `<tr>
      <td class="title-cell"><span class="t"><a href="${epicSearchUrl(g.title)}" target="_blank" rel="noopener" title="Search for this title on the Epic Games Store">${escapeHtml(g.title)}</a></span></td>
      <td>&mdash;</td>
      <td><span class="badge neutral">${refreshing ? "Refreshing&hellip;" : "Resolving&hellip;"}</span></td>
      <td><span class="stamp spinner">&hellip;</span></td>
      <td class="links"><span class="none">&mdash;</span></td>
    </tr>`;
  }
  const year = g.release_date ? (String(g.release_date).match(/\d{4}/) || [])[0] : null;
  const claimed = g.purchaseDateMillis ? `claimed ${new Date(g.purchaseDateMillis).toLocaleDateString()}` : null;
  const sub = [year, claimed, g.steam_appid ? null : "no Steam listing"].filter(Boolean).join(" &middot; ");
  const f2p = g.is_free ? '<span class="f2p">F2P</span>' : "";
  // Show an active-filter genre even if it wouldn't otherwise make the 3-tag preview cut —
  // otherwise a game can correctly match a genre filter (matching uses the full list) while
  // showing no visible reason why, since the row only ever displayed the first 3 genres.
  const orderedGenres = [...(g.genres || [])].sort((a, b) => (state.genre.has(b) ? 1 : 0) - (state.genre.has(a) ? 1 : 0));
  const genreTags = orderedGenres.slice(0, 3).map(gen =>
    `<span class="genre-tag genre-tag-clickable${state.genre.has(gen) ? " active" : ""}" data-genre="${escapeHtml(gen)}" title="Click to filter by ${escapeHtml(gen)}; Shift-click to add to current filter">${escapeHtml(gen)}</span>`
  ).join("");

  let reviewCell;
  if (!g.steam_appid) {
    reviewCell = `<span class="badge neutral">Unlisted</span>`;
  } else if (!g.review_desc) {
    reviewCell = `<span class="badge neutral">Few reviews</span>`;
  } else {
    const cls = reviewClass(g.review_desc);
    const mc = g.metacritic ? `<span class="mc">MC ${g.metacritic}</span>` : "";
    reviewCell = `<span class="badge ${cls}">${escapeHtml(g.review_desc)}</span>${mc}` +
      `<span class="review-count">${(g.total_reviews || 0).toLocaleString()} reviews</span>`;
  }

  const pk = protonKey(g);
  const pm = PROTON_META[pk] || PROTON_META.unlisted;
  const protonCell = `<span class="stamp ${pm.cls}">${pm.label}</span>`;

  const updatedTitle = g.resolvedAt
    ? `Updated ${relTime(g.resolvedAt)} (${new Date(g.resolvedAt).toLocaleString()})`
    : "Never successfully fetched — use Refetch or Fix match";
  const steamLink = g.steam_appid ? `<a href="https://store.steampowered.com/app/${g.steam_appid}/" target="_blank" rel="noopener" title="${escapeHtml(updatedTitle)}">Steam &#8599;</a>` : "";
  const protonLink = g.steam_appid ? `<a href="https://www.protondb.com/app/${g.steam_appid}" target="_blank" rel="noopener" title="${escapeHtml(updatedTitle)}">ProtonDB &#8599;</a>` : "";
  const refreshBtn = `<button class="row-refresh" data-key="${escapeHtml(g.key)}" data-title="${escapeHtml(g.title)}" title="Refetch this game's Steam &amp; ProtonDB data">&#8635; Refetch</button>`;
  const fixBtn = `<button class="row-fix" data-key="${escapeHtml(g.key)}" data-title="${escapeHtml(g.title)}" title="Paste the correct Steam store URL or App ID">Fix match</button>`;
  const linksCell = (steamLink || protonLink) ? `${steamLink}${protonLink}${refreshBtn}${fixBtn}` : `<span class="none">&mdash;</span>${refreshBtn}${fixBtn}`;

  const manualTag = g.manualOverride ? `<span class="f2p" title="Manually matched">manual</span>` : "";

  return `<tr>
    <td class="title-cell"><span class="t"><a href="${epicSearchUrl(g.title)}" target="_blank" rel="noopener" title="Search for this title on the Epic Games Store">${escapeHtml(g.title)}</a>${f2p}${manualTag}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</td>
    <td><div class="genres">${genreTags || '<span class="genre-tag">&mdash;</span>'}</div></td>
    <td>${reviewCell}</td>
    <td>${protonCell}</td>
    <td class="links">${linksCell}</td>
  </tr>`;
}

function renderTable() {
  if (!GAMES.length) {
    el("rows").innerHTML = "";
    el("emptyMsg").hidden = false;
    el("emptyMsg").innerHTML = `No library loaded yet.<br><span class="cta" id="loadCta">Load your library</span>`;
    el("loadCta")?.addEventListener("click", doRefresh);
    el("count").textContent = "";
    renderStats([]);
    return;
  }
  el("emptyMsg").hidden = true;

  let list = GAMES.filter(g => {
    if (state.q && !g.title.toLowerCase().includes(state.q)) return false;
    if (state.genre.size && !(g.genres || []).some(gen => state.genre.has(gen))) return false;
    if (state.review.size && !state.review.has(reviewKey(g))) return false;
    if (state.proton.size && !state.proton.has(protonKey(g))) return false;
    return true;
  });

  const protonRank = k => PROTON_ORDER.indexOf(k);
  if (state.sort === "reviewscore") {
    list.sort((a, b) => (b.total_positive && b.total_reviews ? b.total_positive / b.total_reviews : -1)
      - (a.total_positive && a.total_reviews ? a.total_positive / a.total_reviews : -1));
  } else if (state.sort === "reviewcount") {
    list.sort((a, b) => (b.total_reviews || 0) - (a.total_reviews || 0));
  } else if (state.sort === "proton") {
    list.sort((a, b) => protonRank(protonKey(a)) - protonRank(protonKey(b)));
  } else if (state.sort === "claimdate-desc") {
    list.sort((a, b) => (b.purchaseDateMillis || 0) - (a.purchaseDateMillis || 0));
  } else if (state.sort === "claimdate-asc") {
    list.sort((a, b) => (a.purchaseDateMillis || 0) - (b.purchaseDateMillis || 0));
  } else {
    list.sort((a, b) => a.title.localeCompare(b.title));
  }

  el("rows").innerHTML = list.map(rowHtml).join("");
  el("emptyMsg").hidden = list.length !== 0;
  if (list.length === 0) el("emptyMsg").textContent = "No claims match these filters.";
  el("count").textContent = `Showing ${list.length} of ${GAMES.length}`;
  renderStats(list);
}

function updateHeader() {
  el("updated").textContent = ORDER_HISTORY.length
    ? `Library updated ${relTime(ORDER_HISTORY_FETCHED_AT)}`
    : "not loaded yet";
}

let resolveDebounce = null;
function scheduleRerender() {
  clearTimeout(resolveDebounce);
  resolveDebounce = setTimeout(() => { renderFilters(); renderTable(); }, 250);
}

function kickOffResolution() {
  const todo = pendingTitles();
  if (!todo.length) {
    el("progress").hidden = true;
    return;
  }
  el("progress").hidden = false;
  el("progressText").textContent = `Resolving ${todo.length} title${todo.length === 1 ? "" : "s"} against Steam & ProtonDB…`;
  chrome.runtime.sendMessage({ type: "RESOLVE_STEAM_INFO", titles: todo }, resp => {
    el("progress").hidden = true;
    if (resp?.ok) {
      STEAM_CACHE = resp.steamCache;
      buildGames();
      renderFilters();
      renderTable();
    }
  });
}

chrome.runtime.onMessage.addListener(message => {
  if (message.type === "STEAM_ENTRY_RESOLVED") {
    STEAM_CACHE[message.key] = message.entry;
    REFRESHING.delete(message.key);
    buildGames();
    scheduleRerender();
  }
});

function parseAppId(input) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/\/app\/(\d+)/);
  return m ? m[1] : null;
}

function fixMatch(key, title) {
  const input = window.prompt(`Paste the correct Steam store URL or App ID for "${title}":`);
  if (!input) return;
  const appid = parseAppId(input);
  if (!appid) {
    window.alert("Couldn't find an App ID in that — paste something like https://store.steampowered.com/app/337000/ or just 337000.");
    return;
  }
  REFRESHING.add(key);
  renderTable();
  chrome.runtime.sendMessage({ type: "SET_MANUAL_MATCH", title, appid }, resp => {
    REFRESHING.delete(key);
    if (resp?.ok) {
      STEAM_CACHE[key] = resp.entry;
      buildGames();
    } else {
      window.alert(resp?.error || "Could not fetch that App ID.");
    }
    renderFilters();
    renderTable();
  });
}

function refreshSingleGame(key, title) {
  if (REFRESHING.has(key)) return;
  REFRESHING.add(key);
  renderTable();
  chrome.runtime.sendMessage({ type: "RESOLVE_STEAM_INFO", titles: [title], force: true }, resp => {
    REFRESHING.delete(key);
    if (resp?.ok) {
      STEAM_CACHE = resp.steamCache;
      buildGames();
    }
    renderFilters();
    renderTable();
  });
}

async function doRefresh() {
  const btn = el("refreshBtn");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = "Refreshing…";
  el("updated").textContent = "Reading order history from epicgames.com…";
  chrome.runtime.sendMessage({ type: "REFRESH_LIBRARY" }, async resp => {
    btn.disabled = false;
    btn.textContent = prevLabel;
    if (!resp?.ok) {
      el("updated").textContent = resp?.error || "Refresh failed.";
      return;
    }
    await loadStorage();
    buildGames();
    updateHeader();
    renderFilters();
    renderTable();
    kickOffResolution();
  });
}

const THEME_ORDER = ["auto", "light", "dark"];
const THEME_META = {
  auto: { icon: "\u{1F313}", label: "Auto (follows system)" },
  light: { icon: "\u{2600}\u{FE0F}", label: "Light" },
  dark: { icon: "\u{1F319}", label: "Dark" },
};

function currentTheme() {
  const t = localStorage.getItem("theme");
  return t === "light" || t === "dark" ? t : "auto";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const meta = THEME_META[theme];
  const btn = el("themeToggle");
  btn.textContent = meta.icon;
  btn.title = `Theme: ${meta.label} (click to change)`;
}

function initTheme() {
  applyTheme(currentTheme());
  el("themeToggle").addEventListener("click", () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
    if (next === "auto") localStorage.removeItem("theme"); else localStorage.setItem("theme", next);
    applyTheme(next);
  });
}

function initTabMode() {
  const isTab = new URLSearchParams(location.search).get("mode") === "tab";
  if (isTab) {
    document.body.classList.add("tab-mode");
    el("expandBtn").hidden = true;
  } else {
    el("expandBtn").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=tab") });
    });
  }
}

async function init() {
  initTheme();
  initTabMode();
  await loadEmbedded();
  await loadStorage();
  buildGames();
  updateHeader();
  renderFilters();
  renderTable();
  kickOffResolution();

  el("refreshBtn").addEventListener("click", doRefresh);
  el("q").addEventListener("input", e => { state.q = e.target.value.toLowerCase(); renderTable(); });
  el("sort").addEventListener("change", e => { state.sort = e.target.value; renderTable(); });
  el("rows").addEventListener("click", e => {
    const refreshBtn = e.target.closest(".row-refresh");
    if (refreshBtn) return refreshSingleGame(refreshBtn.dataset.key, refreshBtn.dataset.title);
    const fixBtn = e.target.closest(".row-fix");
    if (fixBtn) return fixMatch(fixBtn.dataset.key, fixBtn.dataset.title);
    const genreTag = e.target.closest(".genre-tag-clickable");
    if (genreTag) {
      toggleSelection(state.genre, genreTag.dataset.genre, e.shiftKey);
      renderFilters();
      renderTable();
    }
  });
}

init();
