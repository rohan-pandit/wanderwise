-- ============================================================
-- Wanderwise — seed / mock inventory data (Phase 1)
--
-- 6 destinations, ~22 flights, ~16 hotels, ~27 activities. Deliberately
-- includes the edge cases called out in PROJECT_BRIEF.md §11.2:
--   - red-eye flights, including the cheapest option on a route
--     (eval scenario 5, PROJECT_BRIEF.md §19)
--   - a stale inventory_version = 0 record in each table
--     (eval scenario 10)
--   - a closed-on-Monday activity and two activities with overlapping
--     opening hours in the same destination
--   - an unusually long activity duration (full-day tour)
--   - null/incomplete optional fields (rating, description)
--   - a non-refundable hotel (high cancellation penalty) and a
--     low room-capacity hotel (occupancy constraint)
--   - two near-duplicate-looking hotels in the same destination
--
-- Embeddings are left NULL — generated in Phase 5 (retrieval/curation),
-- not here. `estimated_daily_cost_usd` and prices are illustrative mock
-- figures, not real quotes.
--
-- This lives in migrations/, not supabase/seed.sql as PROJECT_BRIEF.md §15
-- sketches, so the same file applies via `supabase db push` against both a
-- hosted project and (if local dev ever becomes viable again) a local one
-- via `supabase db reset` — one copy of the data instead of two that could
-- drift apart.
-- ============================================================

-- ============================================================
-- Destinations
-- ============================================================

insert into destinations (name, country, time_zone, description, vibe_tags, seasonality, estimated_daily_cost_usd, inventory_version, source)
values
  ('Lisbon', 'Portugal', 'Europe/Lisbon',
   'A hilly, sun-bleached port city of pastel facades, custard tarts, and fado music drifting out of tiled taverns.',
   array['culture','food','coastal','walkable'],
   '{"best_months":[4,5,6,9,10],"notes":"Hot and crowded in July/August; shoulder season is milder and cheaper."}',
   120, 1, 'seed'),

  ('Kyoto', 'Japan', 'Asia/Tokyo',
   'Japan''s former imperial capital — thousands of temples and shrines, geisha districts, and some of the country''s best seasonal cooking.',
   array['culture','food','temples','history'],
   '{"best_months":[3,4,10,11],"notes":"Cherry blossoms in late March/early April; autumn foliage in November. Summer is hot and humid."}',
   150, 1, 'seed'),

  ('Tulum', 'Mexico', 'America/Cancun',
   'Laid-back Caribbean coast town with cliffside Mayan ruins, cenotes, and a beach-club scene just south of Cancún.',
   array['beach','wellness','ruins','nightlife'],
   '{"best_months":[11,12,1,2,3,4],"notes":"Hurricane season runs June-November; sargassum seaweed can be heavy in summer."}',
   140, 1, 'seed'),

  ('Reykjavik', 'Iceland', 'Atlantic/Reykjavik',
   'Gateway to Iceland''s glaciers, geothermal springs, and the Ring Road — small, walkable, and surprisingly good New Nordic food.',
   array['outdoors','nature','adventure','hot-springs'],
   '{"best_months":[6,7,8],"notes":"Midnight sun in summer; aurora season is Sept-March but weather is harsher and daylight short."}',
   180, 1, 'seed'),

  ('Cape Town', 'South Africa', 'Africa/Johannesburg',
   'Table Mountain, penguin colonies, and the Cape Winelands, all within an hour of a genuinely great restaurant scene.',
   array['outdoors','food','beach','wine','family'],
   '{"best_months":[11,12,1,2,3],"notes":"Southern hemisphere summer; winter (Jun-Aug) is mild but wetter."}',
   110, 1, 'seed'),

  ('Barcelona', 'Spain', 'Europe/Madrid',
   'Gaudí architecture, Mediterranean beaches, and tapas bars packed into a dense, walkable grid.',
   array['culture','food','beach','family','nightlife'],
   '{"best_months":[5,6,9,10],"notes":"Very hot and touristed in July/August."}',
   130, 1, 'seed'),

  -- Stale fixture: an old inventory version of a destination that has since
  -- been re-seeded above. Used to exercise "stale inventory" handling
  -- (PROJECT_BRIEF.md §19, scenario 10) — application code should filter
  -- to the current inventory_version and never surface this row.
  ('Lisbon', 'Portugal', 'Europe/Lisbon',
   'Outdated listing kept only as a stale-inventory fixture.',
   array['culture','food'],
   '{}', 95, 0, 'seed');

