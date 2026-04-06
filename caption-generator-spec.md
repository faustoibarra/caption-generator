# Caption Generator — Spec

## Overview

A web app for sports photographers that automates athlete identification in post-edited JPG photos. The app scrapes any college athletics roster URL, uses the Claude Vision API to match athlete faces and jersey numbers to each uploaded photo, writes the athlete name(s) into two XMP metadata fields embedded in the JPG, and provides a ZIP download of all processed files.

**Target user:** Sports photographers covering college athletics (initially Fausto Ibarra / ISI Photos). v1 is single-user — no login required. Auth and multi-user support are v2.

**v1 scope decision:** No authentication, no session history, no multi-user support. State lives in the browser for the duration of one job. Works for any school with a static or server-rendered roster page (not JS-rendered SPAs).

---

## Tech Stack

- **Framework:** Next.js 14, TypeScript
- **Styling:** Tailwind CSS, shadcn/ui components
- **DB + Storage:** Supabase (no auth for v1)
- **AI:** Anthropic Claude API (`@anthropic-ai/sdk`)
- **Image processing:** `sharp` (resize before Claude API calls)
- **XMP manipulation:** `@xmldom/xmldom` (pure JS, no exiftool)
- **File upload UI:** `react-dropzone`
- **State management:** `zustand`
- **ZIP download:** `jszip`
- **Deployment:** Vercel (personal account, private URL for v1)

---

## Pages & Routes

| Route | Description |
|-------|-------------|
| `/` | Single-page app — all job states render here based on zustand state |

No auth pages. No sessions list. No per-session routes. All UI is one page that transitions through job states.

---

## Database Schema

### `roster_athletes`

```sql
create table roster_athletes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null,    -- client-generated UUID, not a FK to any table
  name         text not null,
  jersey_number text,            -- null for sports without jersey numbers
  headshot_url text,             -- Supabase Storage path; null if download failed
  created_at   timestamptz default now()
);

create index roster_athletes_session_id_idx on roster_athletes(session_id);
```

### `photos`

```sql
create table photos (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null,
  filename         text not null,
  storage_path     text not null,         -- photos-original/{session_id}/{filename}
  processed_path   text,                  -- photos-processed/{session_id}/{filename}
  status           text not null default 'queued',
  -- status: queued | processing | matched | unmatched | skipped | error
  matched_names    text[],                -- e.g. ["Daria Gusarova", "Emmy Sharp"]
  face_confidence  float,
  jersey_confidence float,
  match_type       text,                  -- face | jersey | both | null
  error_message    text,
  created_at       timestamptz default now()
);

create index photos_session_id_idx on photos(session_id);
create index photos_status_idx     on photos(status);
```

**No sessions table. No RLS. No user_id columns.**

`session_id` is a UUID generated client-side at job start and stored in zustand. It namespaces all DB rows and storage paths for a job. Cleanup (deleting rows + storage files) runs after successful ZIP download.

---

## Supabase Storage Buckets

| Bucket | Contents |
|--------|----------|
| `rosters` | Athlete headshots: `rosters/{session_id}/{athlete_id}.jpg` |
| `photos-original` | Uploaded JPGs: `photos-original/{session_id}/{filename}` |
| `photos-processed` | XMP-updated JPGs: `photos-processed/{session_id}/{filename}` |

All buckets are private. Access is via the Supabase service-role key in API routes only (never exposed to the client).

---

## Sport Field

Sport is a free-text input field (e.g. "Field Hockey", "Water Polo", "Gymnastics"). No hardcoded sports list. The user types the sport name; the Claude Vision prompt uses it to provide context for jersey number relevance.

The user also indicates whether jersey numbers are relevant for their sport via a checkbox.

---

## Job State

State lives in zustand on the client. No sessions table. The job state machine:

```
setup → scraping → roster_ready → uploading → processing ⇄ uploading (loop for additional batches)
                                                          ↘ complete
                                                          ↘ error
```

The single page at `/` renders different UI based on the current zustand job state:
- `setup` — **Job Setup** form
- `scraping` — loading state, scraping in progress
- `roster_ready` — **Roster Confirmation** step
- `uploading` — **Photo Upload** step (used for every batch, including the first)
- `processing` — **Processing Progress** step
- `complete` — **Results** step

The `session_id` UUID is generated when the user submits the setup form and stored in zustand for the duration of the job. It remains the same across all batches — all photos for a job share one `session_id`.

Zustand also tracks `batch_number` (integer, starts at 1) and `cumulative_stats` (totals across all completed batches, updated when a batch finishes). The current batch's IDs are tracked in `current_batch_photo_ids: string[]` so the processing view can scope its live table to just the active batch.

---

## API Routes

