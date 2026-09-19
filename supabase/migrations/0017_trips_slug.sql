-- URL-friendly identifier for a trip (app/app/trips/[identifier]/page.tsx),
-- generated once at creation time (generateUniqueTripSlug,
-- src/repositories/trips.ts) from the trip's name. Nullable at the DB
-- level for the same reason `trips.name` is (0016_trips_name.sql):
-- existing trips predate this column, and internal/eval callers of
-- startTrip don't set one -- the page falls back to looking a trip up by
-- its raw id when the URL segment isn't a known slug.
alter table trips add column slug text;

-- Scoped per-user, not global: RLS already means a slug is only ever
-- resolved within its owner's own trips, so two different users can
-- reuse the same slug with no ambiguity. Partial (`where slug is not
-- null`) so any number of legacy slug-less rows can coexist.
create unique index trips_user_id_slug_unique on trips (user_id, slug) where slug is not null;
