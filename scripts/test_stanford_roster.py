#!/usr/bin/env python3
"""
Proof-of-concept: programmatically extract names, jersey numbers, and
headshot URLs from a gostanford.com roster page without using Claude.

Usage:
    python scripts/test_stanford_roster.py
    python scripts/test_stanford_roster.py https://gostanford.com/sports/womens-volleyball/roster

No third-party libraries needed (uses stdlib only).
"""
import sys
import json
import re
import gzip
import urllib.request
from typing import Any


# ---------------------------------------------------------------------------
# 1.  Fetch HTML  (handles gzip compression)
# ---------------------------------------------------------------------------

def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9",
        "Accept-Encoding": "gzip",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=20) as resp:
        ce = resp.headers.get("Content-Encoding", "")
        raw = resp.read()
    return gzip.decompress(raw).decode("utf-8", errors="replace") if ce == "gzip" else raw.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# 2.  Devalue decoder
#     Nuxt 3 embeds page data as a flat JSON array in
#     <script type="application/json" data-nuxt-data="nuxt-app">.
#     Format: every integer in an object/array value position is an index
#     reference into the flat array; strings/numbers at the top level are
#     literal values.
# ---------------------------------------------------------------------------

def decode_devalue(data: list) -> Any:
    cache: dict[int, Any] = {}

    def resolve_idx(i: int) -> Any:
        if i in cache:
            return cache[i]
        cache[i] = None  # break cycles
        result = resolve_value(data[i])
        cache[i] = result
        return result

    def resolve_value(v: Any) -> Any:
        if isinstance(v, dict):
            return {
                k: (resolve_idx(val) if isinstance(val, int) else resolve_value(val))
                for k, val in v.items()
            }
        if isinstance(v, list):
            # devalue special-encodes non-JSON types as 1-element arrays w/ string marker
            if v and isinstance(v[0], str) and v[0] in (
                "undefined", "NaN", "Infinity", "-Infinity", "-0",
                "Date", "Set", "Map", "RegExp", "Error", "BigInt",
            ):
                return None
            return [
                (resolve_idx(item) if isinstance(item, int) else resolve_value(item))
                for item in v
            ]
        return v  # literal string, number, bool, or None

    return resolve_idx(0)


# ---------------------------------------------------------------------------
# 3.  Walk the decoded tree — collect "player roster entry" objects.
#
#     On gostanford.com the Sidearm Sports / Nuxt payload stores each player
#     as an object with (at minimum) these keys:
#       player_id, jersey_number, photo  ← the shape we look for
#     Names are NOT a direct field; they live in photo.title / photo.alt.
# ---------------------------------------------------------------------------

def find_players(node: Any, results: list, visited: set) -> None:
    if node is None or isinstance(node, (str, int, float, bool)):
        return
    nid = id(node)
    if nid in visited:
        return
    visited.add(nid)

    if isinstance(node, dict):
        keys = set(node.keys())
        # Sidearm Sports player roster entry: must have player_id + photo + jersey_number
        if "player_id" in keys and "photo" in keys and "jersey_number" in keys:
            results.append(node)
            return  # don't recurse inside this node
        for v in node.values():
            find_players(v, results, visited)
    elif isinstance(node, list):
        for item in node:
            find_players(item, results, visited)


# ---------------------------------------------------------------------------
# 4.  Normalise a raw Sidearm player object into (name, jersey, photo_url)
# ---------------------------------------------------------------------------

def extract_480w_url(srcset: str):
    """Return the 480w variant URL from a CSS srcset string, or None."""
    for part in srcset.split(","):
        part = part.strip()
        tokens = part.split()
        if len(tokens) >= 2 and tokens[1] == "480w" and tokens[0].startswith("http"):
            return tokens[0]
    # Fall back to first URL in srcset
    if srcset:
        first = srcset.split(",")[0].strip().split()[0]
        if first.startswith("http"):
            return first
    return None


def _looks_like_filename(s: str) -> bool:
    return bool(re.search(r'\.(jpg|jpeg|png|gif|webp)$', s, re.IGNORECASE)) or ("_" in s and len(s) > 40)


_NAME_SUFFIXES = re.compile(r'\s*[-–]?\s*(headshot|photo|portrait|pic|image)\s*$', re.IGNORECASE)


def _clean_name(s: str) -> str:
    return _NAME_SUFFIXES.sub("", s).strip()


