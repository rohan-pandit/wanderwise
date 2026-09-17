/**
 * The Orchestrator (PROJECT_BRIEF.md §6.2/§6.3), scoped for Phase 6 to the
 * one agent that exists so far — the Intake and Revision Interpreter
 * (`src/agents/intake.ts`). Wiring later agents (Curator, Explanation
 * Writer) in Phase 5/7 follows the same shape: load the state slice an
 * agent needs, call it through a `ModelClient`, validate its output,
 * persist what's valid, log telemetry/guardrails, drive the workflow
 * controller.
 *
 * This module is what §6.3 describes the orchestrator doing and *not*
 * doing: it loads trip state, invokes the agent, persists validated state
 * changes, emits workflow events, enforces transition gates (by only ever
 * calling `advanceTrip`, never writing `trips.status`/`trip_state_versions`
 * directly) — and it never computes a budget, never queries inventory
 * tables, and the completeness gate that actually decides `requirements_ready`
 * is deterministic code (`checkRequirementsComplete`), not the model's own
 * claim that it's done.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { runIntakeAgent, type IntakeAgentResult } from "@/src/agents/intake";
import type { ModelClient } from "@/src/agents/model-client";
import {
  ExtractedPreference,
  ExtractedRequirement,
  checkRequirementsComplete,
  type ClarificationRequest,
  type ExtractionSource,
  type PreferenceFieldName,
  type PreferenceRecord,
  type RequirementFieldName,
  type RequirementRecord,
  type RevisionProposal,
} from "@/src/domain/extraction";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { appendMessage } from "@/src/repositories/messages";
import {
  appendTripPreference,
  listActiveTripPreferences,
  retireActiveTripPreferencesForField,
  type TripPreferenceRow,
} from "@/src/repositories/trip-preferences";
import {
  appendTripRequirement,
  listActiveTripRequirements,
  retireActiveTripRequirementsForField,
  type TripRequirementRow,
} from "@/src/repositories/trip-requirements";
import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getTrip } from "@/src/repositories/trips";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import {
  getCurrentChainStep,
  requirementRevisionTargetStep,
  revisionRisksConfirmedWork,
  type ChainDecision,
  type ChainStep,
} from "@/src/domain/chain";
import { advanceOrThrow } from "./advance";
import { deriveCorrelationId } from "./correlation";
import { REVISABLE_CHAIN_STEPS } from "./step-shared";
import type { WorkflowEvent, WorkflowState } from "./state-machine";

export interface DecisionRevisionRequested {
  step: ChainStep;
}

export interface PendingCascadeConfirmation {
  kind: "decision" | "requirement";
  step: ChainStep;
  field: string;
}

export { OrchestrationConflictError, OrchestrationTransitionError } from "./orchestration-errors";

const AGENT_NAME = "intake_and_revision_interpreter";
const MAX_MESSAGE_LENGTH = 4000;

export class InputGuardrailRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InputGuardrailRejectedError";
  }
}

/**
 * The only caller today (`app/app/actions.ts`) always derives `sessionId`
 * from the trip it looked up, so this never fires in practice — but nothing
 * inside this module enforced that on its own before this check existed. A
 * future caller (a Route Handler, a test, a second Server Action) passing a
 * mismatched pair would otherwise append chat messages and stamp telemetry
 * against a session that has nothing to do with the trip, with no error.
 */
export class SessionTripMismatchError extends Error {
  constructor(tripId: string, sessionId: string) {
    super(`Trip ${tripId} does not belong to session ${sessionId}.`);
    this.name = "SessionTripMismatchError";
  }
}

function requirementRecordFromRow(row: TripRequirementRow): RequirementRecord {
  return {
    id: row.id,
    field: row.field as RequirementFieldName,
    value: row.value,
    source: row.source as ExtractionSource,
    confidence: row.confidence ?? 1,
    status: row.status as RequirementRecord["status"],
    createdAt: row.created_at,
  };
}

/** Keeps only the last item per field — if `record_extraction` and/or `propose_trip_revision` both target the same field in one turn, the last one in call order wins, matching how the same field reported twice across multiple `record_extraction` calls already behaves. Without this, the retire-then-append loop would still leave the DB correct (each retire clears the prior insert), but the in-memory rows from earlier, now-superseded iterations would leak into the returned snapshot. */
function lastByField<T extends { field: string }>(items: T[]): T[] {
  const byField = new Map<string, T>();
  for (const item of items) byField.set(item.field, item);
  return [...byField.values()];
}

