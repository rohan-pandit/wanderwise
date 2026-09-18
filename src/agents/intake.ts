/**
 * Intake and Revision Interpreter agent (PROJECT_BRIEF.md §6.2 row A). One
 * agent, not two — "intake" vs. "revision" is a framing difference driven by
 * whether `currentDecisions` is non-empty, not a separate code path (matches
 * §6.2's single row covering both responsibilities).
 *
 * Design choice, not literal to §12: the model always reports structured
 * requirements/preferences through a tool call (`record_extraction`) rather
 * than free-text JSON, alongside the two tools §12 does name
 * (`request_clarification`, `propose_trip_revision`). §6.4 says tool schemas
 * must be "explicit, typed, narrow, and validated" — that applies just as
 * much to getting extraction data out reliably as to the two named tools,
 * and keeping all three as real tool calls (rather than one structured-output
 * call plus two tool calls) means a single non-looping model request can
 * emit any combination of them in one turn.
 *
 * This agent never touches the database and never decides workflow state —
 * it is a pure function of (message, state slice) -> validated extraction,
 * called by a `ModelClient` it doesn't own. Wiring its output into
 * `trip_requirements`/`trip_preferences`/the workflow controller is Phase 6
 * (PROJECT_BRIEF.md §6.3: orchestrator persists validated state changes).
 */
import { z } from "zod";
import {
  ClarificationRequest,
  ExtractedPreference,
  ExtractedRequirement,
  REQUIRED_FOR_READY,
  REQUIREMENT_FIELDS,
  RevisionProposal,
  type PreferenceRecord,
  type RequirementRecord,
} from "@/src/domain/extraction";
import type { ModelClient, ModelCompletionUsage, ModelTool, ToolCallLogEntry } from "./model-client";

/**
 * The full-strictness schema shown to the model as the `record_extraction`
 * tool's input contract (every item must match `ExtractedRequirement`/
 * `ExtractedPreference` exactly). Our own parsing of the model's actual call
 * is deliberately looser than this — see `parseRecordExtractionCall` below —
 * so one malformed item doesn't discard the rest of an otherwise-valid call.
 */
const RecordExtractionInput = z.object({
  requirements: z.array(ExtractedRequirement).default([]),
  preferences: z.array(ExtractedPreference).default([]),
});

/** Single source of truth for tool names, so the dispatch loop below can't silently drift from what's actually sent to the model. */
const TOOL_NAMES = {
  recordExtraction: "record_extraction",
  requestClarification: "request_clarification",
  proposeTripRevision: "propose_trip_revision",
} as const;

const TOOLS: ModelTool[] = [
  {
    name: TOOL_NAMES.recordExtraction,
    description:
      "Report any trip requirements (hard musts) or preferences (soft wants) found in the user's latest message. Call only when the message actually contains new or changed information — omit fields already correctly recorded in the current trip state.",
    inputSchema: z.toJSONSchema(RecordExtractionInput) as Record<string, unknown>,
  },
  {
    name: TOOL_NAMES.requestClarification,
    description:
      "Ask the user for still-missing information needed to proceed. Only call this for fields not already present in the current trip state and not resolved by the latest message.",
    inputSchema: z.toJSONSchema(ClarificationRequest) as Record<string, unknown>,
  },
  {
    name: TOOL_NAMES.proposeTripRevision,
    description:
      "Propose a change to an already-recorded requirement, preference, or decision. Only call this when the user is asking to change something that was previously set, not for first-time information.",
    inputSchema: z.toJSONSchema(RevisionProposal) as Record<string, unknown>,
  },
];

