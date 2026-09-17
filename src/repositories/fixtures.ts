/**
 * Test-only builders for repository row shapes, shared across domain/
 * validation test files so each one doesn't redefine its own copy. Not
 * imported by any production code.
 */
import type { Activity } from "./activities";
import type { Flight } from "./flights";
import type { Hotel } from "./hotels";

/** Fixture `destinations.id` for "Lisbon" — the seeded destination every other fixture in this file is set in. */
export const LISBON_DESTINATION_ID = "destination-lisbon";

export function flight(overrides: Partial<Flight> = {}): Flight {
  return {
    id: "flight-1",
    origin: "New York",
    origin_id: null,
    destination: "Lisbon",
    destination_id: LISBON_DESTINATION_ID,
    departure_time: "2026-10-05T23:00:00Z",
    arrival_time: "2026-10-06T09:00:00Z",
    departure_time_zone: "America/New_York",
    arrival_time_zone: "Europe/Lisbon",
    airline: "TAP",
    flight_number: "TP202",
    price_usd: 500,
    taxes_fees_usd: 80,
    cabin: "economy",
    is_red_eye: false,
    duration_minutes: 420,
    refundable: false,
    changeable: true,
    inventory_version: 1,
    ...overrides,
  };
}

export function hotel(overrides: Partial<Hotel> = {}): Hotel {
  return {
    id: "hotel-1",
    destination: "Lisbon",
    destination_id: LISBON_DESTINATION_ID,
    name: "Hotel Alfama",
    neighborhood: "Alfama",
    price_per_night_usd: 150,
    taxes_fees_usd: 20,
    rating: 4.2,
    room_capacity: 2,
    amenities: ["wifi"],
    cancellation_policy: "Free cancellation up to 48 hours before check-in",
    vibe_tags: ["culture"],
    inventory_version: 1,
    ...overrides,
  };
}

export function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "activity-1",
    destination: "Lisbon",
    destination_id: LISBON_DESTINATION_ID,
    name: "Alfama Walking Tour",
    description: null,
    category: "food",
    vibe_tags: ["food"],
    price_usd: 89,
    duration_minutes: 180,
    opening_hours: null,
    closed_days: ["monday"],
    location: "Alfama",
    accessibility_attributes: [],
    reservation_required: true,
    inventory_version: 1,
    embedding: null,
    ...overrides,
  };
}
