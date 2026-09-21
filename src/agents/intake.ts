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

The trip state below includes today, today's real date (YYYY-MM-DD) — you have no other way to know it. When the user states a date without a year (e.g. "October 2nd", "next Tuesday"), resolve it relative to today to the correct upcoming occurrence, never a date that's already in the past relative to today. Only use a different year than that inference would produce if the user explicitly states one. This also applies to a relative range with no literal date at all — "next weekend" means the Saturday-Sunday of the week following today, "this weekend" the coming Saturday-Sunday (even if today is itself a weekend day), "in two weeks" a single date 14 days from today (not a range, unless the user also states how long the trip is). Never leave departureDate/returnDate unset just because the phrase was relative rather than a literal date — resolve it yourself using today, the same way you already do for "next Tuesday".

budgetTotalUsd must be a specific number — never invent one to fill it in. If the user only gives a qualitative descriptor with no number ("cheap", "budget-friendly", "as cheap as possible", "doesn't need to be fancy"), still call request_clarification for budgetTotalUsd since it's required either way, but also record that framing as a travelStyle preference (e.g. "budget-conscious") via record_extraction in the same turn so it isn't silently dropped — it should still be able to influence which options look best later, not just gate on the eventual number.

originAirportCode/destinationAirportCode are special: almost every trip never needs them (most cities have exactly one commercial airport, resolved automatically downstream), so never ask about or extract these unprompted. The trip state's pendingAirportClarification array is the only signal that they're needed right now — when it's non-empty, the deterministic system (not you) already asked the user which airport for each listed city+candidate-list, in the same shape you see it. If the user's latest message answers that — names one of the listed airports, by its code, its name, or a description that clearly picks one (e.g. "the one closest to Manhattan") — call record_extraction with the matching field set to that airport's exact iata code from the candidate list, never a code you're inferring on your own. If their message doesn't answer it (asks something else, or is ambiguous even against the candidate list), don't guess — leave the field unset; the same question will be asked again next turn.

origin and destination must both be specific cities, not a state, country, region, or vague description ("somewhere warm", "the Midwest", "Tuscany"). If the user's wording doesn't name an actual city, don't extract the field yet — ask them to name one instead. This version of Wanderwise only supports departures from within the United States: if the user's home city is clearly outside the US, or they only give a non-US country/region for where they're leaving from, ask for a specific US departure city the same way you would for any other too-vague origin, rather than trying to record a non-US one.

pendingDestinationClarification works the same way as pendingAirportClarification, for destination itself rather than which airport: non-empty means the deterministic system already asked the user to confirm or pick a destination, for one of a few reasons distinguished by each entry's regionKind. regionKind null means their wording didn't exactly match a known destination and the system is confirming a close match — candidates lists the real destination name(s) it found (one candidate: "did you mean X?"; several: "which did you mean?"). regionKind "state" or "country" means they named a whole US state or a whole country, not a specific city, and the system is asking which city instead — candidates, if non-empty, lists real cities already available in that region. regionKind "state_or_country" means the name matches both a US state and a real country Wanderwise has inventory for (e.g. "Georgia") — the system genuinely can't tell which one was meant, so ask the user to clarify, not just "which city" (candidates lists the country's cities, but a US state city is just as valid an answer). In every case, if the user's latest message answers it — confirms a candidate, names one of the listed candidates directly, or (for a state/country/state_or_country ask) names a specific city — call record_extraction with destination set to that exact resolved city name, never a value you're inferring or normalizing yourself. If their message doesn't answer it, don't guess — leave destination unset; the same question will be asked again next turn.

pendingOriginClarification is the same mechanic, narrower: it only ever fires when origin was given as a bare US state name with no specific city (e.g. "Texas") — cityQuery is that free text; there are no candidates to list, since (unlike destination) there's no catalog of "cities in this state" to offer. If the user's latest message names a specific city, call record_extraction with origin set to that city. If it doesn't, leave origin unset; the same question will be asked again next turn.

lastStepFailure, when not null, is the deterministic system's own record of the active chain step's most recent search/propose attempt failing — already known fact, not something you need to (or should) guess about. When the user asks about search results or progress ("check again", "why isn't this working", "any updates?"), ground your reply in this message rather than inventing a different or more optimistic explanation — do not suggest an unrelated fix (like adjusting the budget) unless the message itself points at one. If the user's current message just changed something that plausibly addresses the failure, it's fine to acknowledge a fresh attempt is happening instead of repeating the old failure verbatim.

