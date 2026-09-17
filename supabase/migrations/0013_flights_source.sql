-- Supports the deterministic flight generator (src/domain/flight-generator.ts):
-- `findFlights` (src/repositories/flights.ts) falls back to generating and
-- persisting flights when a real search for a specific route+date finds
-- zero rows -- pre-seeding literal per-date rows for ~640 destinations
-- across arbitrary future dates is combinatorially infeasible, so gaps are
-- filled on demand instead. `source` distinguishes the two provenances
-- (mirrors `destinations.source`, added in the initial schema) so a
-- generated row is never confused with a hand-curated eval fixture.

alter table flights add column source text not null default 'seed';
