import { normTitle, titleSimilarity } from "./lib/util.js";

const EPIC_ORDER_HISTORY_URL = "https://www.epicgames.com/account/v2/payment/ajaxGetOrderHistory";
const EPIC_TAB_URL = "https://www.epicgames.com/account/transactions?lang=en-US";
const STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/";
const STEAM_APPDETAILS = "https://store.steampowered.com/api/appdetails";
const STEAM_APPREVIEWS = "https://store.steampowered.com/appreviews/";
const PROTONDB_SUMMARY = "https://www.protondb.com/api/v1/reports/summaries/";

// --- injected into the epicgames.com tab; must be self-contained ---
async function fetchAllEpicOrders() {
  try {
    let all = [];
    let nextPageToken;
    do {
      const url = new URL("/account/v2/payment/ajaxGetOrderHistory", location.origin);
      url.searchParams.set("count", "50");
      url.searchParams.set("sortDir", "DESC");
      url.searchParams.set("sortBy", "DATE");
      url.searchParams.set("locale", "en-US");
      if (nextPageToken) url.searchParams.set("nextPageToken", nextPageToken);

      const res = await fetch(url.toString(), {
        credentials: "include",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
        },
        method: "GET",
      });
      const status = res.status;
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return { ok: false, reason: "BAD_RESPONSE", message: `HTTP ${status}, non-JSON body (first 200 chars): ${text.slice(0, 200)}`, finalUrl: location.href };
      }
      if (data.needLogin) return { ok: false, reason: "NEED_LOGIN", finalUrl: location.href };
      if (!data.orders) return { ok: false, reason: "BAD_RESPONSE", message: `HTTP ${status}, JSON keys: ${Object.keys(data).join(",")}`, finalUrl: location.href };

      for (const order of data.orders) {
        for (const item of order.items || []) {
          all.push({
            title: item.description,
            orderId: order.orderId,
            purchaseDateMillis: order.createdAtMillis,
          });
        }
      }
      nextPageToken = data.nextPageToken;
    } while (nextPageToken);
    return { ok: true, orders: all };
  } catch (e) {
    return { ok: false, reason: "FETCH_ERROR", message: String(e && e.stack || e), finalUrl: location.href };
  }
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for epicgames.com to load."));
    }, timeoutMs);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function refreshLibrary() {
  const tab = await chrome.tabs.create({ url: EPIC_TAB_URL, active: false });
  try {
    await waitForTabComplete(tab.id);
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fetchAllEpicOrders,
    });
    const result = injected[0]?.result;
    if (!result || !result.ok) {
      const reason = result?.reason || "UNKNOWN";
      if (reason === "NEED_LOGIN") {
        throw new Error("Not logged in to Epic Games — log in at epicgames.com, then refresh again.");
      }
      const detail = result?.message ? ` — ${result.message}` : "";
      throw new Error(`Could not read Epic order history (${reason})${detail}. Landed on: ${result?.finalUrl || "unknown"}`);
    }
    await chrome.storage.local.set({
      orderHistory: result.orders,
      orderHistoryFetchedAt: Date.now(),
    });
    return result.orders;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// --- Steam / ProtonDB resolution, runs directly in the service worker ---
// Signals a search hit is an add-on rather than the base game (DLC packs, access
// passes, etc. often share more words with a short query than the actual base game
// does once a publisher has renamed/merged it — e.g. "HITMAN" vs. the current Steam
// listing "HITMAN World of Assassination"). Penalize these unless the query itself
// uses the word, so a real game legitimately named e.g. "... Pack" isn't punished.
const ADDON_SIGNALS = ["dlc", "expansion", "access pass", "season pass", "soundtrack", "artbook", "demo", "pack", "upgrade"];

// Titles Steam's own storesearch endpoint can never return, regardless of query, because
// Valve delisted them from search (not from the store — appdetails/appreviews still work
// fine by App ID). Known permanent cases, not a fuzzy-match judgment call like Hitman.
const SEARCH_DELISTED_APPIDS = {
  "rocket league": 252950,
};

// Steam's storesearch appears to require most/all query terms to loosely match, so a
// trailing qualifier the base app's own Steam listing doesn't carry in its name — e.g.
// Epic's "Pillars of Eternity - Definitive Edition" vs. Steam's plain "Pillars of
// Eternity" — can zero out the whole search. These are almost always re-releases of a
// base game, not a separate app, so retry with the suffix stripped when the first pass
// comes up empty.
// This only ever runs after the direct full-title search already came up empty, so it's
// safe to be broad: a game genuinely named "... Edition" as part of its real title would
// already have matched on the first pass and never reach here.
const EDITION_SUFFIXES = [
  /\s+(game of the year|goty) edition$/,
  /\s+\S+ edition$/,
  /\s+remastered$/,
  /\s+directors cut$/,
];

function stripEditionSuffix(normalized) {
  for (const re of EDITION_SUFFIXES) {
    if (re.test(normalized)) return normalized.replace(re, "");
  }
  return null;
}

