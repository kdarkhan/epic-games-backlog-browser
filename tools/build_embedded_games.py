#!/usr/bin/env python3
"""
Builds data/embedded_games.json from a plain-text list of Epic Games Store titles
(one per line). Ports the matching logic in background.js's steamSearch() so the
bundled snapshot benefits from the same fixes (hyphen-as-NOT-operator handling,
edition-suffix retry, add-on penalty, delisted-from-search pins) rather than the
naive matching the original one-off enrichment used.

Usage: python3 tools/build_embedded_games.py <titles.txt> [--out data/embedded_games.json]
"""
import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.parse

STEAM_SEARCH = "https://store.steampowered.com/api/storesearch/"
STEAM_APPDETAILS = "https://store.steampowered.com/api/appdetails"
STEAM_APPREVIEWS = "https://store.steampowered.com/appreviews/"
PROTONDB_SUMMARY = "https://www.protondb.com/api/v1/reports/summaries/"

# Keep in sync with background.js's SEARCH_DELISTED_APPIDS.
SEARCH_DELISTED_APPIDS = {
    "rocket league": 252950,
}

# Keep in sync with background.js's ADDON_SIGNALS.
ADDON_SIGNALS = ["dlc", "expansion", "access pass", "season pass", "soundtrack", "artbook", "demo", "pack", "upgrade"]

# Keep in sync with background.js's EDITION_SUFFIXES.
EDITION_SUFFIXES = [
    re.compile(r"\s+(game of the year|goty) edition$"),
    re.compile(r"\s+\S+ edition$"),
    re.compile(r"\s+remastered$"),
    re.compile(r"\s+directors cut$"),
]


def norm_title(s):
    s = s.lower()
    s = re.sub(r"[™®©]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def title_similarity(a, b):
    na, nb = norm_title(a), norm_title(b)
    if not na or not nb:
        return 0
    if na == nb:
        return 1
    sa, sb = set(na.split()), set(nb.split())
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0


def strip_edition_suffix(normalized):
    for pattern in EDITION_SUFFIXES:
        if pattern.search(normalized):
            return pattern.sub("", normalized)
    return None


def http_get_json(url, params, retries=3):
    qs = urllib.parse.urlencode(params)
    full_url = f"{url}?{qs}"
    for attempt in range(retries):
        try:
            req = urllib.request.Request(full_url, headers={"User-Agent": "Mozilla/5.0 (build script)"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status != 200:
                    return None
                return json.loads(resp.read())
        except Exception:
            if attempt == retries - 1:
                return None
            time.sleep(1.5)
    return None


def search_once(query_term, scoring_title):
    data = http_get_json(STEAM_SEARCH, {"term": query_term, "l": "english", "cc": "US"})
    if not data:
        return None
    items = data.get("items") or []
    if not items:
        return None
    best, best_score = None, 0
    for item in items:
        score = title_similarity(scoring_title, item["name"])
        name_lower = item["name"].lower()
        is_addon = any(sig in name_lower and sig not in query_term for sig in ADDON_SIGNALS)
        if is_addon:
            score *= 0.3
        if score > best_score:
            best_score, best = score, item
    return best["id"] if best_score >= 0.6 else None


def steam_search(title):
    query_norm = norm_title(title)
    pinned = SEARCH_DELISTED_APPIDS.get(query_norm)
    if pinned:
        return pinned

    direct = search_once(query_norm, title)
    if direct:
        return direct

    stripped = strip_edition_suffix(query_norm)
    if stripped and stripped != query_norm:
        via_base = search_once(stripped, stripped)
        if via_base:
            return via_base
    return None


def steam_details(appid):
    data = http_get_json(STEAM_APPDETAILS, {"appids": appid, "l": "english", "cc": "US"})
    if not data:
        return {}
    entry = data.get(str(appid))
    if not entry or not entry.get("success"):
        return {}
    d = entry["data"]
    return {
        "genres": [g["description"] for g in d.get("genres", [])],
        "metacritic": (d.get("metacritic") or {}).get("score"),
        "is_free": d.get("is_free"),
        "release_date": (d.get("release_date") or {}).get("date"),
        "linux_native": (d.get("platforms") or {}).get("linux", False),
    }


def steam_reviews(appid):
    data = http_get_json(f"{STEAM_APPREVIEWS}{appid}/", {"json": 1, "num_per_page": 0, "language": "all"})
    if not data:
        return {}
    qs = data.get("query_summary") or {}
    return {
        "review_desc": qs.get("review_score_desc"),
        "total_positive": qs.get("total_positive"),
        "total_negative": qs.get("total_negative"),
        "total_reviews": qs.get("total_reviews"),
    }


def protondb_info(appid):
    data = http_get_json(f"{PROTONDB_SUMMARY}{appid}.json", {})
    if not data:
        return {}
    return {"tier": data.get("tier"), "confidence": data.get("confidence")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("titles_file")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    script_dir = __file__.rsplit("/", 1)[0]
    out_path = args.out or f"{script_dir}/../data/embedded_games.json"

    with open(args.titles_file) as f:
        titles = [line.strip() for line in f if line.strip()]

    print(f"Loaded {len(titles)} titles from {args.titles_file}", file=sys.stderr)

    generated_at = int(time.time() * 1000)
    embedded = {}
    for i, title in enumerate(titles):
        key = norm_title(title)
        entry = {"title": title, "steam_appid": None}
        try:
            appid = steam_search(title)
            if appid:
                entry["steam_appid"] = appid
                entry.update(steam_details(appid))
                entry.update(steam_reviews(appid))
                entry.update(protondb_info(appid))
                entry["resolvedAt"] = generated_at
                time.sleep(0.4)
            else:
                time.sleep(0.15)
        except Exception as e:
            entry["error"] = str(e)
        embedded[key] = entry

        if (i + 1) % 25 == 0 or (i + 1) == len(titles):
            print(f"{i + 1}/{len(titles)}", file=sys.stderr)
            with open(out_path, "w") as f:
                json.dump(embedded, f, separators=(",", ":"))

    with open(out_path, "w") as f:
        json.dump(embedded, f, separators=(",", ":"))

    matched = sum(1 for e in embedded.values() if e.get("steam_appid"))
    print(f"done: {matched}/{len(embedded)} matched, wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
