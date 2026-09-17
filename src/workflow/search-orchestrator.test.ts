import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";

vi.mock("@/src/agents/curator");
vi.mock("@/src/repositories/agent-runs");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/flights");
vi.mock("@/src/repositories/hotels");
vi.mock("@/src/repositories/trip-events");
vi.mock("@/src/repositories/trip-preferences");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/trip-state");
vi.mock("@/src/repositories/workflow-runs");
vi.mock("@/src/retrieval/activities-retrieval");
vi.mock("./controller");

import { runCuratorAgent } from "@/src/agents/curator";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { findFlights } from "@/src/repositories/flights";
import { findHotels } from "@/src/repositories/hotels";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripPreferences } from "@/src/repositories/trip-preferences";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { retrieveActivities } from "@/src/retrieval/activities-retrieval";
import { advanceTrip } from "./controller";
import { OrchestrationConflictError } from "./orchestration-errors";
import { InvalidWorkflowStateError, NoViableCandidatesError, runSearchAndCuration } from "./search-orchestrator";

const supabase = {} as SupabaseClient<Database>;
const modelClient = { model: "claude-sonnet-5" } as ModelClient;
const embeddingClient = {} as EmbeddingClient;

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

const READY_REQUIREMENTS = [
  requirementRow("origin", "New York"),
  requirementRow("destination", "Lisbon"),
  requirementRow("departureDate", "2026-10-05"),
  requirementRow("partySize", 2),
  requirementRow("budgetTotalUsd", 3000),
];

function stateAt(workflowState: string) {
  return { version: 5, state: { workflowState }, actor: "system", operationType: "x", correlationId: null, createdAt: "now" };
}

function flight(id: string, overrides: Record<string, unknown> = {}) {
  return { id, origin: "New York", destination: "Lisbon", price_usd: 500, is_red_eye: false, ...overrides };
}

function hotel(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    destination: "Lisbon",
    price_per_night_usd: 150,
    rating: 4.5,
    room_capacity: 4,
    cancellation_policy: "Free cancellation up to 48 hours before check-in",
    ...overrides,
  };
}

function activity(id: string) {
  return { id, destination: "Lisbon", name: `Activity ${id}`, price_usd: 20, closed_days: [] };
}

function curationResult(overrides: Record<string, unknown> = {}) {
  return {
    curation: { rankedIds: ["activity-1"], excludedIds: [], rationale: "good fit" },
    referenceCheck: { valid: true, unresolvedIds: [] },
    assistantMessage: "",
    toolCallLog: [{ toolName: "record_curation", input: {}, status: "success", result: {} }],
    usage: ZERO_USAGE,
    stopReason: "tool_use",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getLatestTripState).mockResolvedValue(stateAt("requirements_ready") as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
  vi.mocked(listActiveTripPreferences).mockResolvedValue([]);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(findFlights).mockResolvedValue([flight("flight-1")] as never);
  vi.mocked(findHotels).mockResolvedValue([hotel("hotel-1")] as never);
  vi.mocked(retrieveActivities).mockResolvedValue([activity("activity-1")] as never);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendTripEvent).mockResolvedValue({} as never);
  vi.mocked(recordAgentRun).mockResolvedValue(AGENT_RUN as never);
  vi.mocked(recordToolCalls).mockResolvedValue([]);
  vi.mocked(runCuratorAgent).mockResolvedValue(curationResult() as never);
  vi.mocked(advanceTrip).mockImplementation(
    async (_s, transitionParams) =>
      ({
        status: "applied",
        fromState: "x",
        toState:
          transitionParams.event === "begin_search"
            ? "searching_inventory"
            : transitionParams.event === "search_completed"
              ? "validating_candidates"
              : transitionParams.event === "candidates_valid"
                ? "assembling_options"
                : transitionParams.event === "recoverable_error"
                  ? "failed_recoverable"
                  : "x",
        version: 10,
      }) as never,
  );
});

