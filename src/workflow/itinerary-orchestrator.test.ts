import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import { activity as activityFixture, flight, hotel } from "@/src/repositories/fixtures";
import type { MatchedActivity } from "@/src/repositories/activities";

/** `activity()` builds a full `Activity` row; the itinerary orchestrator consumes Phase 5's `MatchedActivity` retrieval projection (same fields minus `embedding`, plus `similarity`). */
function activity(overrides: Parameters<typeof activityFixture>[0] = {}): MatchedActivity {
  const row: Partial<ReturnType<typeof activityFixture>> = activityFixture(overrides);
  delete row.embedding;
  return { ...row, similarity: 1 } as MatchedActivity;
}

vi.mock("@/src/agents/itinerary-writer");
vi.mock("@/src/repositories/agent-runs");
vi.mock("@/src/repositories/activities");
vi.mock("@/src/repositories/flights");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/hotels");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/trip-state");
vi.mock("@/src/repositories/workflow-runs");
vi.mock("./controller");

import { runItineraryWriterAgent } from "@/src/agents/itinerary-writer";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { getActivitiesByIds } from "@/src/repositories/activities";
import { findFlights, getFlightsByIds } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { findHotels, getHotelsByIds } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
} from "@/src/repositories/trip-decisions";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { advanceTrip } from "./controller";
import {
  assembleItinerary,
  InvalidWorkflowStateError,
  NoFeasibleCombinationError,
  OneWayTripNotSupportedError,
  reviseItinerary,
  UnsupportedDecisionFieldError,
} from "./itinerary-orchestrator";

const supabase = {} as SupabaseClient<Database>;
const modelClient = { model: "claude-sonnet-5" } as ModelClient;
const TRIP_ID = "trip-1";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };
const AGENT_RUN = { id: "agent-run-1" };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

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

const ROUND_TRIP_REQUIREMENTS = [
  requirementRow("origin", "New York"),
  requirementRow("destination", "Lisbon"),
  requirementRow("departureDate", "2026-10-05"),
  requirementRow("returnDate", "2026-10-12"),
  requirementRow("partySize", 2),
  requirementRow("budgetTotalUsd", 5000),
];

function stateAt(workflowState: string) {
  return { version: 5, state: { workflowState }, actor: "system", operationType: "x", correlationId: null, createdAt: "now" };
}

function decisionRow(field: string, value: unknown) {
  return { id: `dec_${field}`, trip_id: TRIP_ID, field, value, source: "system_computed", status: "proposed", created_at: "now" };
}

const OUTBOUND = flight({
  id: "outbound-1",
  origin: "New York",
  destination: "Lisbon",
  departure_time: "2026-10-05T23:00:00Z",
  arrival_time: "2026-10-06T09:00:00Z",
  departure_time_zone: "America/New_York",
  arrival_time_zone: "Europe/Lisbon",
});

const OUTBOUND_ALT = flight({
  id: "outbound-2",
  origin: "New York",
  destination: "Lisbon",
  price_usd: 400,
  departure_time: "2026-10-05T22:00:00Z",
  arrival_time: "2026-10-06T08:00:00Z",
  departure_time_zone: "America/New_York",
  arrival_time_zone: "Europe/Lisbon",
});

const RETURN = flight({
  id: "return-1",
  origin: "Lisbon",
  destination: "New York",
  departure_time: "2026-10-12T20:00:00Z",
  arrival_time: "2026-10-13T06:00:00Z",
  departure_time_zone: "Europe/Lisbon",
  arrival_time_zone: "America/New_York",
});

const HOTEL = hotel({ id: "hotel-1", room_capacity: 2 });
const HOTEL_ALT = hotel({ id: "hotel-2", room_capacity: 2, price_per_night_usd: 100 });

function writerResult(overrides: Record<string, unknown> = {}) {
  return {
    itinerary: { explanation: "Day 1: arrive and settle in.", groundedIds: ["outbound-1", "return-1", "hotel-1"] },
    referenceCheck: { valid: true, unresolvedIds: [] },
    assistantMessage: "",
    toolCallLog: [{ toolName: "write_itinerary", input: {}, status: "success", result: {} }],
    usage: ZERO_USAGE,
    stopReason: "tool_use",
    ...overrides,
  };
}

