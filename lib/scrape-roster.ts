import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { createServiceClient } from '@/lib/supabase/server';

const anthropic = new Anthropic({
  timeout: 120_000,  // 2 min per attempt
  maxRetries: 4,     // up to 5 total attempts; SDK auto-retries on 529 overloaded
});

export interface AthleteResult {
  id: string;
  name: string;
  jersey_number: string | null;
  headshot_url: string | null; // signed URL valid 1 hr, or null
}

function elapsed(start: number) {
  return `${((Date.now() - start) / 1000).toFixed(2)}s`;
}

type RawAthlete = { name: string; jersey_number: string | null; headshot_url: string | null };

/**
 * Parse Sidearm Sports / Nuxt SSR pages that embed roster data as a flat devalue array
 * in a <script id="__NUXT_DATA__"> tag.  All integer values in objects are index
 * references into the flat array; resolve one level for primitives, two for photos.
 *
 * Returns null if the page doesn't use this format.
 */
function tryParseSidarmNuxt(html: string): RawAthlete[] | null {
  const m = html.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;

  let flat: unknown[];
  try {
    flat = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(flat) || flat.length < 10) return null;

  const n = flat.length;
  const res = (v: unknown): unknown => (typeof v === 'number' && v >= 0 && v < n ? flat[v] : v);

  const athletes: RawAthlete[] = [];
  const seenIds = new Set<unknown>();

  const getPhotoUrl = (photoObj: unknown): string | null => {
    if (typeof photoObj !== 'object' || photoObj === null || Array.isArray(photoObj)) return null;
    const photo = photoObj as Record<string, unknown>;
    const srcset = res(photo.srcset);
    if (typeof srcset === 'string' && srcset.startsWith('http')) {
      return srcset.split(',')[0].trim().split(/\s+/)[0];
    }
    const url = res(photo.url);
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  };

  for (const item of flat) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    // Use roster_player wrapper objects (have player_id + jersey_number).
    // These carry the roster-season photo in their `photo` field, which is populated
    // even when the player's master_photo is null (e.g. newly added athletes).
    if (!('player_id' in obj) || !('jersey_number' in obj)) continue;

    const id = res(obj.id);
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    // Name comes from the nested player object
    const playerObj = res(obj.player);
    if (typeof playerObj !== 'object' || playerObj === null || Array.isArray(playerObj)) continue;
    const player = playerObj as Record<string, unknown>;
    const name = res(player.full_name);
    if (typeof name !== 'string' || !name.trim()) continue;

    // jersey_number_label is a pre-formatted string; prefer it over the raw number
    const jlabelRaw = res(obj.jersey_number_label);
    const jerseyRaw = res(obj.jersey_number);
    const jersey =
      typeof jlabelRaw === 'string' && jlabelRaw.trim()
        ? jlabelRaw.trim()
        : jerseyRaw != null
          ? String(jerseyRaw)
          : null;

    // Prefer wrapper's `photo` (roster-season upload); fall back to player's `master_photo`.
    const headshotUrl =
      getPhotoUrl(res(obj.photo)) ??
      getPhotoUrl(res(player.master_photo));

    athletes.push({ name: name.trim(), jersey_number: jersey, headshot_url: headshotUrl });
  }

  return athletes.length > 0 ? athletes : null;
}

/**
 * CSS-selector scraping for common college-athletics HTML templates (non-Nuxt sites).
 * Handles Sidearm HTML-rendered pages, Presto Sports, and generic roster grids.
 *
 * Returns null if no athletes are found so the caller can fall back to Claude.
 */