function preferenceRecordFromRow(row: TripPreferenceRow): PreferenceRecord {
  return {
    id: row.id,
    field: row.field as PreferenceFieldName,
    value: row.value as string | string[],
    source: row.source as ExtractionSource,
    confidence: row.confidence ?? 1,
    status: row.status as PreferenceRecord["status"],
    createdAt: row.created_at,
  };
}

/**
 * Decides which workflow events (in order) this turn's outcome authorizes —
 * the Layer 4 gate itself still lives in `validateStateTransition` via
 * `advanceTrip`; this only decides what to *propose*. Deliberately narrow:
 * the only way out of `awaiting_clarification` is full completeness (which
 * also immediately satisfies `requirements_ready`, so both hops apply in the
 * same turn) — whether the model happened to ask another clarifying question
 * this turn doesn't drive a state transition, only what's shown to the user.
 */
function decideNextEvents(
  workflowState: WorkflowState,
  ready: boolean,
  clarification: ClarificationRequest | null,
): WorkflowEvent[] {
  if (workflowState === "collecting_requirements") {
    if (ready) return ["requirements_complete"];
    if (clarification) return ["clarification_needed"];
    return [];
  }
  if (workflowState === "awaiting_clarification") {
    if (ready) return ["clarification_resolved", "requirements_complete"];
    return [];
  }
  return [];
}

/**
 * Turns a validated `propose_trip_revision` call into an extraction item the
 * same persistence path as `record_extraction` can apply — a revision is
 * structurally just a new value for a field, re-validated against that
 * field's own schema since `RevisionProposal.value` is untyped
 * (`src/domain/extraction.ts` deliberately leaves this to whoever applies
 * the revision).
 *
 * `revisionType: "decision"` doesn't apply anything itself — actually
 * revising a decision means re-proposing the relevant chain step
 * (`src/workflow/step-router.ts`'s `reviseChainStep`), which needs a model
 * client and embedding-adjacent state this orchestrator doesn't own. For a
 * step the caller knows how to handle (`step-shared.ts`'s
 * `REVISABLE_CHAIN_STEPS`), this returns a signal (`decisionRevisionRequested`)
 * for the caller (a Server Action) to act on after this turn persists,
 * rather than driving it here. An unrecognized target (e.g. "activities" —
 * which specific activity to swap needs more than a step name to resolve)
 * is logged as unsupported instead.
 *
 * Stepwise chain redesign slice 4: if revising the target risks invalidating
 * already-confirmed downstream work (`src/domain/chain.ts`'s
 * `revisionRisksConfirmedWork`), this returns `pendingCascadeConfirmation`
 * instead of (for a decision) `decisionRevisionRequested`, or alongside (for
 * a requirement) the still-persisted `requirement` — a requirement's value
 * is always recorded this turn as before; only the *ensuing* chain
 * re-propose/retirement waits on explicit user confirmation. Revising the
 * currently-active (not-yet-confirmed) step never risks this, since nothing
 * confirmed exists downstream of it yet.
 */
