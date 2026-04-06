# Caption Generator

Automates athlete identification in sports photos. Upload post-edited JPGs, and the app matches athletes by face and jersey number, then writes the names directly into the XMP metadata — ready to open in Photo Mechanic with captions pre-filled.

Built for sports photographers covering college athletics.

---

## How it works

1. **Paste a roster URL** — the app scrapes the school's athletics page and downloads athlete headshots
2. **Confirm the roster** — review the scraped athletes before processing
3. **Upload photos** — drag in JPGs from a shoot; process in batches during a game if needed
4. **Automatic matching** — each photo is analysed using ArcFace (face recognition) and Claude Vision (jersey numbers); matched names are written to `dc:title` and `dc:description` in the JPEG's XMP metadata
5. **Download a ZIP** — all processed files in one download; unmatched photos are included unchanged

---

## Tech stack

- **Next.js 14** (App Router, TypeScript)
- **Supabase** — Postgres + Storage for athlete data, original and processed photos
- **Anthropic Claude** — roster scraping and jersey number reading
- **InsightFace / ArcFace** — face recognition (Vercel Python Function)
- **sharp** — server-side image resizing
- **Tailwind CSS + shadcn/ui**
- **Zustand** — client state
- **jszip** — ZIP download

---

## Setup & deployment

See **[SETUP.md](SETUP.md)** for full instructions:
- Creating the Supabase project and running migrations
- Setting environment variables in Vercel
- Deploying and testing

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `ANTHROPIC_API_KEY` | Anthropic API key |

---

## Notes

- **No authentication** — v1 is single-user; the app URL is the only access control
- **Confidence threshold** — default 0.40; lower toward 0.30 for more matches, raise toward 0.55 to reduce false positives
- **First photo per session is slow** (~30–60s) while the face recognition model cold-starts on Vercel; subsequent photos are fast
- **Unsupported roster pages** — JS-rendered pages (some Sidearm Sports sites) return no athletes; headless browser support is planned for v2
