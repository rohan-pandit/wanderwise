-- ============================================================
-- Wanderwise — initial schema
--
-- Implements the data model in PROJECT_BRIEF.md §7, with the
-- identity/auth strategy decided in
-- docs/architecture/ADR-003-state-and-data-model.md:
--   - Supabase Auth (magic link) is required before any data exists.
--   - Every user-owned row traces back to auth.users — there is no
--     anonymous/unowned state.
--   - RLS is enabled everywhere. User-owned tables get owner-scoped
--     policies. Internal/telemetry tables get RLS enabled with NO
--     policies, so only the service role (server-side code) can
--     touch them — anon/authenticated clients are locked out entirely.
--
-- Requires the pgvector extension (for destinations.embedding and
-- activities.embedding).
-- ============================================================

create extension if not exists vector;

-- ============================================================
-- Product / session data
-- ============================================================

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  status text not null default 'active'
);

create table trips (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'created',
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

-- Append-only, versioned trip-state projection
create table trip_state_versions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  version int not null,
  state jsonb not null,
  actor text not null,          -- 'user' | 'orchestrator' | 'deterministic_service' | agent name | 'system'
  operation_type text not null,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  unique (trip_id, version)
);

create table trip_requirements (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  field text not null,
  value jsonb not null,
  unit text,
  source text not null,          -- 'user_explicit' | 'user_inferred' | 'system_default' | 'agent_proposed' | ...
  confidence numeric,
  status text not null,          -- 'active' | 'confirmed' | 'retracted'
  created_at timestamptz not null default now()
);

create table trip_preferences (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  field text not null,
  value jsonb not null,
  source text not null,
  confidence numeric,
  status text not null,
  created_at timestamptz not null default now()
);

create table trip_decisions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  field text not null,           -- 'flight' | 'hotel' | 'activity' | ...
  value jsonb not null,          -- selected inventory ID(s)
  source text not null,
  status text not null,          -- 'proposed' | 'confirmed' | 'superseded'
  created_at timestamptz not null default now()
);

create table trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  event_type text not null,       -- 'trip_created' | 'requirements_extracted' | 'budget_calculated' | ...
  payload jsonb not null,
  correlation_id uuid,
  created_at timestamptz not null default now()
);

create table approval_records (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  proposal_state_version int not null,
  proposal_hash text not null,
  approved_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Inventory (seeded/mock — not user-owned, world-readable)
-- ============================================================

create table destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  time_zone text,
  description text,
  vibe_tags text[],
  seasonality jsonb,
  estimated_daily_cost_usd numeric,
  inventory_version int not null default 1,
  source text not null default 'seed',
  embedding vector(1536)
);

create table flights (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  destination text not null,
  departure_time timestamptz not null,
  arrival_time timestamptz not null,
  departure_time_zone text,
  arrival_time_zone text,
  airline text,
  flight_number text,
  price_usd numeric not null,
  taxes_fees_usd numeric not null default 0,
  cabin text,
  is_red_eye boolean not null default false,
  duration_minutes int,
  refundable boolean not null default false,
  changeable boolean not null default false,
  inventory_version int not null default 1
);

create table hotels (
  id uuid primary key default gen_random_uuid(),
  destination text not null,
  name text not null,
  neighborhood text,
  price_per_night_usd numeric not null,
  taxes_fees_usd numeric not null default 0,
  rating numeric,
  room_capacity int not null default 2,
  amenities text[],
  cancellation_policy text,
  vibe_tags text[],
  inventory_version int not null default 1
);

create table activities (
  id uuid primary key default gen_random_uuid(),
  destination text not null,
  name text not null,
  description text,
  category text,
  vibe_tags text[],
  price_usd numeric not null default 0,
  duration_minutes int,
  opening_hours jsonb,
  closed_days text[],
  location text,
  accessibility_attributes text[],
  reservation_required boolean not null default false,
  inventory_version int not null default 1,
  embedding vector(1536)
);