-- ============================================================
-- Flights
-- Origins used: Philadelphia, New York, San Francisco, Chicago, Miami
-- ============================================================

insert into flights (origin, destination, departure_time, arrival_time, departure_time_zone, arrival_time_zone, airline, flight_number, price_usd, taxes_fees_usd, cabin, is_red_eye, duration_minutes, refundable, changeable, inventory_version)
values
  -- Lisbon
  ('Philadelphia', 'Lisbon', '2026-10-05T18:30:00-04:00', '2026-10-06T07:45:00+01:00', 'America/New_York', 'Europe/Lisbon', 'TAP Air Portugal', 'TP204', 612.00, 118.40, 'economy', true, 435, false, true, 1),
  ('New York', 'Lisbon', '2026-10-05T20:10:00-04:00', '2026-10-06T09:05:00+01:00', 'America/New_York', 'Europe/Lisbon', 'TAP Air Portugal', 'TP202', 548.00, 112.00, 'economy', true, 415, false, false, 1),
  ('New York', 'Lisbon', '2026-10-05T10:15:00-04:00', '2026-10-05T22:50:00+01:00', 'America/New_York', 'Europe/Lisbon', 'United', 'UA58', 789.00, 132.50, 'premium_economy', false, 395, true, true, 1),
  ('Chicago', 'Lisbon', '2026-10-05T16:00:00-05:00', '2026-10-06T06:20:00+01:00', 'America/Chicago', 'Europe/Lisbon', 'American Airlines', 'AA732', 701.50, 121.00, 'economy', true, 500, false, true, 1),

  -- Kyoto (routed via Osaka/Kansai, listed simply as Kyoto)
  ('San Francisco', 'Kyoto', '2026-10-08T13:20:00-07:00', '2026-10-09T17:05:00+09:00', 'America/Los_Angeles', 'Asia/Tokyo', 'ANA', 'NH7', 1120.00, 210.00, 'economy', false, 645, false, false, 1),
  ('Los Angeles', 'Kyoto', '2026-10-08T23:55:00-07:00', '2026-10-10T05:30:00+09:00', 'America/Los_Angeles', 'Asia/Tokyo', 'Japan Airlines', 'JL62', 985.00, 198.00, 'economy', true, 695, false, true, 1),
  ('Chicago', 'Kyoto', '2026-10-08T11:40:00-05:00', '2026-10-09T15:15:00+09:00', 'America/Chicago', 'Asia/Tokyo', 'United', 'UA881', 1340.00, 224.00, 'business', false, 745, true, true, 1),

  -- Tulum (via Cancun)
  ('Miami', 'Tulum', '2026-10-12T09:05:00-04:00', '2026-10-12T11:40:00-05:00', 'America/New_York', 'America/Cancun', 'American Airlines', 'AA1029', 298.00, 64.00, 'economy', false, 155, false, false, 1),
  ('New York', 'Tulum', '2026-10-12T06:15:00-04:00', '2026-10-12T09:50:00-05:00', 'America/New_York', 'America/Cancun', 'JetBlue', 'B6103', 342.50, 71.20, 'economy', false, 275, true, true, 1),
  ('Chicago', 'Tulum', '2026-10-12T23:40:00-05:00', '2026-10-13T03:55:00-05:00', 'America/Chicago', 'America/Cancun', 'Spirit', 'NK540', 211.00, 58.00, 'economy', true, 195, false, false, 1),

  -- Reykjavik
  ('New York', 'Reykjavik', '2026-10-15T22:50:00-04:00', '2026-10-16T08:10:00+00:00', 'America/New_York', 'Atlantic/Reykjavik', 'Icelandair', 'FI631', 462.00, 89.00, 'economy', true, 320, false, true, 1),
  ('Philadelphia', 'Reykjavik', '2026-10-15T20:15:00-04:00', '2026-10-16T05:45:00+00:00', 'America/New_York', 'Atlantic/Reykjavik', 'Icelandair', 'FI633', 439.00, 85.50, 'economy', true, 330, false, false, 1),
  ('Chicago', 'Reykjavik', '2026-10-15T17:30:00-05:00', '2026-10-16T06:10:00+00:00', 'America/Chicago', 'Atlantic/Reykjavik', 'Icelandair', 'FI653', 501.00, 92.00, 'premium_economy', false, 400, true, true, 1),

  -- Cape Town
  ('New York', 'Cape Town', '2026-10-20T17:45:00-04:00', '2026-10-21T18:20:00+02:00', 'America/New_York', 'Africa/Johannesburg', 'United', 'UA122', 1245.00, 245.00, 'economy', false, 995, false, true, 1),
  ('Chicago', 'Cape Town', '2026-10-20T13:10:00-05:00', '2026-10-21T18:20:00+02:00', 'America/Chicago', 'Africa/Johannesburg', 'Lufthansa', 'LH493', 1189.00, 238.00, 'economy', false, 1150, false, false, 1),

  -- Barcelona
  ('New York', 'Barcelona', '2026-10-03T19:25:00-04:00', '2026-10-04T08:50:00+02:00', 'America/New_York', 'Europe/Madrid', 'Delta', 'DL140', 588.00, 114.00, 'economy', true, 445, false, true, 1),
  ('Philadelphia', 'Barcelona', '2026-10-03T18:05:00-04:00', '2026-10-04T07:20:00+02:00', 'America/New_York', 'Europe/Madrid', 'American Airlines', 'AA716', 561.00, 109.00, 'economy', true, 435, false, false, 1),
  ('Chicago', 'Barcelona', '2026-10-03T15:50:00-05:00', '2026-10-04T07:35:00+02:00', 'America/Chicago', 'Europe/Madrid', 'United', 'UA982', 622.00, 118.00, 'economy', false, 525, true, true, 1),
  ('Philadelphia', 'Barcelona', '2026-10-03T09:10:00-04:00', '2026-10-03T22:15:00+02:00', 'America/New_York', 'Europe/Madrid', 'Lufthansa', 'LH401', 745.00, 128.00, 'business', false, 425, true, true, 1),

  -- Stale fixture (old price, superseded by the New York -> Lisbon rows above)
  ('New York', 'Lisbon', '2026-09-01T20:00:00-04:00', '2026-09-02T08:30:00+01:00', 'America/New_York', 'Europe/Lisbon', 'TAP Air Portugal', 'TP202', 399.00, 95.00, 'economy', true, 390, false, false, 0);