function tryParseHtml(html: string, baseUrl: string): RawAthlete[] | null {
  const $ = cheerio.load(html);

  // Resolve a potentially-relative URL to absolute
  const abs = (src: string): string => {
    if (!src) return '';
    try { return new URL(src, baseUrl).href; } catch { return src; }
  };

  // Candidate selectors in priority order (most-specific first)
  const CARD_SELECTORS = [
    '.s-person-card',          // Sidearm card layout
    '.roster-card',
    '[class*="roster"] [class*="card"]',
    '[class*="roster"] [class*="person"]',
    '[class*="roster"] li',
    'ul.roster li',
    'table.roster tr',
  ];

  for (const sel of CARD_SELECTORS) {
    const cards = $(sel).toArray();
    if (cards.length < 3) continue; // not enough to be a real roster

    const athletes: RawAthlete[] = [];
    for (const card of cards) {
      const $c = $(card);

      // Name: prefer explicit name element, fall back to link text
      const nameEl =
        $c.find('[class*="name"]').first() ||
        $c.find('h3,h4,h2').first() ||
        $c.find('a').first();
      const name = nameEl.text().trim();
      if (!name || name.length < 3) continue;

      // Jersey number
      const numEl = $c.find('[class*="number"],[class*="jersey"],[class*="uni"]').first();
      const jersey = numEl.text().replace(/[^0-9]/g, '') || null;

      // Headshot: img src or data-src
      const img = $c.find('img').first();
      let headshotUrl =
        abs(img.attr('src') ?? '') ||
        abs(img.attr('data-src') ?? '') ||
        abs(img.attr('data-lazy-src') ?? '');
      if (headshotUrl && (headshotUrl.endsWith('.svg') || headshotUrl.includes('silhouette') || headshotUrl.includes('placeholder'))) {
        headshotUrl = '';
      }

      athletes.push({ name, jersey_number: jersey, headshot_url: headshotUrl || null });
    }

    if (athletes.length >= 3) {
      console.log(`[scrape-roster] CSS parse: selector="${sel}" athletes=${athletes.length}`);
      return athletes;
    }
  }

  return null;
}

/**
 * Strip everything Claude doesn't need: scripts, styles, SVGs, comments,
 * and all tag attributes except src/href (for headshot URLs).
 * Reduces a typical 1–2 MB roster page to ~50–150 KB.
 */
