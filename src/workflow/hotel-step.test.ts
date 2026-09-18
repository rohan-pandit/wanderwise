import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

vi.mock("@/src/repositories/destinations");
vi.mock("@/src/repositories/flights");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/hotels");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-events");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/workflow-runs");

import { getDestinationByName } from "@/src/repositories/destinations";
import { getFlightsByIds } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { findHotels, getHotelsByIds } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  confirmTripDecisionById,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
  retireProposedTripDecisionsForField,
  supersedeOtherActiveTripDecisions,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import {
  FlightStepNotConfirmedError,
  InvalidHotelSelectionError,
  NoViableHotelCandidatesError,
  confirmHotelStep,
  proposeHotelStep,
} from "./hotel-step";
import { UnknownDestinationError } from "./step-shared";

const supabase = {} as SupabaseClient<Database>;

const TRIP_ID = "trip-1";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };
const LISBON_ID = "destination-lisbon";
const LISBON = { id: LISBON_ID, name: "Lisbon", inventory_version: 1 };

function requirementRow(field: string, value: unknown) {
  return {
    id: `req_${field}`,
    trip_id: TRIP_ID,
    field,
    value,
    unit: null,
    source: "user_explicit",
    confidence: 1,
    status: "active",
    created_at: "2026-09-16T00:00:00Z",
  };
}

const READY_REQUIREMENTS = [
  requirementRow("origin", "New York"),
  requirementRow("destination", "Lisbon"),
  requirementRow("departureDate", "2026-10-05"),
  requirementRow("returnDate", "2026-10-12"),
  requirementRow("partySize", 2),
  requirementRow("budgetTotalUsd", 3000),
];

function decisionRow(field: string, value: unknown, status = "confirmed") {
  return { id: `dec_${field}`, trip_id: TRIP_ID, field, value, status, source: "user_explicit", created_at: "now" };
}

const CONFIRMED_FLIGHT_DECISIONS = [decisionRow("outboundFlight", "o1"), decisionRow("returnFlight", "r1")];

function outboundFlight() {
  return { id: "o1", origin: "New York", destination: "Lisbon", arrival_time: "2026-10-06T09:00:00Z", arrival_time_zone: "Europe/Lisbon" };
}

function returnFlight() {
  return { id: "r1", origin: "Lisbon", destination: "New York", departure_time: "2026-10-12T14:00:00Z", departure_time_zone: "Europe/Lisbon" };
}

function hotel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    destination: "Lisbon",
    destination_id: LISBON_ID,
    price_per_night_usd: 150,
    rating: 4.5,
    room_capacity: 4,
    available_rooms: 5,
    cancellation_policy: "Free cancellation up to 48 hours before check-in",
    inventory_version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDestinationByName).mockResolvedValue(LISBON as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
  vi.mocked(listActiveTripDecisions).mockResolvedValue(CONFIRMED_FLIGHT_DECISIONS as never);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripDecision).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripDecisionsForField).mockResolvedValue(undefined as never);
  vi.mocked(retireProposedTripDecisionsForField).mockResolvedValue(undefined as never);
  vi.mocked(supersedeOtherActiveTripDecisions).mockResolvedValue(undefined as never);
  vi.mocked(confirmTripDecisionById).mockResolvedValue(undefined as never);
  vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) => (ids[0] === "o1" ? [outboundFlight()] : [returnFlight()]) as never);
});

describe("proposeHotelStep", () => {
  it("throws FlightStepNotConfirmedError when the flight step hasn't been confirmed yet", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([]);

    await expect(proposeHotelStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(FlightStepNotConfirmedError);
    expect(findHotels).not.toHaveBeenCalled();
  });

  it("scopes the search to the confirmed flight's derived stay dates", async () => {
    vi.mocked(findHotels).mockResolvedValue([hotel("h1")] as never);

    const result = await proposeHotelStep(supabase, { tripId: TRIP_ID });

    expect(result.hotelStayDates).toEqual({ destinationTimeZone: "Europe/Lisbon", checkIn: "2026-10-06", checkOut: "2026-10-12" });
    expect(findHotels).toHaveBeenCalledWith(supabase, expect.objectContaining({ destinationId: LISBON_ID }));
  });

  it("throws UnknownDestinationError when the trip's destination doesn't resolve to any real destination", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue(null as never);

    await expect(proposeHotelStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(UnknownDestinationError);
    expect(findHotels).not.toHaveBeenCalled();
  });

  it("returns the top 3 cheapest passing hotels and persists them as proposed", async () => {
    vi.mocked(findHotels).mockResolvedValue([
      hotel("cheap", { price_per_night_usd: 100 }),
      hotel("mid", { price_per_night_usd: 150 }),
      hotel("pricier", { price_per_night_usd: 200 }),
      hotel("priciest", { price_per_night_usd: 300 }),
    ] as never);

    const result = await proposeHotelStep(supabase, { tripId: TRIP_ID });

    expect(result.candidates.map((h) => h.id)).toEqual(["cheap", "mid", "pricier"]);
    expect(retireProposedTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "hotel", value: "cheap", status: "proposed", source: "system_computed" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "hotel", value: "mid", status: "proposed", source: "system_computed" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "hotel", value: "pricier", status: "proposed", source: "system_computed" }),
    );
  });

  it("narrows candidates by a maxHotelPriceUsd requirement", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([
      ...READY_REQUIREMENTS,
      requirementRow("maxHotelPriceUsd", 150),
    ] as never);
    vi.mocked(findHotels).mockResolvedValue([
      hotel("cheap", { price_per_night_usd: 150 }),
      hotel("pricier", { price_per_night_usd: 151 }),
    ] as never);

    const result = await proposeHotelStep(supabase, { tripId: TRIP_ID });

    expect(result.candidates.map((h) => h.id)).toEqual(["cheap"]);
  });

  it("rejects a hotel that can't fit the room group, logs the guardrail, and throws NoViableHotelCandidatesError when nothing passes", async () => {
    vi.mocked(findHotels).mockResolvedValue([hotel("too-small", { room_capacity: 1 })] as never);

    await expect(proposeHotelStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(NoViableHotelCandidatesError);
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "hotel_hard_constraints", triggered: true }),
    );
  });

  it("rejects a hotel without enough rooms free for every room group, even though each room's capacity is fine", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([
      ...READY_REQUIREMENTS,
      requirementRow("roomGroups", [
        { occupants: 2, label: "parents" },
        { occupants: 1, label: "kid" },
      ]),
    ] as never);
    vi.mocked(findHotels).mockResolvedValue([hotel("one-room-only", { room_capacity: 4, available_rooms: 1 })] as never);

    await expect(proposeHotelStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(NoViableHotelCandidatesError);
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "hotel_hard_constraints", triggered: true }),
    );
  });

  it("logs a hotel_step_proposed trip event with the ranked candidate ids and stay dates", async () => {
    vi.mocked(findHotels).mockResolvedValue([hotel("h1")] as never);

    await proposeHotelStep(supabase, { tripId: TRIP_ID });

    expect(appendTripEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        eventType: "hotel_step_proposed",
        payload: expect.objectContaining({
          candidates: [expect.objectContaining({ hotelId: "h1" })],
          checkIn: "2026-10-06",
          checkOut: "2026-10-12",
        }),
      }),
    );
  });
});