def normalise_player(p: dict) -> dict:
    # Name — prefer player.full_name (always present and correct on Sidearm rosters).
    # Fall back to photo.title / photo.alt for any roster that lacks the player sub-object.
    # This fixes sports like rowing where photo.title is a generic filename and photo.alt is null.
    name = ""
    player_sub = p.get("player")
    if isinstance(player_sub, dict):
        name = (player_sub.get("full_name") or "").strip()

    if not name:
        photo_obj = p.get("photo")
        if isinstance(photo_obj, dict):
            title = _clean_name(str(photo_obj.get("title") or ""))
            alt = _clean_name(str(photo_obj.get("alt") or ""))
            if title and not _looks_like_filename(title):
                name = title
            elif alt and not _looks_like_filename(alt):
                name = alt
            elif title:
                # Last resort: use the part of the filename before the first underscore
                name = title.split("_")[0].strip()

    # Jersey — stored as integer; convert to string (None if missing/blank)
    jn = p.get("jersey_number")
    jersey = str(jn).strip() if jn is not None and str(jn).strip() not in ("", "None") else None

    # Headshot — prefer 480w from srcset, fall back to url field
    headshot = None
    if isinstance(photo_obj, dict):
        srcset = photo_obj.get("srcset") or ""
        if srcset:
            headshot = extract_480w_url(srcset)
        if not headshot:
            u = photo_obj.get("url") or ""
            if u.startswith("http"):
                headshot = u

    return {"name": name, "jersey_number": jersey, "headshot_url": headshot}


# ---------------------------------------------------------------------------
# 5.  HTML fallback — extract names + jersey numbers via regex
#     (used when devalue parsing fails or yields 0 players)
# ---------------------------------------------------------------------------

def extract_from_html(html: str) -> list[dict]:
    names = re.findall(r'class="roster-card-item__title[^"]*"[^>]*>([^<]+)<', html)
    jerseys = re.findall(r'class="roster-card-item__jersey-number[^"]*"[^>]*>([^<]+)<', html)
    players = [{"name": n.strip(), "jersey_number": None, "headshot_url": None} for n in names]
    for i, j in enumerate(jerseys):
        if i < len(players):
            players[i]["jersey_number"] = j.strip()
    return players


# ---------------------------------------------------------------------------
# 6.  Main extraction function
# ---------------------------------------------------------------------------

def scrape_roster(url: str) -> list[dict]:
    print(f"Fetching {url} …", file=sys.stderr)
    html = fetch_html(url)
    print(f"  Got {len(html):,} bytes", file=sys.stderr)

    # Extract Nuxt devalue JSON block
    match = re.search(
        r'<script[^>]+type=["\']application/json["\'][^>]+data-nuxt-data=[^>]+>([\s\S]*?)</script>',
        html,
    )

    players: list[dict] = []

    if match:
        raw_json = match.group(1).strip()
        print(f"  Nuxt JSON block: {len(raw_json):,} chars", file=sys.stderr)
        try:
            data = json.loads(raw_json)
            if isinstance(data, list):
                decoded = decode_devalue(data)
                raw_players: list[dict] = []
                find_players(decoded, raw_players, set())
                print(f"  Raw player objects: {len(raw_players)}", file=sys.stderr)

                seen_names: set[str] = set()
                for rp in raw_players:
                    p = normalise_player(rp)
                    if p["name"] and p["name"] not in seen_names:
                        seen_names.add(p["name"])
                        players.append(p)
            else:
                print("  JSON is not a list — skipping devalue decode", file=sys.stderr)
        except Exception as e:
            print(f"  Devalue decode error: {e}", file=sys.stderr)
    else:
        print("  No Nuxt JSON block found", file=sys.stderr)

    if not players:
        print("  Falling back to HTML regex (no headshots)", file=sys.stderr)
        players = extract_from_html(html)

    return players


# ---------------------------------------------------------------------------
# 7.  Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    urls = sys.argv[1:] or [
        "https://gostanford.com/sports/mens-volleyball/roster",
        "https://gostanford.com/sports/womens-volleyball/roster",
        "https://gostanford.com/sports/womens-soccer/roster",
    ]

    for url in urls:
        print(f"\n{'='*70}", file=sys.stderr)
        athletes = scrape_roster(url)

        print(f"\n--- {url} ---")
        print(f"Athletes: {len(athletes)}  |  "
              f"With headshots: {sum(1 for a in athletes if a['headshot_url'])}  |  "
              f"With jersey #: {sum(1 for a in athletes if a['jersey_number'])}")
        print()
        for a in athletes:
            j = f"#{a['jersey_number']}" if a["jersey_number"] else "   "
            ph = (a["headshot_url"] or "")
            ph_short = ph[:80] + "…" if len(ph) > 80 else (ph or "(no photo)")
            print(f"  {j:>4}  {a['name']:<32}  {ph_short}")


if __name__ == "__main__":
    main()
