# Caption Generator — Knowledge Base

Things that aren't obvious from the code or recoverable from `git log`. The **why** behind decisions, the gotchas that cost a session to figure out, and experiments that didn't work so we don't repeat them.

For setup steps, see `SETUP.md`. For the system spec, see `caption-generator-spec.md`. For tech-stack overview, see `README.md`.

---

## Recognition engines

### Rekognition `FaceMatchThreshold` is hardcoded at 40%

Set in commit `91bab9f`. Higher thresholds (50/60/70) missed athletes wearing helmets, sunglasses, or photographed at sharp angles. 40% catches them while false positives remain manageable because we then display per-athlete confidence in the UI for human review.

**The user-facing "confidence threshold" slider does NOT control this** — it's used for client-side filtering / display logic only. Don't conflate them.

### All detected athletes are matched regardless of confidence

Commit `b27b3d9`. Rekognition returns matches for every face it finds; we keep all of them and surface the per-athlete confidence in the Personality (`dc:title`) field instead of filtering server-side. Reason: a low-confidence "maybe" is more useful to a photographer than a missing name.

### Rekognition cannot read jersey numbers

By design — Rekognition is face-only. The "Has Jersey Numbers" checkbox is hidden when Rekognition is the selected engine. If we ever need jersey numbers in Rekognition mode, options are Textract OCR or a supplemental Claude call (deferred — see Decision Log #17 in spec).

### Headshots with no detectable face are silently skipped

`IndexFaces` drops them. Those athletes will never match in Rekognition mode. If ALL headshots fail to index, the UI shows a banner — otherwise it's silent. Worth checking the Rekognition-mode logs if a specific athlete consistently goes unmatched.

---

## Roster scraping

### Programmatic Stanford scraper, NOT Claude

Commit `b10aaab` added a programmatic scraper for Stanford pages. Commit `1c4a0f0` (merge) explicitly chose to keep it over the earlier inline tiered Claude approach. Reason: faster, cheaper, no API dependency for the scraping step.

Claude is still used for non-Stanford schools as a fallback (and for the photo recognition step in Claude mode).

### Sports with generic photo filenames break headshot URL discovery

Commit `6a81007`. Rowing (and similar) use generic filenames like `IMG_1234.jpg` on the roster page rather than `firstname-lastname.jpg`. The scraper had to be updated to not rely on filename patterns matching the athlete's name. Watch for this with new sports — if rowing-style cameras are used, the headshot-to-athlete mapping may need a sport-specific path.

### JS-rendered roster pages return zero athletes

Sidearm Sports and similar SPAs render rosters client-side. Raw HTML fetch returns minimal markup, scraper returns `[]`. UI shows "no athletes found — try re-scraping" but rescraping won't help. Headless browser support is a v2 item.

### Force-rescrape when headshots are missing from storage

Commit `67aeb82`. If a session reuses a roster but the headshots were cleaned up, rescrape automatically rather than failing silently downstream.

---

## Photo processing

### First photo of a session is slow (~30–60s)

The InsightFace/ArcFace Vercel Python Function cold-starts on the first request. Subsequent photos are fast. Don't read this as a bug; don't add a "pre-warm" hack unless we're seeing it in production usage frequently enough to matter.

### Vercel 300s function timeout was hit during processing

Commit `98f8c33` reduced Claude API timeout/retries and capped structured data size to stay under 300s. If we ever hit this again, the fix isn't to raise the Vercel timeout (Fluid Compute default is already 300s) — it's to keep individual `process` calls fast and rely on the client-orchestrated queue (3 concurrent slots) to handle volume.

### Rekognition collection must be rebuilt on reuse

Commit `2c7c6ee`. The collection state can drift from the DB if rosters are re-scraped. Rule: index AFTER the DB insert succeeds, and rebuild the collection whenever the roster is reused.

---

## Storage & filenames

### UUID-based storage keys, not original filenames

Commits `bd3e293`, `478f149`, `5a4039c`. Special characters in filenames (apostrophes, accents, spaces) broke Supabase Storage uploads with "invalid key". Storage path is `{session_id}/{uuid}.jpg`; the original filename is stored in the DB row.

For the ZIP download, we restore original filenames from the DB (commit `db993ea` — the bug there was returning UUID keys in the ZIP, which was the wrong fix direction).

### Signed URL PUT requires `apikey` header

Commit `1b4d40c`. Storage uploads were 400ing because the signed-URL PUT was missing the `apikey` header. Required by Supabase even though the URL is "signed".

---

## XMP metadata

### `dc:title` is the Personality field (NOT `Iptc4xmpExt:PersonInImage`)

Decision Log #6 in the spec. Confirmed by inspecting real Photo Mechanic output. Don't switch to the IPTC namespace without re-verifying — Photo Mechanic's own behavior is what we're matching.

### `dc:description` updates only if `enter_caption_here` is present

Sentinel-based replacement. If the photographer has already typed a caption, we leave it alone. `dc:title` is always written.

### Pure-JS XMP manipulation, no exiftool

Decision Log #3. Vercel serverless can't reliably run binaries. `@xmldom/xmldom` does the parsing; we manually rebuild the JPEG APP1 segment with padding to handle length changes.

---

## Failed experiments / abandoned approaches

- **Single long-running server loop** for processing — hit Vercel function timeouts. Replaced with client-orchestrated queue (3 concurrent slots).
- **Inline tiered Claude scraping** for Stanford — replaced with programmatic scraper (`1c4a0f0`).
- **Filename parsing as athlete-ID fallback** — abandoned because photographers don't follow naming conventions consistently.
- **Headless browser scraping** — would solve JS-rendered rosters, but adds a heavy dependency. Deferred to v2.
- **`exiftool` subprocess for XMP** — Vercel can't run it reliably.

---

## Open questions / known limitations

- Cold-start latency on the first photo of a session — acceptable for now, but if usage grows, look into keeping the Python function warm.
- Rekognition cost at higher volumes — worth tracking per-job spend once multiple shoots run through it.
- No way for a photographer to manually correct a wrong match before download. They'd have to fix it in Photo Mechanic. v2 candidate.
