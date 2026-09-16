-- ============================================================
-- Idempotency safety net for trip_state_versions.
--
-- PROJECT_BRIEF.md §7.7 requires duplicate requests to be handled
-- idempotently. The workflow controller (src/workflow/controller.ts)
-- checks for a prior row with the same correlation_id before writing, but
-- that check-then-insert has a race window between two concurrent
-- requests carrying the same correlation_id (e.g. a client retry racing
-- the original request). This partial unique index closes that window:
-- Postgres itself rejects the second insert, and the controller's existing
-- "insert failed -> report conflict -> caller retries -> idempotency check
-- now finds the row" path resolves it the same way it already resolves an
-- optimistic-concurrency version conflict.
-- ============================================================

create unique index trip_state_versions_trip_correlation_unique
  on trip_state_versions (trip_id, correlation_id)
  where correlation_id is not null;
