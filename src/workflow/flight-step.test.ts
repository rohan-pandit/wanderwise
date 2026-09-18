import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

vi.mock("@/src/repositories/destinations");
vi.mock("@/src/repositories/flights");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-events");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/workflow-runs");

import { getDestinationByName } from "@/src/repositories/destinations";
import { findFlights, findFlightsFromProvider, getFlightsByIds } from "@/src/repositories/flights";
import { AirportAmbiguousError, UnknownDestinationError } from "./step-shared";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import {
  appendTripDecision,
  confirmTripDecisions,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
  retireProposedTripDecisionsForField,
  supersedeOtherActiveTripDecisions,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
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
const LISBON_ID = "destination-lisbon";
const LISBON = { id: LISBON_ID, name: "Lisbon", country: "Portugal", inventory_version: 1 };

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
    origin_id: null,
    destination: "Lisbon",
    destination_id: LISBON_ID,
    price_usd: 500,
    is_red_eye: false,
    departure_time: "2026-10-05T23:00:00Z",
    arrival_time: "2026-10-06T09:00:00Z",
    departure_time_zone: "America/New_York",
    arrival_time_zone: "Europe/Lisbon",
    inventory_version: 1,
    ...overrides,
  };
}

function returnFlight(id: string, overrides: Record<string, unknown> = {}) {
  return flight(id, {
    origin: "Lisbon",
    origin_id: LISBON_ID,
    destination: "New York",
    destination_id: null,
    departure_time: "2026-10-12T14:00:00Z",
    arrival_time: "2026-10-13T02:00:00Z",
    departure_time_zone: "Europe/Lisbon",
    arrival_time_zone: "America/New_York",
    ...overrides,
  });
}

function decisionRow(field: string, value: unknown, status = "confirmed") {
  return { id: `dec_${field}_${status}`, trip_id: TRIP_ID, field, value, status, source: "user_explicit", created_at: "now" };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDestinationByName).mockResolvedValue(LISBON as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripDecision).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripDecisionsForField).mockResolvedValue(undefined as never);
  vi.mocked(retireProposedTripDecisionsForField).mockResolvedValue(undefined as never);
  vi.mocked(supersedeOtherActiveTripDecisions).mockResolvedValue(undefined as never);
  vi.mocked(confirmTripDecisions).mockResolvedValue(undefined as never);
  vi.mocked(listActiveTripDecisions).mockResolvedValue([]);
});

