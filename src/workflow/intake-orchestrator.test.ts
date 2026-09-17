import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";

vi.mock("@/src/agents/intake");
vi.mock("@/src/repositories/agent-runs");
vi.mock("@/src/repositories/guardrail-events");
vi.mock("@/src/repositories/messages");
vi.mock("@/src/repositories/trip-decisions");
vi.mock("@/src/repositories/trip-preferences");
vi.mock("@/src/repositories/trip-requirements");
vi.mock("@/src/repositories/trip-state");
vi.mock("@/src/repositories/trips");
vi.mock("@/src/repositories/workflow-runs");
vi.mock("./controller");

import { runIntakeAgent } from "@/src/agents/intake";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { appendMessage } from "@/src/repositories/messages";
import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import {
  appendTripPreference,
  listActiveTripPreferences,
  retireActiveTripPreferencesForField,
} from "@/src/repositories/trip-preferences";
import {
  appendTripRequirement,
  listActiveTripRequirements,
  retireActiveTripRequirementsForField,
} from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getTrip } from "@/src/repositories/trips";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { advanceTrip } from "./controller";
import {
  InputGuardrailRejectedError,
  OrchestrationConflictError,
  OrchestrationTransitionError,
  SessionTripMismatchError,
  processIntakeTurn,
} from "./intake-orchestrator";

const supabase = {} as SupabaseClient<Database>;
const modelClient = { model: "claude-sonnet-5" } as ModelClient;

const TRIP_ID = "trip-1";
const SESSION_ID = "session-1";
const RUN = { id: "run-1", trip_id: TRIP_ID, status: "running", started_at: "now", completed_at: null };
const AGENT_RUN = { id: "agent-run-1" };

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function emptyAgentResult(overrides: Partial<Awaited<ReturnType<typeof runIntakeAgent>>> = {}) {
  return {
    requirements: [],
    preferences: [],
    clarification: null,
    revisionProposal: null,
    assistantMessage: "ok",
    toolCallLog: [],
    usage: ZERO_USAGE,
    stopReason: "end_turn",
    ...overrides,
  };
}

function requirementRow(field: string, value: unknown, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function stateAt(workflowState: string, version: number) {
  return { version, state: { workflowState }, actor: "system", operationType: "x", correlationId: null, createdAt: "now" };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getTrip).mockResolvedValue({ id: TRIP_ID, session_id: SESSION_ID, user_id: "user-1", status: "created", created_at: "now" } as never);
  vi.mocked(getOrCreateActiveWorkflowRun).mockResolvedValue(RUN as never);
  vi.mocked(recordAgentRun).mockResolvedValue(AGENT_RUN as never);
  vi.mocked(recordToolCalls).mockResolvedValue([]);
  vi.mocked(recordGuardrailEvent).mockResolvedValue({} as never);
  vi.mocked(appendMessage).mockResolvedValue({} as never);
  vi.mocked(listActiveTripRequirements).mockResolvedValue([]);
  vi.mocked(listActiveTripPreferences).mockResolvedValue([]);
  vi.mocked(listActiveTripDecisions).mockResolvedValue([]);
  vi.mocked(retireActiveTripRequirementsForField).mockResolvedValue(undefined);
  vi.mocked(retireActiveTripPreferencesForField).mockResolvedValue(undefined);
  vi.mocked(appendTripRequirement).mockImplementation(
    async (_s, r) => requirementRow(r.field, r.value, { source: r.source, confidence: r.confidence }) as never,
  );
  vi.mocked(appendTripPreference).mockImplementation(
    async (_s, p) => ({ id: `pref_${p.field}`, trip_id: TRIP_ID, field: p.field, value: p.value, source: p.source, confidence: p.confidence, status: "active", created_at: "now" }) as never,
  );
});