function stripHtml(html: string): string {
  return html
    // Remove block tags and their entire contents
    .replace(/<(script|style|noscript|svg|iframe|canvas|video|audio|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Remove HTML comments
    .replace(/<!--[\s\S]*?-->/g, '')
    // Strip all attributes except those that carry URLs (src, href, data-src, data-*)
    // Also extract the first URL from srcset (responsive images store headshots there)
    .replace(/<([a-z][a-z0-9]*)\s([^>]+)>/gi, (match, tag, attrs) => {
      const kept = (attrs.match(/(?:src|href|data-[a-z][a-z0-9-]*)="[^"]*"/gi) ?? []) as string[];
      // If no src but has srcset, pull the first URL out as src
      if (!kept.some(a => a.startsWith('src=')) ) {
        const srcsetMatch = attrs.match(/srcset="([^"]+)"/i);
        if (srcsetMatch) {
          const firstUrl = srcsetMatch[1].split(',')[0].trim().split(/\s+/)[0];
          if (firstUrl) kept.push(`src="${firstUrl}"`);
        }
      }
      return kept.length > 0 ? `<${tag} ${kept.join(' ')}>` : `<${tag}>`;
    })
    // Collapse runs of whitespace / blank lines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function scrapeRoster(
  sessionId: string,
  rosterUrl: string,
  sport: string,
  hasJerseyNumbers: boolean,
  rescrape = false,
): Promise<AthleteResult[]> {
  const t0 = Date.now();
  // Normalize so check-roster can match it reliably
  rosterUrl = rosterUrl.trim().replace(/\/+$/, '');
  console.log(`[scrape-roster] START  url=${rosterUrl} session=${sessionId} rescrape=${rescrape}`);

  // Fetch raw HTML
  const t1 = Date.now();
  const htmlRes = await fetch(rosterUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CaptionGenerator/1.0)' },
  });
  if (!htmlRes.ok) {
    throw new Error(`Failed to fetch roster URL: ${htmlRes.status} ${htmlRes.statusText}`);
  }
  const rosterHtml = await htmlRes.text();
  console.log(`[scrape-roster] HTML fetch done  raw=${rosterHtml.length} chars  time=${elapsed(t1)}`);

  // ── Tier 1: Sidearm Sports / Nuxt devalue (fast, no AI) ──────────────────
  const t2 = Date.now();
  let rawAthletes: RawAthlete[] | null = tryParseSidarmNuxt(rosterHtml);
  if (rawAthletes) {
    console.log(`[scrape-roster] Tier1 devalue: ${rawAthletes.length} athletes  time=${elapsed(t2)}`);
  }

  // ── Tier 2: CSS selector parsing (fast, no AI) ────────────────────────────
  if (!rawAthletes) {
    rawAthletes = tryParseHtml(rosterHtml, rosterUrl);
    if (rawAthletes) {
      console.log(`[scrape-roster] Tier2 CSS: ${rawAthletes.length} athletes  time=${elapsed(t2)}`);
    }
  }

  // ── Tier 3: Claude (fallback for unusual pages) ───────────────────────────
  if (!rawAthletes) {
    console.log(`[scrape-roster] Tier3 Claude fallback  time=${elapsed(t2)}`);
    const strippedHtml = stripHtml(rosterHtml);

    // Nuxt/Vue SSR pages store athlete+photo data in embedded JSON <script> tags.
    const jsonScriptBlocks = Array.from(
      rosterHtml.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)
    ).map(m => m[1].trim());
    const nuxtStateBlocks = Array.from(
      rosterHtml.matchAll(/window\.__NUXT(?:_DATA)?__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/gi)
    ).map(m => m[1]);
    const structuredData = [...jsonScriptBlocks, ...nuxtStateBlocks];
    const hasStructuredData = structuredData.length > 0;

    const HTML_CAP = hasStructuredData ? 0 : 60_000;
    const cappedHtml = HTML_CAP === 0
      ? ''
      : strippedHtml.length > HTML_CAP
        ? strippedHtml.slice(0, HTML_CAP) + '\n<!-- [truncated] -->'
        : strippedHtml;

    const TOTAL_STRUCTURED_CAP = hasStructuredData ? 200_000 : 60_000;
    let structuredDataForPrompt = '';
    let structuredCharsUsed = 0;
    for (let i = 0; i < structuredData.length; i++) {
      const remaining = TOTAL_STRUCTURED_CAP - structuredCharsUsed;
      if (remaining <= 0) break;
      const chunk = structuredData[i].slice(0, remaining);
      structuredDataForPrompt += `--- Embedded JSON block ${i + 1} ---\n${chunk}\n`;
      structuredCharsUsed += chunk.length;
    }

    console.log(`[scrape-roster] Calling Claude  html_chars=${cappedHtml.length}  structured_chars=${structuredCharsUsed}`);
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: hasStructuredData ? `You are extracting athlete data from a sports team roster page.

The following is embedded JSON state from the page (Nuxt/Vue SSR devalue format).
It is a flat array where integer values are indices referencing other elements in the array.
The athlete names and their headshot URLs are both stored as plain strings within this array.
Find the section containing player/roster data and extract each athlete's name and headshot URL.
Prefer the smallest imgproxy image variant (rs:fit:480) as the headshot_url.

${structuredDataForPrompt}

Extract all athletes and return a JSON array. For each athlete include:
- name: full name as shown
- jersey_number: jersey number as a string, or null if not shown or not applicable
- headshot_url: the absolute URL to their headshot image, or null if not found

Return only valid JSON with no commentary. Example:
[
  { "name": "Daria Gusarova", "jersey_number": null, "headshot_url": "https://..." },
  { "name": "Emmy Sharp", "jersey_number": "12", "headshot_url": "https://..." }
]` : `You are extracting athlete data from a sports team roster page.

Here is the stripped HTML of the roster page (scripts and styles removed):
<html>
${cappedHtml}
</html>

Extract all athletes and return a JSON array. For each athlete include:
- name: full name as shown
- jersey_number: jersey number as a string, or null if not shown or not applicable
- headshot_url: the absolute URL to their headshot image, or null if not found

Return only valid JSON with no commentary. Example:
[
  { "name": "Daria Gusarova", "jersey_number": null, "headshot_url": "https://..." },
  { "name": "Emmy Sharp", "jersey_number": "12", "headshot_url": "https://..." }
]`,
        },
      ],
    });
    console.log(`[scrape-roster] Claude API done  input_tokens=${message.usage.input_tokens} output_tokens=${message.usage.output_tokens} stop_reason=${message.stop_reason}  time=${elapsed(t2)}`);

    const block = message.content[0];
    if (block.type !== 'text') throw new Error('Unexpected Claude response type');

    let responseText = block.text.trim();
    if (message.stop_reason === 'max_tokens') {
      console.warn('[scrape-roster] Output truncated at max_tokens — attempting partial parse');
      const lastBrace = responseText.lastIndexOf('}');
      if (lastBrace !== -1) responseText = responseText.slice(0, lastBrace + 1) + ']';
    }

    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error('No JSON array found in response');
      rawAthletes = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('Failed to parse Claude response as JSON');
    }
  }

  const athletes: RawAthlete[] = rawAthletes ?? [];
  console.log(`[scrape-roster] Parsed ${athletes.length} athletes (${athletes.filter(a => a.headshot_url).length} with headshots)`);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log(`[scrape-roster] Supabase env  url=${supabaseUrl ? supabaseUrl.slice(0, 30) + '…' : 'MISSING'}  service_key=${serviceKey ? 'SET' : 'MISSING'}`);
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Supabase env vars not set: check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }

  const supabase = createServiceClient();

  // When the user explicitly chooses to rescrape, delete the old athletes for this URL
  // so we don't accumulate duplicate rows.
  if (rescrape) {
    const { error: delError } = await supabase
      .from('roster_athletes')
      .delete()
      .eq('roster_url', rosterUrl);
    if (delError) {
      console.warn(`[scrape-roster] Failed to delete existing athletes: ${delError.message}`);
    } else {
      console.log(`[scrape-roster] Deleted existing athletes for url=${rosterUrl}`);
    }
  }

  // Process all athletes in parallel — serial was the main timeout culprit
  const t3 = Date.now();
  const settled = await Promise.allSettled(
    athletes.map(async (raw, i) => {
      const ta = Date.now();
      const athleteId = crypto.randomUUID();
      let storagePath: string | null = null;

      // Try to download and upload headshot
      if (raw.headshot_url) {
        try {
          const td = Date.now();
          const imgRes = await fetch(raw.headshot_url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          const downloadMs = Date.now() - td;
          if (imgRes.ok) {
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            const tu = Date.now();
            const storageKey = `${sessionId}/${athleteId}.jpg`;
            const { error: uploadError } = await supabase.storage
              .from('rosters')
              .upload(storageKey, imgBuffer, { contentType: 'image/jpeg', upsert: true });
            const uploadMs = Date.now() - tu;
            if (!uploadError) {
              storagePath = storageKey;
              console.log(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  download=${downloadMs}ms  upload=${uploadMs}ms  size=${imgBuffer.length}B`);
            } else {
              console.warn(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  storage upload error: ${uploadError.message}`);
            }
          } else {
            console.warn(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  headshot fetch ${imgRes.status}  download=${downloadMs}ms`);
          }
        } catch (err) {
          console.warn(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  headshot exception: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        console.log(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  no headshot URL`);
      }

      // Insert DB row
      const { error: dbError } = await supabase.from('roster_athletes').insert({
        id: athleteId,
        session_id: sessionId,
        roster_url: rosterUrl,
        name: raw.name,
        jersey_number: raw.jersey_number ?? null,
        headshot_url: storagePath,
      });

      if (dbError) {
        console.error(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  DB insert failed:`, JSON.stringify(dbError));
        throw new Error(dbError.message);
      }

      // Generate signed URL for client display
      let signedUrl: string | null = null;
      if (storagePath) {
        const { data: signed } = await supabase.storage
          .from('rosters')
          .createSignedUrl(storagePath, 3600);
        signedUrl = signed?.signedUrl ?? null;
      }

      console.log(`[scrape-roster] [${i + 1}/${athletes.length}] ${raw.name}  done  time=${elapsed(ta)}`);

      return {
        id: athleteId,
        name: raw.name,
        jersey_number: raw.jersey_number ?? null,
        headshot_url: signedUrl,
      } satisfies AthleteResult;
    })
  );

  console.log(`[scrape-roster] Parallel loop done  time=${elapsed(t3)}`);

  const results: AthleteResult[] = settled
    .filter((r): r is PromiseFulfilledResult<AthleteResult> => r.status === 'fulfilled')
    .map((r) => r.value);

  console.log(`[scrape-roster] DONE  athletes=${results.length}/${athletes.length}  total=${elapsed(t0)}`);

  return results;
}
