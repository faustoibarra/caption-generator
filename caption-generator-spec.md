# Caption Generator — Spec

## Overview

A web app for sports photographers that automates athlete identification in post-edited JPG photos. The app scrapes any college athletics roster URL, uses either the Claude Vision API or AWS Rekognition to match athletes to each uploaded photo, writes the athlete name(s) into two XMP metadata fields embedded in the JPG, and provides a ZIP download of all processed files.

The **recognition engine** is selected per-job at setup. **Claude Vision** handles face matching and jersey number reading in a single API call. **AWS Rekognition** uses a dedicated face-matching service (potentially higher accuracy or lower per-photo cost) but cannot read jersey numbers.

**Target user:** Sports photographers covering college athletics (initially Fausto Ibarra / ISI Photos). v1 is single-user — no login required. Auth and multi-user support are v2.

**v1 scope decision:** No authentication, no session history, no multi-user support. State lives in the browser for the duration of one job. Works for any school with a static or server-rendered roster page (not JS-rendered SPAs).

---

## Tech Stack

- **Framework:** Next.js 14, TypeScript
- **Styling:** Tailwind CSS, shadcn/ui components
- **DB + Storage:** Supabase (no auth for v1)
- **AI:** Anthropic Claude API (`@anthropic-ai/sdk`) — roster scraping (always) + photo recognition (Claude mode)
- **Face recognition (alternative):** AWS Rekognition (`@aws-sdk/client-rekognition`) — face-only matching, selected per-job at setup
- **Image processing:** `sharp` (resize before API calls)
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

Zustand also tracks:
- `recognition_engine: 'claude' | 'rekognition'` — set at job setup, unchanged for the life of the session
- `batch_number` (integer, starts at 1)
- `cumulative_stats` (totals across all completed batches, updated when a batch finishes)
- `current_batch_photo_ids: string[]` — IDs of photos in the active batch, so the processing view can scope its live table

---

## API Routes

### `POST /api/scrape-roster`
Scrapes the roster URL using Claude, downloads headshots to Supabase Storage, inserts `roster_athletes` rows. Body: `{ session_id, roster_url, sport, has_jersey_numbers, recognition_engine }`. Updates zustand state to `roster_ready` on completion (via response).

**If `recognition_engine` is `rekognition`:** after all headshots are stored, creates an AWS Rekognition Collection with `CollectionId = session_id` and calls `IndexFaces` for each successfully downloaded headshot, using the athlete's `id` (UUID) as the `ExternalImageId`. Athletes with no headshot are silently skipped for face indexing.

### `POST /api/rescrape`
Re-runs roster scraping. Deletes existing `roster_athletes` rows for the `session_id`, re-downloads headshots, re-inserts rows. Body: `{ session_id, roster_url, sport, has_jersey_numbers, recognition_engine }`.

**If `recognition_engine` is `rekognition`:** deletes the existing Rekognition Collection for the `session_id` (if present) before recreating and re-indexing.

### `GET /api/status?session_id=...`
Returns aggregate counts for the entire session:
```json
{ "photos_total": 42, "photos_processed": 38, "photos_matched": 30, "photos_unmatched": 8 }
```
Polled by the client every 2 seconds during active processing. Counts cover all batches, not just the current one.

### `POST /api/photos/upload`
Handles photo uploads. Body: multipart form with JPG file + `session_id`. Uploads to `photos-original/{session_id}/{filename}`, inserts `photos` row (status: `queued`), returns `{ photo_id }`.

### `POST /api/photos/[id]/process`
Processes a single photo. Body includes `recognition_engine`. Behavior branches after the common setup steps.

**Common steps (both engines):**
1. Downloads JPG from `photos-original/`
2. Resizes to longest edge 1200px using `sharp`

**Claude mode:**
3. Fetches all `roster_athletes` for the `session_id`
4. Calls Claude Vision API with roster headshot images + event photo (see prompt below)
5. Parses response JSON — produces `face_confidence`, `jersey_confidence`, `match_type`, `position_x` per athlete

**Rekognition mode:**
3. Calls `SearchFacesByImage` against the session's Rekognition Collection using the resized photo buffer
4. Maps each match's `ExternalImageId` back to a `roster_athletes` row to retrieve the athlete name
5. Sets `face_confidence` = Rekognition `Similarity` ÷ 100 (Rekognition uses 0–100); `jersey_confidence` = `null`; `match_type` = `"face"`
6. Orders matched athletes left-to-right by bounding box `Left` value for name string formatting

**Common steps (both engines):**
7. If any athlete's relevant confidence score ≥ confidence threshold:
   - Writes athlete names to `dc:description` (replace `enter_caption_here`) and `dc:title`
   - Uploads modified JPG to `photos-processed/`
   - Updates `photos` row: status `matched`, matched_names, face_confidence, jersey_confidence, match_type
8. If no match:
   - Copies original JPG to `photos-processed/` unchanged
   - Updates `photos` row: status `unmatched`
