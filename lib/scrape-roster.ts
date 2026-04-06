import Anthropic from '@anthropic-ai/sdk';
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
): Promise<AthleteResult[]> {
  const t0 = Date.now();
  // Normalize so check-roster can match it reliably
  rosterUrl = rosterUrl.trim().replace(/\/+$/, '');
  console.log(`[scrape-roster] START  url=${rosterUrl} session=${sessionId}`);

  // Fetch raw HTML
  const t1 = Date.now();
  const htmlRes = await fetch(rosterUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CaptionGenerator/1.0)' },
  });
  if (!htmlRes.ok) {
    throw new Error(`Failed to fetch roster URL: ${htmlRes.status} ${htmlRes.statusText}`);
  }
  const rosterHtml = await htmlRes.text();
  const strippedHtml = stripHtml(rosterHtml);

  // Nuxt/Vue SSR pages store athlete+photo data in embedded JSON <script> tags, not img attributes.
  // Extract those blocks so Claude can see the structured data with photo URLs intact.
  const jsonScriptBlocks = Array.from(
    rosterHtml.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)
  ).map(m => m[1].trim());
  // Also grab inline Nuxt state (window.__NUXT__ = {...} or similar)
  const nuxtStateBlocks = Array.from(
    rosterHtml.matchAll(/window\.__NUXT(?:_DATA)?__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/gi)
  ).map(m => m[1]);

  const structuredData = [...jsonScriptBlocks, ...nuxtStateBlocks];
  const structuredDataSizes = structuredData.map(b => b.length);
  console.log(`[scrape-roster] HTML fetch done  raw=${rosterHtml.length} chars  stripped=${strippedHtml.length} chars  structured_data_blocks=${structuredData.length}  block_sizes=${structuredDataSizes.join(',')}  time=${elapsed(t1)}`);

  // Call Claude to extract athletes
  const t2 = Date.now();

  // Hard cap on stripped HTML — 60 KB is enough to cover any roster page layout
  const HTML_CAP = 60_000;
  const cappedHtml = strippedHtml.length > HTML_CAP
    ? strippedHtml.slice(0, HTML_CAP) + '\n<!-- [truncated] -->'
    : strippedHtml;

  // Cap total structured data at 60 KB across all blocks combined
  const TOTAL_STRUCTURED_CAP = 60_000;
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
        content: `You are extracting athlete data from a sports team roster page.

Here is the stripped HTML of the roster page (scripts and styles removed):
<html>
${cappedHtml}
</html>
${structuredData.length > 0 ? `
The following is embedded JSON state from the page (Nuxt/Vue SSR devalue format).
It is a flat array where integer values are indices referencing other elements in the array.
The athlete names and their headshot URLs are both stored as plain strings within this array.
Find the section containing player/roster data and extract each athlete's name and headshot URL.
Prefer the smallest imgproxy image variant (rs:fit:480) as the headshot_url.

${structuredDataForPrompt}
` : ''}
Extract all athletes and return a JSON array. For each athlete include:
- name: full name as shown
- jersey_number: jersey number as a string, or null if not shown or not applicable
- headshot_url: the absolute URL to their headshot image found in the structured data above, or null if not found

Return only valid JSON with no commentary. Example:
[
  { "name": "Daria Gusarova", "jersey_number": null, "headshot_url": "https://..." },
  { "name": "Emmy Sharp", "jersey_number": "12", "headshot_url": "https://..." }
]`,
      },
    ],
  });
  console.log(`[scrape-roster] Claude API done  input_tokens=${message.usage.input_tokens} output_tokens=${message.usage.output_tokens} stop_reason=${message.stop_reason}  time=${elapsed(t2)}`);

  // Parse response
  const block = message.content[0];
  if (block.type !== 'text') throw new Error('Unexpected Claude response type');

  // If output was truncated, attempt to salvage the partial JSON by closing the array
  let responseText = block.text.trim();
  if (message.stop_reason === 'max_tokens') {
    console.warn('[scrape-roster] Output truncated at max_tokens — attempting partial parse');
    // Find the last complete object and close the array
    const lastBrace = responseText.lastIndexOf('}');
    if (lastBrace !== -1) responseText = responseText.slice(0, lastBrace + 1) + ']';
  }

  let rawAthletes: Array<{ name: string; jersey_number: string | null; headshot_url: string | null }>;
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');
    rawAthletes = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error('Failed to parse Claude response as JSON');
  }
  console.log(`[scrape-roster] Parsed ${rawAthletes.length} athletes (${rawAthletes.filter(a => a.headshot_url).length} with headshots)`);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log(`[scrape-roster] Supabase env  url=${supabaseUrl ? supabaseUrl.slice(0, 30) + '…' : 'MISSING'}  service_key=${serviceKey ? 'SET' : 'MISSING'}`);
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Supabase env vars not set: check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local');
  }

  const supabase = createServiceClient();
  const results: AthleteResult[] = [];

  // Headshots are downloaded serially — logged per-athlete so you can see which are slow
  const t3 = Date.now();
  for (const [i, raw] of rawAthletes.entries()) {
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
            console.log(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  download=${downloadMs}ms  upload=${uploadMs}ms  size=${imgBuffer.length}B`);
          } else {
            console.warn(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  storage upload error: ${uploadError.message}  download=${downloadMs}ms`);
          }
        } else {
          console.warn(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  headshot fetch ${imgRes.status}  download=${downloadMs}ms`);
        }
      } catch (err) {
        console.warn(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  headshot exception: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      console.log(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  no headshot URL`);
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
      console.error(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  DB insert failed:`, JSON.stringify(dbError));
      continue;
    }

    // Generate signed URL for client display
    let signedUrl: string | null = null;
    if (storagePath) {
      const { data: signed } = await supabase.storage
        .from('rosters')
        .createSignedUrl(storagePath, 3600);
      signedUrl = signed?.signedUrl ?? null;
    }

    console.log(`[scrape-roster] [${i + 1}/${rawAthletes.length}] ${raw.name}  athlete done  time=${elapsed(ta)}`);

    results.push({
      id: athleteId,
      name: raw.name,
      jersey_number: raw.jersey_number ?? null,
      headshot_url: signedUrl,
    });
  }

  console.log(`[scrape-roster] Headshot loop done  time=${elapsed(t3)}`);
  console.log(`[scrape-roster] DONE  athletes=${results.length}  total=${elapsed(t0)}`);

  return results;
}