function baseMocks() {
  vi.mocked(getLatestTripState).mockResolvedValue(stateAt("assembling_options") as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(ROUND_TRIP_REQUIREMENTS as never);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripDecision).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripDecisionsForField).mockResolvedValue(undefined);
  vi.mocked(recordAgentRun).mockResolvedValue(AGENT_RUN as never);
  vi.mocked(recordToolCalls).mockResolvedValue([]);
  vi.mocked(runItineraryWriterAgent).mockResolvedValue(writerResult() as never);
  vi.mocked(advanceTrip).mockImplementation(
    async (_s, transitionParams) =>
      ({
        status: "applied",
        fromState: "x",
        toState:
          transitionParams.event === "combinations_assembled"
            ? "validating_itinerary"
            : transitionParams.event === "itinerary_valid"
              ? "presenting_draft"
              : transitionParams.event === "itinerary_invalid"
                ? "assembling_options"
                : transitionParams.event === "revision_requested"
                  ? "awaiting_user_revision"
                  : transitionParams.event === "revision_submitted"
                    ? "applying_revision"
                    : transitionParams.event === "revision_applied"
                      ? "validating_itinerary"
                      : "x",
        version: 10,
      }) as never,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  baseMocks();
});

describe("assembleItinerary", () => {
  it("throws InvalidWorkflowStateError when the trip isn't in assembling_options", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("validating_candidates") as never);

    await expect(
      assembleItinerary(supabase, modelClient, {
        tripId: TRIP_ID,
        outboundFlights: [OUTBOUND],
        returnFlights: [RETURN],
        hotels: [HOTEL],
        activities: [],
        curation: null,
      }),
    ).rejects.toThrow(InvalidWorkflowStateError);
  });

  it("throws if the trip has no state history", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(null);

    await expect(
      assembleItinerary(supabase, modelClient, {
        tripId: TRIP_ID,
        outboundFlights: [OUTBOUND],
        returnFlights: [RETURN],
        hotels: [HOTEL],
        activities: [],
        curation: null,
      }),
    ).rejects.toThrow("no state history");
  });

  it("throws OneWayTripNotSupportedError when returnDate isn't stated", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      ROUND_TRIP_REQUIREMENTS.filter((r) => r.field !== "returnDate") as never,
    );

    await expect(
      assembleItinerary(supabase, modelClient, {
        tripId: TRIP_ID,
        outboundFlights: [OUTBOUND],
        returnFlights: [],
        hotels: [HOTEL],
        activities: [],
        curation: null,
      }),
    ).rejects.toThrow(OneWayTripNotSupportedError);
    expect(advanceTrip).not.toHaveBeenCalled();
  });

  it("assembles, schedules, writes, and persists a feasible round-trip itinerary end to end", async () => {
    const activities = [
      activity({ id: "act-1", price_usd: 50, duration_minutes: 120, closed_days: [] }),
      activity({ id: "act-2", price_usd: 60, duration_minutes: 90, closed_days: [] }),
    ];

    const result = await assembleItinerary(supabase, modelClient, {
      tripId: TRIP_ID,
      outboundFlights: [OUTBOUND],
      returnFlights: [RETURN],
      hotels: [HOTEL],
      activities,
      curation: { rankedIds: ["act-2", "act-1"], excludedIds: [], rationale: "good fit" },
    });

    expect(advanceTrip).toHaveBeenNthCalledWith(1, supabase, expect.objectContaining({ event: "combinations_assembled" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(2, supabase, expect.objectContaining({ event: "itinerary_valid" }));
    expect(result.workflowState).toBe("presenting_draft");
    expect(result.feasibility.valid).toBe(true);
    expect(result.combination.outboundFlight.id).toBe("outbound-1");
    expect(result.combination.returnFlight?.id).toBe("return-1");
    expect(result.draft.hotelStay.checkIn).toBe("2026-10-06");
    expect(result.draft.hotelStay.checkOut).toBe("2026-10-12");
    expect(result.itineraryText).toBe("Day 1: arrive and settle in.");
    // Curation ranked act-2 first, so it should claim the earlier slot.
    const firstSlot = [...result.draft.scheduledActivities].sort((a, b) => a.startMinutes - b.startMinutes)[0];
    expect(firstSlot.id).toBe("act-2");

    expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "outboundFlight");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "outboundFlight", value: "outbound-1" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "returnFlight", value: "return-1" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "hotel", value: "hotel-1" }));
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "budget" }));
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "itineraryText", value: "Day 1: arrive and settle in." }),
    );
  });

  it("doesn't persist itineraryText, and still succeeds, when the Writer agent fails", async () => {
    vi.mocked(runItineraryWriterAgent).mockRejectedValue(new Error("model unavailable"));

    const result = await assembleItinerary(supabase, modelClient, {
      tripId: TRIP_ID,
      outboundFlights: [OUTBOUND],
      returnFlights: [RETURN],
      hotels: [HOTEL],
      activities: [],
      curation: null,
    });

    expect(result.workflowState).toBe("presenting_draft");
    expect(result.itineraryText).toBeNull();
    expect(appendTripDecision).not.toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "itineraryText" }));
    expect(recordAgentRun).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ agentName: "itinerary_writer", status: "error", errorMessage: "model unavailable" }),
    );
  });

  it("drives itinerary_invalid and throws when no combination fits the budget ceiling", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      ROUND_TRIP_REQUIREMENTS.map((r) => (r.field === "budgetTotalUsd" ? requirementRow("budgetTotalUsd", 10) : r)) as never,
    );

    await expect(
      assembleItinerary(supabase, modelClient, {
        tripId: TRIP_ID,
        outboundFlights: [OUTBOUND],
        returnFlights: [RETURN],
        hotels: [HOTEL],
        activities: [],
        curation: null,
      }),
    ).rejects.toThrow(NoFeasibleCombinationError);

    expect(advanceTrip).toHaveBeenCalledWith(supabase, expect.objectContaining({ event: "itinerary_invalid" }));
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "itinerary_feasibility", triggered: true }),
    );
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("drives itinerary_invalid and throws when an activity can never be scheduled (closed every day)", async () => {
    const neverOpenActivity = activity({
      id: "always-closed",
      price_usd: 10,
      closed_days: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    });

    await expect(
      assembleItinerary(supabase, modelClient, {
        tripId: TRIP_ID,
        outboundFlights: [OUTBOUND],
        returnFlights: [RETURN],
        hotels: [HOTEL],
        activities: [neverOpenActivity],
        curation: null,
      }),
    ).rejects.toThrow(NoFeasibleCombinationError);

    expect(advanceTrip).toHaveBeenCalledWith(supabase, expect.objectContaining({ event: "itinerary_invalid" }));
    expect(appendTripDecision).not.toHaveBeenCalled();
  });
});