9. On error: retry once automatically. If second attempt fails, mark status `error` (treated as unmatched for download). Store error message.
10. If XMP APP1 segment is absent or malformed: mark status `skipped`, copy original unchanged, flag in results.

### `GET /api/download?session_id=...`
Streams a ZIP of all files in `photos-processed/{session_id}/` using `jszip`. On successful ZIP generation, **deletes all storage files and DB rows** for the session_id (cleanup). If `recognition_engine` is `rekognition`, also calls `DeleteCollection` for the session's Rekognition Collection. Returns ZIP with `Content-Disposition: attachment; filename="{job_name}.zip"`.

---

## Claude Vision API — Roster Scraping Prompt (both modes)

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

## AWS Rekognition — Face Matching (Rekognition mode)

### Collection lifecycle

| Event | Action |
|-------|--------|
| Roster scraped | `CreateCollection(CollectionId=session_id)` |
| Each headshot indexed | `IndexFaces(CollectionId=session_id, ExternalImageId=athlete_id)` |
| Re-scrape | `DeleteCollection` → recreate → re-index |
| Session cleanup (on download) | `DeleteCollection(CollectionId=session_id)` |

### Per-photo matching

```typescript
const result = await rekognition.searchFacesByImage({
  CollectionId: session_id,
  Image: { Bytes: resizedJpgBuffer },
  FaceMatchThreshold: confidenceThreshold * 100, // Rekognition uses 0–100
  MaxFaces: 10,
});
```

Each entry in `result.FaceMatches` provides:
- `Face.ExternalImageId` — the `roster_athletes.id` UUID used to look up the athlete name
- `Similarity` — 0–100; stored as `face_confidence` (divided by 100)
- `Face.BoundingBox.Left` — used to sort matched athletes left-to-right for the name string

### Limitations vs. Claude mode

- **No jersey number matching.** `jersey_confidence` is always `null`; `match_type` is always `"face"`. The `Has Jersey Numbers` checkbox is hidden in the UI when Rekognition is selected.
- **Headshots with no detectable face** are silently skipped during `IndexFaces`; those athletes cannot be matched in this mode.
- **Multiple athletes per photo** are returned naturally — one `FaceMatch` entry per detected face.
- **AWS credentials required:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` must be set as environment variables.

---

## Claude Vision API — Photo Processing Prompt (Claude mode)

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
- Fields:
  - School Name (text)
  - Sport (text)
  - Roster URL (text)
  - **Recognition Engine** — radio or select: `Claude Vision` (default) | `AWS Rekognition`
  - Has Jersey Numbers (checkbox) — **hidden when Rekognition is selected** (jersey matching unavailable)
  - Confidence Threshold (number, default 0.80)
- "Start →" button submits and triggers roster scraping
- On submit: generate `session_id` UUID, store `recognition_engine` in zustand, call `POST /api/scrape-roster`, transition to `scraping`

### Scraping (state: `scraping`)

- Loading spinner
- "Scraping roster..." message (Claude mode) / "Scraping roster and indexing faces..." message (Rekognition mode)
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
- `Face + Jersey` — green (Claude mode only)
- `Face` — blue
- `Jersey` — amber (Claude mode only)
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
| Individual headshot download fails | Athlete added to roster with placeholder; face matching skipped (both modes), jersey matching still possible (Claude mode only) |
| Claude API call fails on photo | Retry once automatically; if still failing, mark photo `error` (treated as unmatched) |
| Rekognition `CreateCollection` fails during scraping | Transition to `error` state with "Retry" button |
| Rekognition `IndexFaces` fails for a headshot | Log and skip; athlete will not be matchable via face in this session |
| All headshots fail `IndexFaces` (no faces detected in any headshot) | Warn user at `roster_ready` with a banner: "No faces were indexed — recognition will return no matches" |
| Rekognition `SearchFacesByImage` fails on a photo | Retry once automatically; if still failing, mark photo `error` (treated as unmatched) |
| XMP segment missing or malformed in JPG | Mark photo `skipped`, copy original unchanged, flag in results |
| `enter_caption_here` not found in `dc:description` | Skip `dc:description` update; still update `dc:title` |
| Photo upload fails | Show per-file error in upload zone; allow retry |
| Download/cleanup fails | Show error with retry button; do not delete files or Rekognition Collection if ZIP generation failed |

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
| 1 | Recognition engine selectable per-job: Claude Vision (default) or AWS Rekognition | Hardcoding one engine; Azure Face API | Claude Vision handles face + jersey in a single call; Rekognition is a dedicated face-matching service that may offer higher accuracy or lower per-photo cost but cannot read jersey numbers — user picks based on sport and accuracy needs |
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
| 17 | No jersey matching in Rekognition mode | Textract OCR or supplemental Claude call for jersey numbers | Adds a third service dependency and extra latency for a feature not needed in all sports; deferrable to v2 or a per-sport toggle |
