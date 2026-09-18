import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";

vi.mock("@/src/agents/curator");
vi.mock("@/src/agents/itinerary-writer");
vi.mock("@/src/repositories/activities");
vi.mock("@/src/repositories/agent-runs");
vi.mock("@/src/repositories/destinations");
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
import { getDestinationByName } from "@/src/repositories/destinations";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { getFlightsByIds } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { getHotelsByIds } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
  retireProposedTripDecisionsForField,
  retireTripDecisionById,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { appendTripPreference, listActiveTripPreferences, retireActiveTripPreferencesForField } from "@/src/repositories/trip-preferences";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { retrieveActivities } from "@/src/retrieval/activities-retrieval";
import {
  ActivityNotSelectedError,
  FlightStepNotConfirmedError,
  HotelStepNotConfirmedError,
  InvalidActivitiesSelectionError,
  confirmActivitySelection,
  finalizeActivitiesStep,
  proposeActivitiesStep,
  removeActivitySelection,
} from "./activities-step";
import { UnknownDestinationError } from "./step-shared";

const supabase = {} as SupabaseClient<Database>;
const modelClient = { model: "claude-sonnet-5" } as ModelClient;
const embeddingClient = {} as EmbeddingClient;

const TRIP_ID = "trip-1";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };
const LISBON_ID = "destination-lisbon";
const LISBON = { id: LISBON_ID, name: "Lisbon", inventory_version: 1 };
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

