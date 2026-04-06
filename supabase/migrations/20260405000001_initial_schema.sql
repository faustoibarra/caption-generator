-- Caption Generator — initial schema
-- Per approved design doc: 2 tables only, no sessions table, no RLS, no user_id.
-- session_id is a client-generated UUID stored in rows for namespacing.

-- ─────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────

create table roster_athletes (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null,
  name         text not null,
  jersey_number text,
  headshot_url text,
  created_at   timestamptz default now()
);

create index roster_athletes_session_id_idx on roster_athletes(session_id);

create table photos (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null,
  filename         text not null,
  storage_path     text not null,
  processed_path   text,
  status           text not null default 'queued',
  -- queued | processing | matched | unmatched | skipped | error
  matched_names    text[],
  face_confidence  float,
  jersey_confidence float,
  match_type       text,
  -- face | jersey | both | null
  error_message    text,
  created_at       timestamptz default now()
);

create index photos_session_id_idx on photos(session_id);
create index photos_status_idx     on photos(status);