-- ============================================================
-- Hotels
-- ============================================================

insert into hotels (destination, name, neighborhood, price_per_night_usd, taxes_fees_usd, rating, room_capacity, amenities, cancellation_policy, vibe_tags, inventory_version)
values
  ('Lisbon', 'Hotel Alfama Bica', 'Alfama', 165.00, 28.00, 4.5, 2, array['breakfast','rooftop-bar','air-conditioning'], 'Free cancellation up to 48 hours before check-in', array['boutique','culture','walkable'], 1),
  ('Lisbon', 'Baixa Riverside Suites', 'Baixa', 142.00, 24.00, 4.2, 4, array['kitchenette','washer','elevator'], 'Free cancellation up to 72 hours before check-in', array['family','central'], 1),
  ('Lisbon', 'Alfama Bica Inn', 'Alfama', 158.00, 27.00, null, 2, array['breakfast'], 'Non-refundable', array['boutique'], 1),

  ('Kyoto', 'Gion Ryokan Nishimura', 'Gion', 210.00, 32.00, 4.8, 2, array['onsen','breakfast','tatami-rooms'], 'Free cancellation up to 7 days before check-in', array['traditional','culture','quiet'], 1),
  ('Kyoto', 'Kyoto Station City Hotel', 'Kyoto Station', 118.00, 19.00, 4.0, 2, array['air-conditioning','elevator'], 'Free cancellation up to 24 hours before check-in', array['convenient','budget'], 1),
  ('Kyoto', 'Higashiyama Family Suites', 'Higashiyama', 175.00, 26.00, 4.3, 5, array['kitchenette','breakfast','laundry'], 'Free cancellation up to 48 hours before check-in', array['family','culture'], 1),

  ('Tulum', 'Casa Cenote Beachfront', 'Tulum Beach', 245.00, 38.00, 4.6, 2, array['pool','beach-access','breakfast'], 'Non-refundable', array['beach','wellness','romantic'], 1),
  ('Tulum', 'Selva Eco-Lodge', 'Tulum Pueblo', 98.00, 15.00, 4.1, 3, array['pool','bike-rental'], 'Free cancellation up to 5 days before check-in', array['budget','wellness','eco'], 1),
  ('Tulum', 'Familia Tulum Resort', 'Tulum Beach', 268.00, 41.00, 4.4, 6, array['pool','kids-club','breakfast','beach-access'], 'Free cancellation up to 7 days before check-in', array['family','beach'], 1),

  ('Reykjavik', 'Sky Lagoon View Hotel', 'Downtown', 289.00, 44.00, 4.5, 2, array['breakfast','sauna'], 'Free cancellation up to 48 hours before check-in', array['nature','adventure'], 1),
  ('Reykjavik', 'Reykjavik Budget Inn', 'Downtown', 155.00, 22.00, 3.8, 2, array['shared-kitchen'], 'Non-refundable', array['budget'], 1),

  ('Cape Town', 'Camps Bay Ocean Suites', 'Camps Bay', 198.00, 30.00, 4.7, 2, array['pool','beach-access','breakfast'], 'Free cancellation up to 72 hours before check-in', array['beach','romantic'], 1),
  ('Cape Town', 'Table Mountain Lodge', 'City Bowl', 132.00, 20.00, 4.3, 4, array['breakfast','shuttle'], 'Free cancellation up to 48 hours before check-in', array['family','outdoors'], 1),
  ('Cape Town', 'Winelands Family Villas', 'Constantia', 175.00, 27.00, 4.5, 6, array['pool','kitchenette','breakfast'], 'Free cancellation up to 7 days before check-in', array['family','wine'], 1),

  ('Barcelona', 'Gothic Quarter Boutique', 'Gothic Quarter', 189.00, 29.00, 4.4, 2, array['breakfast','rooftop-bar'], 'Free cancellation up to 48 hours before check-in', array['culture','nightlife'], 1),
  ('Barcelona', 'Barceloneta Beach Apartments', 'Barceloneta', 224.00, 34.00, 4.2, 5, array['kitchenette','beach-access','washer'], 'Free cancellation up to 7 days before check-in', array['family','beach'], 1),

  -- Stale fixture
  ('Lisbon', 'Hotel Alfama Bica', 'Alfama', 110.00, 18.00, 4.5, 2, array['breakfast'], 'Free cancellation up to 48 hours before check-in', array['boutique'], 0);

