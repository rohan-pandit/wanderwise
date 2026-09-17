import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";

vi.mock("@/src/agents/curator");
vi.mock("@/src/agents/itinerary-writer");
vi.mock("@/src/repositories/activities");
vi.mock("@/src/repositories/agent-runs");
vi.mock("@/src/repositories/flights");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/hotels");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-events");
vi.mock("@/src/repositories/trip-preferences");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/workflow-runs");
vi.mock("@/src/retrieval/activities-retrieval");

import { runCuratorAgent } from "@/src/agents/curator";
import { runItineraryWriterAgent } from "@/src/agents/itinerary-writer";
import { getActivitiesByIds } from "@/src/repositories/activities";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { getFlightsByIds } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { getHotelsByIds } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
  retireProposedTripDecisionsForField,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripPreferences } from "@/src/repositories/trip-preferences";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { retrieveActivities } from "@/src/retrieval/activities-retrieval";
import {
  FlightStepNotConfirmedError,
  HotelStepNotConfirmedError,
  InvalidActivitiesSelectionError,
  confirmActivitiesStep,
  proposeActivitiesStep,
} from "./activities-step";

const supabase = {} as SupabaseClient<Database>;
const modelClient = { model: "claude-sonnet-5" } as ModelClient;
const embeddingClient = {} as EmbeddingClient;

const TRIP_ID = "trip-1";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };
const AGENT_RUN = { id: "agent-run-1" };
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function requirementRow(field: string, value: unknown) {
  return { id: `req_${field}`, trip_id: TRIP_ID, field, value, unit: null, source: "user_explicit", confidence: 1, status: "active", created_at: "now" };
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

const CONFIRMED_UPSTREAM_DECISIONS = [
  decisionRow("outboundFlight", "o1"),
  decisionRow("returnFlight", "r1"),
  decisionRow("hotel", "h1"),
];

function outboundFlight() {
  return {
    id: "o1",
    origin: "New York",
    destination: "Lisbon",
    arrival_time: "2026-10-06T09:00:00Z",
    arrival_time_zone: "Europe/Lisbon",
    departure_time: "2026-10-05T23:00:00Z",
    departure_time_zone: "America/New_York",
    airline: "TAP",
    flight_number: "TP202",
    price_usd: 500,
    taxes_fees_usd: 80,
  };
}

function returnFlight() {
  return {
    id: "r1",
    origin: "Lisbon",
    destination: "New York",
    departure_time: "2026-10-12T14:00:00Z",
    departure_time_zone: "Europe/Lisbon",
    arrival_time: "2026-10-12T22:00:00Z",
    arrival_time_zone: "America/New_York",
    airline: "TAP",
    flight_number: "TP203",
    price_usd: 520,
    taxes_fees_usd: 85,
  };
}

function hotel() {
  return {
    id: "h1",
    destination: "Lisbon",
    name: "Hotel Alfama",
    neighborhood: "Alfama",
    price_per_night_usd: 150,
    taxes_fees_usd: 20,
  };
}

function activity(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    destination: "Lisbon",
    name: `Activity ${id}`,
    category: "culture",
    price_usd: 20,
    duration_minutes: 90,
    opening_hours: null,
    closed_days: [],
    ...overrides,
  };
}

function curationResult(overrides: Record<string, unknown> = {}) {
  return {
    curation: { rankedIds: ["a1"], excludedIds: [], rationale: "good fit" },
    referenceCheck: { valid: true, unresolvedIds: [] },
    assistantMessage: "",
    toolCallLog: [{ toolName: "record_curation", input: {}, status: "success", result: {} }],
    usage: ZERO_USAGE,
    stopReason: "tool_use",
    ...overrides,
  };
}

function writerResult(overrides: Record<string, unknown> = {}) {
  return {
    itinerary: { explanation: "a lovely trip", groundedIds: ["o1", "r1", "h1", "a1"] },
    referenceCheck: { valid: true, unresolvedIds: [] },
    assistantMessage: "",
    toolCallLog: [{ toolName: "write_itinerary", input: {}, status: "success", result: {} }],
    usage: ZERO_USAGE,
    stopReason: "tool_use",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listActiveTripDecisions).mockResolvedValue(CONFIRMED_UPSTREAM_DECISIONS as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
  vi.mocked(listActiveTripPreferences).mockResolvedValue([]);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(getFlightsByIds).mockImplementation(async (_s, ids) => (ids[0] === "o1" ? [outboundFlight()] : [returnFlight()]) as never);
  vi.mocked(getHotelsByIds).mockResolvedValue([hotel()] as never);
  vi.mocked(getActivitiesByIds).mockResolvedValue([activity("a1")] as never);
  vi.mocked(retrieveActivities).mockResolvedValue([activity("a1")] as never);
  vi.mocked(runCuratorAgent).mockResolvedValue(curationResult() as never);
  vi.mocked(runItineraryWriterAgent).mockResolvedValue(writerResult() as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripEvent).mockResolvedValue({} as never);
  vi.mocked(recordAgentRun).mockResolvedValue(AGENT_RUN as never);
  vi.mocked(recordToolCalls).mockResolvedValue([]);
  vi.mocked(appendTripDecision).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripDecisionsForField).mockResolvedValue(undefined as never);
  vi.mocked(retireProposedTripDecisionsForField).mockResolvedValue(undefined as never);
});

