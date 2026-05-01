alter table photos add column if not exists athlete_confidences jsonb;
-- Format: [{"name": "Athlete Name", "confidence": 0.92}, ...]
-- One entry per matched athlete, in left-to-right order (same as matched_names).
-- null for rows processed before this migration.
