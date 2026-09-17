-- ============================================================
-- Idempotency key for trip creation (startTrip, src/workflow/controller.ts).
--
-- Tracked as an open gap since Phase 3 (IMPLEMENTATION_PLAN.md §5):
-- `trips` has no correlation-id column, so a lost response followed by a
-- client retry (a double form submit, or a network-level retry of the
-- `sendMessage` Server Action when no `tripId` exists yet) creates a
-- second, orphaned trip with its own genesis state and workflow run. Now
-- that a real chat UI exists (Phase 7) driving this exact call path, this
-- is a real risk, not a theoretical one.
--
-- Mirrors the existing `trip_state_versions_trip_correlation_unique`
-- pattern (0003_trip_state_idempotency.sql): the application checks for a
-- prior row with the same correlation_id before inserting, and this
-- partial unique index closes the race window between two concurrent
-- callers carrying the same key -- the loser's insert fails with a
-- unique_violation (23505) instead of silently creating a duplicate trip.
-- ============================================================

alter table trips add column correlation_id uuid;

create unique index trips_correlation_id_unique
  on trips (correlation_id)
  where correlation_id is not null;