describe("proposeActivitiesStep", () => {
  it("throws FlightStepNotConfirmedError when the flight step hasn't been confirmed", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([]);

    await expect(proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      FlightStepNotConfirmedError,
    );
    expect(retrieveActivities).not.toHaveBeenCalled();
  });

  it("throws HotelStepNotConfirmedError when the flight is confirmed but the hotel isn't", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([decisionRow("outboundFlight", "o1"), decisionRow("returnFlight", "r1")] as never);

    await expect(proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      HotelStepNotConfirmedError,
    );
  });

  it("retrieves, curates, and schedules activities into the confirmed flight's derived stay dates", async () => {
    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(retrieveActivities).toHaveBeenCalledWith(supabase, embeddingClient, expect.objectContaining({ destination: "Lisbon" }));
    expect(runCuratorAgent).toHaveBeenCalled();
    expect(result.scheduledActivities.map((a) => a.id)).toEqual(["a1"]);
    expect(result.scheduledActivities[0].date >= "2026-10-06" && result.scheduledActivities[0].date <= "2026-10-12").toBe(true);
    expect(result.feasibility.valid).toBe(true);
    expect(result.curation?.rankedIds).toEqual(["a1"]);
    expect(retireProposedTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "activities");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activities", status: "proposed", source: "system_computed" }),
    );
  });

  it("skips the Curator call and returns null curation when there are no activity candidates", async () => {
    vi.mocked(retrieveActivities).mockResolvedValue([]);

    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(runCuratorAgent).not.toHaveBeenCalled();
    expect(result.curation).toBeNull();
    expect(result.scheduledActivities).toEqual([]);
  });

  it("excludes an activity the Curator explicitly left out of rankedIds from the schedule", async () => {
    vi.mocked(retrieveActivities).mockResolvedValue([activity("a1"), activity("a2")] as never);
    vi.mocked(runCuratorAgent).mockResolvedValue(
      curationResult({ curation: { rankedIds: ["a1"], excludedIds: [{ id: "a2", reason: "not a fit" }], rationale: "x" } }) as never,
    );

    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(result.scheduledActivities.map((a) => a.id)).toEqual(["a1"]);
  });

  it("logs an itinerary_feasibility guardrail event", async () => {
    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "itinerary_feasibility" }),
    );
  });

  it("logs a tool_call_schema_validation output_validation guardrail event for a malformed Curator tool call", async () => {
    vi.mocked(runCuratorAgent).mockResolvedValue(
      curationResult({
        curation: null,
        toolCallLog: [{ toolName: "record_curation", input: {}, status: "error", error: "unknown tool", errorKind: "malformed" }],
      }) as never,
    );

    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "tool_call_schema_validation", layer: "output_validation", triggered: true }),
    );
  });

  it("does not double-count a reference-check failure as a tool_call_schema_validation guardrail trigger", async () => {
    vi.mocked(runCuratorAgent).mockResolvedValue(
      curationResult({
        curation: null,
        referenceCheck: { valid: false, unresolvedIds: ["ghost"] },
        toolCallLog: [
          {
            toolName: "record_curation",
            input: {},
            status: "error",
            error: "referenced unapproved candidate id(s): ghost",
            errorKind: "reference_check_failed",
          },
        ],
      }) as never,
    );

    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(recordGuardrailEvent).toHaveBeenCalledWith(supabase, expect.objectContaining({ guardrailName: "curation_reference_check" }));
    expect(recordGuardrailEvent).not.toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "tool_call_schema_validation" }),
    );
  });
});

describe("confirmActivitiesStep", () => {
  const SCHEDULED = [{ id: "a1", date: "2026-10-07", startMinutes: 600, durationMinutes: 90 }];

  it("persists activities/budget/itineraryText as confirmed decisions", async () => {
    const result = await confirmActivitiesStep(supabase, modelClient, { tripId: TRIP_ID, scheduledActivities: SCHEDULED });

    expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "activities");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activities", value: SCHEDULED, status: "confirmed" }),
    );
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "budget", status: "confirmed" }));
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "itineraryText", value: "a lovely trip", status: "confirmed" }),
    );
    expect(result.itineraryText).toBe("a lovely trip");
    expect(result.budget.totalEstimate.amount).toBeGreaterThan(0);
    expect(appendTripEvent).toHaveBeenCalledWith(supabase, expect.objectContaining({ eventType: "activities_step_confirmed" }));
  });

  it("throws InvalidActivitiesSelectionError when an activity id doesn't resolve to real inventory", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([]);

    await expect(
      confirmActivitiesStep(supabase, modelClient, { tripId: TRIP_ID, scheduledActivities: SCHEDULED }),
    ).rejects.toThrow(InvalidActivitiesSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("throws InvalidActivitiesSelectionError when an activity belongs to a different destination", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([activity("a1", { destination: "Paris" })] as never);

    await expect(
      confirmActivitiesStep(supabase, modelClient, { tripId: TRIP_ID, scheduledActivities: SCHEDULED }),
    ).rejects.toThrow(InvalidActivitiesSelectionError);
  });

  it("throws InvalidActivitiesSelectionError when the given schedule is no longer feasible (e.g. before the arrival transfer buffer)", async () => {
    const tooEarly = [{ id: "a1", date: "2026-10-06", startMinutes: 0, durationMinutes: 90 }];

    await expect(
      confirmActivitiesStep(supabase, modelClient, { tripId: TRIP_ID, scheduledActivities: tooEarly }),
    ).rejects.toThrow(InvalidActivitiesSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("is non-fatal when the Itinerary Writer fails — still persists the deterministic data", async () => {
    vi.mocked(runItineraryWriterAgent).mockRejectedValue(new Error("model call failed"));

    const result = await confirmActivitiesStep(supabase, modelClient, { tripId: TRIP_ID, scheduledActivities: SCHEDULED });

    expect(result.itineraryText).toBeNull();
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "activities" }));
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "budget" }));
    expect(appendTripDecision).not.toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "itineraryText" }));
  });
});
