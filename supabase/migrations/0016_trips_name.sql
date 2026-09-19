-- User-facing trip name (PROJECT_BRIEF.md §14 UX rework: a naming step
-- before chat starts). Nullable at the DB level, not enforced with `not
-- null` -- every trip created through the app's own naming screen always
-- has one (enforced in app code, `createTripAction`), but existing trips
-- predate this column and internal/eval callers of `startTrip` that never
-- go through that screen shouldn't be forced to invent a name. The UI
-- falls back to "Untitled trip" wherever a null name would otherwise show.
alter table trips add column name text;
