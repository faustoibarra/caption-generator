# Caption Generator — Session Prompts

One prompt per Claude Code session. Paste the prompt at the start of each session.

**Stages 1 and 5 are already complete.**

---

## Stage 1 — Scaffold + Database ✓ DONE

Next.js 14, TypeScript, Tailwind CSS, shadcn/ui scaffolded. Supabase running on ports
54331–54337 (shifted to avoid conflict with photo-curator). Two tables (`roster_athletes`,
`photos`) and three storage buckets (`rosters`, `photos-original`, `photos-processed`)
created via migrations. No sessions table, no RLS, no user_id columns.

---

## Stage 2 — Single-Page UI Shell + Zustand Store

```
Read caption-generator-spec.md before writing any code.

The Next.js 14 scaffold and Supabase schema are already in place. There is no auth
and no sessions list. Everything runs on a single page at `/`.

Implement the zustand job store and the full page shell:

1. lib/store.ts — zustand store with this shape:
   - state: 'setup' | 'scraping' | 'roster_ready' | 'uploading' | 'processing' | 'complete' | 'error'
   - sessionId: string | null  (UUID, generated on setup submit)
   - jobName: string            (e.g. "Stanford Field Hockey 2025-03-15")
   - rosterUrl: string
   - sport: string
   - hasJerseyNumbers: boolean
   - confidenceThreshold: number (default 0.8)
   - errorMessage: string | null
   - batchNumber: number (starts at 1, increments each time the user uploads a new batch)
   - currentBatchPhotoIds: string[]  (IDs of photos in the active batch; set when
     processing starts, cleared when "Upload More" is chosen)
   - cumulativeStats: { total: number; matched: number; unmatched: number } | null
     (updated from the final status poll when a batch finishes; null until first batch done)
   - Actions: setSetup, startScraping, setRosterReady, setUploading, setProcessing,
     setComplete, setError, reset,
     setCurrentBatchPhotoIds(ids: string[]),
     finishBatch(stats: { total: number; matched: number; unmatched: number }),
       // saves stats to cumulativeStats; does NOT change state — UI shows action bar
     startNextBatch(),
       // clears currentBatchPhotoIds, increments batchNumber, sets state to 'uploading'
     finishJob()
       // sets state to 'complete'

2. app/page.tsx — single-page shell that renders a different component based on
   store state:
   - setup        → <SetupForm />
   - scraping     → <ScrapingState />
   - roster_ready → <RosterConfirmation />
   - uploading    → <PhotoUpload />
   - processing   → <ProcessingProgress />
   - complete     → <Results />
   - error        → <ErrorState />

3. Implement each component as a stub with correct heading and placeholder content
   (no real logic yet — that comes in later stages). Each stub should show the state
   name so it's easy to verify transitions work.

4. SetupForm — this one should be fully functional:
   - Fields: Job Name (text), School Name (text), Sport (text), Roster URL (text),
     Has Jersey Numbers (checkbox, default unchecked), Confidence Threshold
     (number input, default 0.80, step 0.05, min 0.5, max 1.0)
   - "Start →" button: generates a crypto.randomUUID() for sessionId, saves all
     fields to the zustand store, transitions to 'scraping' state, and calls
     POST /api/scrape-roster (stubbed for now — just return { ok: true })
   - Basic validation: all text fields required, roster URL must start with http

5. Create app/api/scrape-roster/route.ts as a stub that returns
   { ok: true, athletes: [] } so the SetupForm can complete its flow.
   Transitioning to roster_ready after the stub response is fine for now.

Use shadcn/ui components (Button, Input, Label, Checkbox, Card) for the SetupForm.
The other stubs can use plain HTML/Tailwind.
```

---

## Stage 3 — Roster Scraping + Confirmation

```
Read caption-generator-spec.md before writing any code.

The zustand store and single-page shell are in place. The SetupForm is functional.
Implement real roster scraping and the RosterConfirmation UI.

1. app/api/scrape-roster/route.ts (replace the stub):
   - Body: { session_id, roster_url, sport, has_jersey_numbers }
   - Fetch the roster_url HTML using fetch()
   - Call Claude API (claude-sonnet-4-6) with the roster scraping prompt from the spec
   - For each athlete in the response:
     * If headshot_url is present: download the image, upload to
       rosters/{session_id}/{athlete_id}.jpg in Supabase Storage
     * If headshot download fails: insert the athlete row with headshot_url = null
       (do not fail the whole scrape)
     * Insert a roster_athletes row
   - Return { ok: true, athletes: [{ id, name, jersey_number, headshot_url }] }
   - On fatal failure: return { ok: false, error: "..." }
   - Use the Anthropic SDK (@anthropic-ai/sdk), not fetch
   - Use the Supabase service-role client for storage uploads

2. app/api/rescrape/route.ts:
   - Body: { session_id, roster_url, sport, has_jersey_numbers }
   - Delete all roster_athletes rows for session_id
   - Delete all files in rosters/{session_id}/ from Supabase Storage
   - Re-run the same scraping logic as scrape-roster
   - Return same shape as scrape-roster

3. lib/store.ts — update:
   - Add athletes: Athlete[] to the store (populated after scraping)
   - Add setAthletes action
   - In the scraping flow: on success, call setAthletes and transition to roster_ready;
     on failure, transition to error with the error message

4. components/RosterConfirmation.tsx (replace stub):
   - Heading: "Confirm Roster — {school} {sport}"
   - Athlete count: "{N} athletes found"
   - Grid of athlete cards: headshot image (from Supabase Storage signed URL) + name
     + jersey number if has_jersey_numbers is true
   - Missing headshot: gray placeholder avatar
   - Two buttons:
     * "Re-scrape" → calls POST /api/rescrape, transitions back to scraping state
     * "Looks good, continue →" → transitions store to uploading state
   - If athletes array is empty: show a warning banner "No athletes found.
     This may be a JS-rendered page. Try re-scraping or check the URL."

Use the Supabase service-role client to generate signed URLs for headshot display.
Use the exact Claude prompt from the spec.
```

