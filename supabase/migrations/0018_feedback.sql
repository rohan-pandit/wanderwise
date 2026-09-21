-- "Report an issue" (docs/END_TO_END_TESTING_ISSUES.md-informed feature):
-- free-text + category feedback a user can submit from the trip
-- chat/itinerary screen, reviewed in /internal/product-metrics. Trip data
-- the user entered and the agent's own responses are never duplicated here
-- -- `trip_id` is enough to join back to `messages`/`trip_requirements`/
-- `trip_decisions`, which already record all of that; a snapshot copy
-- would just be a second, driftable source of the same facts.
create table feedback (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  categories text[] not null default '{}',
  message text,
  -- Where the user was when they reported it -- 'chain step: flight' /
  -- 'finalized' / 'cancelled', computed server-side from the trip's own
  -- decisions at submit time (app/app/actions.ts's submitFeedback), not
  -- trusted from the client.
  context text not null,
  created_at timestamptz not null default now()
);

alter table feedback enable row level security;
create policy "owner can access own feedback" on feedback
  for all using (
    exists (select 1 from trips t where t.id = feedback.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = feedback.trip_id and t.user_id = auth.uid())
  );