describe("runSearchAndCuration", () => {
  it("throws InvalidWorkflowStateError when the trip isn't in requirements_ready", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements") as never);

    await expect(runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      InvalidWorkflowStateError,
    );
    expect(findFlights).not.toHaveBeenCalled();
  });

  it("throws if the trip has no state history", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(null);

    await expect(runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      "no state history",
    );
  });

  it("drives begin_search -> search_completed -> candidates_valid and returns the filtered candidates plus curation", async () => {
    const result = await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(advanceTrip).toHaveBeenNthCalledWith(1, supabase, expect.objectContaining({ event: "begin_search" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(2, supabase, expect.objectContaining({ event: "search_completed" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(3, supabase, expect.objectContaining({ event: "candidates_valid" }));
    expect(result.workflowState).toBe("assembling_options");
    expect(result.outboundFlights.map((f) => f.id)).toEqual(["flight-1"]);
    expect(result.returnFlights).toEqual([]);
    expect(result.hotels.map((h) => h.id)).toEqual(["hotel-1"]);
    expect(result.activities.map((a) => a.id)).toEqual(["activity-1"]);
    expect(result.curation?.rankedIds).toEqual(["activity-1"]);
    expect(findFlights).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ origin: "New York", destination: "Lisbon", departureDate: "2026-10-05" }),
    );
  });

  it("rejects a red-eye flight when noRedEye is required, logs the guardrail, and drives recoverable_error", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([...READY_REQUIREMENTS, requirementRow("noRedEye", true)] as never);
    vi.mocked(findFlights).mockResolvedValue([flight("flight-1", { is_red_eye: true })] as never);

    await expect(runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      NoViableCandidatesError,
    );

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "outbound_flight_hard_constraints", triggered: true }),
    );
    expect(advanceTrip).toHaveBeenCalledWith(supabase, expect.objectContaining({ event: "recoverable_error" }));
  });

  it("rejects a hotel that can't fit the default single room group derived from partySize", async () => {
    vi.mocked(findHotels).mockResolvedValue([hotel("hotel-1", { room_capacity: 1 })] as never);

    await expect(runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      NoViableCandidatesError,
    );
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "hotel_hard_constraints", triggered: true }),
    );
  });

  it("skips the Curator call and returns null curation when there are no activity candidates", async () => {
    vi.mocked(retrieveActivities).mockResolvedValue([]);

    const result = await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(runCuratorAgent).not.toHaveBeenCalled();
    expect(result.curation).toBeNull();
  });

  it("treats a curation that fails the hallucination reference check as no curation, but still logs the run and guardrail", async () => {
    vi.mocked(runCuratorAgent).mockResolvedValue(
      curationResult({
        curation: null,
        referenceCheck: { valid: false, unresolvedIds: ["made-up-id"] },
        toolCallLog: [
          { toolName: "record_curation", input: {}, status: "error", error: "referenced unapproved candidate id(s): made-up-id" },
        ],
      }) as never,
    );

    const result = await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(result.curation).toBeNull();
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        guardrailName: "curation_reference_check",
        triggered: true,
        detail: expect.stringContaining("made-up-id"),
      }),
    );
    expect(recordAgentRun).toHaveBeenCalledWith(supabase, expect.objectContaining({ status: "error" }));
  });

  it("propagates OrchestrationConflictError (not swallowed) when begin_search races a concurrent write", async () => {
    vi.mocked(advanceTrip).mockResolvedValueOnce({ status: "conflict" } as never);

    await expect(runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      OrchestrationConflictError,
    );
    expect(findFlights).not.toHaveBeenCalled();
  });

  it("appends an inventory_searched trip event with the passing candidate ids", async () => {
    await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(appendTripEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        eventType: "inventory_searched",
        payload: expect.objectContaining({ outboundFlightCandidateIds: ["flight-1"], hotelCandidateIds: ["hotel-1"] }),
      }),
    );
  });

  it("also searches and filters a return flight when returnDate is stated, in the reversed direction", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([...READY_REQUIREMENTS, requirementRow("returnDate", "2026-10-12")] as never);
    vi.mocked(findFlights).mockImplementation(async (_s, filter) =>
      (filter.origin === "Lisbon"
        ? [flight("return-flight-1", { origin: "Lisbon", destination: "New York" })]
        : [flight("flight-1")]) as never,
    );

    const result = await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });

    expect(findFlights).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ origin: "Lisbon", destination: "New York", departureDate: "2026-10-12" }),
    );
    expect(result.returnFlights.map((f) => f.id)).toEqual(["return-flight-1"]);
  });

  it("fails with NoViableCandidatesError when a stated returnDate finds no viable return flight", async () => {
    vi.mocked(listActiveTripRequirements).mockResolvedValue([...READY_REQUIREMENTS, requirementRow("returnDate", "2026-10-12")] as never);
    vi.mocked(findFlights).mockImplementation(async (_s, filter) => (filter.origin === "Lisbon" ? [] : [flight("flight-1")]) as never);

    await expect(runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID })).rejects.toThrow(
      NoViableCandidatesError,
    );
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "return_flight_hard_constraints", triggered: false }),
    );
  });

  it("doesn't search a return flight at all when returnDate isn't stated (one-way)", async () => {
    await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: TRIP_ID });
    expect(findFlights).toHaveBeenCalledTimes(1);
  });
});
