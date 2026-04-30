import { processAthletes, type RawAthlete } from '@/lib/scrape-roster-shared';
import type { AthleteResult } from '@/lib/scrape-roster';

// ---------------------------------------------------------------------------
// Devalue decoder (rich-harris/devalue v4, used by Nuxt 3)
// The page embeds a flat JSON array in <script type="application/json"
// data-nuxt-data="nuxt-app">. Integer values inside objects/arrays are index
// references into that flat array; all other types are literal values.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyVal = any;

function decodeDevalue(data: AnyVal[]): AnyVal {
  const cache = new Map<number, AnyVal>();

  function resolveIdx(i: number): AnyVal {
    if (cache.has(i)) return cache.get(i);
    cache.set(i, null); // break cycles
    const result = resolveValue(data[i]);
    cache.set(i, result);
    return result;
  }

  function resolveValue(v: AnyVal): AnyVal {
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) {
        // devalue special-encodes non-JSON types as ["TypeName", ...args]
        if (v.length > 0 && typeof v[0] === 'string' &&
          ['undefined','NaN','Infinity','-Infinity','-0','Date','Set','Map','RegExp','Error','BigInt'].includes(v[0])) {
          return undefined;
        }
        return v.map((item: AnyVal) => typeof item === 'number' ? resolveIdx(item) : resolveValue(item));
      }
      // plain object
      const out: Record<string, AnyVal> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = typeof val === 'number' ? resolveIdx(val) : resolveValue(val);
      }
      return out;
    }
    return v; // literal: string, number, boolean, null
  }

  return resolveIdx(0);
}

// ---------------------------------------------------------------------------
// Walk the decoded Nuxt payload and collect Sidearm Sports player objects.
// Each player entry has: player_id, jersey_number, photo (nested object).
// ---------------------------------------------------------------------------

function findPlayerObjects(node: AnyVal, results: AnyVal[], visited: Set<AnyVal>): void {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    for (const item of node) findPlayerObjects(item, results, visited);
    return;
  }

  // Sidearm Sports player entry: has player_id + photo + jersey_number
  if ('player_id' in node && 'photo' in node && 'jersey_number' in node) {
    results.push(node);
    return; // don't recurse inside
  }

  for (const val of Object.values(node)) findPlayerObjects(val, results, visited);
}

// ---------------------------------------------------------------------------
// Name / headshot extraction from a raw Sidearm player object
// ---------------------------------------------------------------------------

const NAME_SUFFIX_RE = /\s*[-–]?\s*(headshot|photo|portrait|pic|image)\s*$/i;
const LOOKS_LIKE_FILENAME_RE = /\.(jpe?g|png|gif|webp)$/i;

function cleanName(s: string): string {
  return NAME_SUFFIX_RE.exec(s) ? s.replace(NAME_SUFFIX_RE, '').trim() : s.trim();
}

function looksLikeFilename(s: string): boolean {
  return LOOKS_LIKE_FILENAME_RE.test(s) || (s.includes('_') && s.length > 40);
}

function extract480wUrl(srcset: string): string | null {
  for (const part of srcset.split(',')) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length >= 2 && tokens[1] === '480w' && tokens[0].startsWith('http')) {
      return tokens[0];
    }
  }
  // fall back to first URL
  const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
  return first?.startsWith('http') ? first : null;
}

function normalisePlayer(p: AnyVal): RawAthlete | null {
  // Name lives in photo.title or photo.alt (never as a top-level field)
  let name = '';
  const photoObj = p.photo;
  if (photoObj && typeof photoObj === 'object') {
    const title = cleanName(String(photoObj.title ?? ''));
    const alt   = cleanName(String(photoObj.alt   ?? ''));
    if (title && !looksLikeFilename(title)) {
      name = title;
    } else if (alt && !looksLikeFilename(alt)) {
      name = alt;
    } else if (title) {
      name = title.split('_')[0].trim(); // last resort: strip filename suffix
    }
  }
  if (!name) return null;

  // Jersey number stored as integer — convert to string
  const jn = p.jersey_number;
  const jersey_number: string | null =
    jn !== null && jn !== undefined && String(jn).trim() !== '' ? String(jn) : null;

  // Headshot: prefer 480w from srcset, fall back to full url
  let headshot_url: string | null = null;
  if (photoObj && typeof photoObj === 'object') {
    const srcset = String(photoObj.srcset ?? '');
    if (srcset) headshot_url = extract480wUrl(srcset);
    if (!headshot_url) {
      const u = String(photoObj.url ?? '');
      if (u.startsWith('http')) headshot_url = u;
    }
  }

  return { name, jersey_number, headshot_url };
}