async function searchOnce(queryTerm, originalTitle) {
  const url = new URL(STEAM_SEARCH);
  url.searchParams.set("term", queryTerm);
  url.searchParams.set("l", "english");
  url.searchParams.set("cc", "US");
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const items = (await res.json()).items || [];
  if (!items.length) return null;

  let best = null, bestScore = 0;
  for (const item of items) {
    let score = titleSimilarity(originalTitle, item.name);
    const nameLower = item.name.toLowerCase();
    const isAddon = ADDON_SIGNALS.some(sig => nameLower.includes(sig) && !queryTerm.includes(sig));
    if (isAddon) score *= 0.3;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  // Higher bar than a plain "more than half the words match" — a wrong sibling title in
  // the same franchise (sequel, edition, spin-off) can tie a loose threshold by accident.
  return bestScore >= 0.6 ? best.id : null;
}

async function steamSearch(title) {
  const queryNorm = normTitle(title);
  const pinned = SEARCH_DELISTED_APPIDS[queryNorm];
  if (pinned) return pinned;

  const direct = await searchOnce(queryNorm, title);
  if (direct) return direct;

  const stripped = stripEditionSuffix(queryNorm);
  if (stripped && stripped !== queryNorm) {
    // Score against the stripped title too, not just the full original — an edition
    // qualifier is a much bigger relative share of a short one-word title (e.g.
    // "HUMANKIND Standard Edition" vs. base "HUMANKIND") than a long one, so scoring
    // against the un-stripped title can reject an otherwise-perfect match.
    const viaBaseTitle = await searchOnce(stripped, stripped);
    if (viaBaseTitle) return viaBaseTitle;
  }
  return null;
}

async function steamDetails(appid) {
  const url = new URL(STEAM_APPDETAILS);
  url.searchParams.set("appids", appid);
  url.searchParams.set("l", "english");
  url.searchParams.set("cc", "US");
  const res = await fetch(url.toString());
  if (!res.ok) return {};
  const data = (await res.json())[String(appid)];
  if (!data?.success) return {};
  const d = data.data;
  return {
    genres: (d.genres || []).map(g => g.description),
    metacritic: d.metacritic?.score ?? null,
    is_free: d.is_free ?? null,
    release_date: d.release_date?.date ?? null,
  };
}

async function steamReviews(appid) {
  const url = new URL(STEAM_APPREVIEWS + appid + "/");
  url.searchParams.set("json", "1");
  url.searchParams.set("num_per_page", "0");
  url.searchParams.set("language", "all");
  const res = await fetch(url.toString());
  if (!res.ok) return {};
  const qs = (await res.json()).query_summary || {};
  return {
    review_desc: qs.review_score_desc ?? null,
    total_positive: qs.total_positive ?? null,
    total_negative: qs.total_negative ?? null,
    total_reviews: qs.total_reviews ?? null,
  };
}

async function protonDbInfo(appid) {
  const res = await fetch(PROTONDB_SUMMARY + appid + ".json");
  if (!res.ok) return {};
  const d = await res.json();
  return { tier: d.tier ?? null, confidence: d.confidence ?? null };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function resolveSteamInfo(titles, sendProgress, force = false) {
  const { steamCache = {} } = await chrome.storage.local.get("steamCache");
  const unique = [...new Set(titles)];
  const todo = force ? unique : unique.filter(t => !(normTitle(t) in steamCache));

  for (const title of todo) {
    const key = normTitle(title);
    let entry = { title, steam_appid: null };
    try {
      const appid = await steamSearch(title);
      if (appid) {
        entry.steam_appid = appid;
        Object.assign(entry, await steamDetails(appid));
        Object.assign(entry, await steamReviews(appid));
        Object.assign(entry, await protonDbInfo(appid));
      }
    } catch (e) {
      entry.error = String(e);
    }
    entry.resolvedAt = Date.now();
    steamCache[key] = entry;
    await chrome.storage.local.set({ steamCache });
    sendProgress?.(key, entry);
    await sleep(appidDelay(entry));
  }
  return steamCache;
}

function appidDelay(entry) {
  return entry.steam_appid ? 350 : 120;
}

async function setManualMatch(title, appid) {
  const { steamCache = {} } = await chrome.storage.local.get("steamCache");
  const key = normTitle(title);
  const entry = { title, steam_appid: appid, manualOverride: true };
  Object.assign(entry, await steamDetails(appid));
  Object.assign(entry, await steamReviews(appid));
  Object.assign(entry, await protonDbInfo(appid));
  entry.resolvedAt = Date.now();
  steamCache[key] = entry;
  await chrome.storage.local.set({ steamCache });
  return entry;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "REFRESH_LIBRARY") {
    refreshLibrary()
      .then(orders => sendResponse({ ok: true, orders }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "RESOLVE_STEAM_INFO") {
    resolveSteamInfo(message.titles || [], (key, entry) => {
      chrome.runtime.sendMessage({ type: "STEAM_ENTRY_RESOLVED", key, entry }).catch(() => {});
    }, !!message.force)
      .then(steamCache => sendResponse({ ok: true, steamCache }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (message.type === "SET_MANUAL_MATCH") {
    setManualMatch(message.title, message.appid)
      .then(entry => sendResponse({ ok: true, entry }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
