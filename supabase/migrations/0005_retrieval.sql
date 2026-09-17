-- ============================================================
-- Phase 5: retrieval and curation (PROJECT_BRIEF.md §10)
--
-- 1. Narrows destinations.embedding/activities.embedding from the
--    placeholder vector(1536) to Voyage AI's chosen output dimension
--    (voyage-4-lite, output_dimension=1024 — see BUILD_LOG.md,
--    2026-09-16 "embedding provider decided"). Safe: both columns are
--    still all NULL, since no embeddings have been generated yet.
-- 2. Adds match_destinations/match_activities — cosine-similarity search
--    with metadata pre-filtering done inside Postgres (§10.2: "apply
--    metadata filters before or alongside vector similarity"), rather
--    than filtering client-side after fetching every row's embedding.
--    Date/closed-day/opening-hours filtering is deliberately NOT done
--    here — that's the existing deterministic constraint engine's job
--    (src/domain/constraints.ts, Phase 2), applied as a post-filter in
--    the TypeScript retrieval layer so date logic isn't duplicated in SQL.
-- ============================================================

alter table destinations alter column embedding type vector(1024);
alter table activities alter column embedding type vector(1024);

create or replace function match_destinations(
  query_embedding vector(1024),
  match_count int,
  filter_inventory_version int,
  filter_max_daily_cost_usd numeric default null,
  filter_vibe_tags text[] default null
)
returns table (
  id uuid,
  name text,
  country text,
  time_zone text,
  description text,
  vibe_tags text[],
  seasonality jsonb,
  estimated_daily_cost_usd numeric,
  inventory_version int,
  similarity float
)
language sql stable
as $$
  select
    d.id, d.name, d.country, d.time_zone, d.description, d.vibe_tags,
    d.seasonality, d.estimated_daily_cost_usd, d.inventory_version,
    1 - (d.embedding <=> query_embedding) as similarity
  from destinations d
  where d.inventory_version = filter_inventory_version
    and d.embedding is not null
    and (filter_max_daily_cost_usd is null or d.estimated_daily_cost_usd <= filter_max_daily_cost_usd)
    and (filter_vibe_tags is null or d.vibe_tags && filter_vibe_tags)
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_activities(
  query_embedding vector(1024),
  match_count int,
  filter_destination text,
  filter_inventory_version int,
  filter_min_price_usd numeric default null,
  filter_max_price_usd numeric default null,
  filter_required_accessibility text[] default null,
  filter_vibe_tags text[] default null
)
returns table (
  id uuid,
  destination text,
  name text,
  description text,
  category text,
  vibe_tags text[],
  price_usd numeric,
  duration_minutes int,
  opening_hours jsonb,
  closed_days text[],
  location text,
  accessibility_attributes text[],
  reservation_required boolean,
  inventory_version int,
  similarity float
)
language sql stable
as $$
  select
    a.id, a.destination, a.name, a.description, a.category, a.vibe_tags,
    a.price_usd, a.duration_minutes, a.opening_hours, a.closed_days,
    a.location, a.accessibility_attributes, a.reservation_required, a.inventory_version,
    1 - (a.embedding <=> query_embedding) as similarity
  from activities a
  where a.destination = filter_destination
    and a.inventory_version = filter_inventory_version
    and a.embedding is not null
    and (filter_min_price_usd is null or a.price_usd >= filter_min_price_usd)
    and (filter_max_price_usd is null or a.price_usd <= filter_max_price_usd)
    and (filter_required_accessibility is null or a.accessibility_attributes @> filter_required_accessibility)
    and (filter_vibe_tags is null or a.vibe_tags && filter_vibe_tags)
  order by a.embedding <=> query_embedding
  limit match_count;
$$;
