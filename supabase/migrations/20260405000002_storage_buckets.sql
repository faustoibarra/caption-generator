-- Storage buckets
-- All private (public = false). Access via service-role key in API routes only.

insert into storage.buckets (id, name, public)
values
  ('rosters',           'rosters',           false),
  ('photos-original',   'photos-original',   false),
  ('photos-processed',  'photos-processed',  false)
on conflict (id) do nothing;