-- ============================================================
-- Activities
-- opening_hours keys are day names; "closed" or omission means not open
-- ============================================================

insert into activities (destination, name, description, category, vibe_tags, price_usd, duration_minutes, opening_hours, closed_days, location, accessibility_attributes, reservation_required, inventory_version)
values
  ('Lisbon', 'Alfama Walking Food Tour', 'Small-group tour through Alfama''s alleys, tasting pastéis de nata, ginjinha, and petiscos along the way.', 'food', array['food','culture','walkable'], 89.00, 180, '{"tuesday":"10:00-18:00","wednesday":"10:00-18:00","thursday":"10:00-18:00","friday":"10:00-18:00","saturday":"10:00-18:00","sunday":"10:00-18:00"}', array['monday'], 'Alfama', array['wheelchair-limited'], true, 1),
  ('Lisbon', 'Tram 28 Heritage Ride', null, 'sightseeing', array['culture','budget'], 3.50, 45, '{"monday":"06:00-23:00","tuesday":"06:00-23:00","wednesday":"06:00-23:00","thursday":"06:00-23:00","friday":"06:00-23:00","saturday":"06:00-23:00","sunday":"06:00-23:00"}', array[]::text[], 'Citywide', array[]::text[], false, 1),
  ('Lisbon', 'Sintra Day Trip', 'Full-day guided excursion to Sintra''s palaces, including Pena Palace and the Quinta da Regaleira gardens.', 'day-trip', array['culture','outdoors'], 95.00, 480, '{"monday":"08:00-19:00","tuesday":"08:00-19:00","wednesday":"08:00-19:00","thursday":"08:00-19:00","friday":"08:00-19:00","saturday":"08:00-19:00"}', array['sunday'], 'Sintra (day trip from Lisbon)', array[]::text[], true, 1),
  ('Lisbon', 'Fado Dinner Show', 'Traditional fado performance with a set-menu dinner in a family-run Alfama tavern.', 'entertainment', array['culture','food','romantic'], 65.00, 150, '{"wednesday":"19:30-23:00","thursday":"19:30-23:00","friday":"19:30-23:00","saturday":"19:30-23:00"}', array['sunday','monday','tuesday'], 'Alfama', array[]::text[], true, 1),

  ('Kyoto', 'Fushimi Inari Sunrise Hike', 'Early-morning walk through the thousands of torii gates up Mount Inari, before the crowds arrive.', 'outdoors', array['culture','outdoors','free'], 0.00, 120, '{"monday":"05:00-20:00","tuesday":"05:00-20:00","wednesday":"05:00-20:00","thursday":"05:00-20:00","friday":"05:00-20:00","saturday":"05:00-20:00","sunday":"05:00-20:00"}', array[]::text[], 'Fushimi Inari-taisha', array[]::text[], false, 1),
  ('Kyoto', 'Tea Ceremony Experience', 'Hands-on introduction to Japanese tea ceremony with a certified tea master, in a traditional machiya house.', 'culture', array['culture','quiet'], 55.00, 90, '{"tuesday":"10:00-17:00","wednesday":"10:00-17:00","thursday":"10:00-17:00","friday":"10:00-17:00","saturday":"10:00-17:00","sunday":"10:00-17:00"}', array['monday'], 'Higashiyama', array['wheelchair-limited'], true, 1),
  ('Kyoto', 'Arashiyama Bamboo Grove & Monkey Park', 'Self-guided walk through the bamboo grove followed by the Iwatayama Monkey Park overlook.', 'outdoors', array['outdoors','family'], 12.00, 150, '{"monday":"09:00-16:30","tuesday":"09:00-16:30","wednesday":"09:00-16:30","thursday":"09:00-16:30","friday":"09:00-16:30","saturday":"09:00-16:30","sunday":"09:00-16:30"}', array[]::text[], 'Arashiyama', array[]::text[], false, 1),
  ('Kyoto', 'Nishiki Market Food Crawl', 'Guided tasting crawl through "Kyoto''s Kitchen" — pickles, skewers, and knife shops included.', 'food', array['food','culture'], 70.00, 135, '{"tuesday":"10:00-16:00","wednesday":"10:00-16:00","thursday":"10:00-16:00","friday":"10:00-16:00","saturday":"10:00-16:00","sunday":"10:00-16:00"}', array['monday'], 'Nishiki Market', array[]::text[], true, 1),

  ('Tulum', 'Gran Cenote Snorkeling', 'Snorkel a crystal-clear freshwater cenote with turtles and small caverns.', 'outdoors', array['outdoors','wellness'], 25.00, 120, '{"monday":"08:00-17:00","tuesday":"08:00-17:00","wednesday":"08:00-17:00","thursday":"08:00-17:00","friday":"08:00-17:00","saturday":"08:00-17:00","sunday":"08:00-17:00"}', array[]::text[], 'Gran Cenote', array[]::text[], false, 1),
  ('Tulum', 'Tulum Ruins at Sunrise', 'Small-group early entry to the cliffside Mayan ruins overlooking the Caribbean, before tour buses arrive.', 'ruins', array['culture','outdoors'], 40.00, 90, '{"monday":"08:00-17:00","tuesday":"08:00-17:00","wednesday":"08:00-17:00","thursday":"08:00-17:00","friday":"08:00-17:00","saturday":"08:00-17:00","sunday":"08:00-17:00"}', array[]::text[], 'Tulum Archaeological Site', array[]::text[], true, 1),
  ('Tulum', 'Beach Club Day Pass', 'All-day beach club access with loungers, pool, and lunch included.', 'leisure', array['beach','nightlife'], 60.00, 480, '{"monday":"09:00-20:00","tuesday":"09:00-20:00","wednesday":"09:00-20:00","thursday":"09:00-20:00","friday":"09:00-20:00","saturday":"09:00-20:00","sunday":"09:00-20:00"}', array[]::text[], 'Tulum Beach', array[]::text[], false, 1),
  ('Tulum', 'Sound Healing & Temazcal Ceremony', null, 'wellness', array['wellness'], 85.00, 150, '{"friday":"18:00-21:00","saturday":"18:00-21:00"}', array['monday','tuesday','wednesday','thursday','sunday'], 'Tulum Pueblo', array[]::text[], true, 1),

  ('Reykjavik', 'Golden Circle Day Tour', 'Þingvellir National Park, Geysir, and Gullfoss waterfall in one guided day trip.', 'day-trip', array['outdoors','nature'], 110.00, 540, '{"monday":"08:00-20:00","tuesday":"08:00-20:00","wednesday":"08:00-20:00","thursday":"08:00-20:00","friday":"08:00-20:00","saturday":"08:00-20:00","sunday":"08:00-20:00"}', array[]::text[], 'Golden Circle (day trip from Reykjavik)', array[]::text[], true, 1),
  ('Reykjavik', 'Sky Lagoon Geothermal Spa', 'Oceanfront geothermal lagoon with a multi-step spa ritual.', 'wellness', array['wellness','hot-springs'], 95.00, 180, '{"monday":"07:00-23:00","tuesday":"07:00-23:00","wednesday":"07:00-23:00","thursday":"07:00-23:00","friday":"07:00-23:00","saturday":"07:00-23:00","sunday":"07:00-23:00"}', array[]::text[], 'Kópavogur', array['wheelchair-accessible'], true, 1),
  ('Reykjavik', 'Northern Lights Hunt', 'Evening minibus tour chasing clear skies outside the city''s light pollution — weather dependent, free rebooking.', 'outdoors', array['nature','adventure'], 75.00, 240, '{"monday":"21:00-01:00","tuesday":"21:00-01:00","wednesday":"21:00-01:00","thursday":"21:00-01:00","friday":"21:00-01:00","saturday":"21:00-01:00","sunday":"21:00-01:00"}', array[]::text[], 'Outside Reykjavik (pickup downtown)', array[]::text[], true, 1),

  ('Cape Town', 'Table Mountain Cableway', 'Rotating cable car to the top of Table Mountain for panoramic views over the city and coastline.', 'outdoors', array['outdoors','family'], 30.00, 120, '{"tuesday":"08:00-18:00","wednesday":"08:00-18:00","thursday":"08:00-18:00","friday":"08:00-18:00","saturday":"08:00-18:00","sunday":"08:00-18:00"}', array['monday'], 'Table Mountain', array['wheelchair-accessible'], false, 1),
  ('Cape Town', 'Boulders Beach Penguin Colony', 'Boardwalk visit to see the African penguin colony up close.', 'wildlife', array['outdoors','family'], 15.00, 90, '{"monday":"08:00-17:00","tuesday":"08:00-17:00","wednesday":"08:00-17:00","thursday":"08:00-17:00","friday":"08:00-17:00","saturday":"08:00-17:00","sunday":"08:00-17:00"}', array[]::text[], 'Simon''s Town', array['wheelchair-accessible'], false, 1),
  ('Cape Town', 'Constantia Winelands Tasting Tour', 'Half-day guided tastings at three Constantia valley estates, with a cheese-and-charcuterie pairing.', 'food', array['wine','food'], 85.00, 240, '{"wednesday":"11:00-17:00","thursday":"11:00-17:00","friday":"11:00-17:00","saturday":"11:00-17:00"}', array['sunday','monday','tuesday'], 'Constantia', array[]::text[], true, 1),
  ('Cape Town', 'Cape Point Full-Day Tour', 'Scenic drive down the peninsula to Cape Point and the Cape of Good Hope, with stops along Chapman''s Peak.', 'day-trip', array['outdoors','family'], 90.00, 480, '{"monday":"07:00-18:00","tuesday":"07:00-18:00","wednesday":"07:00-18:00","thursday":"07:00-18:00","friday":"07:00-18:00","saturday":"07:00-18:00","sunday":"07:00-18:00"}', array[]::text[], 'Cape Point (day trip from Cape Town)', array[]::text[], true, 1),

  ('Barcelona', 'Sagrada Família Skip-the-Line Tour', 'Guided visit inside Gaudí''s unfinished basilica, with priority entry.', 'culture', array['culture'], 45.00, 90, '{"monday":"09:00-18:00","tuesday":"09:00-18:00","wednesday":"09:00-18:00","thursday":"09:00-18:00","friday":"09:00-18:00","saturday":"09:00-18:00","sunday":"10:30-18:00"}', array[]::text[], 'Eixample', array['wheelchair-accessible'], true, 1),
  ('Barcelona', 'Park Güell Entry + Gaudí Highlights Walk', 'Timed entry to Park Güell followed by a walking overview of Gaudí''s other major works nearby.', 'culture', array['culture','family'], 38.00, 150, '{"monday":"09:30-17:00","tuesday":"09:30-17:00","wednesday":"09:30-17:00","thursday":"09:30-17:00","friday":"09:30-17:00","saturday":"09:30-17:00","sunday":"09:30-17:00"}', array[]::text[], 'Gràcia', array[]::text[], true, 1),
  -- Deliberately overlapping opening window with the Park Güell activity above,
  -- to exercise itinerary-conflict detection (PROJECT_BRIEF.md §9.2).
  ('Barcelona', 'Gràcia Neighborhood Tapas Crawl', 'Evening-into-afternoon tapas crawl through Gràcia''s bars, timed to overlap the Park Güell walk on purpose for feasibility-engine testing.', 'food', array['food','nightlife'], 58.00, 150, '{"monday":"12:00-22:00","tuesday":"12:00-22:00","wednesday":"12:00-22:00","thursday":"12:00-22:00","friday":"12:00-22:00","saturday":"12:00-22:00","sunday":"12:00-22:00"}', array[]::text[], 'Gràcia', array[]::text[], false, 1),
  ('Barcelona', 'Barceloneta Beach Day', 'Free self-guided beach day with optional loungers and paddleboard rental.', 'leisure', array['beach','family','budget'], 0.00, 300, '{"monday":"08:00-20:00","tuesday":"08:00-20:00","wednesday":"08:00-20:00","thursday":"08:00-20:00","friday":"08:00-20:00","saturday":"08:00-20:00","sunday":"08:00-20:00"}', array[]::text[], 'Barceloneta', array['wheelchair-accessible'], false, 1),

  -- Stale fixture
  ('Lisbon', 'Alfama Walking Food Tour', 'Outdated listing kept only as a stale-inventory fixture.', 'food', array['food'], 59.00, 180, '{}', array[]::text[], 'Alfama', array[]::text[], false, 0);
