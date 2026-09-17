-- A second Lisbon -> New York return-leg flight, on a different departure
-- date than the one 0006_return_flights.sql seeded (2026-10-12). Closes the
-- last of the tracked seed-data gaps (docs/IMPLEMENTATION_PLAN.md §5): the
-- flight->hotel cascade's "dates changed" branch (confirmFlightStep retiring
-- a confirmed hotel decision when a re-confirmed flight's derived stay dates
-- differ, src/workflow/flight-step.ts) had no second real return date to
-- swap in for a live-verification round-trip against the hosted project —
-- only the "same dates -> untouched" direction had ever been exercised live.
-- One week later than the existing return leg, same style/price range as
-- 0006_return_flights.sql's other Lisbon rows.

insert into flights (origin, destination, departure_time, arrival_time, departure_time_zone, arrival_time_zone, airline, flight_number, price_usd, taxes_fees_usd, cabin, is_red_eye, duration_minutes, refundable, changeable, inventory_version)
values
  ('Lisbon', 'New York', '2026-10-19T11:45:00+01:00', '2026-10-19T15:05:00-04:00', 'Europe/Lisbon', 'America/New_York', 'TAP Air Portugal', 'TP205', 579.00, 115.00, 'economy', false, 440, false, true, 1);