// ---------------------------------------------------------------------------
// HTML fallback: extract names + jersey numbers via regex when devalue fails
// ---------------------------------------------------------------------------

function extractFromHtml(html: string): RawAthlete[] {
  const names   = [...html.matchAll(/class="roster-card-item__title[^"]*"[^>]*>([^<]+)</g)].map(m => m[1].trim());
  const jerseys = [...html.matchAll(/class="roster-card-item__jersey-number[^"]*"[^>]*>([^<]+)</g)].map(m => m[1].trim());
  return names.map((name, i) => ({
    name,
    jersey_number: jerseys[i] ?? null,
    headshot_url: null,
  }));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function elapsed(start: number) {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

export async function scrapeRosterProgrammatic(
  sessionId: string,
  rosterUrl: string,
  sport: string,
  hasJerseyNumbers: boolean,
  rescrape = false,
  recognitionEngine: 'claude' | 'rekognition' = 'claude',
): Promise<AthleteResult[]> {
  const t0 = Date.now();
  rosterUrl = rosterUrl.trim().replace(/\/+$/, '');
  console.log(`[scrape-programmatic] START  url=${rosterUrl} session=${sessionId}`);

  // Fetch HTML
  const t1 = Date.now();
  const htmlRes = await fetch(rosterUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Encoding': 'gzip',
    },
  });
  if (!htmlRes.ok) {
    throw new Error(`Failed to fetch roster URL: ${htmlRes.status} ${htmlRes.statusText}`);
  }
  const html = await htmlRes.text();
  console.log(`[scrape-programmatic] HTML fetch done  bytes=${html.length}  time=${elapsed(t1)}`);

  // Extract Nuxt devalue JSON block
  const jsonMatch = html.match(/<script[^>]+type=["']application\/json["'][^>]+data-nuxt-data[^>]*>([\s\S]*?)<\/script>/i);

  let rawAthletes: RawAthlete[] = [];

  if (jsonMatch) {
    const rawJson = jsonMatch[1].trim();
    console.log(`[scrape-programmatic] Nuxt JSON block: ${rawJson.length} chars`);
    try {
      const data = JSON.parse(rawJson);
      if (Array.isArray(data)) {
        const decoded = decodeDevalue(data);
        const playerObjs: AnyVal[] = [];
        findPlayerObjects(decoded, playerObjs, new Set());
        console.log(`[scrape-programmatic] Raw player objects: ${playerObjs.length}`);

        const seen = new Set<string>();
        for (const obj of playerObjs) {
          const athlete = normalisePlayer(obj);
          if (athlete && !seen.has(athlete.name)) {
            seen.add(athlete.name);
            rawAthletes.push(athlete);
          }
        }
      }
    } catch (e) {
      console.warn(`[scrape-programmatic] Devalue decode error: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    console.warn('[scrape-programmatic] No Nuxt JSON block found');
  }

  if (rawAthletes.length === 0) {
    console.warn('[scrape-programmatic] Falling back to HTML regex (no headshots)');
    rawAthletes = extractFromHtml(html);
  }

  console.log(`[scrape-programmatic] Athletes extracted: ${rawAthletes.length} (${rawAthletes.filter(a => a.headshot_url).length} with headshots)  time=${elapsed(t0)}`);

  if (rawAthletes.length === 0) {
    throw new Error('Programmatic scraper found 0 athletes. Try the Claude AI scraping method instead.');
  }

  // Void unused params (kept for signature parity with scrapeRoster)
  void sport;
  void hasJerseyNumbers;

  const results = await processAthletes(rawAthletes, sessionId, rosterUrl, rescrape, recognitionEngine);
  console.log(`[scrape-programmatic] DONE  athletes=${results.length}/${rawAthletes.length}  total=${elapsed(t0)}`);
  return results;
}
