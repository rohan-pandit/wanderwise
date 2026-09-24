-- Beta feedback: widens 0018's trip-only "Report an issue" table so a report
-- can come from any /app page (the header's Beta chip / banner /
-- "Feedback" link), not just from inside a trip workspace.
--
-- * trip_id becomes optional -- a report from /app/trips or /app/new has no
--   trip. Still set whenever the reporter was inside one, so
--   /internal/product-metrics can keep joining back to that trip's
--   requirements and transcript.
-- * user_id is the new ownership anchor (RLS below), since trip_id can no
--   longer carry it. Backfilled from each existing row's trip before the
--   not-null constraint lands.
-- * kind separates bug reports from ideas/general feedback. Existing rows
--   all came from "Report an issue", so they backfill as 'bug'.
-- * route is the /app path the reporter was on -- client-supplied (the
--   server can't know which page a Server Action was invoked from), so it's
--   triage context only, never trusted for anything else.
alter table feedback alter column trip_id drop not null;

alter table feedback add column user_id uuid references auth.users(id) on delete cascade;
update feedback f set user_id = t.user_id from trips t where t.id = f.trip_id;
alter table feedback alter column user_id set not null;

alter table feedback add column kind text not null default 'bug'
  check (kind in ('bug', 'idea', 'other'));
alter table feedback add column route text;

drop policy "owner can access own feedback" on feedback;
create policy "owner can access own feedback" on feedback
  for all using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (
      trip_id is null
      or exists (select 1 from trips t where t.id = feedback.trip_id and t.user_id = auth.uid())
    )
  );