function decisionRow(field: string, value: unknown, status = "confirmed", id = `dec_${field}`) {
  return { id, trip_id: TRIP_ID, field, value, status, source: "user_explicit", created_at: "now" };
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
    destination_id: LISBON_ID,
    name: `Activity ${id}`,
    category: "cultural",
    description: "A lovely thing to do.",
    price_usd: 20,
    duration_minutes: 90,
    location: "Alfama",
    reservation_required: false,
    opening_hours: null,
    closed_days: [],
    inventory_version: 1,
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
  vi.mocked(getDestinationByName).mockResolvedValue(LISBON as never);
  vi.mocked(listActiveTripDecisions).mockResolvedValue(CONFIRMED_UPSTREAM_DECISIONS as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
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
  vi.mocked(retireTripDecisionById).mockResolvedValue(undefined as never);
  vi.mocked(appendTripPreference).mockResolvedValue({} as never);
  vi.mocked(retireActiveTripPreferencesForField).mockResolvedValue(undefined as never);
  vi.mocked(listActiveTripPreferences).mockResolvedValue([]);
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

  it("throws UnknownDestinationError when the trip's destination doesn't resolve to any real destination", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue(null as never);

    await expect(proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      UnknownDestinationError,
    );
    expect(retrieveActivities).not.toHaveBeenCalled();
  });

  it("retrieves and curates candidates, returning them richly (name/category/price) rather than just ids", async () => {
    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(retrieveActivities).toHaveBeenCalledWith(
      supabase,
      embeddingClient,
      expect.objectContaining({ destination: "Lisbon", destinationId: LISBON_ID }),
    );
    expect(runCuratorAgent).toHaveBeenCalled();
    expect(result.candidates).toEqual([
      expect.objectContaining({ id: "a1", name: "Activity a1", category: "cultural", priceUsd: 20, description: "A lovely thing to do." }),
    ]);
    expect(result.curation?.rankedIds).toEqual(["a1"]);
    expect(retireProposedTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "activityCandidate");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activityCandidate", value: "a1", status: "proposed", source: "system_computed" }),
    );
  });

  it("does NOT schedule candidates — no date/time on the returned candidates", async () => {
    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });
    expect(result.candidates[0]).not.toHaveProperty("date");
    expect(result.candidates[0]).not.toHaveProperty("startMinutes");
  });

  it("persists submitted category chips as the activityInterests preference and passes them as a hard filter", async () => {
    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID, categories: ["food", "spa"] });

    expect(retireActiveTripPreferencesForField).toHaveBeenCalledWith(supabase, TRIP_ID, "activityInterests");
    expect(appendTripPreference).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activityInterests", value: ["food", "spa"], source: "user_explicit" }),
    );
    expect(retrieveActivities).toHaveBeenCalledWith(supabase, embeddingClient, expect.objectContaining({ categories: ["food", "spa"] }));
  });

  it("persists free-text criteria as the activityNotes preference and uses it as the retrieval query", async () => {
    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID, criteria: "nothing too touristy" });

    expect(appendTripPreference).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activityNotes", value: "nothing too touristy" }),
    );
    expect(retrieveActivities).toHaveBeenCalledWith(supabase, embeddingClient, expect.objectContaining({ query: "nothing too touristy" }));
  });

  it("doesn't persist a preference row when no categories/criteria are given", async () => {
    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });
    expect(appendTripPreference).not.toHaveBeenCalled();
  });

  it("falls back to a previously-stored preference when categories/criteria are omitted (a reload's auto-re-propose)", async () => {
    vi.mocked(listActiveTripPreferences).mockResolvedValue([
      { id: "p1", trip_id: TRIP_ID, field: "activityInterests", value: ["nightlife"], source: "user_explicit", confidence: 1, status: "active", created_at: "now" },
      { id: "p2", trip_id: TRIP_ID, field: "activityNotes", value: "somewhere lively", source: "user_explicit", confidence: 1, status: "active", created_at: "now" },
    ] as never);

    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(retrieveActivities).toHaveBeenCalledWith(
      supabase,
      embeddingClient,
      expect.objectContaining({ categories: ["nightlife"], query: "somewhere lively" }),
    );
    // A fallback reuse, not a new submission — nothing should be re-persisted.
    expect(appendTripPreference).not.toHaveBeenCalled();
  });

  it("an explicit (even empty) categories/criteria argument overrides the stored preference rather than falling back to it", async () => {
    vi.mocked(listActiveTripPreferences).mockResolvedValue([
      { id: "p1", trip_id: TRIP_ID, field: "activityInterests", value: ["nightlife"], source: "user_explicit", confidence: 1, status: "active", created_at: "now" },
    ] as never);

    await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID, categories: ["spa"] });

    expect(retrieveActivities).toHaveBeenCalledWith(supabase, embeddingClient, expect.objectContaining({ categories: ["spa"] }));
    expect(appendTripPreference).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activityInterests", value: ["spa"] }),
    );
  });

  it("returns already-selected activities richly detailed, for a reload's 'already in your itinerary' display", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([...CONFIRMED_UPSTREAM_DECISIONS, decisionRow("activity", "a9")] as never);
    vi.mocked(getActivitiesByIds).mockImplementation(async (_s, ids) => ids.map((id) => activity(id)) as never);
    vi.mocked(retrieveActivities).mockResolvedValue([activity("a1")] as never);

    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(result.alreadySelected).toEqual([expect.objectContaining({ id: "a9", name: "Activity a9" })]);
  });

  it("excludes already-confirmed activities from the candidate list automatically", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([...CONFIRMED_UPSTREAM_DECISIONS, decisionRow("activity", "a1")] as never);
    vi.mocked(retrieveActivities).mockResolvedValue([activity("a1"), activity("a2")] as never);
    vi.mocked(runCuratorAgent).mockResolvedValue(curationResult({ curation: { rankedIds: ["a2"], excludedIds: [], rationale: "x" } }) as never);

    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    // a1 must never even reach the Curator, since it's already confirmed.
    expect(runCuratorAgent).toHaveBeenCalledWith(
      modelClient,
      expect.objectContaining({ candidates: [expect.objectContaining({ id: "a2" })] }),
    );
    expect(result.candidates.map((c) => c.id)).toEqual(["a2"]);
  });

  it("skips the Curator call and returns null curation when there are no activity candidates", async () => {
    vi.mocked(retrieveActivities).mockResolvedValue([]);

    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(runCuratorAgent).not.toHaveBeenCalled();
    expect(result.curation).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("excludes an activity the Curator explicitly left out of rankedIds", async () => {
    vi.mocked(retrieveActivities).mockResolvedValue([activity("a1"), activity("a2")] as never);
    vi.mocked(runCuratorAgent).mockResolvedValue(
      curationResult({ curation: { rankedIds: ["a1"], excludedIds: [{ id: "a2", reason: "not a fit" }], rationale: "x" } }) as never,
    );

    const result = await proposeActivitiesStep(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(result.candidates.map((c) => c.id)).toEqual(["a1"]);
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

describe("confirmActivitySelection", () => {
  it("adds one activity as its own confirmed 'activity' decision row", async () => {
    const result = await confirmActivitySelection(supabase, { tripId: TRIP_ID, activityId: "a1" });

    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activity", value: "a1", status: "confirmed", source: "user_explicit" }),
    );
    expect(result.activity).toEqual(expect.objectContaining({ id: "a1", name: "Activity a1" }));
  });

  it("is a no-op (not an error) if the activity is already selected", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([...CONFIRMED_UPSTREAM_DECISIONS, decisionRow("activity", "a1")] as never);

    await confirmActivitySelection(supabase, { tripId: TRIP_ID, activityId: "a1" });

    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("throws InvalidActivitiesSelectionError when the activity id doesn't resolve to real inventory", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([]);
    await expect(confirmActivitySelection(supabase, { tripId: TRIP_ID, activityId: "ghost" })).rejects.toThrow(
      InvalidActivitiesSelectionError,
    );
  });

  it("throws InvalidActivitiesSelectionError when the activity belongs to a different destination", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([activity("a1", { destination_id: "destination-paris" })] as never);
    await expect(confirmActivitySelection(supabase, { tripId: TRIP_ID, activityId: "a1" })).rejects.toThrow(
      InvalidActivitiesSelectionError,
    );
  });

  it("throws InvalidActivitiesSelectionError for a stale inventory version", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([activity("a1", { inventory_version: 0 })] as never);
    await expect(confirmActivitySelection(supabase, { tripId: TRIP_ID, activityId: "a1" })).rejects.toThrow(
      InvalidActivitiesSelectionError,
    );
  });
});

describe("removeActivitySelection", () => {
  it("retires the specific confirmed 'activity' row matching the given id", async () => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      ...CONFIRMED_UPSTREAM_DECISIONS,
      decisionRow("activity", "a1", "confirmed", "dec_activity_a1"),
      decisionRow("activity", "a2", "confirmed", "dec_activity_a2"),
    ] as never);

    await removeActivitySelection(supabase, { tripId: TRIP_ID, activityId: "a1" });

    expect(retireTripDecisionById).toHaveBeenCalledWith(supabase, TRIP_ID, "dec_activity_a1");
    expect(retireTripDecisionById).not.toHaveBeenCalledWith(supabase, TRIP_ID, "dec_activity_a2");
  });

  it("throws ActivityNotSelectedError when the activity isn't currently selected", async () => {
    await expect(removeActivitySelection(supabase, { tripId: TRIP_ID, activityId: "never-added" })).rejects.toThrow(
      ActivityNotSelectedError,
    );
    expect(retireTripDecisionById).not.toHaveBeenCalled();
  });
});