describe("processIntakeTurn", () => {
  it("rejects an empty message before touching the model or the trip", async () => {
    await expect(
      processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "   " }),
    ).rejects.toThrow(InputGuardrailRejectedError);

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ layer: "input_scope", triggered: true }),
    );
    expect(appendMessage).not.toHaveBeenCalled();
    expect(runIntakeAgent).not.toHaveBeenCalled();
  });

  it("rejects an oversized message", async () => {
    await expect(
      processIntakeTurn(supabase, modelClient, {
        tripId: TRIP_ID,
        sessionId: SESSION_ID,
        userMessage: "x".repeat(5000),
      }),
    ).rejects.toThrow(InputGuardrailRejectedError);
  });

  it("starts intake when the trip is still in the created state, then calls the agent", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(advanceTrip).mockResolvedValueOnce({
      status: "applied",
      fromState: "created",
      toState: "collecting_requirements",
      version: 2,
    } as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(emptyAgentResult() as never);

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "Hi, I'd like to plan a trip.",
    });

    expect(advanceTrip).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ tripId: TRIP_ID, event: "start_intake" }),
    );
    expect(runIntakeAgent).toHaveBeenCalledOnce();
    expect(result.workflowState).toBe("collecting_requirements");
  });

  it("throws OrchestrationTransitionError if start_intake is unexpectedly rejected", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(advanceTrip).mockResolvedValueOnce({ status: "rejected", reason: "nope" } as never);

    await expect(
      processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "hi" }),
    ).rejects.toThrow(OrchestrationTransitionError);
    expect(runIntakeAgent).not.toHaveBeenCalled();
  });

  it("throws OrchestrationConflictError (not OrchestrationTransitionError) when a transition races a concurrent write", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(advanceTrip).mockResolvedValueOnce({ status: "conflict" } as never);

    await expect(
      processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "hi" }),
    ).rejects.toThrow(OrchestrationConflictError);
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ layer: "workflow_authorization", triggered: true }),
    );
  });

  it("rejects when the given sessionId doesn't belong to the given tripId", async () => {
    vi.mocked(getTrip).mockResolvedValue({ id: TRIP_ID, session_id: "some-other-session", user_id: "user-1", status: "created", created_at: "now" } as never);

    await expect(
      processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "hi" }),
    ).rejects.toThrow(SessionTripMismatchError);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("logs a Layer 4 guardrail event (not triggered) for a successful workflow transition", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(advanceTrip).mockResolvedValue({ status: "applied", fromState: "created", toState: "collecting_requirements", version: 2 } as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(emptyAgentResult() as never);

    await processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "hi" });

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ layer: "workflow_authorization", triggered: false }),
    );
  });

  it("derives the chain's correlation id from the event name, not its position, so a shorter retry chain still lines up", async () => {
    const READY_REQUIREMENTS = [
      requirementRow("origin", "New York"),
      requirementRow("destination", "Lisbon"),
      requirementRow("departureDate", "2026-10-05"),
      requirementRow("partySize", 2),
      requirementRow("budgetTotalUsd", 3000),
    ];
    const sameCorrelationId = "33333333-3333-3333-3333-333333333333";
    vi.mocked(listActiveTripRequirements).mockResolvedValue(READY_REQUIREMENTS as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(emptyAgentResult() as never);
    vi.mocked(advanceTrip).mockImplementation(async (_s, params) => ({
      status: "applied",
      fromState: "x",
      toState: params.event === "clarification_resolved" ? "collecting_requirements" : "requirements_ready",
      version: 1,
    } as never));

    // First attempt: still awaiting_clarification, so the chain is two hops —
    // "requirements_complete" lands at index 1.
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("awaiting_clarification", 4) as never);
    await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "budget is 3000",
      correlationId: sameCorrelationId,
    });
    const requirementsCompleteCallFirstAttempt = vi
      .mocked(advanceTrip)
      .mock.calls.find((call) => call[1].event === "requirements_complete")!;

    // Simulated retry: "clarification_resolved" already durably applied
    // before a crash, so the state is now collecting_requirements and the
    // chain this time is just one hop — "requirements_complete" at index 0.
    vi.mocked(advanceTrip).mockClear();
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 5) as never);
    await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "budget is 3000",
      correlationId: sameCorrelationId,
    });
    const requirementsCompleteCallRetry = vi
      .mocked(advanceTrip)
      .mock.calls.find((call) => call[1].event === "requirements_complete")!;

    expect(requirementsCompleteCallRetry[1].correlationId).toBe(requirementsCompleteCallFirstAttempt[1].correlationId);
  });

  it("persists extracted requirements/preferences and moves collecting_requirements -> requirements_ready once all required fields are present", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        requirements: [
          { field: "origin", value: "New York", source: "user_explicit", confidence: 1 },
          { field: "destination", value: "Lisbon", source: "user_explicit", confidence: 1 },
          { field: "departureDate", value: "2026-10-05", source: "user_explicit", confidence: 1 },
          { field: "partySize", value: 2, source: "user_explicit", confidence: 1 },
          { field: "budgetTotalUsd", value: 3000, source: "user_explicit", confidence: 1 },
        ],
        toolCallLog: [{ toolName: "record_extraction", input: {}, status: "success", result: {} }],
      }) as never,
    );
    vi.mocked(advanceTrip).mockResolvedValue({
      status: "applied",
      fromState: "collecting_requirements",
      toState: "requirements_ready",
      version: 4,
    } as never);

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "NY to Lisbon, Oct 5, party of 2, budget 3000",
    });

    expect(appendTripRequirement).toHaveBeenCalledTimes(5);
    expect(advanceTrip).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ event: "requirements_complete" }),
    );
    expect(result.ready).toBe(true);
    expect(result.workflowState).toBe("requirements_ready");
  });

  it("transitions to awaiting_clarification when fields are still missing and the agent asks", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        clarification: { missingFields: ["budgetTotalUsd"], reason: "no budget yet" },
      }) as never,
    );
    vi.mocked(advanceTrip).mockResolvedValue({
      status: "applied",
      fromState: "collecting_requirements",
      toState: "awaiting_clarification",
      version: 4,
    } as never);

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "Barcelona, 3 of us",
    });

    expect(advanceTrip).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ event: "clarification_needed" }),
    );
    expect(result.workflowState).toBe("awaiting_clarification");
  });

  it("does not transition at all when collecting_requirements stays incomplete and the agent didn't ask", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(emptyAgentResult() as never);

    await processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "sounds good" });

    expect(advanceTrip).not.toHaveBeenCalled();
  });

  it("stays in awaiting_clarification (no transition) if the turn still leaves required fields missing", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("awaiting_clarification", 4) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({ clarification: { missingFields: ["budgetTotalUsd"], reason: "still no budget" } }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "still thinking about it",
    });

    expect(advanceTrip).not.toHaveBeenCalled();
    expect(result.workflowState).toBe("awaiting_clarification");
  });

  it("chains clarification_resolved then requirements_complete when the last missing field arrives from awaiting_clarification", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("awaiting_clarification", 4) as never);
    vi.mocked(listActiveTripRequirements).mockResolvedValue([
      requirementRow("origin", "New York"),
      requirementRow("destination", "Lisbon"),
      requirementRow("departureDate", "2026-10-05"),
      requirementRow("partySize", 2),
    ] as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        requirements: [{ field: "budgetTotalUsd", value: 3000, source: "user_explicit", confidence: 1 }],
      }) as never,
    );
    vi.mocked(advanceTrip)
      .mockResolvedValueOnce({ status: "applied", fromState: "awaiting_clarification", toState: "collecting_requirements", version: 5 } as never)
      .mockResolvedValueOnce({ status: "applied", fromState: "collecting_requirements", toState: "requirements_ready", version: 6 } as never);

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "budget is 3000",
    });

    expect(advanceTrip).toHaveBeenNthCalledWith(1, supabase, expect.objectContaining({ event: "clarification_resolved" }));
    expect(advanceTrip).toHaveBeenNthCalledWith(2, supabase, expect.objectContaining({ event: "requirements_complete" }));
    expect(result.workflowState).toBe("requirements_ready");
  });

  it("uses the same derived correlation id for the same base correlation id across calls (idempotent chaining)", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("created", 1) as never);
    vi.mocked(advanceTrip).mockResolvedValue({
      status: "applied",
      fromState: "created",
      toState: "collecting_requirements",
      version: 2,
    } as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(emptyAgentResult() as never);

    await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "hi",
      correlationId: "11111111-1111-1111-1111-111111111111",
    });
    const firstCallId = vi.mocked(advanceTrip).mock.calls[0][1].correlationId;

    vi.mocked(advanceTrip).mockClear();
    await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "hi",
      correlationId: "11111111-1111-1111-1111-111111111111",
    });
    const secondCallId = vi.mocked(advanceTrip).mock.calls[0][1].correlationId;

    expect(firstCallId).toBe(secondCallId);
    expect(firstCallId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("logs a Layer 2 guardrail event for each malformed tool call, and still keeps whatever validated", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        requirements: [{ field: "origin", value: "New York", source: "user_explicit", confidence: 1 }],
        toolCallLog: [
          { toolName: "record_extraction", input: {}, status: "success", result: {} },
          { toolName: "request_clarification", input: {}, status: "error", error: "bad shape" },
        ],
      }) as never,
    );

    await processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "NY" });

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ layer: "output_validation", triggered: true, detail: expect.stringContaining("bad shape") }),
    );
    expect(appendTripRequirement).toHaveBeenCalledOnce();
  });

  it("records a failed agent_runs row and rethrows if the model call itself throws", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    const modelError = new Error("Anthropic request failed");
    vi.mocked(runIntakeAgent).mockRejectedValue(modelError);

    await expect(
      processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "hi" }),
    ).rejects.toThrow(modelError);

    expect(recordAgentRun).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ status: "error", errorMessage: "Anthropic request failed" }),
    );
    expect(appendTripRequirement).not.toHaveBeenCalled();
    expect(advanceTrip).not.toHaveBeenCalled();
  });

  it("when record_extraction and a revision target the same field in one turn, the revision wins and only one row is appended", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        requirements: [{ field: "budgetTotalUsd", value: 3500, source: "user_explicit", confidence: 1 }],
        revisionProposal: { revisionType: "requirement", target: "budgetTotalUsd", value: 4000 },
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "budget is 3500, actually make it 4000",
    });

    expect(appendTripRequirement).toHaveBeenCalledTimes(1);
    expect(appendTripRequirement).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "budgetTotalUsd", value: 4000 }),
    );
    expect(result.requirements.filter((r) => r.field === "budgetTotalUsd")).toEqual([
      expect.objectContaining({ value: 4000 }),
    ]);
  });

  it("retires any existing active row for a field before appending its new value", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(listActiveTripRequirements).mockResolvedValue([requirementRow("budgetTotalUsd", 3000)] as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        requirements: [{ field: "budgetTotalUsd", value: 4000, source: "user_explicit", confidence: 1 }],
      }) as never,
    );

    await processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "make it 4000" });

    expect(retireActiveTripRequirementsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "budgetTotalUsd");
    expect(appendTripRequirement).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "budgetTotalUsd", value: 4000 }),
    );
  });

  it("applies a valid requirement revision proposal, superseding the prior value", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(listActiveTripRequirements).mockResolvedValue([requirementRow("budgetTotalUsd", 3000)] as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        revisionProposal: { revisionType: "requirement", target: "budgetTotalUsd", value: 4000 },
        toolCallLog: [{ toolName: "propose_trip_revision", input: {}, status: "success", result: {} }],
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "actually make it 4000",
    });

    expect(retireActiveTripRequirementsForField).toHaveBeenCalledWith(supabase, TRIP_ID, "budgetTotalUsd");
    expect(appendTripRequirement).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ field: "budgetTotalUsd", value: 4000 }),
    );
    const budgetEntries = result.requirements.filter((r) => r.field === "budgetTotalUsd");
    expect(budgetEntries).toHaveLength(1);
    expect(budgetEntries[0].value).toBe(4000);
  });

  it("signals decisionRevisionRequested for a revisable decision field, without applying anything itself or logging it as unsupported", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        revisionProposal: { revisionType: "decision", target: "hotel", value: "hotel_456" },
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "switch hotels",
    });

    expect(result.decisionRevisionRequested).toEqual({ step: "hotel" });
    expect(result.pendingCascadeConfirmation).toBeNull();
    expect(recordGuardrailEvent).not.toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "decision_revision_unsupported" }),
    );
    expect(appendTripRequirement).not.toHaveBeenCalled();
    expect(appendTripPreference).not.toHaveBeenCalled();
  });

  it("signals pendingCascadeConfirmation instead of decisionRevisionRequested when revising an already-confirmed earlier step", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      { id: "d1", trip_id: TRIP_ID, field: "outboundFlight", value: "o1", status: "confirmed", source: "user_explicit", created_at: "now" },
      { id: "d2", trip_id: TRIP_ID, field: "returnFlight", value: "r1", status: "confirmed", source: "user_explicit", created_at: "now" },
      { id: "d3", trip_id: TRIP_ID, field: "hotel", value: "h1", status: "confirmed", source: "user_explicit", created_at: "now" },
    ] as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        revisionProposal: { revisionType: "decision", target: "flight", value: null },
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "actually, change my flight",
    });

    expect(result.decisionRevisionRequested).toBeNull();
    expect(result.pendingCascadeConfirmation).toEqual({ kind: "decision", step: "flight", field: "flight" });
  });

  it("signals pendingCascadeConfirmation for a requirement revision that maps to a step with confirmed downstream work, while still persisting the requirement", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(listActiveTripDecisions).mockResolvedValue([
      { id: "d1", trip_id: TRIP_ID, field: "hotel", value: "h1", status: "confirmed", source: "user_explicit", created_at: "now" },
      { id: "d2", trip_id: TRIP_ID, field: "activities", value: "[]", status: "confirmed", source: "user_explicit", created_at: "now" },
    ] as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        revisionProposal: { revisionType: "requirement", target: "minHotelRating", value: 4.5 },
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "actually I want a higher-rated hotel",
    });

    expect(result.pendingCascadeConfirmation).toEqual({ kind: "requirement", step: "hotel", field: "minHotelRating" });
    expect(appendTripRequirement).toHaveBeenCalledWith(supabase, expect.objectContaining({ field: "minHotelRating", value: 4.5 }));
  });

  it("logs a domain-validation guardrail for a decision revision targeting a field that isn't revisable", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        revisionProposal: { revisionType: "decision", target: "activities", value: "swap the food tour" },
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "swap the food tour for something else",
    });

    expect(result.decisionRevisionRequested).toBeNull();
    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "decision_revision_unsupported", layer: "domain_validation", triggered: true }),
    );
    expect(appendTripRequirement).not.toHaveBeenCalled();
    expect(appendTripPreference).not.toHaveBeenCalled();
  });

  it("logs an output-validation guardrail and skips a revision whose value doesn't match its field's schema", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        revisionProposal: { revisionType: "requirement", target: "partySize", value: "two" },
      }) as never,
    );

    await processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "two of us actually" });

    expect(recordGuardrailEvent).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ guardrailName: "revision_schema_validation", layer: "output_validation", triggered: true }),
    );
    expect(appendTripRequirement).not.toHaveBeenCalled();
  });

  it("excludes a superseded field's stale row from the returned snapshot", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(listActiveTripRequirements).mockResolvedValue([
      requirementRow("origin", "New York"),
      requirementRow("budgetTotalUsd", 3000),
    ] as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(
      emptyAgentResult({
        requirements: [{ field: "budgetTotalUsd", value: 4000, source: "user_explicit", confidence: 1 }],
      }) as never,
    );

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "make it 4000",
    });

    expect(result.requirements.filter((r) => r.field === "budgetTotalUsd")).toHaveLength(1);
    expect(result.requirements.find((r) => r.field === "origin")?.value).toBe("New York");
  });

  it("throws if the trip has no state history", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(null);

    await expect(
      processIntakeTurn(supabase, modelClient, { tripId: TRIP_ID, sessionId: SESSION_ID, userMessage: "hi" }),
    ).rejects.toThrow("no state history");
  });

  it("substitutes a fallback assistant message when the model only calls tools and returns no text (observed live)", async () => {
    vi.mocked(getLatestTripState).mockResolvedValue(stateAt("collecting_requirements", 3) as never);
    vi.mocked(runIntakeAgent).mockResolvedValue(emptyAgentResult({ assistantMessage: "" }) as never);

    const result = await processIntakeTurn(supabase, modelClient, {
      tripId: TRIP_ID,
      sessionId: SESSION_ID,
      userMessage: "budget is 3000",
    });

    expect(result.assistantMessage).not.toBe("");
    expect(appendMessage).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ role: "assistant", content: result.assistantMessage }),
    );
  });
});
