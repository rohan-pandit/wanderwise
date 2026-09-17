-- Return-leg flights (Phase 6 continued, slice 2). `flights` is a one-way
-- table and Phase 1's seed data only ever seeded one direction per route
-- (city -> destination), never the reverse — a gap invisible until
-- round-trip search was actually wired and exercised live, since nothing
-- before this needed a "flights returning FROM a destination" query.
-- One reversed-direction leg per unique outbound origin, ~1 week after the
-- corresponding outbound departure date, so a stated `returnDate` has a real
-- candidate to find for every seeded destination.

insert into flights (origin, destination, departure_time, arrival_time, departure_time_zone, arrival_time_zone, airline, flight_number, price_usd, taxes_fees_usd, cabin, is_red_eye, duration_minutes, refundable, changeable, inventory_version)
values
  -- Lisbon -> (2026-10-12, one week after the 2026-10-05 outbound dates)
  ('Lisbon', 'Philadelphia', '2026-10-12T13:00:00+01:00', '2026-10-12T16:35:00-04:00', 'Europe/Lisbon', 'America/New_York', 'TAP Air Portugal', 'TP203', 598.00, 116.00, 'economy', false, 455, false, true, 1),
  ('Lisbon', 'New York', '2026-10-12T11:30:00+01:00', '2026-10-12T14:50:00-04:00', 'Europe/Lisbon', 'America/New_York', 'TAP Air Portugal', 'TP201', 562.00, 114.00, 'economy', false, 440, false, false, 1),
  ('Lisbon', 'Chicago', '2026-10-12T12:15:00+01:00', '2026-10-12T16:40:00-05:00', 'Europe/Lisbon', 'America/Chicago', 'American Airlines', 'AA733', 715.00, 123.00, 'economy', false, 505, true, true, 1),

  -- Kyoto -> (2026-10-15, one week after the 2026-10-08 outbound dates)
  ('Kyoto', 'San Francisco', '2026-10-15T17:40:00+09:00', '2026-10-15T11:05:00-07:00', 'Asia/Tokyo', 'America/Los_Angeles', 'ANA', 'NH8', 1145.00, 215.00, 'economy', false, 625, false, false, 1),
  ('Kyoto', 'Los Angeles', '2026-10-15T18:20:00+09:00', '2026-10-15T12:50:00-07:00', 'Asia/Tokyo', 'America/Los_Angeles', 'Japan Airlines', 'JL61', 1010.00, 202.00, 'economy', false, 690, false, true, 1),
  ('Kyoto', 'Chicago', '2026-10-15T16:05:00+09:00', '2026-10-15T14:20:00-05:00', 'Asia/Tokyo', 'America/Chicago', 'United', 'UA882', 1365.00, 228.00, 'business', false, 740, true, true, 1),

  -- Tulum -> (2026-10-19, one week after the 2026-10-12 outbound dates)
  ('Tulum', 'Miami', '2026-10-19T13:20:00-05:00', '2026-10-19T16:00:00-04:00', 'America/Cancun', 'America/New_York', 'American Airlines', 'AA1030', 305.00, 66.00, 'economy', false, 160, false, false, 1),
  ('Tulum', 'New York', '2026-10-19T10:30:00-05:00', '2026-10-19T14:10:00-04:00', 'America/Cancun', 'America/New_York', 'JetBlue', 'B6104', 350.00, 73.00, 'economy', false, 280, true, true, 1),
  ('Tulum', 'Chicago', '2026-10-19T15:10:00-05:00', '2026-10-19T18:00:00-05:00', 'America/Cancun', 'America/Chicago', 'Spirit', 'NK541', 216.00, 59.00, 'economy', false, 200, false, false, 1),

  -- Reykjavik -> (2026-10-22, one week after the 2026-10-15 outbound dates)
  ('Reykjavik', 'New York', '2026-10-22T11:15:00+00:00', '2026-10-22T13:35:00-04:00', 'Atlantic/Reykjavik', 'America/New_York', 'Icelandair', 'FI632', 468.00, 90.00, 'economy', false, 320, false, true, 1),
  ('Reykjavik', 'Philadelphia', '2026-10-22T10:45:00+00:00', '2026-10-22T13:10:00-04:00', 'Atlantic/Reykjavik', 'America/New_York', 'Icelandair', 'FI634', 445.00, 86.50, 'economy', false, 325, false, false, 1),
  ('Reykjavik', 'Chicago', '2026-10-22T09:20:00+00:00', '2026-10-22T12:50:00-05:00', 'Atlantic/Reykjavik', 'America/Chicago', 'Icelandair', 'FI654', 508.00, 93.00, 'premium_economy', false, 410, true, true, 1),

  -- Cape Town -> (2026-10-27, one week after the 2026-10-20 outbound dates)
  ('Cape Town', 'New York', '2026-10-27T21:10:00+02:00', '2026-10-27T22:50:00-04:00', 'Africa/Johannesburg', 'America/New_York', 'United', 'UA123', 1260.00, 248.00, 'economy', false, 1000, true, true, 1),
  ('Cape Town', 'Chicago', '2026-10-27T20:30:00+02:00', '2026-10-27T23:20:00-05:00', 'Africa/Johannesburg', 'America/Chicago', 'Lufthansa', 'LH494', 1198.00, 241.00, 'economy', false, 1155, false, false, 1),

  -- Barcelona -> (2026-10-10, one week after the 2026-10-03 outbound dates)
  ('Barcelona', 'New York', '2026-10-10T11:20:00+02:00', '2026-10-10T14:15:00-04:00', 'Europe/Madrid', 'America/New_York', 'Delta', 'DL141', 595.00, 116.00, 'economy', false, 455, false, true, 1),
  ('Barcelona', 'Philadelphia', '2026-10-10T10:05:00+02:00', '2026-10-10T13:00:00-04:00', 'Europe/Madrid', 'America/New_York', 'American Airlines', 'AA717', 568.00, 111.00, 'economy', false, 445, false, false, 1),
  ('Barcelona', 'Chicago', '2026-10-10T09:15:00+02:00', '2026-10-10T11:50:00-05:00', 'Europe/Madrid', 'America/Chicago', 'United', 'UA983', 628.00, 120.00, 'economy', false, 535, false, true, 1);