-- ============================================================
-- AI and workflow execution (internal — service role only)
-- ============================================================

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  status text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id) on delete cascade,
  from_state text,
  to_state text,
  event text not null,
  actor text not null,
  correlation_id uuid,
  created_at timestamptz not null default now()
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete set null,
  trip_id uuid references trips(id) on delete set null,
  workflow_run_id uuid references workflow_runs(id) on delete set null,
  agent_name text not null,
  prompt_version text,
  model text,
  input_state_version int,
  output_state_version int,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  latency_ms int,
  cost_usd numeric,
  status text not null check (status in ('success', 'error', 'guardrail_blocked')),
  error_message text,
  correlation_id uuid,
  created_at timestamptz not null default now()
);

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  tool_name text not null,
  arguments jsonb not null,
  result jsonb,
  duration_ms int,
  status text not null check (status in ('success', 'error')),
  created_at timestamptz not null default now()
);

create table guardrail_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id) on delete set null,
  trip_id uuid references trips(id) on delete set null,
  agent_name text,
  guardrail_name text not null,
  layer text not null,           -- 'input_scope' | 'output_validation' | 'domain_validation' | 'workflow_authorization'
  triggered boolean not null,
  detail text,
  workflow_run_id uuid references workflow_runs(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Evaluation and analytics (internal — service role only)
-- ============================================================

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  run_label text,
  created_at timestamptz not null default now()
);

create table eval_results (
  id uuid primary key default gen_random_uuid(),
  eval_run_id uuid not null references eval_runs(id) on delete cascade,
  test_case_name text not null,
  passed boolean not null,
  score numeric,
  details jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

-- User-owned tables: owner-scoped access via auth.uid()

alter table sessions enable row level security;
create policy "owner can access own sessions" on sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table trips enable row level security;
create policy "owner can access own trips" on trips
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table messages enable row level security;
create policy "owner can access own messages" on messages
  for all using (
    exists (select 1 from sessions s where s.id = messages.session_id and s.user_id = auth.uid())
  ) with check (
    exists (select 1 from sessions s where s.id = messages.session_id and s.user_id = auth.uid())
  );

alter table trip_state_versions enable row level security;
create policy "owner can access own trip_state_versions" on trip_state_versions
  for all using (
    exists (select 1 from trips t where t.id = trip_state_versions.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = trip_state_versions.trip_id and t.user_id = auth.uid())
  );

alter table trip_requirements enable row level security;
create policy "owner can access own trip_requirements" on trip_requirements
  for all using (
    exists (select 1 from trips t where t.id = trip_requirements.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = trip_requirements.trip_id and t.user_id = auth.uid())
  );

alter table trip_preferences enable row level security;
create policy "owner can access own trip_preferences" on trip_preferences
  for all using (
    exists (select 1 from trips t where t.id = trip_preferences.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = trip_preferences.trip_id and t.user_id = auth.uid())
  );

alter table trip_decisions enable row level security;
create policy "owner can access own trip_decisions" on trip_decisions
  for all using (
    exists (select 1 from trips t where t.id = trip_decisions.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = trip_decisions.trip_id and t.user_id = auth.uid())
  );

alter table trip_events enable row level security;
create policy "owner can access own trip_events" on trip_events
  for all using (
    exists (select 1 from trips t where t.id = trip_events.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = trip_events.trip_id and t.user_id = auth.uid())
  );

alter table approval_records enable row level security;
create policy "owner can access own approval_records" on approval_records
  for all using (
    exists (select 1 from trips t where t.id = approval_records.trip_id and t.user_id = auth.uid())
  ) with check (
    exists (select 1 from trips t where t.id = approval_records.trip_id and t.user_id = auth.uid())
  );

-- Inventory tables: world-readable (seeded/mock, not user-owned), writes reserved to service role

alter table destinations enable row level security;
create policy "anyone can read destinations" on destinations for select using (true);

alter table flights enable row level security;
create policy "anyone can read flights" on flights for select using (true);

alter table hotels enable row level security;
create policy "anyone can read hotels" on hotels for select using (true);

alter table activities enable row level security;
create policy "anyone can read activities" on activities for select using (true);

-- Internal/telemetry tables: RLS enabled, no policies — only the
-- service role (used exclusively in server-side code) can read or
-- write these. anon/authenticated clients get nothing.

alter table workflow_runs enable row level security;
alter table workflow_steps enable row level security;
alter table agent_runs enable row level security;
alter table tool_calls enable row level security;
alter table guardrail_events enable row level security;
alter table eval_runs enable row level security;
alter table eval_results enable row level security;