### `POST /api/scrape-roster`
Scrapes the roster URL using Claude, downloads headshots to Supabase Storage, inserts `roster_athletes` rows. Body: `{ session_id, roster_url, sport, has_jersey_numbers }`. Updates zustand state to `roster_ready` on completion (via response).

### `POST /api/rescrape`
Re-runs roster scraping. Deletes existing `roster_athletes` rows for the `session_id`, re-downloads headshots, re-inserts rows. Body: `{ session_id, roster_url, sport, has_jersey_numbers }`.

### `GET /api/status?session_id=...`
Returns aggregate counts for the entire session:
```json
{ "photos_total": 42, "photos_processed": 38, "photos_matched": 30, "photos_unmatched": 8 }
```
Polled by the client every 2 seconds during active processing. Counts cover all batches, not just the current one.

### `POST /api/photos/upload`
Handles photo uploads. Body: multipart form with JPG file + `session_id`. Uploads to `photos-original/{session_id}/{filename}`, inserts `photos` row (status: `queued`), returns `{ photo_id }`.

### `POST /api/photos/[id]/process`
Processes a single photo:
1. Downloads JPG from `photos-original/`
2. Resizes to longest edge 1200px using `sharp`
3. Fetches all `roster_athletes` for the `session_id`
4. Calls Claude Vision API (see prompt below)
5. Parses response JSON
6. If any athlete has `face_confidence` OR `jersey_confidence` ≥ confidence threshold:
   - Writes athlete names to `dc:description` (replace `enter_caption_here`) and `dc:title`
   - Uploads modified JPG to `photos-processed/`
   - Updates `photos` row: status `matched`, matched_names, face_confidence, jersey_confidence, match_type
7. If no match:
   - Copies original JPG to `photos-processed/` unchanged
   - Updates `photos` row: status `unmatched`
8. On error: retry once automatically. If second attempt fails, mark status `error` (treated as unmatched for download). Store error message.
9. If XMP APP1 segment is absent or malformed: mark status `skipped`, copy original unchanged, flag in results.

### `GET /api/download?session_id=...`
Streams a ZIP of all files in `photos-processed/{session_id}/` using `jszip`. On successful ZIP generation, **deletes all storage files and DB rows** for the session_id (cleanup). Returns ZIP with `Content-Disposition: attachment; filename="{job_name}.zip"`.

---

## Claude Vision API — Roster Scraping Prompt

```
You are extracting athlete data from a sports team roster page.

Here is the HTML of the roster page:
<html>
{roster_html}
</html>

Extract all athletes and return a JSON array. For each athlete include:
- name: full name as shown
- jersey_number: jersey number as a string, or null if not shown or not applicable
- headshot_url: the absolute URL to their headshot image, or null if not found

Return only valid JSON. Example:
[
  { "name": "Daria Gusarova", "jersey_number": null, "headshot_url": "https://..." },
  { "name": "Emmy Sharp", "jersey_number": "12", "headshot_url": "https://..." }
]
```

**Note:** v1 fetches raw HTML only. JS-rendered roster pages (e.g. Sidearm Sports platform) will return minimal HTML and Claude will return an empty array. The app shows a "no athletes found — try re-scraping" error in that case. Headless browser support is deferred to v2.

---

## Claude Vision API — Photo Processing Prompt

```
You are identifying college athletes in a sports photograph.

The sport is: {sport_name}
Jersey numbers are relevant for this sport: {has_jersey_numbers}

Below are the roster headshots for all athletes on the team.
Each image is labeled with the athlete's name and jersey number (if applicable).

[roster headshot images, each labeled]

Now analyze this event photo:

[event photo]

Identify all athletes visible in the photo. For each athlete:
1. Try to match their face to a roster headshot
2. If jersey numbers are relevant, try to read the jersey number and match it to the roster
3. Note their horizontal position in the frame (for left-to-right ordering)

Return JSON only, in this exact format:
{
  "athletes": [
    {
      "name": "Athlete Name",
      "face_confidence": 0.92,        // 0-1, or null if face not visible/matchable
      "jersey_confidence": 0.88,      // 0-1, or null if jersey not visible or not relevant
      "match_type": "both",           // "face", "jersey", or "both"
      "position_x": 0.3              // approximate horizontal position 0=left, 1=right
    }
  ]
}

Only include athletes you can match to the roster with reasonable confidence.
Do not include opponent athletes.
If no athletes can be identified, return: { "athletes": [] }
```

---

## Client-Orchestrated Processing

The browser manages the processing queue with 3 concurrent slots:

```typescript
const PROCESSING_CONCURRENCY = 3; // change to 5 or higher as needed
```