const SYSTEM_PROMPT = `You are the Intake and Revision Interpreter for Wanderwise, a travel-planning concierge. You do not book anything, invent flights/hotels/activities, or quote prices — that is deterministic code's job downstream.

Each turn you receive the current trip state (already-recorded requirements, preferences, and, once selections exist, decisions) and the user's latest message. Your job:

1. Extract new or changed requirements/preferences from the message via record_extraction. A requirement is a hard must (origin, destination, dates, party size, budget, "no red-eye flights", accessibility need). A preference is a soft want that could be traded away (boutique hotels, food and culture focus, late mornings). Mark source as "user_explicit" when the user stated it directly, "user_inferred" when you reasonably inferred it, and set confidence to your actual certainty (1.0 for explicit statements, lower for inferences).
2. If required information is still missing after this message, call request_clarification naming exactly which fields and why. The required fields before planning can begin are: ${REQUIRED_FOR_READY.join(", ")}. Decide what to ask and how to phrase it yourself — there is no fixed question order.
3. If the user is asking to change something already recorded in the current trip state (a requirement, preference, or an actual decision like a chosen flight/hotel), call propose_trip_revision instead of record_extraction for that item.
4. Always also give a short, natural reply to the user as plain text alongside any tool calls.

Valid requirement fields: ${REQUIREMENT_FIELDS.join(", ")}. Never invent a field outside this list, and never fabricate a value the user didn't state or clearly imply.

The trip state below includes today, today's real date (YYYY-MM-DD) — you have no other way to know it. When the user states a date without a year (e.g. "October 2nd", "next Tuesday"), resolve it relative to today to the correct upcoming occurrence, never a date that's already in the past relative to today. Only use a different year than that inference would produce if the user explicitly states one.

originAirportCode/destinationAirportCode are special: almost every trip never needs them (most cities have exactly one commercial airport, resolved automatically downstream), so never ask about or extract these unprompted. The trip state's pendingAirportClarification array is the only signal that they're needed right now — when it's non-empty, the deterministic system (not you) already asked the user which airport for each listed city+candidate-list, in the same shape you see it. If the user's latest message answers that — names one of the listed airports, by its code, its name, or a description that clearly picks one (e.g. "the one closest to Manhattan") — call record_extraction with the matching field set to that airport's exact iata code from the candidate list, never a code you're inferring on your own. If their message doesn't answer it (asks something else, or is ambiguous even against the candidate list), don't guess — leave the field unset; the same question will be asked again next turn.

When calling propose_trip_revision with revisionType "decision", target must be exactly "flight" or "hotel" — the chain step being revised, not a specific leg or field ("flight" covers both the outbound and return legs together). Activities can't be revised this way yet. The currently active, not-yet-confirmed step is given to you as activeChainStep in the trip state below; you may also target an earlier step that's already confirmed if the user is asking to change something already picked.

If the user's request about a decision is comparative/directional ("cheaper", "less expensive", "shorter", "higher rated") rather than an absolute threshold, don't propose a "decision" revision for it — instead propose a "requirement" revision with a concrete numeric threshold computed relative to the currently selected item's price/attribute (shown in the trip state's decisions below). For example, if the current hotel costs $158/night and the user asks for something cheaper, propose maxHotelPriceUsd around 10-15% below that (e.g. 135), not the word "cheaper" itself. If the request is instead absolute/hard ("free", "wheelchair accessible", "non-stop"), propose the matching requirement field directly at its exact value (e.g. maxActivityPriceUsd: 0 for "free") — do not invent a threshold for these.`;

/** One side (origin or destination) of a pending "which airport" disambiguation — computed deterministically by `checkAirportReadiness` (`src/workflow/step-shared.ts`), not by this agent. Kept as a minimal local shape (not that module's own `PendingAirportDisambiguation`) so this file stays a pure function of (message, state slice), with no coupling to workflow-layer types. */
export interface PendingAirportClarificationInput {
  field: "originAirportCode" | "destinationAirportCode";
  cityQuery: string;
  candidates: { iata: string; name: string }[];
}

export interface IntakeAgentInput {
  userMessage: string;
  /** Today's real date (YYYY-MM-DD), computed once by the orchestrator (`processIntakeTurn`) and passed straight through — this agent has no other way to know it, and needs it to resolve a year-less date the user states (e.g. "October 2nd") to the correct upcoming date instead of guessing (found live 2026-09-18: guessed the wrong year with no grounding at all, docs/IMPLEMENTATION_PLAN.md). Required, not optional, so it can never be silently omitted. */
  today: string;
  currentRequirements: RequirementRecord[];
  currentPreferences: PreferenceRecord[];
  /**
   * Minimal decision summaries — present once selections exist, which is
   * what shifts the model into revision framing. Confirmed decisions only
   * (the caller filters out merely-"proposed" candidates). `priceUsd` (for
   * `outboundFlight`/`returnFlight`/`hotel`) is what lets the model actually
   * follow its own instruction below to compute a concrete threshold for a
   * comparative revision request ("a cheaper hotel") — found live
   * 2026-09-18 (`docs/IMPLEMENTATION_PLAN.md`): without it, the model
   * correctly noticed it had nothing to compute a relative threshold from
   * and asked for clarification instead of ever proposing the revision.
   */
  currentDecisions?: { field: string; value: unknown; status: string; priceUsd?: number; airline?: string | null; name?: string }[];
  /** The chain step (`src/domain/chain.ts`'s `ChainStep`) that's currently active/not-yet-confirmed, or "complete" once all three are — computed by the orchestrator via `getCurrentChainStep`, not by this module, to keep it free of chain-domain coupling beyond this string. Tells the model which decision-revision targets are "the active step" vs. "an already-confirmed earlier one." */
  activeChainStep?: string;
  /**
   * Non-empty exactly when the trip is stuck waiting on a deterministic
   * "which airport" answer (`processIntakeTurn`'s own pre-turn check) — this
   * agent has no conversation history, so without this a bare reply like
   * "JFK" or "the one closest to Manhattan" would give it no signal about
   * what's being answered, or that it's an answer at all rather than a new
   * fact. Each entry names the real candidate airports so the model resolves
   * the user's answer to an actual IATA code rather than guessing one.
   */
  pendingAirportClarification?: PendingAirportClarificationInput[];
}

