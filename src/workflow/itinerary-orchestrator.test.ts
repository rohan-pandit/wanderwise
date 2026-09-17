import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { activity as activityFixture, flight, hotel } from "@/src/repositories/fixtures";
import type { MatchedActivity } from "@/src/repositories/activities";

/** `activity()` builds a full `Activity` row; `assembleItinerary` consumes Phase 5's `MatchedActivity` retrieval projection (same fields minus `embedding`, plus `similarity`). */
function activity(overrides: Parameters<typeof activityFixture>[0] = {}): MatchedActivity {
  const row: Partial<ReturnType<typeof activityFixture>> = activityFixture(overrides);
  delete row.embedding;
  return { ...row, similarity: 1 } as MatchedActivity;
}

vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/trip-state");
vi.mock("@/src/repositories/workflow-runs");
vi.mock("./controller");

import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { appendTripDecision, retireActiveTripDecisionsForField } from "@/src/repositories/trip-decisions";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { advanceTrip } from "./controller";
import {
  assembleItinerary,
  InvalidWorkflowStateError,
  NoFeasibleCombinationError,
  OneWayTripNotSupportedError,
} from "./itinerary-orchestrator";

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

const OUTBOUND = flight({
  id: "outbound-1",
  origin: "New York",
  destination: "Lisbon",
  departure_time: "2026-10-05T23:00:00Z",
  arrival_time: "2026-10-06T09:00:00Z",
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

function baseMocks() {
  vi.mocked(getLatestTripState).mockResolvedValue(stateAt("assembling_options") as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(ROUND_TRIP_REQUIREMENTS as never);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripDecision).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripDecisionsForField).mockResolvedValue(undefined);
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
      assembleItinerary(supabase, {
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
      assembleItinerary(supabase, {
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
      assembleItinerary(supabase, {
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

  it("assembles, schedules, and persists a feasible round-trip itinerary end to end", async () => {
    const activities = [
      activity({ id: "act-1", price_usd: 50, duration_minutes: 120, closed_days: [] }),
      activity({ id: "act-2", price_usd: 60, duration_minutes: 90, closed_days: [] }),
    ];

    const result = await assembleItinerary(supabase, {
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
  });

  it("drives itinerary_invalid and throws when no combination fits the budget ceiling", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue(
      ROUND_TRIP_REQUIREMENTS.map((r) => (r.field === "budgetTotalUsd" ? requirementRow("budgetTotalUsd", 10) : r)) as never,
    );

    await expect(
      assembleItinerary(supabase, {
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
      assembleItinerary(supabase, {
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