**Logic:**
1. On "Start Processing", snapshot the IDs of all currently `queued` photos for the session and store them in `current_batch_photo_ids` in zustand. Transition to `processing`.
2. Maintain a queue of those pending IDs and a count of in-flight requests.
3. While `in_flight < PROCESSING_CONCURRENCY` and queue is not empty: dequeue next ID, call `POST /api/photos/[id]/process`, decrement in-flight on completion.
4. Poll `GET /api/status?session_id=...` every 2 seconds to update the summary bar.
5. When all IDs in `current_batch_photo_ids` are in a terminal state (`matched`, `unmatched`, `error`, `skipped`), the batch is complete:
   - Stop polling.
   - Update `cumulative_stats` in zustand with the session-wide totals from the final status poll.
   - Show the **Batch Complete** action bar (see UI section below) — do **not** auto-transition to `complete`.
6. If the user chooses **"Upload More Photos"**: clear `current_batch_photo_ids`, increment `batch_number`, transition to `uploading`.
7. If the user chooses **"Finish & Download"**: transition to `complete`.

---

## XMP Metadata Writing

The XMP block is a JPEG APP1 segment identified by the namespace `http://ns.adobe.com/xap/1.0/\0`.

**Algorithm:**
1. Scan JPG buffer for the XMP APP1 marker
2. Extract existing XMP XML string
3. Parse with `@xmldom/xmldom`
4. Update `dc:description`: find the `rdf:li` under `dc:description/rdf:Alt` and replace `enter_caption_here` with the athlete name string. If `enter_caption_here` is not present, leave `dc:description` unchanged.
5. Update `dc:title`: find or create `dc:title/rdf:Alt/rdf:li[@xml:lang="x-default"]` and set its text content to the athlete name string.
6. Serialize back to XML string
7. Rebuild JPG buffer with updated XMP segment (pad with spaces to maintain original segment length; resize segment if new XML is longer)

**Athlete name string format:**
```
"Athlete A"               // single athlete
"Athlete A, Athlete B"    // multiple athletes, left-to-right by position_x, comma + space
```

**Implemented in:** `lib/xmp-writer.ts` — `writeAthleteNames(jpgBuffer: Buffer, names: string[]): Promise<Buffer>`

---

## Page — UI States

### Job Setup (state: `setup`)

- Heading: "Caption Generator"
- Fields: School Name (text), Sport (text), Roster URL (text), Has Jersey Numbers (checkbox), Confidence Threshold (number, default 0.80)
- "Start →" button submits and triggers roster scraping
- On submit: generate `session_id` UUID, store in zustand, call `POST /api/scrape-roster`, transition to `scraping`

### Scraping (state: `scraping`)

- Loading spinner
- "Scraping roster..." message
- Cancel button resets to `setup`

### Roster Confirmation (state: `roster_ready`)

- Heading: "Confirm Roster — {school} {sport}"
- Grid of athlete cards: headshot image + name + jersey number (if applicable)
- Missing headshot: show placeholder avatar
- Athlete count badge
- Two buttons: **"Re-scrape"** | **"Looks good, continue →"**

### Photo Upload (state: `uploading`)

- Drag-and-drop zone (react-dropzone), JPG only
- Per-file upload progress
- File count badge (count of photos in the current batch only)
- If `batch_number > 1`: show a cumulative stats bar above the drop zone — "Job total so far: N processed · N matched · N unmatched" — so the user knows what's already been handled.
- **"Start Processing"** button — active once at least one photo is uploaded in the current batch

### Processing Progress (state: `processing`)

**While batch is in progress:**

Summary bar at top (scoped to current batch):
- Batch N · Total | Matched | Unmatched | In Progress

Photo list (updates live via polling, shows only current batch photos):

| Thumbnail | Filename | Status | Athlete(s) | Match Type | Confidence |
|-----------|----------|--------|------------|------------|------------|
| 120×80px | `_FMI1234.JPG` | ✅ Matched | Daria Gusarova | Face + Jersey | 94% |
| 120×80px | `_FMI1235.JPG` | ⚠️ Unmatched | — | — | — |
| 120×80px | `_FMI1236.JPG` | ⏳ Processing | — | — | — |

Match type badges:
- `Face + Jersey` — green
- `Face` — blue
- `Jersey` — amber
- `Unmatched` — gray

**When the batch finishes (Batch Complete action bar):**

Replace the "In Progress" count in the summary bar with the final batch result. Below the photo list, show a sticky action bar:

```
Batch N complete — N matched, N unmatched
[ Upload More Photos ]   [ Finish & Download ZIP ]
```

- **"Upload More Photos"** — transitions to `uploading` for the next batch (same `session_id`)
- **"Finish & Download ZIP"** — transitions to `complete`

If `batch_number > 1`, the summary bar also shows a secondary line: "Job total: N matched, N unmatched across N batches" (from `cumulative_stats`).

### Results (state: `complete`)

Summary card (totals across all batches for the session):
- Total photos processed
- Matched (N / N%)
- Unmatched (N / N%)
- Average confidence (matched photos only)
- Number of batches processed (shown only if > 1)

