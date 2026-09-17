-- Enables Supabase Realtime (postgres_changes) for the two tables the chat
-- UI's live itinerary panel subscribes to (Phase 7,
-- app/app/_components/itinerary-panel.tsx): as each step of
-- runSearchAndCuration/assembleItinerary/reviseItinerary completes and
-- writes a trip_decisions/trip_events row, subscribed clients see it land
-- immediately, not on a poll. RLS (already enabled on both tables —
-- supabase/migrations/0001_initial_schema.sql) still scopes what each
-- subscribed client actually receives to their own trips; adding a table to
-- this publication only controls whether changes are broadcast at all, not
-- who receives them.
alter publication supabase_realtime add table trip_decisions;
alter publication supabase_realtime add table trip_events;