describe("finalizeActivitiesStep", () => {
  beforeEach(() => {
    vi.mocked(listActiveTripDecisions).mockResolvedValue([...CONFIRMED_UPSTREAM_DECISIONS, decisionRow("activity", "a1")] as never);
  });

  it("schedules every confirmed activity selection and persists activities/budget/itineraryText, now with names", async () => {
    const result = await finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID });

    expect(result.scheduledActivities).toEqual([
      expect.objectContaining({ id: "a1", name: "Activity a1", category: "cultural", priceUsd: 20 }),
    ]);
    expect(result.scheduledActivities[0].date >= "2026-10-06" && result.scheduledActivities[0].date <= "2026-10-12").toBe(true);
    expect(retireActiveTripDecisionsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "activities");
    expect(appendTripDecision).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "activities", status: "confirmed" }),
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

  it("throws InvalidActivitiesSelectionError when a confirmed activity id no longer resolves to real inventory", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([]);
    await expect(finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID })).rejects.toThrow(InvalidActivitiesSelectionError);
    expect(appendTripDecision).not.toHaveBeenCalled();
  });

  it("throws InvalidActivitiesSelectionError when a confirmed activity belongs to a different destination", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([activity("a1", { destination: "Paris", destination_id: "destination-paris" })] as never);
    await expect(finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID })).rejects.toThrow(InvalidActivitiesSelectionError);
  });

  it("throws InvalidActivitiesSelectionError for a stale inventory version (defense in depth)", async () => {
    vi.mocked(getActivitiesByIds).mockResolvedValue([activity("a1", { inventory_version: 0 })] as never);
    await expect(finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID })).rejects.toThrow(InvalidActivitiesSelectionError);
  });

  it("throws UnknownDestinationError when the trip's destination doesn't resolve to any real destination", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue(null as never);
    await expect(finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID })).rejects.toThrow(UnknownDestinationError);
  });

  it("reports activities that couldn't be scheduled rather than silently dropping them", async () => {
    // The trip's stay (derived from the confirmed flights) spans several
    // days (Oct 6 - Oct 12) — far more 10-hour activities than available
    // days are needed to force a genuine overflow.
    const ids = Array.from({ length: 12 }, (_, i) => `a${i + 1}`);
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      ...CONFIRMED_UPSTREAM_DECISIONS,
      ...ids.map((id, i) => decisionRow("activity", id, "confirmed", `dec_activity_${i}`)),
    ] as never);
    vi.mocked(getActivitiesByIds).mockResolvedValue(ids.map((id) => activity(id, { duration_minutes: 600 })) as never);

    const result = await finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID });
    expect(result.unscheduledActivityIds.length).toBeGreaterThan(0);
  });

  it("is non-fatal when the Itinerary Writer fails — still persists the deterministic data", async () => {
    vi.mocked(runItineraryWriterAgent).mockRejectedValue(new Error("model call failed"));

    const result = await finalizeActivitiesStep(supabase, modelClient, { tripId: TRIP_ID });

    expect(result.itineraryText).toBeNull();
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "activities" }));
    expect(appendTripDecision).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "budget" }));
    expect(appendTripDecision).not.toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "itineraryText" }));
  });
});