describe("confirmHotelStep", () => {
  it("persists the hotel as a confirmed decision", async () => {
    vi.mocked(getHotelsByIds).mockResolvedValue([hotel("h1")] as never);

    const result = await confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "h1" });

    expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "hotel", value: "h1", status: "confirmed", source: "user_explicit" }),
    );
    expect(result.hotel.id).toBe("h1");
    expect(appendTripEvent).toHaveBeenCalledWith(supabase, expect.objectContaining({ eventType: "hotel_step_confirmed" }));
  });

  it("promotes a matching proposed candidate in place instead of retiring and reinserting", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      ...CONFIRMED_FLIGHT_DECISIONS,
      decisionRow("hotel", "h1", "proposed"),
    ] as never);
    vi.mocked(getHotelsByIds).mockResolvedValue([hotel("h1")] as never);

    await confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "h1" });

    expect(supersedeOtherActiveTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, "hotel", "dec_hotel");
    expect(confirmTripDecisionById).toHaveBeenCalledWith(supabase, TRIP_ID, "dec_hotel");
    expect(retireActiveTripDecisionsForField).not.toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
    expect(appendTripDecision).not.toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "hotel", status: "confirmed" }),
    );
  });

  it("also supersedes the prior confirmed hotel when promoting a new pick while revising an already-confirmed step", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      ...CONFIRMED_FLIGHT_DECISIONS,
      { id: "dec_hotel_old", trip_id: TRIP_ID, field: "hotel", value: "h-old", status: "confirmed", source: "user_explicit", created_at: "now" },
      { id: "dec_hotel_new", trip_id: TRIP_ID, field: "hotel", value: "h-new", status: "proposed", source: "system_computed", created_at: "now" },
    ] as never);
    vi.mocked(getHotelsByIds).mockResolvedValue([hotel("h-new")] as never);

    await confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "h-new" });

    // supersedeOtherActiveTripDecisions supersedes every OTHER non-superseded
    // row for the field (any status) except the one being kept — that
    // includes the still-confirmed old pick, not just sibling proposals.
    expect(supersedeOtherActiveTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, "hotel", "dec_hotel_new");
    expect(confirmTripDecisionById).toHaveBeenCalledWith(supabase, TRIP_ID, "dec_hotel_new");
  });

  it("throws InvalidHotelSelectionError when the id doesn't resolve to real inventory", async () => {
    vi.mocked(getHotelsByIds).mockResolvedValue([]);

    await expect(confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "missing" })).rejects.toThrow(InvalidHotelSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("throws InvalidHotelSelectionError when the hotel belongs to a different destination", async () => {
    vi.mocked(getHotelsByIds).mockResolvedValue([hotel("wrong-dest", { destination: "Paris", destination_id: "destination-paris" })] as never);

    await expect(confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "wrong-dest" })).rejects.toThrow(InvalidHotelSelectionError);
  });

  it("throws InvalidHotelSelectionError when the hotel shares the trip's destination NAME but belongs to a different destination id (the identifier-space gap docs/IMPLEMENTATION_PLAN.md §5 tracked)", async () => {
    vi.mocked(getHotelsByIds).mockResolvedValue([
      hotel("ambiguous-name", { destination: "Lisbon", destination_id: "destination-a-different-lisbon" }),
    ] as never);

    await expect(confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "ambiguous-name" })).rejects.toThrow(InvalidHotelSelectionError);
  });

  it("throws InvalidHotelSelectionError when the hotel is a stale inventory version (docs/IMPLEMENTATION_PLAN.md §5 defense-in-depth)", async () => {
    vi.mocked(getHotelsByIds).mockResolvedValue([hotel("stale", { inventory_version: 0 })] as never);

    await expect(confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "stale" })).rejects.toThrow(InvalidHotelSelectionError);
  });

  it("throws InvalidHotelSelectionError when the hotel no longer passes hard constraints", async () => {
    vi.mocked(getHotelsByIds).mockResolvedValue([hotel("too-small", { room_capacity: 1 })] as never);

    await expect(confirmHotelStep(supabase, { tripId: TRIP_ID, hotelId: "too-small" })).rejects.toThrow(InvalidHotelSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });
});
