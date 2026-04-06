# Caption Generator — Build Plan

## Stage 1 — Scaffold + Database
Set up the Next.js 14 app with TypeScript, Tailwind, shadcn/ui, and local Supabase. Create all 3 tables (`sessions`, `roster_athletes`, `photos`) with RLS policies and the 3 storage buckets. End state: `supabase start` and `npm run dev` run without errors.

## Stage 2 — Auth + Sessions List
Supabase email/password auth, protected routes, `/sessions` list page, and the `/sessions/new` form that creates a session row and kicks off roster scraping.

## Stage 3 — Roster Scraping + Confirmation
`POST /api/sessions/[id]/scrape-roster` — Claude API extracts athletes from the roster page HTML, downloads headshots to Supabase Storage, inserts `roster_athletes` rows. UI: athlete grid with headshots, Re-scrape and Continue buttons.

## Stage 4 — Photo Upload
Drag-and-drop zone (react-dropzone), per-file upload progress, upload to `photos-original/`, insert `photos` rows, Start Processing button activates once at least one photo is uploaded.

## Stage 5 — XMP Writer + Unit Test
`lib/xmp-writer.ts` — pure JS XMP manipulation using `@xmldom/xmldom`. Full test suite in `__tests__/xmp-writer.test.ts` against fixture files. All 4 tests must pass before moving on.

## Stage 6 — Photo Processing
`POST /api/photos/[id]/process` — resize with sharp, build Claude Vision prompt with roster headshots + event photo, parse match JSON, write XMP, upload to `photos-processed/`. Client-side queue with `PROCESSING_CONCURRENCY = 3`. Live processing table with per-photo status, athlete names, match type badges, and confidence.

## Stage 7 — Results + Download
Summary stats card (total, matched %, unmatched %, avg confidence), final photo table, unmatched files list, and Download All ZIP via `GET /api/sessions/[id]/download` using jszip.

---

**Note:** Stage 5 (XMP writer) should be verified with real fixture JPGs before Stage 6 starts. The XMP logic is the trickiest part — use `Daria Gusarova_FI_03152025_011.JPG` as a fixture.
