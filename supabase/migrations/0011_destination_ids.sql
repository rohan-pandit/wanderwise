-- Closes the destination-identifier-space gap tracked in
-- docs/IMPLEMENTATION_PLAN.md §5 since Phase 2 (2026-09-16): flights/hotels/
-- activities each only ever carried a free-text `destination` column matched
-- against `destinations.name`, with no FK and no uniqueness guarantee on
-- that name. Adds a real `destination_id` (and, for flights, `origin_id`)
-- foreign key, backfilled from the existing text columns.
--
-- flights.origin_id/destination_id stay nullable deliberately: a flight leg's
-- two endpoints aren't both always a seeded `destinations` row — a return
-- leg's `destination` column (and an outbound leg's `origin` column) is
-- typically a traveler's home city ("New York", "Chicago", ...), which this
-- project's seed data never lists in `destinations` at all. Only whichever
-- endpoint actually is a real seeded destination resolves to a non-null id.
--
-- hotels.destination_id/activities.destination_id become NOT NULL after
-- backfill — every hotel/activity row's destination is always a real seeded
-- destination. If backfill ever missed a row (a seed destination name typo,
-- for instance), the NOT NULL constraint below fails the migration loudly
-- instead of silently leaving a null.
--
-- The existing `origin`/`destination` text columns are kept, not dropped —
-- they remain the display string (the UI reads `hotel.destination` directly)
-- and the only field available for the non-seeded-city side of a flight leg.
-- The new id columns become authoritative for identity/matching; the text
-- stays for everything else.

alter table flights add column origin_id uuid references destinations(id);
alter table flights add column destination_id uuid references destinations(id);
alter table hotels add column destination_id uuid references destinations(id);
alter table activities add column destination_id uuid references destinations(id);

-- Joining on (name, inventory_version) together, not name alone, correctly
-- resolves the deliberately-seeded stale-v0 fixtures to their own stale
-- `destinations` row rather than the current one.
update flights f set origin_id = d.id
  from destinations d
  where d.name = f.origin and d.inventory_version = f.inventory_version;

update flights f set destination_id = d.id
  from destinations d
  where d.name = f.destination and d.inventory_version = f.inventory_version;

update hotels h set destination_id = d.id
  from destinations d
  where d.name = h.destination and d.inventory_version = h.inventory_version;

update activities a set destination_id = d.id
  from destinations d
  where d.name = a.destination and d.inventory_version = a.inventory_version;

alter table hotels alter column destination_id set not null;
alter table activities alter column destination_id set not null;

-- match_activities filtered by the free-text `destination` column; switch it
-- to the new id column. Postgres requires drop+create (not `create or
-- replace`) when a parameter's type changes.
drop function if exists match_activities(vector(1024), int, text, int, numeric, numeric, text[], text[]);

create function match_activities(
  query_embedding vector(1024),
  match_count int,
  filter_destination_id uuid,
  filter_inventory_version int,
  filter_min_price_usd numeric default null,
  filter_max_price_usd numeric default null,
  filter_required_accessibility text[] default null,
  filter_vibe_tags text[] default null
)
returns table (
  id uuid,
  destination text,
  destination_id uuid,
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
    a.id, a.destination, a.destination_id, a.name, a.description, a.category, a.vibe_tags,
    a.price_usd, a.duration_minutes, a.opening_hours, a.closed_days,
    a.location, a.accessibility_attributes, a.reservation_required, a.inventory_version,
    1 - (a.embedding <=> query_embedding) as similarity
  from activities a
  where a.destination_id = filter_destination_id
    and a.inventory_version = filter_inventory_version
    and a.embedding is not null
    and (filter_min_price_usd is null or a.price_usd >= filter_min_price_usd)
    and (filter_max_price_usd is null or a.price_usd <= filter_max_price_usd)
    and (filter_required_accessibility is null or a.accessibility_attributes @> filter_required_accessibility)
    and (filter_vibe_tags is null or a.vibe_tags && filter_vibe_tags)
  order by a.embedding <=> query_embedding
  limit match_count;
$$;