Full photo list (same table as above, all rows final, all batches combined).

Unmatched photos section: list of filenames that need manual entry in Photo Mechanic.

**"Download All"** button — calls `GET /api/download?session_id=...`, which ZIPs all files in `photos-processed/{session_id}/` (every batch). Disabled while ZIP is generating. After successful download, storage and DB rows for the session are deleted automatically.

**"New Job"** button — resets zustand state to `setup` (generates a new session_id on next submit).

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Roster scraping fails (site down, unexpected layout) | Transition to `error` state with "Retry" button that re-runs scraping |
| Roster page is JS-rendered (empty HTML returned) | Show "No athletes found" error with "Try re-scraping" option |
| Individual headshot download fails | Athlete added to roster with placeholder; face matching skipped, jersey matching still possible |
| Claude API call fails on photo | Retry once automatically; if still failing, mark photo `error` (treated as unmatched) |
| XMP segment missing or malformed in JPG | Mark photo `skipped`, copy original unchanged, flag in results |
| `enter_caption_here` not found in `dc:description` | Skip `dc:description` update; still update `dc:title` |
| Photo upload fails | Show per-file error in upload zone; allow retry |
| Download/cleanup fails | Show error with retry button; do not delete files if ZIP generation failed |

---

## Automated Test

**File:** `__tests__/xmp-writer.test.ts`

Tests the XMP manipulation module in isolation using real fixture JPGs:
- `__tests__/fixtures/template.jpg` — JPG with `enter_caption_here` in `dc:description`
- `__tests__/fixtures/no-placeholder.jpg` — JPG with a real name already in `dc:description`

```typescript
import { writeAthleteNames } from '@/lib/xmp-writer';
import fs from 'fs';

describe('xmp-writer', () => {
  it('replaces enter_caption_here in dc:description', async () => { ... });
  it('sets dc:title to athlete name', async () => { ... });
  it('formats multiple athletes left-to-right with comma and space', async () => { ... });
  it('leaves dc:description unchanged if enter_caption_here is absent', async () => { ... });
});
```

All 4 tests pass. ✓

---

## Non-Goals (v1)

- Authentication / login (v2)
- Multi-user support (v2)
- Session history / past jobs list (v2)
- In-app caption editing / photo browsing (v2)
- JS-rendered roster pages / headless browser scraping (v2)
- Direct integration with Photo Mechanic or Lightroom
- Mobile-optimized UI

---

## Decision Log

| # | Decision | Alternatives considered | Reason |
|---|----------|------------------------|--------|
| 1 | Claude Vision API for face + jersey recognition | AWS Rekognition, Azure Face API | Already in stack; handles jersey reading in same call; no additional service |
| 2 | Claude API for roster scraping | Sport-specific CSS scrapers | Roster pages differ by school and sport; Claude handles structural variation |
| 3 | Pure JS XMP manipulation (`@xmldom/xmldom`) | `exiftool` subprocess | Vercel serverless can't reliably run binaries |
| 4 | Client-orchestrated processing (3 concurrent calls) | Single long-running server loop | Avoids Vercel timeout; natural per-photo progress updates |
| 5 | Concurrency of 3 (configurable constant) | Fully parallel | Keeps Claude API costs predictable; easy to raise later |
| 6 | `dc:title` as Personality field | `Iptc4xmpExt:PersonInImage` | Confirmed from real output JPG — Photo Mechanic writes to `dc:title` |
| 7 | Face OR jersey match (either sufficient) | Face required, jersey as confirmation only | Jersey alone is reliable when clearly visible |
| 8 | Roster confirmation page before upload | Scrape silently, surface errors only on failure | Lets user verify data quality before committing to a full processing run |
| 9 | Supabase Storage for file handling | Local disk, Vercel Blob | Avoids Vercel payload limits; consistent with future multi-user path |
| 10 | `jszip` for download | Streaming individual files | Single ZIP is simpler UX |
| 11 | No auth for v1 | Auth from day one | Weeks of preamble before testing the core bet (matching accuracy). Add in v2. |
| 12 | No sessions table | Sessions table with status | Job state lives in zustand; no server-side session lifecycle needed for single-user |
| 13 | Free-text sport field | Hardcoded SPORTS constant | Makes the app school-agnostic at zero cost; works for any sport |
| 14 | Cleanup on download | Keep files indefinitely | Storage is free at this scale; cleanup keeps things tidy without a cron job |
| 15 | Raw HTML fetch for roster scraping | Headless browser (Puppeteer) | Covers the majority of schools; JS-rendered pages are v2 |
| 16 | Batch upload loop (uploading ⇄ processing, explicit "Finish" to download) | Single upload-then-download flow | Lets the photographer process photos in card-by-card bursts during a game without waiting for a full shoot to finish; same `session_id` keeps all batches in one ZIP |
