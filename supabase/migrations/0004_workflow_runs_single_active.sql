-- ============================================================
-- Closes the workflow_runs race flagged in Phase 3's review
-- (IMPLEMENTATION_PLAN.md §5): getOrCreateActiveWorkflowRun does a plain
-- select-then-insert with nothing in the database stopping two concurrent
-- callers for the same trip from both seeing no active run and both
-- inserting one. This partial unique index makes the database itself
-- enforce "at most one active run per trip" -- the loser's insert now
-- fails with a unique_violation (23505) instead of silently succeeding,
-- and the application code (src/repositories/workflow-runs.ts) catches
-- that and re-fetches the winner's row.
-- ============================================================

create unique index workflow_runs_trip_active_unique
  on workflow_runs (trip_id)
  where status = 'running' and completed_at is null;
