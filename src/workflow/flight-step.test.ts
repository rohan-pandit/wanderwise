import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

vi.mock("@/src/repositories/flights");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-events");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/workflow-runs");

import { findFlights, getFlightsByIds } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { appendTripDecision, retireActiveTripDecisionsForField } from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { OneWayTripNotSupportedError } from "./itinerary-orchestrator";
import {
  InvalidFlightSelectionError,
  NoViableFlightCandidatesError,
  RequirementsNotReadyError,
  confirmFlightStep,
  proposeFlightStep,
} from "./flight-step";

const supabase = {} as SupabaseClient<Database>;

const TRIP_ID = "trip-1";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };

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

function flight(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    origin: "New York",
    destination: "Lisbon",
    price_usd: 500,
    is_red_eye: false,
    departure_time: "2026-10-05T23:00:00Z",
    arrival_time: "2026-10-06T09:00:00Z",
    departure_time_zone: "America/New_York",
    arrival_time_zone: "Europe/Lisbon",
    ...overrides,
  };
}

function returnFlight(id: string, overrides: Record<string, unknown> = {}) {
  return flight(id, {
    origin: "Lisbon",
    destination: "New York",
    departure_time: "2026-10-12T14:00:00Z",
    arrival_time: "2026-10-13T02:00:00Z",
    departure_time_zone: "Europe/Lisbon",
    arrival_time_zone: "America/New_York",
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripDecision).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripDecisionsForField).mockResolvedValue(undefined as never);
});

describe("proposeFlightStep", () => {
  it("throws RequirementsNotReadyError when required fields are missing", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([requirementRow("origin", "New York")] as never);

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(RequirementsNotReadyError);
    expect(findFlights).not.toHaveBeenCalled();
  });

  it("throws OneWayTripNotSupportedError when there's no returnDate", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      READY_REQUIREMENTS.filter((r) => r.field !== "returnDate") as never,
    );

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(OneWayTripNotSupportedError);
  });

  it("searches the return leg in the reversed direction", async () => {
    vi.mocked(findFlights).mockResolvedValue([flight("f1")] as never);

    await proposeFlightStep(supabase, { tripId: TRIP_ID });

    expect(findFlights).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ origin: "New York", destination: "Lisbon", departureDate: "2026-10-05" }),
    );
    expect(findFlights).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ origin: "Lisbon", destination: "New York", departureDate: "2026-10-12" }),
    );
  });

  it("returns the top 3 cheapest passing outbound x return pairs, cheapest first, without persisting anything", async () => {
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.origin === "Lisbon"
        ? [returnFlight("r-cheap", { price_usd: 100 }), returnFlight("r-mid", { price_usd: 200 }), returnFlight("r-expensive", { price_usd: 900 })]
        : [flight("o1", { price_usd: 500 })]) as never,
    );

    const result = await proposeFlightStep(supabase, { tripId: TRIP_ID });

    expect(result.candidates.map((c) => c.returnFlight.id)).toEqual(["r-cheap", "r-mid", "r-expensive"]);
    expect(result.candidates[0].totalPriceUsd).toBe(600);
    expect(result.candidates).toHaveLength(3);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("caps the ranked list at 3 even with more passing pairs", async () => {
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.origin === "Lisbon"
        ? [1, 2, 3, 4, 5].map((n) => returnFlight(`r${n}`, { price_usd: n * 10 }))
        : [flight("o1")]) as never,
    );

    const result = await proposeFlightStep(supabase, { tripId: TRIP_ID });
    expect(result.candidates).toHaveLength(3);
  });

  it("excludes a red-eye outbound flight when noRedEye is required, logs the guardrail, and throws NoViableFlightCandidatesError", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([...READY_REQUIREMENTS, requirementRow("noRedEye", true)] as never);
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.origin === "Lisbon" ? [returnFlight("r1")] : [flight("o1", { is_red_eye: true })]) as never,
    );

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(NoViableFlightCandidatesError);
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "outbound_flight_hard_constraints", triggered: true }),
    );
  });

  it("logs a flight_step_proposed trip event with the ranked candidate ids", async () => {
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.origin === "Lisbon" ? [returnFlight("r1")] : [flight("o1")]) as never,
    );

    await proposeFlightStep(supabase, { tripId: TRIP_ID });

    expect(appendTripEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        eventType: "flight_step_proposed",
        payload: expect.objectContaining({
          candidates: [expect.objectContaining({ outboundFlightId: "o1", returnFlightId: "r1" })],
        }),
      }),
    );
  });
});

describe("confirmFlightStep", () => {
  it("persists both legs as confirmed decisions and returns the derived hotel stay dates", async () => {
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "o1" ? [flight("o1")] : [returnFlight("r1")]) as never,
    );

    const result = await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

    expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "outboundFlight");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "outboundFlight", value: "o1", status: "confirmed", source: "user_explicit" }),
    );
    expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "returnFlight");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "returnFlight", value: "r1", status: "confirmed", source: "user_explicit" }),
    );
    expect(result.hotelStayDates).toEqual({
      destinationTimeZone: "Europe/Lisbon",
      checkIn: "2026-10-06",
      checkOut: "2026-10-12",
    });
    expect(appendTripEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ eventType: "flight_step_confirmed" }),
    );
  });

  it("supersedes a prior confirmation when called again with a different pair", async () => {
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "o2" ? [flight("o2", { price_usd: 400 })] : [returnFlight("r2")]) as never,
    );

    await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o2", returnFlightId: "r2" });

    expect(retireActiveTripDecisionsForField).toHaveBeenCalledTimes(2);
    expect(appendTripDecision).toHaveBeenCalledTimes(2);
  });

  it("throws InvalidFlightSelectionError when an id doesn't resolve to real inventory", async () => {
    vi.mocked(getFlightsByIds).mockResolvedValue([]);

    await expect(
      confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "missing", returnFlightId: "also-missing" }),
    ).rejects.toThrow(InvalidFlightSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("throws InvalidFlightSelectionError when the outbound flight's route doesn't match the trip", async () => {
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "wrong-route" ? [flight("wrong-route", { destination: "Paris" })] : [returnFlight("r1")]) as never,
    );

    await expect(
      confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "wrong-route", returnFlightId: "r1" }),
    ).rejects.toThrow(InvalidFlightSelectionError);
  });

  it("throws InvalidFlightSelectionError when the selection no longer passes hard constraints", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([...READY_REQUIREMENTS, requirementRow("noRedEye", true)] as never);
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "o1" ? [flight("o1", { is_red_eye: true })] : [returnFlight("r1")]) as never,
    );

    await expect(
      confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" }),
    ).rejects.toThrow(InvalidFlightSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });
});
