-- Supports the SerpAPI live-inventory integration's caching check
-- (src/repositories/flights.ts's `findFlightsFromProvider`): a `source =
-- 'serpapi'` row for a given airport pair + date is reused, rather than
-- calling the (rate-limited, metered) live API again, as long as it's
-- recent enough. `flights` never had a `created_at` before this -- every
-- other inventory table (destinations/hotels/activities) is purely static
-- seed data with no per-row temporal meaning, but a live-fetched flight row
-- genuinely has one now.

alter table flights add column created_at timestamptz not null default now();