export interface IntakeAgentResult {
  requirements: ExtractedRequirement[];
  preferences: ExtractedPreference[];
  clarification: ClarificationRequest | null;
  revisionProposal: RevisionProposal | null;
  assistantMessage: string;
  toolCallLog: ToolCallLogEntry[];
  usage: ModelCompletionUsage;
  /** Anthropic's `stop_reason` for this turn (e.g. "end_turn", "max_tokens", "refusal"). Callers should treat anything other than "end_turn"/"tool_use" as a signal the result may be incomplete rather than a clean empty turn. */
  stopReason: string;
}

function buildUserContent(input: IntakeAgentInput): string {
  const state = {
    today: input.today,
    requirements: input.currentRequirements.map((r) => ({ field: r.field, value: r.value, status: r.status })),
    preferences: input.currentPreferences.map((p) => ({ field: p.field, value: p.value, status: p.status })),
    decisions: input.currentDecisions ?? [],
    activeChainStep: input.activeChainStep ?? "flight",
    pendingAirportClarification: input.pendingAirportClarification ?? [],
  };
  return `Current trip state:\n${JSON.stringify(state)}\n\nLatest user message:\n${input.userMessage}`;
}

/** Loose top-level shape only — validates that `requirements`/`preferences` are arrays, without requiring their items to be valid yet. */
const RecordExtractionShape = z.object({
  requirements: z.array(z.unknown()).default([]),
  preferences: z.array(z.unknown()).default([]),
});

/**
 * Validates a `record_extraction` call item-by-item rather than as one atomic
 * array (unlike `RecordExtractionInput`, which is the strict contract shown
 * to the model). Zod array validation is all-or-nothing — one malformed item
 * would otherwise silently discard every valid sibling in the same call, so
 * this keeps whatever validates and reports only the items that don't.
 */
function parseRecordExtractionCall(
  input: unknown,
): { requirements: ExtractedRequirement[]; preferences: ExtractedPreference[]; errors: string[] } {
  const shape = RecordExtractionShape.safeParse(input);
  if (!shape.success) {
    return { requirements: [], preferences: [], errors: [shape.error.message] };
  }

  const requirements: ExtractedRequirement[] = [];
  const preferences: ExtractedPreference[] = [];
  const errors: string[] = [];

  for (const item of shape.data.requirements) {
    const parsed = ExtractedRequirement.safeParse(item);
    if (parsed.success) requirements.push(parsed.data);
    else errors.push(`requirement: ${parsed.error.message}`);
  }
  for (const item of shape.data.preferences) {
    const parsed = ExtractedPreference.safeParse(item);
    if (parsed.success) preferences.push(parsed.data);
    else errors.push(`preference: ${parsed.error.message}`);
  }

  return { requirements, preferences, errors };
}

export async function runIntakeAgent(
  modelClient: ModelClient,
  input: IntakeAgentInput,
): Promise<IntakeAgentResult> {
  const response = await modelClient.complete({
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: [{ role: "user", content: buildUserContent(input) }],
    maxTokens: 4096,
  });

  const result: IntakeAgentResult = {
    requirements: [],
    preferences: [],
    clarification: null,
    revisionProposal: null,
    assistantMessage: response.text,
    toolCallLog: [],
    usage: response.usage,
    stopReason: response.stopReason,
  };

  for (const call of response.toolCalls) {
    if (call.toolName === TOOL_NAMES.recordExtraction) {
      const parsed = parseRecordExtractionCall(call.input);
      result.requirements.push(...parsed.requirements);
      result.preferences.push(...parsed.preferences);
      result.toolCallLog.push({
        toolName: call.toolName,
        input: call.input,
        status: parsed.errors.length === 0 ? "success" : "error",
        result: { requirementsExtracted: parsed.requirements.length, preferencesExtracted: parsed.preferences.length },
        error: parsed.errors.length > 0 ? parsed.errors.join("; ") : undefined,
      });
    } else if (call.toolName === TOOL_NAMES.requestClarification) {
      const parsed = ClarificationRequest.safeParse(call.input);
      if (!parsed.success) {
        result.toolCallLog.push({ toolName: call.toolName, input: call.input, status: "error", error: parsed.error.message });
      } else if (result.clarification) {
        result.toolCallLog.push({
          toolName: call.toolName,
          input: call.input,
          status: "error",
          error: "duplicate request_clarification call in one turn",
        });
      } else {
        result.clarification = parsed.data;
        result.toolCallLog.push({ toolName: call.toolName, input: call.input, status: "success", result: parsed.data });
      }
    } else if (call.toolName === TOOL_NAMES.proposeTripRevision) {
      const parsed = RevisionProposal.safeParse(call.input);
      if (!parsed.success) {
        result.toolCallLog.push({ toolName: call.toolName, input: call.input, status: "error", error: parsed.error.message });
      } else if (result.revisionProposal) {
        result.toolCallLog.push({
          toolName: call.toolName,
          input: call.input,
          status: "error",
          error: "duplicate propose_trip_revision call in one turn",
        });
      } else {
        result.revisionProposal = parsed.data;
        result.toolCallLog.push({ toolName: call.toolName, input: call.input, status: "success", result: parsed.data });
      }
    } else {
      result.toolCallLog.push({ toolName: call.toolName, input: call.input, status: "error", error: "unknown tool" });
    }
  }

  return result;
}
