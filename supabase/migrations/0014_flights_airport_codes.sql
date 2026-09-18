-- Supports the SerpAPI (Google Flights) live-inventory integration
-- (docs/IMPLEMENTATION_PLAN.md): unlike seeded/generated flights, which are
-- keyed by free-text city name / destination_id, a SerpAPI search is keyed
-- by IATA airport code -- "JFK" -> "MAD", not "New York" -> "Madrid". These
-- columns record which specific airport a `source = 'serpapi'` row actually
-- came from, both so the UI can show it and so the caching check in
-- `src/repositories/providers/serpapi-flight-provider.ts` can look up "do we
-- already have a recent result for this exact airport pair + date" before
-- calling the live API again.
--
-- Nullable: every non-'serpapi' row (seeded, generated) has no airport-code
-- concept at all -- these columns are `source = 'serpapi'`-only, not a
-- general property of every flight.

alter table flights add column origin_airport_code text;
alter table flights add column destination_airport_code text;