---

## Stage 4 — Photo Upload

```
Read caption-generator-spec.md before writing any code.

Roster confirmation is working. Implement photo upload.

1. app/api/photos/upload/route.ts:
   - Accept multipart form: file (JPG) + session_id
   - Validate Content-Type is image/jpeg
   - Upload file to photos-original/{session_id}/{filename} in Supabase Storage
   - Insert a photos row: { session_id, filename, storage_path, status: 'queued' }
   - Return { photo_id }
   - Use the Supabase service-role client

2. components/PhotoUpload.tsx (replace stub):
   - react-dropzone drop zone, JPG files only (accept: { 'image/jpeg': ['.jpg', '.JPG'] })
   - Multiple files allowed; upload each file immediately on drop (not batched)
   - Per-file progress: track upload progress with fetch + ReadableStream or
     XMLHttpRequest — not just a spinner
   - Show each file with: filename, progress bar, and ✓ / ✗ status icon on completion
   - File count badge: "{N} photos uploaded" (count for the current batch only)
   - If store.batchNumber > 1: show a cumulative stats bar above the drop zone —
     "Job total so far: N processed · N matched · N unmatched" — read from
     store.cumulativeStats
   - Show per-file errors inline; allow the user to retry individual files
   - "Start Processing" button:
     * Disabled until at least 1 file has uploaded successfully in this batch
     * On click:
       - Call store.setCurrentBatchPhotoIds([...ids of successfully uploaded photos])
       - Transition store to 'processing' state
       - Call POST /api/photos/start-processing (stub for now)

3. lib/store.ts — update:
   - Add uploadedPhotoIds: string[] to the store (tracks IDs uploaded in the current batch)
   - Add addUploadedPhoto(id: string) action
   - Reset uploadedPhotoIds to [] inside startNextBatch() so the drop zone is clean
     for each batch

4. app/api/photos/start-processing/route.ts — stub returning { ok: true }

Use zustand for upload queue state. Use shadcn/ui components where appropriate.
```

---

## Stage 5 — XMP Writer + Unit Tests ✓ DONE

`lib/xmp-writer.ts` implemented using `@xmldom/xmldom`. Exports
`writeAthleteNames(jpgBuffer: Buffer, names: string[]): Promise<Buffer>`.
All 4 tests in `__tests__/xmp-writer.test.ts` pass using real fixture JPGs.

---

## Stage 6 — Photo Processing