async function applyRevisionProposal(
  supabase: SupabaseClient<Database>,
  tripId: string,
  workflowRunId: string,
  proposal: RevisionProposal,
  confirmedDecisions: ChainDecision[],
): Promise<{
  requirement?: ExtractedRequirement;
  preference?: ExtractedPreference;
  decisionRevisionRequested?: DecisionRevisionRequested;
  pendingCascadeConfirmation?: PendingCascadeConfirmation;
}> {
  if (proposal.revisionType === "decision") {
    if (REVISABLE_CHAIN_STEPS.includes(proposal.target as ChainStep)) {
      const step = proposal.target as ChainStep;
      if (revisionRisksConfirmedWork(step, confirmedDecisions)) {
        return { pendingCascadeConfirmation: { kind: "decision", step, field: step } };
      }
      return { decisionRevisionRequested: { step } };
    }
    await recordGuardrailEvent(supabase, {
      tripId,
      agentName: AGENT_NAME,
      guardrailName: "decision_revision_unsupported",
      layer: "domain_validation",
      triggered: true,
      detail: `Revising "${proposal.target}" isn't supported yet — only flight/hotel can be revised.`,
      workflowRunId,
    });
    return {};
  }

  const candidate = { field: proposal.target, value: proposal.value, source: "user_explicit" as const, confidence: 1 };
  const schema = proposal.revisionType === "requirement" ? ExtractedRequirement : ExtractedPreference;
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    await recordGuardrailEvent(supabase, {
      tripId,
      agentName: AGENT_NAME,
      guardrailName: "revision_schema_validation",
      layer: "output_validation",
      triggered: true,
      detail: `${proposal.revisionType} revision for "${proposal.target}": ${parsed.error.message}`,
      workflowRunId,
    });
    return {};
  }
  if (proposal.revisionType === "preference") {
    return { preference: parsed.data as ExtractedPreference };
  }
  const requirement = parsed.data as ExtractedRequirement;
  const targetStep = requirementRevisionTargetStep(requirement.field);
  if (revisionRisksConfirmedWork(targetStep, confirmedDecisions)) {
    return { requirement, pendingCascadeConfirmation: { kind: "requirement", step: targetStep, field: requirement.field } };
  }
  return { requirement };
}

export interface ProcessIntakeTurnParams {
  tripId: string;
  sessionId: string;
  userMessage: string;
  /** Idempotency key for this turn — a retry with the same ID must be safe (PROJECT_BRIEF.md §8.3). Defaults to a fresh UUID if omitted, which means a caller that wants retry safety across its own request boundary must generate and pass one itself. */
  correlationId?: string;
}

export interface ProcessIntakeTurnResult {
  workflowState: WorkflowState;
  assistantMessage: string;
  clarification: ClarificationRequest | null;
  ready: boolean;
  requirements: RequirementRecord[];
  preferences: PreferenceRecord[];
  /** Set when this turn proposed a revision to the *active* (not-yet-confirmed) chain step, safe to act on immediately — the caller should follow up with `reviseChainStep` (`src/workflow/step-router.ts`) once this turn's own persistence/transition finishes. Mutually exclusive with `pendingCascadeConfirmation`. */
  decisionRevisionRequested: DecisionRevisionRequested | null;
  /** Set when applying this turn's revision risks invalidating already-confirmed downstream work (`src/domain/chain.ts`'s `revisionRisksConfirmedWork`) — the caller must show a warning and get explicit confirmation (`confirmCascadeAndRevise`) before re-proposing/retiring anything. For a requirement revision, the value itself is already persisted this turn regardless; only the ensuing cascade waits. */
  pendingCascadeConfirmation: PendingCascadeConfirmation | null;
}