describe("reviseItinerary", () => {
  function baseRevisionMocks() {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("presenting_draft") as never);
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "outbound-1"),
      decisionRow("returnFlight", "return-1"),
      decisionRow("hotel", "hotel-1"),
      decisionRow("activities", []),
      decisionRow("budget", {}),
    ] as never);
    vi.mocked(getFlightsByIds).mockImplementation(
      async (_s, ids) => [OUTBOUND, RETURN].filter((f) => ids.includes(f.id)) as never,
    );
    vi.mocked(getHotelsByIds).mockResolvedValue([HOTEL] as never);
    vi.mocked(getActivitiesByIds).mockResolvedValue([]);
    vi.mocked(findFlights).mockResolvedValue([]);
    vi.mocked(findHotels).mockResolvedValue([]);
  }

  beforeEach(() => {
    baseRevisionMocks();
  });

  it("throws InvalidWorkflowStateError when not presenting_draft or awaiting_confirmation", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("assembling_options") as never);

    await expect(reviseItinerary(supabase, modelClient, { tripId: TRIP_ID, field: "hotel" })).rejects.toThrow(
      InvalidWorkflowStateError,
    );
  });

  it("throws UnsupportedDecisionFieldError for a field other than outboundFlight/returnFlight/hotel", async () => {
    await expect(
      // @ts-expect-error deliberately invalid field for this test
      reviseItinerary(supabase, modelClient, { tripId: TRIP_ID, field: "activities" }),
    ).rejects.toThrow(UnsupportedDecisionFieldError);
  });

  it("drives revision_requested -> revision_submitted -> revision_applied -> itinerary_valid and switches to a cheaper hotel", async () => {
    vi.mocked(findHotels).mockResolvedValue([HOTEL_ALT] as never);

    const result = await reviseItinerary(supabase, modelClient, { tripId: TRIP_ID, field: "hotel" });

    expect(advanceTrip).toHaveBeenNthCalledWith(1, supabase, expect.objectContaining({ event: "revision_requested" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(2, supabase, expect.objectContaining({ event: "revision_submitted" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(3, supabase, expect.objectContaining({ event: "revision_applied" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(4, supabase, expect.objectContaining({ event: "itinerary_valid" }));
    expect(result.combination.hotel.id).toBe("hotel-2");
    expect(result.workflowState).toBe("presenting_draft");
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "hotel", value: "hotel-2" }));
  });

  it("switches to a different outbound flight, excluding the current one", async () => {
    vi.mocked(findFlights).mockResolvedValue([OUTBOUND, OUTBOUND_ALT] as never);

    const result = await reviseItinerary(supabase, modelClient, { tripId: TRIP_ID, field: "outboundFlight" });

    expect(result.combination.outboundFlight.id).toBe("outbound-2");
  });

  it("keeps the current selection and logs a guardrail when no alternative passes hard constraints", async () => {
    vi.mocked(findHotels).mockResolvedValue([]); // no alternatives at all

    const result = await reviseItinerary(supabase, modelClient, { tripId: TRIP_ID, field: "hotel" });

    expect(result.combination.hotel.id).toBe("hotel-1");
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "revision_no_alternative", triggered: true }),
    );
  });
});
