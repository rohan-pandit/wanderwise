import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";

vi.mock("@/src/repositories/trip-decisions");
vi.mock("./flight-step");
vi.mock("./hotel-step");
vi.mock("./activities-step");

import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import { proposeFlightStep } from "./flight-step";
import { proposeHotelStep } from "./hotel-step";
import { confirmActivitiesStep, proposeActivitiesStep } from "./activities-step";
import { advanceOrRefreshChain, proposeCurrentChainStep, reviseChainStep } from "./step-router";

const supabase = {} as SupabaseClient<Database>;
const TRIP_ID = "trip-1";
const clients = {
  curatorModelClient: {} as ModelClient,
  writerModelClient: {} as ModelClient,
  embeddingClient: {} as EmbeddingClient,
};

function decisionRow(field: string, value: unknown, status = "confirmed") {
  return { id: `dec_${field}`, trip_id: TRIP_ID, field, value, status, source: "user_explicit", created_at: "now" };
}

const FLIGHT_RESULT = { candidates: [{ outboundFlight: { id: "o1" }, returnFlight: { id: "r1" }, totalPriceUsd: 600 }] };
const HOTEL_RESULT = { candidates: [{ id: "h1" }], hotelStayDates: { destinationTimeZone: "Europe/Lisbon", checkIn: "2026-10-06", checkOut: "2026-10-12" } };
const ACTIVITIES_RESULT = {
  scheduledActivities: [{ id: "a1", date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }],
  unscheduledActivityIds: [],
  feasibility: { valid: true, violations: [] },
  curation: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(proposeFlightStep).mockResolvedValue(FLIGHT_RESULT as never);
  vi.mocked(proposeHotelStep).mockResolvedValue(HOTEL_RESULT as never);
  vi.mocked(proposeActivitiesStep).mockResolvedValue(ACTIVITIES_RESULT as never);
  vi.mocked(confirmActivitiesStep).mockResolvedValue({ scheduledActivities: [], budget: {}, itineraryText: "hi" } as never);
});

describe("proposeCurrentChainStep", () => {
  it("proposes the flight step when nothing is confirmed yet, returning its result", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([]);
    const result = await proposeCurrentChainStep(supabase, TRIP_ID, clients);
    expect(result).toEqual({ step: "flight", result: FLIGHT_RESULT });
    expect(proposeFlightStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID });
    expect(proposeHotelStep).not.toHaveBeenCalled();
  });

  it("proposes the hotel step once flight is confirmed", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
    ] as never);
    const result = await proposeCurrentChainStep(supabase, TRIP_ID, clients);
    expect(result).toEqual({ step: "hotel", result: HOTEL_RESULT });
    expect(proposeHotelStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID });
  });

  it("proposes the activities step once flight and hotel are confirmed", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
    ] as never);
    const result = await proposeCurrentChainStep(supabase, TRIP_ID, clients);
    expect(result).toEqual({ step: "activities", result: ACTIVITIES_RESULT });
    expect(proposeActivitiesStep).toHaveBeenCalledWith(supabase, clients.curatorModelClient, clients.embeddingClient, { tripId: TRIP_ID });
  });

  it("proposes nothing once the chain is already complete", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
      decisionRow("activities", "[]"),
    ] as never);
    const result = await proposeCurrentChainStep(supabase, TRIP_ID, clients);
    expect(result).toEqual({ step: "complete" });
    expect(proposeFlightStep).not.toHaveBeenCalled();
    expect(proposeHotelStep).not.toHaveBeenCalled();
    expect(proposeActivitiesStep).not.toHaveBeenCalled();
  });
});

describe("reviseChainStep", () => {
  it("re-proposes flight excluding the currently confirmed pair", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o-old"),
      decisionRow("returnFlight", "r-old"),
    ] as never);

    const result = await reviseChainStep(supabase, TRIP_ID, "flight", clients);

    expect(result).toEqual({ step: "flight", result: FLIGHT_RESULT });
    expect(proposeFlightStep).toHaveBeenCalledWith(supabase, {
      tripId: TRIP_ID,
      excludeOutboundFlightId: "o-old",
      excludeReturnFlightId: "r-old",
    });
  });

  it("re-proposes hotel excluding the currently confirmed pick", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([decisionRow("hotel", "h-old")] as never);

    const result = await reviseChainStep(supabase, TRIP_ID, "hotel", clients);

    expect(result).toEqual({ step: "hotel", result: HOTEL_RESULT });
    expect(proposeHotelStep).toHaveBeenCalledWith(supabase, { tripId: TRIP_ID, excludeHotelId: "h-old" });
  });

  it("re-proposes activities with no exclusion (a full re-curation)", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([]);

    const result = await reviseChainStep(supabase, TRIP_ID, "activities", clients);

    expect(result).toEqual({ step: "activities", result: ACTIVITIES_RESULT });
    expect(proposeActivitiesStep).toHaveBeenCalledWith(supabase, clients.curatorModelClient, clients.embeddingClient, { tripId: TRIP_ID });
  });
});

describe("advanceOrRefreshChain", () => {
  it("delegates to proposeCurrentChainStep when the chain isn't complete", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
    ] as never);

    const result = await advanceOrRefreshChain(supabase, TRIP_ID, clients);

    expect(result).toEqual({ step: "hotel", result: HOTEL_RESULT });
    expect(confirmActivitiesStep).not.toHaveBeenCalled();
  });

  it("refreshes budget/itineraryText with the same schedule when the chain is already complete", async () => {
    const scheduled = [{ id: "a1", date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }];
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
      decisionRow("activities", scheduled),
    ] as never);

    const result = await advanceOrRefreshChain(supabase, TRIP_ID, clients);

    expect(result).toEqual({ step: "refreshed" });
    expect(confirmActivitiesStep).toHaveBeenCalledWith(supabase, clients.writerModelClient, {
      tripId: TRIP_ID,
      scheduledActivities: scheduled,
    });
    expect(proposeFlightStep).not.toHaveBeenCalled();
    expect(proposeHotelStep).not.toHaveBeenCalled();
    expect(proposeActivitiesStep).not.toHaveBeenCalled();
  });
});