describe("proposeFlightStep", () => {
  it("throws RequirementsNotReadyError when required fields are missing", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([requirementRow("origin", "New York")] as never);

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(RequirementsNotReadyError);
    expect(findFlights).not.toHaveBeenCalled();
  });

  it("throws RequirementsNotReadyError when returnDate is missing (a one-way trip needs a clarification, not a silent default)", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      READY_REQUIREMENTS.filter((r) => r.field !== "returnDate") as never,
    );

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(RequirementsNotReadyError);
    expect(findFlights).not.toHaveBeenCalled();
  });

  it("throws UnknownDestinationError when the trip's destination doesn't resolve to any real destination", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue(null as never);

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(UnknownDestinationError);
    expect(findFlights).not.toHaveBeenCalled();
  });

  it("splits a 'City, Country' destination requirement before resolving it (found live: \"Madrid, Spain\" failed to match a destination seeded as exactly \"Madrid\")", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      READY_REQUIREMENTS.map((r) => (r.field === "destination" ? requirementRow("destination", "Madrid, Spain") : r)) as never,
    );
    vi.mocked(findFlights).mockResolvedValue([flight("f1")] as never);

    await proposeFlightStep(supabase, { tripId: TRIP_ID });

    expect(getDestinationByName).toHaveBeenCalledWith(supabase, "Madrid", 1, "Spain");
  });

  it("uses the live provider instead of findFlights when flightProvider is set, resolving real airport codes for both legs", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      READY_REQUIREMENTS.map((r) => (r.field === "origin" ? requirementRow("origin", "Boston") : r)) as never, // Boston -> BOS, unambiguous
    );
    vi.mocked(findFlightsFromProvider).mockResolvedValue([flight("f1")] as never);
    const provider = { name: "serpapi", search: vi.fn() };

    await proposeFlightStep(supabase, { tripId: TRIP_ID, flightProvider: provider });

    expect(findFlights).not.toHaveBeenCalled();
    expect(findFlightsFromProvider).toHaveBeenCalledWith(
      supabase,
      provider,
      expect.objectContaining({ originAirportCode: "BOS", destinationAirportCode: "LIS", departureDate: "2026-10-05" }),
    );
    expect(findFlightsFromProvider).toHaveBeenCalledWith(
      supabase,
      provider,
      expect.objectContaining({ originAirportCode: "LIS", destinationAirportCode: "BOS", departureDate: "2026-10-12" }),
    );
  });

  it("throws AirportAmbiguousError (a bug signal, not reachable through normal use) if flightProvider is set but the origin is still ambiguous at search time", async () => {
    // "New York" (the default READY_REQUIREMENTS origin) resolves to two
    // real airports (JFK/LGA) with no originAirportCode disambiguation
    // stored — this should never happen in practice, since
    // `checkAirportReadiness` gates `requirements_ready` on it, but the
    // flight step itself must still fail loudly rather than silently guess.
    const provider = { name: "serpapi", search: vi.fn() };

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID, flightProvider: provider })).rejects.toThrow(
      AirportAmbiguousError,
    );
    expect(findFlightsFromProvider).not.toHaveBeenCalled();
  });

  it("resolves an ambiguous origin via the stored originAirportCode requirement when flightProvider is set", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([
      ...READY_REQUIREMENTS,
      requirementRow("originAirportCode", "LGA"),
    ] as never);
    vi.mocked(findFlightsFromProvider).mockResolvedValue([flight("f1")] as never);
    const provider = { name: "serpapi", search: vi.fn() };

    await proposeFlightStep(supabase, { tripId: TRIP_ID, flightProvider: provider });

    expect(findFlightsFromProvider).toHaveBeenCalledWith(
      supabase,
      provider,
      expect.objectContaining({ originAirportCode: "LGA" }),
    );
  });

  it("searches the return leg in the reversed direction", async () => {
    vi.mocked(findFlights).mockResolvedValue([flight("f1")] as never);

    await proposeFlightStep(supabase, { tripId: TRIP_ID });

    expect(findFlights).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ origin: "New York", destinationId: LISBON_ID, departureDate: "2026-10-05" }),
    );
    expect(findFlights).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ originId: LISBON_ID, destination: "New York", departureDate: "2026-10-12" }),
    );
  });

  it("returns the top 3 cheapest passing outbound x return pairs, cheapest first, and persists them as proposed", async () => {
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.originId === LISBON_ID
        ? [returnFlight("r-cheap", { price_usd: 100 }), returnFlight("r-mid", { price_usd: 200 }), returnFlight("r-expensive", { price_usd: 900 })]
        : [flight("o1", { price_usd: 500 })]) as never,
    );

    const result = await proposeFlightStep(supabase, { tripId: TRIP_ID });

    expect(result.candidates.map((c) => c.returnFlight.id)).toEqual(["r-cheap", "r-mid", "r-expensive"]);
    expect(result.candidates[0].totalPriceUsd).toBe(600);
    expect(result.candidates).toHaveLength(3);
    expect(retireProposedTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "outboundFlight");
    expect(retireProposedTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "returnFlight");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "outboundFlight", value: "o1", status: "proposed", source: "system_computed" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "returnFlight", value: "r-cheap", status: "proposed", source: "system_computed" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "returnFlight", value: "r-expensive", status: "proposed", source: "system_computed" }),
    );
  });

  it("caps the ranked list at 3 even with more passing pairs", async () => {
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.originId === LISBON_ID
        ? [1, 2, 3, 4, 5].map((n) => returnFlight(`r${n}`, { price_usd: n * 10 }))
        : [flight("o1")]) as never,
    );

    const result = await proposeFlightStep(supabase, { tripId: TRIP_ID });
    expect(result.candidates).toHaveLength(3);
  });

  it("excludes a red-eye outbound flight when noRedEye is required, logs the guardrail, and throws NoViableFlightCandidatesError", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([...READY_REQUIREMENTS, requirementRow("noRedEye", true)] as never);
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.originId === LISBON_ID ? [returnFlight("r1")] : [flight("o1", { is_red_eye: true })]) as never,
    );

    await expect(proposeFlightStep(supabase, { tripId: TRIP_ID })).rejects.toThrow(NoViableFlightCandidatesError);
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "outbound_flight_hard_constraints", triggered: true }),
    );
  });

  it("logs a flight_step_proposed trip event with the ranked candidate ids", async () => {
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.originId === LISBON_ID ? [returnFlight("r1")] : [flight("o1")]) as never,
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

  it("promotes a matching proposed candidate in place instead of retiring and reinserting", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1", "proposed"),
      decisionRow("returnFlight", "r1", "proposed"),
    ] as never);
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "o1" ? [flight("o1")] : [returnFlight("r1")]) as never,
    );

    await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

    expect(supersedeOtherActiveTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, "outboundFlight", "dec_outboundFlight_proposed");
    expect(confirmTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, ["outboundFlight"]);
    expect(supersedeOtherActiveTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, "returnFlight", "dec_returnFlight_proposed");
    expect(confirmTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, ["returnFlight"]);
    expect(retireActiveTripDecisionsForField).not.toHaveBeenCalledWith(supabase, TRIP_ID, "outboundFlight");
    expect(retireActiveTripDecisionsForField).not.toHaveBeenCalledWith(supabase, TRIP_ID, "returnFlight");
    expect(appendTripDecision).not.toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "outboundFlight", status: "confirmed" }),
    );
  });

  it("also supersedes the prior confirmed pair when promoting a new pick while revising an already-confirmed step", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o-old", "confirmed"),
      decisionRow("returnFlight", "r-old", "confirmed"),
      decisionRow("outboundFlight", "o-new", "proposed"),
      decisionRow("returnFlight", "r-new", "proposed"),
    ] as never);
    const flightsById: Record<string, unknown> = {
      "o-old": flight("o-old"),
      "r-old": returnFlight("r-old"),
      "o-new": flight("o-new"),
      "r-new": returnFlight("r-new"),
    };
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) => [flightsById[ids[0]]] as never);

    await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o-new", returnFlightId: "r-new" });

    // supersedeOtherActiveTripDecisions supersedes every OTHER non-superseded
    // row for the field (any status), so the still-confirmed old pair is
    // cleared too, not just sibling proposals.
    expect(supersedeOtherActiveTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, "outboundFlight", "dec_outboundFlight_proposed");
    expect(supersedeOtherActiveTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, "returnFlight", "dec_returnFlight_proposed");
    expect(confirmTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, ["outboundFlight"]);
    expect(confirmTripDecisions).toHaveBeenCalledWith(supabase, TRIP_ID, ["returnFlight"]);
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
      (ids[0] === "wrong-route"
        ? [flight("wrong-route", { destination: "Paris", destination_id: "destination-paris" })]
        : [returnFlight("r1")]) as never,
    );

    await expect(
      confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "wrong-route", returnFlightId: "r1" }),
    ).rejects.toThrow(InvalidFlightSelectionError);
  });

  it("throws InvalidFlightSelectionError when the outbound flight shares the trip's destination NAME but belongs to a different destination id (the identifier-space gap docs/IMPLEMENTATION_PLAN.md §5 tracked)", async () => {
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "ambiguous-name"
        ? [flight("ambiguous-name", { destination: "Lisbon", destination_id: "destination-a-different-lisbon" })]
        : [returnFlight("r1")]) as never,
    );

    await expect(
      confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "ambiguous-name", returnFlightId: "r1" }),
    ).rejects.toThrow(InvalidFlightSelectionError);
  });

  it("throws InvalidFlightSelectionError when a flight is a stale inventory version (docs/IMPLEMENTATION_PLAN.md §5 defense-in-depth)", async () => {
    vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) =>
      (ids[0] === "stale" ? [flight("stale", { inventory_version: 0 })] : [returnFlight("r1")]) as never,
    );

    await expect(
      confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "stale", returnFlightId: "r1" }),
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

  describe("flight->hotel cascade", () => {
    // A distinct prior confirmed pair with the *same* derived stay dates as
    // the new "o1"/"r1" selection (2026-10-06 -> 2026-10-12).
    const SAME_DATES_PRIOR_OUTBOUND = flight("o-old", { arrival_time: "2026-10-06T09:00:00Z" });
    const SAME_DATES_PRIOR_RETURN = returnFlight("r-old", { departure_time: "2026-10-12T14:00:00Z" });
    // A prior confirmed pair whose derived stay dates *differ* from the new selection.
    const DIFFERENT_DATES_PRIOR_OUTBOUND = flight("o-old", { arrival_time: "2026-10-07T09:00:00Z" });
    const DIFFERENT_DATES_PRIOR_RETURN = returnFlight("r-old", { departure_time: "2026-10-14T14:00:00Z" });

    function mockFlightsById(map: Record<string, unknown>) {
      vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) => {
        const row = map[ids[0]];
        return (row ? [row] : []) as never;
      });
    }

    it("leaves an existing confirmed hotel decision untouched when the new flight's derived stay dates are unchanged", async () => {
      vi.mocked(listActiveTripDecisions).mockResolvedValue([
        decisionRow("outboundFlight", "o-old"),
        decisionRow("returnFlight", "r-old"),
        decisionRow("hotel", "hotel-1"),
      ] as never);
      mockFlightsById({
        "o-old": SAME_DATES_PRIOR_OUTBOUND,
        "r-old": SAME_DATES_PRIOR_RETURN,
        o1: flight("o1"),
        r1: returnFlight("r1"),
      });

      await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

      expect(retireActiveTripDecisionsForField).not.toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
      expect(appendTripEvent).not.toHaveBeenCalledWith(supabase, expect.objectContaining({ eventType: "hotel_step_invalidated" }));
    });

    it("retires an existing confirmed hotel decision and logs hotel_step_invalidated when the derived stay dates differ", async () => {
      vi.mocked(listActiveTripDecisions).mockResolvedValue([
        decisionRow("outboundFlight", "o-old"),
        decisionRow("returnFlight", "r-old"),
        decisionRow("hotel", "hotel-1"),
      ] as never);
      mockFlightsById({
        "o-old": DIFFERENT_DATES_PRIOR_OUTBOUND,
        "r-old": DIFFERENT_DATES_PRIOR_RETURN,
        o1: flight("o1"),
        r1: returnFlight("r1"),
      });

      await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

      expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
      expect(appendTripEvent).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          eventType: "hotel_step_invalidated",
          payload: expect.objectContaining({ reason: "flight_dates_changed" }),
        }),
      );
    });

    it("also retires an existing confirmed activities decision when the derived stay dates differ", async () => {
      vi.mocked(listActiveTripDecisions).mockResolvedValue([
        decisionRow("outboundFlight", "o-old"),
        decisionRow("returnFlight", "r-old"),
        decisionRow("hotel", "hotel-1"),
        decisionRow("activities", "[]"),
      ] as never);
      mockFlightsById({
        "o-old": DIFFERENT_DATES_PRIOR_OUTBOUND,
        "r-old": DIFFERENT_DATES_PRIOR_RETURN,
        o1: flight("o1"),
        r1: returnFlight("r1"),
      });

      await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

      expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "activities");
      expect(appendTripEvent).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({ eventType: "activities_step_invalidated" }),
      );
    });

    it("doesn't invalidate anything when there's no existing hotel decision, even if dates changed", async () => {
      vi.mocked(listActiveTripDecisions).mockResolvedValue([
        decisionRow("outboundFlight", "o-old"),
        decisionRow("returnFlight", "r-old"),
      ] as never);
      mockFlightsById({
        "o-old": DIFFERENT_DATES_PRIOR_OUTBOUND,
        "r-old": DIFFERENT_DATES_PRIOR_RETURN,
        o1: flight("o1"),
        r1: returnFlight("r1"),
      });

      await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

      expect(retireActiveTripDecisionsForField).not.toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
      expect(appendTripEvent).not.toHaveBeenCalledWith(supabase, expect.objectContaining({ eventType: "hotel_step_invalidated" }));
    });

    it("doesn't invalidate anything on the very first confirmation (no prior confirmed flight at all)", async () => {
      vi.mocked(listActiveTripDecisions).mockResolvedValue([]);
      mockFlightsById({ o1: flight("o1"), r1: returnFlight("r1") });

      await confirmFlightStep(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });

      expect(retireActiveTripDecisionsForField).not.toHaveBeenCalledWith(supabase, TRIP_ID, "hotel");
    });
  });
});
