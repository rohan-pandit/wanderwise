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
import { finalizeActivitiesStep } from "./activities-step";
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(proposeFlightStep).mockResolvedValue(FLIGHT_RESULT as never);
  vi.mocked(proposeHotelStep).mockResolvedValue(HOTEL_RESULT as never);
  vi.mocked(finalizeActivitiesStep).mockResolvedValue({ scheduledActivities: [], unscheduledActivityIds: [], budget: {}, itineraryText: "hi" } as never);
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

  it("signals it's activities' turn once flight and hotel are confirmed, without auto-proposing (needs a user-submitted preference first)", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
    ] as never);
    const result = await proposeCurrentChainStep(supabase, TRIP_ID, clients);
    expect(result).toEqual({ step: "activities" });
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

  it("throws for \"activities\" — chat-driven revision isn't supported for it (REVISABLE_CHAIN_STEPS already excludes it upstream; this is just the defensive invariant)", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([]);
    await expect(reviseChainStep(supabase, TRIP_ID, "activities", clients)).rejects.toThrow(/activities/);
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
    expect(finalizeActivitiesStep).not.toHaveBeenCalled();
  });

  it("refreshes budget/itineraryText by re-finalizing when the chain is already complete", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      decisionRow("outboundFlight", "o1"),
      decisionRow("returnFlight", "r1"),
      decisionRow("hotel", "h1"),
      decisionRow("activities", [{ id: "a1", name: "Old activity", category: "food", priceUsd: 10, date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }]),
    ] as never);

    const result = await advanceOrRefreshChain(supabase, TRIP_ID, clients);

    expect(result).toEqual({ step: "refreshed" });
    expect(finalizeActivitiesStep).toHaveBeenCalledWith(supabase, clients.writerModelClient, { tripId: TRIP_ID });
    expect(proposeFlightStep).not.toHaveBeenCalled();
    expect(proposeHotelStep).not.toHaveBeenCalled();
  });
});