When calling propose_trip_revision with revisionType "decision", target must be exactly "flight" or "hotel" — the chain step being revised, not a specific leg or field ("flight" covers both the outbound and return legs together). Activities can't be revised this way yet. The currently active, not-yet-confirmed step is given to you as activeChainStep in the trip state below; you may also target an earlier step that's already confirmed if the user is asking to change something already picked.

If the user's request about a decision is comparative/directional ("cheaper", "less expensive", "shorter", "higher rated") rather than an absolute threshold, don't propose a "decision" revision for it — instead propose a "requirement" revision with a concrete numeric threshold computed relative to the currently selected item's price/attribute (shown in the trip state's decisions below). For example, if the current hotel costs $158/night and the user asks for something cheaper, propose maxHotelPriceUsd around 10-15% below that (e.g. 135), not the word "cheaper" itself. If the request is instead absolute/hard ("free", "wheelchair accessible", "non-stop"), propose the matching requirement field directly at its exact value (e.g. maxActivityPriceUsd: 0 for "free") — do not invent a threshold for these.`;

/** One side (origin or destination) of a pending "which airport" disambiguation — computed deterministically by `checkAirportReadiness` (`src/workflow/step-shared.ts`), not by this agent. Kept as a minimal local shape (not that module's own `PendingAirportDisambiguation`) so this file stays a pure function of (message, state slice), with no coupling to workflow-layer types. */
export interface PendingAirportClarificationInput {
  field: "originAirportCode" | "destinationAirportCode";
  cityQuery: string;
  candidates: { iata: string; name: string }[];
}

/** A pending "which destination did you mean?" disambiguation — computed deterministically by `checkDestinationReadiness` (`src/workflow/step-shared.ts`), not by this agent. Same minimal-local-shape reasoning as `PendingAirportClarificationInput` above. */
export interface PendingDestinationClarificationInput {
  cityQuery: string;
  candidates: string[];
  regionKind: "state" | "country" | "state_or_country" | null;
}

/** A pending "which city are you leaving from?" disambiguation — computed deterministically by `checkOriginReadiness` (`src/workflow/step-shared.ts`), not by this agent. Narrower than `PendingDestinationClarificationInput`: origin has no candidate cities to list (see that function's own docstring for why), just the free text that turned out to be a bare US state name. */
export interface PendingOriginClarificationInput {
  cityQuery: string;
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
  /**
   * Non-empty exactly when the trip is stuck waiting on a deterministic
   * "did you mean X?" / "which city?" answer (`processIntakeTurn`'s own
   * pre-turn check, `checkDestinationReadiness`) — same reasoning as
   * `pendingAirportClarification`: this agent has no conversation history,
   * so without this a bare "yes" or "New York City" reply gives it no
   * signal about what's being confirmed.
   */
  pendingDestinationClarification?: PendingDestinationClarificationInput[];
  /**
   * Non-empty exactly when the trip is stuck waiting on a deterministic
   * "which city are you leaving from?" answer (`processIntakeTurn`'s own
   * pre-turn check, `checkOriginReadiness`) — same reasoning as
   * `pendingDestinationClarification`, narrower scope (see that function's
   * own docstring: this app's origin support is currently US-only, and this
   * only ever fires for a bare US state name).
   */
  pendingOriginClarification?: PendingOriginClarificationInput[];
  /**
   * The active chain step's most recent propose/revision failure, if one
   * exists and nothing more recent (a later success) already superseded it
   * (`getLatestChainStepFailure`, `src/repositories/trip-events.ts`) — lets
   * this agent answer a follow-up like "check again?" with the real reason
   * instead of guessing one. Null/omitted means either nothing has failed
   * yet, or a later attempt already succeeded.
   */
  lastStepFailure?: { message: string } | null;
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
    pendingDestinationClarification: input.pendingDestinationClarification ?? [],
    pendingOriginClarification: input.pendingOriginClarification ?? [],
    lastStepFailure: input.lastStepFailure ?? null,
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
