# Setup & Deployment

## 1. Create the GitHub repo

```bash
cd /Users/fausto/claude-projects/caption-generator
gh repo create caption-generator --private --source=. --push
```

If you don't have the `gh` CLI:

1. Go to github.com → New repository → name it `caption-generator`, set Private, **don't** initialise with a README
2. Then run:

```bash
cd /Users/fausto/claude-projects/caption-generator
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/caption-generator.git
git push -u origin main
```

---

## 2. Set up Supabase (cloud)

### Create a project

1. Go to [supabase.com](https://supabase.com) → New project
2. Name it `caption-generator`, choose a region close to you, set a database password
3. Wait for provisioning to finish (~2 minutes)

### Run the migrations

Go to your project → **SQL Editor**, then paste and run each block in order.

**Block 1 — tables:**

```sql
create table roster_athletes (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null,
  name          text not null,
  jersey_number text,
  headshot_url  text,
  roster_url    text,
  created_at    timestamptz default now()
);
create index roster_athletes_session_id_idx on roster_athletes(session_id);
create index roster_athletes_roster_url_idx on roster_athletes(roster_url);

create table photos (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null,
  filename          text not null,
  storage_path      text not null,
  processed_path    text,
  status            text not null default 'queued',
  -- queued | processing | matched | unmatched | skipped | error
  matched_names     text[],
  face_confidence   float,
  jersey_confidence float,
  match_type        text,
  -- face | jersey | both | null
  error_message     text,
  created_at        timestamptz default now()
);
create index photos_session_id_idx on photos(session_id);
create index photos_status_idx     on photos(status);
```

**Block 2 — storage buckets:**

```sql
insert into storage.buckets (id, name, public)
values
  ('rosters',          'rosters',          false),
  ('photos-original',  'photos-original',  false),
  ('photos-processed', 'photos-processed', false)
on conflict (id) do nothing;
```

### Get your keys

Go to project → **Settings → API** and copy:

- **Project URL** — looks like `https://xxxxxxxxxxxx.supabase.co`
- **anon / public** key
- **service_role** key (click Reveal)

---

## 3. Deploy to Vercel

### Import the repo

1. Go to [vercel.com](https://vercel.com) → Add New Project → import your `caption-generator` repo
2. Framework is auto-detected as Next.js — leave all build settings as-is
3. **Do not deploy yet** — add environment variables first (next step)

### Set environment variables

Go to **Project Settings → Environment Variables** and add all four for the **Production**, **Preview**, and **Development** environments:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | your Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon / public key |
| `SUPABASE_SERVICE_ROLE_KEY` | your service_role key |
| `ANTHROPIC_API_KEY` | your Anthropic API key |

### Deploy

Click **Deploy**. The first build takes ~3 minutes. Vercel installs both Node and Python dependencies automatically.

---

## 4. Test the app

Open your `.vercel.app` URL and work through the flow:

1. **Setup** — enter school name, sport (e.g. "Field Hockey"), paste the roster URL from the school's athletics site, set confidence threshold (default 0.40)
2. **Roster confirmation** — verify athletes and headshots scraped correctly; re-scrape if blank
3. **Upload photos** — drag in JPGs, wait for uploads, click Start Processing
4. **Processing** — watch the live table update; the first photo will be slow (~30–60s) while the face-matching model downloads to the Vercel function instance; subsequent photos in the same session will be fast
5. **Download** — click Finish & Download ZIP; open a file in Photo Mechanic and check the Caption / Personality fields

> **Confidence threshold:** the default is 0.40. The face model (ArcFace) scores differently from Claude — if you're getting too few matches, try lowering to 0.30. If you're getting false matches, raise it toward 0.55.

---

## 5. Redeploy after code changes

```bash
git add .
git commit -m "describe your change"
git push
```

Vercel auto-deploys on every push to `main`.
