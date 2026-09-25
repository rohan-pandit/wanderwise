-- Per-user observability, Phase B (ADR-007 "Per-user activity view";
-- docs/IMPLEMENTATION_PLAN.md §5). Records the user activity no other table
-- can show: every sign-in (Supabase keeps only last_sign_in_at), failed
-- sign-ins, magic-link requests, and server-action failures that are
-- returned to the UI but never stored.
--
-- event_type values (src/repositories/app-events.ts):
--   sign_in_link_requested   email set, user_id null (the request is unauthenticated)
--   sign_in_link_failed      email set, payload.message
--   sign_in_succeeded        user_id + email set
--   auth_callback_failed     usually no user at all: a bad or expired code
--                            identifies nobody. payload.reason
--   action_failed            user_id set, trip_id when the action has one.
--                            payload.action, payload.kind ('thrown' | 'returned'),
--                            payload.message
--
-- Internal telemetry: RLS on, no policies, so only the service role can
-- read or write it (same as agent_runs/guardrail_events). user_id is
-- `on delete set null` so the record of an event survives if the account
-- goes away; trip_id likewise.

create table app_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  user_id uuid references auth.users(id) on delete set null,
  email text,
  trip_id uuid references trips(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index app_events_user_id_created_at on app_events (user_id, created_at);
create index app_events_email_created_at on app_events (email, created_at);
create index app_events_event_type_created_at on app_events (event_type, created_at);

alter table app_events enable row level security;