export async function processIntakeTurn(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  params: ProcessIntakeTurnParams,
): Promise<ProcessIntakeTurnResult> {
  const correlationId = params.correlationId ?? randomUUID();
  const trimmed = params.userMessage.trim();

  // Layer 1 guardrail (PROJECT_BRIEF.md §9.1): input/scope controls, before any model call.
  const inputGuardrailReason =
    trimmed.length === 0
      ? "empty_message"
      : trimmed.length > MAX_MESSAGE_LENGTH
        ? "message_too_long"
        : null;
  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    sessionId: params.sessionId,
    agentName: AGENT_NAME,
    guardrailName: inputGuardrailReason ?? "input_scope_check",
    layer: "input_scope",
    triggered: inputGuardrailReason !== null,
  });
  if (inputGuardrailReason) {
    throw new InputGuardrailRejectedError(
      inputGuardrailReason === "empty_message"
        ? "Message is empty."
        : `Message exceeds ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  const trip = await getTrip(supabase, params.tripId);
  if (!trip || trip.session_id !== params.sessionId) {
    throw new SessionTripMismatchError(params.tripId, params.sessionId);
  }

  const [, currentState] = await Promise.all([
    appendMessage(supabase, { sessionId: params.sessionId, role: "user", content: trimmed }),
    getLatestTripState(supabase, params.tripId),
  ]);
  if (!currentState) {
    throw new Error(`Trip ${params.tripId} has no state history — call startTrip first.`);
  }

  let workflowState = currentState.state.workflowState;
  if (workflowState === "created") {
    workflowState = await advanceOrThrow(supabase, {
      tripId: params.tripId,
      event: "start_intake",
      actor: "user",
      correlationId: deriveCorrelationId(correlationId, "start_intake"),
      agentName: AGENT_NAME,
    });
  }

  const [requirementRows, preferenceRows, decisionRows] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripPreferences(supabase, params.tripId),
    listActiveTripDecisions(supabase, params.tripId),
  ]);
  const currentRequirements = requirementRows.map(requirementRecordFromRow);
  const currentPreferences = preferenceRows.map(preferenceRecordFromRow);
  // Only genuinely confirmed decisions are shown to the model (and used for
  // the cascade-warning check below) — `decisionRows` can now also include
  // "proposed" candidate rows (stepwise chain redesign slice 4), which
  // aren't decisions the user has actually made yet.
  const confirmedDecisionRows = decisionRows.filter((d) => d.status === "confirmed");
  const currentDecisions = confirmedDecisionRows.map((d) => ({ field: d.field, value: d.value, status: d.status }));
  const activeChainStep = getCurrentChainStep(confirmedDecisionRows);

  const run = await getOrCreateActiveWorkflowRun(supabase, params.tripId);
  const startedAt = Date.now();
  let agentResult: IntakeAgentResult;
  try {
    agentResult = await runIntakeAgent(modelClient, {
      userMessage: trimmed,
      currentRequirements,
      currentPreferences,
      currentDecisions,
      activeChainStep,
    });
  } catch (err) {
    await recordAgentRun(supabase, {
      tripId: params.tripId,
      sessionId: params.sessionId,
      workflowRunId: run.id,
      agentName: AGENT_NAME,
      model: modelClient.model,
      inputStateVersion: currentState.version,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      correlationId,
    });
    throw err;
  }
  const latencyMs = Date.now() - startedAt;

  // A turn cut off by max_tokens or declined by a safety refusal produced
  // whatever partial output it produced — that's not the same as a clean
  // completion, even if every tool call it did make happened to validate.
  const incompleteStopReason = agentResult.stopReason !== "end_turn" && agentResult.stopReason !== "tool_use";
  const anyToolCallFailed = agentResult.toolCallLog.some((c) => c.status === "error");
  const agentRun = await recordAgentRun(supabase, {
    tripId: params.tripId,
    sessionId: params.sessionId,
    workflowRunId: run.id,
    agentName: AGENT_NAME,
    model: modelClient.model,
    inputStateVersion: currentState.version,
    usage: agentResult.usage,
    latencyMs,
    status: anyToolCallFailed || incompleteStopReason ? "error" : "success",
    errorMessage: incompleteStopReason ? `stop_reason: ${agentResult.stopReason}` : null,
    correlationId,
  });

  await recordToolCalls(
    supabase,
    agentRun.id,
    agentResult.toolCallLog.map((call) => ({
      toolName: call.toolName,
      arguments: call.input as Json,
      result: (call.result ?? null) as Json,
      status: call.status,
    })),
  );

  // Layer 2 guardrail: a malformed tool call is a model-output-validation trigger, one row each — independent writes, safe to run concurrently.
  await Promise.all(
    agentResult.toolCallLog
      .filter((call) => call.status === "error")
      .map((call) =>
        recordGuardrailEvent(supabase, {
          tripId: params.tripId,
          agentName: AGENT_NAME,
          guardrailName: "tool_call_schema_validation",
          layer: "output_validation",
          triggered: true,
          detail: `${call.toolName}: ${call.error}`,
          workflowRunId: run.id,
        }),
      ),
  );

  const rawRequirements = [...agentResult.requirements];
  const rawPreferences = [...agentResult.preferences];
  let decisionRevisionRequested: DecisionRevisionRequested | null = null;
  let pendingCascadeConfirmation: PendingCascadeConfirmation | null = null;
  if (agentResult.revisionProposal) {
    const applied = await applyRevisionProposal(
      supabase,
      params.tripId,
      run.id,
      agentResult.revisionProposal,
      confirmedDecisionRows,
    );
    if (applied.requirement) rawRequirements.push(applied.requirement);
    if (applied.preference) rawPreferences.push(applied.preference);
    if (applied.decisionRevisionRequested) decisionRevisionRequested = applied.decisionRevisionRequested;
    if (applied.pendingCascadeConfirmation) pendingCascadeConfirmation = applied.pendingCascadeConfirmation;
  }
  const requirementsToApply = lastByField(rawRequirements);
  const preferencesToApply = lastByField(rawPreferences);

  // A field revised (or simply re-stated) this turn supersedes its prior
  // active row rather than living alongside it — retract-then-append,
  // sequential per item since more than one item in the same turn could
  // target the same field (the later one in the array wins).
  const newRequirementRows: TripRequirementRow[] = [];
  for (const r of requirementsToApply) {
    await retireActiveTripRequirementsForField(supabase, params.tripId, r.field);
    newRequirementRows.push(
      await appendTripRequirement(supabase, {
        tripId: params.tripId,
        field: r.field,
        value: r.value as Json,
        source: r.source,
        confidence: r.confidence,
      }),
    );
  }
  const newPreferenceRows: TripPreferenceRow[] = [];
  for (const p of preferencesToApply) {
    await retireActiveTripPreferencesForField(supabase, params.tripId, p.field);
    newPreferenceRows.push(
      await appendTripPreference(supabase, {
        tripId: params.tripId,
        field: p.field,
        value: p.value as Json,
        source: p.source,
        confidence: p.confidence,
      }),
    );
  }

  // The model sometimes calls a tool (most often record_extraction) with no
  // accompanying text at all — a real, observed behavior (not a bug in this
  // orchestrator), harmless as a bare API response but a visibly broken
  // empty chat bubble once a real chat UI renders it (Phase 7). Backstopped
  // here with a deterministic fallback rather than trusted to prompt
  // engineering alone, same as every other guarantee this orchestrator
  // makes about model output.
  const assistantMessage = agentResult.assistantMessage.trim() || "Got it — updating your trip details now.";
  await appendMessage(supabase, { sessionId: params.sessionId, role: "assistant", content: assistantMessage });

  // currentRequirements/currentPreferences were loaded before this turn's
  // retractions — drop anything just superseded so the snapshot below (and
  // the completeness check) reflects this turn's outcome, not stale rows.
  const touchedRequirementFields = new Set(requirementsToApply.map((r) => r.field));
  const touchedPreferenceFields = new Set(preferencesToApply.map((p) => p.field));
  const allRequirements = [
    ...currentRequirements.filter((r) => !touchedRequirementFields.has(r.field)),
    ...newRequirementRows.map(requirementRecordFromRow),
  ];
  const allPreferences = [
    ...currentPreferences.filter((p) => !touchedPreferenceFields.has(p.field)),
    ...newPreferenceRows.map(preferenceRecordFromRow),
  ];

  // Layer 3 guardrail (domain validation): the deterministic gate, never the model's own claim.
  const completeness = checkRequirementsComplete(allRequirements);
  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    agentName: AGENT_NAME,
    guardrailName: "requirements_completeness",
    layer: "domain_validation",
    triggered: !completeness.ready,
    detail: completeness.ready ? null : `missing: ${completeness.missingFields.join(", ")}`,
    workflowRunId: run.id,
  });

  // Layer 4 (workflow authorization): enforced inside `advanceTrip` itself; logged here either way.
  const events = decideNextEvents(workflowState, completeness.ready, agentResult.clarification);
  for (const event of events) {
    workflowState = await advanceOrThrow(supabase, {
      tripId: params.tripId,
      event,
      actor: AGENT_NAME,
      // Keyed by event name, not position — a retry that recomputes a
      // shorter chain (because an earlier step already durably applied
      // before a crash) must still derive the same ID for the same event,
      // not collide it with whatever event happened to be at that index
      // originally.
      correlationId: deriveCorrelationId(correlationId, `chain:${event}`),
      agentName: AGENT_NAME,
      workflowRunId: run.id,
    });
  }

  return {
    workflowState,
    assistantMessage,
    clarification: agentResult.clarification,
    ready: completeness.ready,
    requirements: allRequirements,
    preferences: allPreferences,
    decisionRevisionRequested,
    pendingCascadeConfirmation,
  };
}
