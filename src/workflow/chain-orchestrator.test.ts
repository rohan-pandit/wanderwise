import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";

vi.mock("@/src/repositories/trip-decisions");
vi.mock("./activities-step");
vi.mock("./flight-step");
vi.mock("./hotel-step");

import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import { confirmActivitiesStep, proposeActivitiesStep } from "./activities-step";
import { runStepwiseChain, runStepwiseRevision } from "./chain-orchestrator";
import { confirmFlightStep, proposeFlightStep } from "./flight-step";
import { confirmHotelStep, proposeHotelStep } from "./hotel-step";

const supabase = {} as SupabaseClient<Database>;
const TRIP_ID = "trip-1";
const clients = {
  curatorModelClient: {} as ModelClient,
  writerModelClient: {} as ModelClient,
  embeddingClient: {} as EmbeddingClient,
};

function decisionRow(field: string, value: string, status = "confirmed") {
  return { id: `dec_${field}`, trip_id: TRIP_ID, field, value, status, source: "user_explicit", created_at: "now" };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(proposeFlightStep).mockResolvedValue({
    candidates: [{ outboundFlight: { id: "o1" }, returnFlight: { id: "r1" }, totalPriceUsd: 1000 }],
  } as never);
  vi.mocked(confirmFlightStep).mockResolvedValue({} as never);
  vi.mocked(proposeHotelStep).mockResolvedValue({ candidates: [{ id: "h1" }], hotelStayDates: {} } as never);
  vi.mocked(confirmHotelStep).mockResolvedValue({} as never);
  vi.mocked(proposeActivitiesStep).mockResolvedValue({
    scheduledActivities: [{ id: "a1", date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }],
    unscheduledActivityIds: [],
    feasibility: { valid: true, violations: [], warnings: [] },
    curation: null,
  } as never);
  vi.mocked(confirmActivitiesStep).mockResolvedValue({ scheduledActivities: [], budget: {}, itineraryText: "done" } as never);
});

describe("runStepwiseChain", () => {
  it("runs all three steps in order, auto-confirming each top pick, when nothing is confirmed yet", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([]);

    const result = await runStepwiseChain(supabase, { tripId: TRIP_ID, ...clients });

    expect(proposeFlightStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID });
    expect(confirmFlightStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID, outboundFlightId: "o1", returnFlightId: "r1" });
    expect(proposeHotelStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID });
    expect(confirmHotelStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID, hotelId: "h1" });
    expect(proposeActivitiesStep).toHaveBeenCalledWith(supabase, clients.curatorModelClient, clients.embeddingClient, { tripId: TRIP_ID });
    expect(confirmActivitiesStep).toHaveBeenCalledWith(supabase, clients.writerModelClient, {
      tripId: TRIP_ID,
      scheduledActivities: [{ id: "a1", date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }],
    });
    expect(result.itineraryText).toBe("done");
  });

  it("picks up from the hotel step when the flight is already confirmed", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([decisionRow("outboundFlight", "o1"), decisionRow("returnFlight", "r1")] as never);

    await runStepwiseChain(supabase, { tripId: TRIP_ID, ...clients });

    expect(proposeFlightStep).not.toHaveBeenCalled();
    expect(confirmFlightStep).not.toHaveBeenCalled();
    expect(proposeHotelStep).toHaveBeenCalled();
    expect(proposeActivitiesStep).toHaveBeenCalled();
  });

  it("picks up from activities when flight and hotel are already confirmed", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
    ] as never);

    await runStepwiseChain(supabase, { tripId: TRIP_ID, ...clients });

    expect(proposeHotelStep).not.toHaveBeenCalled();
    expect(proposeActivitiesStep).toHaveBeenCalled();
  });

  it("does nothing further once the whole chain is already confirmed", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
      decisionRow("activities", "[]"),
    ] as never);

    const result = await runStepwiseChain(supabase, { tripId: TRIP_ID, ...clients });

    expect(proposeFlightStep).not.toHaveBeenCalled();
    expect(proposeHotelStep).not.toHaveBeenCalled();
    expect(proposeActivitiesStep).not.toHaveBeenCalled();
    expect(result.itineraryText).toBeNull();
  });
});

describe("runStepwiseRevision", () => {
  it("re-proposes the flight excluding the currently-confirmed outbound leg, then completes the rest of the chain", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o-current"),
      decisionRow("returnFlight", "r-current"),
      decisionRow("hotel", "h1"),
      decisionRow("activities", "[]"),
    ] as never);

    await runStepwiseRevision(supabase, { tripId: TRIP_ID, field: "outboundFlight", ...clients });

    expect(proposeFlightStep).toHaveBeenCalledWith(supabase, {
      tripId: TRIP_ID,
      excludeOutboundFlightId: "o-current",
      excludeReturnFlightId: undefined,
    });
    expect(confirmFlightStep).toHaveBeenCalled();
  });

  it("re-proposes the hotel excluding the currently-confirmed one", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h-current"),
    ] as never);

    await runStepwiseRevision(supabase, { tripId: TRIP_ID, field: "hotel", ...clients });

    expect(proposeHotelStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID, excludeHotelId: "h-current" });
    expect(confirmHotelStep).toHaveBeenCalled();
  });

  it("refreshes budget/itineraryText (without re-searching activities) when a hotel revision leaves the chain otherwise complete", async () => {
    const existingSchedule = [{ id: "a1", date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }];
    vi.mocked(listActiveTripDecisions)
      .mockResolvedValueOnce([
        decisionRow("outboundFlight", "o1"),
        decisionRow("returnFlight", "r1"),
        decisionRow("hotel", "h-current"),
        { ...decisionRow("activities", "n/a"), value: existingSchedule },
      ] as never)
      .mockResolvedValueOnce([
        decisionRow("outboundFlight", "o1"),
        decisionRow("returnFlight", "r1"),
        decisionRow("hotel", "h1"),
        { ...decisionRow("activities", "n/a"), value: existingSchedule },
      ] as never);

    const result = await runStepwiseRevision(supabase, { tripId: TRIP_ID, field: "hotel", ...clients });

    expect(proposeHotelStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID, excludeHotelId: "h-current" });
    expect(confirmHotelStep).toHaveBeenCalled();
    expect(proposeActivitiesStep).not.toHaveBeenCalled();
    expect(confirmActivitiesStep).toHaveBeenCalledWith(supabase, clients.writerModelClient, {
      tripId: TRIP_ID,
      scheduledActivities: existingSchedule,
    });
    expect(result.itineraryText).toBe("done");
  });

  it("continues into hotel/activities afterward via runStepwiseChain's own re-derivation of the current step", async () => {
    // First call (inside runStepwiseRevision, before the flight revision):
    // flight not yet re-confirmed in this mock's decisions, so listActiveTripDecisions
    // reflects "only flight confirmed" for the getCurrentChainStep call inside
    // the subsequent runStepwiseChain call.
    vi.mocked(listActiveTripDecisions).mockResolvedValue([decisionRow("outboundFlight", "o-current"), decisionRow("returnFlight", "r-current")] as never);

    await runStepwiseRevision(supabase, { tripId: TRIP_ID, field: "outboundFlight", ...clients });

    expect(proposeHotelStep).toHaveBeenCalled();
    expect(proposeActivitiesStep).toHaveBeenCalled();
  });
});