```
Read caption-generator-spec.md before writing any code.

Photo upload is working. lib/xmp-writer.ts is complete and tested.
Implement the processing API route and the live processing UI.

1. app/api/photos/[id]/process/route.ts:
   - POST only
   - Look up the photos row by id to get session_id, storage_path, session metadata
   - Fetch the session's confidence_threshold and has_jersey_numbers from the zustand
     store — these are not in the DB, so pass them in the request body:
     { confidence_threshold, has_jersey_numbers, sport }
   - Download the JPG from photos-original/ in Supabase Storage
   - Resize to longest edge 1200px using sharp
   - Fetch all roster_athletes for session_id (id, name, jersey_number, headshot_url)
   - For each athlete with a headshot_url: download the headshot from Supabase Storage
   - Build the Claude Vision prompt from the spec:
     * Include all roster headshots as labeled image blocks (name + jersey if applicable)
     * Then include the resized event photo
   - Call claude-sonnet-4-6 with vision
   - Parse response JSON — extract athletes array
   - Filter to athletes where face_confidence OR jersey_confidence >= confidence_threshold
   - If any matches:
     * Sort matched athletes by position_x ascending (left to right)
     * Call writeAthleteNames(jpgBuffer, matchedNames) from lib/xmp-writer.ts
     * Upload modified JPG to photos-processed/{session_id}/{filename}
     * Update photos row: status='matched', matched_names, face_confidence,
       jersey_confidence (highest values from matched athletes), match_type
   - If no matches:
     * Copy original JPG to photos-processed/{session_id}/{filename}
     * Update photos row: status='unmatched'
   - On Claude API error: retry once. If second attempt fails, mark status='error',
     store error_message, copy original to photos-processed/
   - If XMP segment missing: mark status='skipped', copy original unchanged
   - Return { status, matched_names, face_confidence, jersey_confidence, match_type }

2. app/api/photos/start-processing/route.ts — keep as { ok: true } stub; the
   client drives all processing directly.

3. components/ProcessingProgress.tsx (replace stub):
   Client-orchestrated queue with PROCESSING_CONCURRENCY = 3:
   - On mount: read store.currentBatchPhotoIds — this is the list of photo IDs to
     process for this batch (set by PhotoUpload before transitioning to 'processing').
     Do NOT fetch the full list from the API; only process the IDs in the current batch.
   - Maintain a local queue (initialised from currentBatchPhotoIds) and an in-flight
     count in component state (not zustand)
   - While in_flight < 3 and queue not empty: dequeue next ID, call
     POST /api/photos/{id}/process with { confidence_threshold, has_jersey_numbers, sport }
     from the zustand store, decrement in-flight on completion
   - Poll GET /api/status?session_id=... every 2s for summary counts (session-wide totals)
   - Track batch completion locally: when every ID in currentBatchPhotoIds is in a
     terminal state (matched | unmatched | error | skipped), the batch is done:
     * Stop polling
     * Call store.finishBatch({ total, matched, unmatched }) with the counts from the
       final status poll
     * Do NOT transition state — show the Batch Complete action bar instead

   UI while processing:
   - Summary bar (scoped to current batch): "Batch {N} · Total | Matched | Unmatched | In Progress"
   - If store.batchNumber > 1: secondary line showing session totals from
     store.cumulativeStats — "Job total: N matched, N unmatched across N batches"
   - Table per the spec: thumbnail (120×80 signed URL), filename, status badge,
     athlete name(s), match type badge (green/blue/amber/gray), confidence %
   - Show only the current batch's photos in the table
   - Rows update live as photos complete

   UI when batch is complete (Batch Complete action bar, sticky below the table):
   - "Batch {N} complete — N matched, N unmatched"
   - Two buttons side by side:
     * "Upload More Photos" → calls store.startNextBatch() (clears currentBatchPhotoIds,
       increments batchNumber, transitions to 'uploading')
     * "Finish & Download ZIP" → calls store.finishJob() (transitions to 'complete')

4. app/api/status/route.ts — GET ?session_id=...:
   Query the photos table for the session_id and return:
   { photos_total, photos_processed, photos_matched, photos_unmatched, photo_ids }
   (photo_ids is the full list of all photo IDs for the session across all batches —
   kept for debugging; the processing queue uses store.currentBatchPhotoIds instead)

Use the Supabase service-role client for all storage operations in API routes.
Use the exact Claude Vision prompt from the spec.
```

---

## Stage 7 — Results + Download + Cleanup

```
Read caption-generator-spec.md before writing any code.

Processing is complete. Implement the results view and download.

1. app/api/download/route.ts — GET ?session_id=...&job_name=...:
   - Fetch all files in photos-processed/{session_id}/ from Supabase Storage
   - Download each file and add to a jszip archive
   - Stream the ZIP as the response:
     Content-Type: application/zip
     Content-Disposition: attachment; filename="{job_name}.zip"
   - On successful ZIP generation, run cleanup:
     * Delete all files in rosters/{session_id}/, photos-original/{session_id}/,
       and photos-processed/{session_id}/ from Supabase Storage
     * Delete all roster_athletes rows where session_id = ...
     * Delete all photos rows where session_id = ...
   - If ZIP generation fails: return 500, do NOT run cleanup
   - Use the Supabase service-role client

2. components/Results.tsx (replace stub):
   Summary card (shadcn/ui Card) — aggregates all batches for the session:
   - Total photos processed
   - Matched: N (N%)
   - Unmatched: N (N%)
   - Average confidence across matched photos only (format as NN%)
   - If store.batchNumber > 1: "Processed in {N} batches"

   Full photo table (same columns as ProcessingProgress — all rows final, no polling):
   | Thumbnail | Filename | Status | Athlete(s) | Match Type | Confidence |

   Unmatched / skipped section:
   - List of filenames with status 'unmatched', 'skipped', or 'error'
   - Label: "These files need manual captions in Photo Mechanic"

   "Download All" button:
   - Calls GET /api/download?session_id=...&job_name=... on click
   - Shows loading state while download is in progress
   - Disabled during download
   - On error: show inline error message with retry button

   "New Job" button:
   - Calls store.reset() to clear all zustand state
   - Transitions back to 'setup' state
   - A new session_id will be generated on the next setup submit

Use shadcn/ui Card, Button, and Badge components throughout.
```
