/**
 * Explicit workflow state machine (PROJECT_BRIEF.md §8.1/§8.2). The workflow
 * controller owns every transition — a model can propose an event (e.g.
 * "I've extracted requirements") but never sets `status` directly. This v1
 * table covers the linear happy path, the revision loop, confirmation, and
 * cancellation/failure/staleness; it's the seam Phase 3 wires the actual
 * controller against, and can grow new states/events as that work reveals
 * what's needed without touching callers of `validateStateTransition`.
 */

export const WORKFLOW_STATES = [
  "created",
  "collecting_requirements",
  "awaiting_clarification",
  "requirements_ready",
  "searching_inventory",
  "validating_candidates",
  "assembling_options",
  "validating_itinerary",
  "presenting_draft",
  "awaiting_user_revision",
  "applying_revision",
  "awaiting_confirmation",
  "finalized",
  "blocked",
  "failed_recoverable",
  "failed_terminal",
  "cancelled",
  "stale",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_EVENTS = [
  "start_intake",
  "clarification_needed",
  "clarification_resolved",
  "requirements_complete",
  "begin_search",
  "search_completed",
  "candidates_valid",
  "combinations_assembled",
  "itinerary_valid",
  "itinerary_invalid",
  "confirmation_requested",
  "revision_requested",
  "revision_submitted",
  "revision_applied",
  "user_confirmed",
  "inventory_changed",
  "refresh",
  "cancel",
  "recoverable_error",
  "fatal_error",
  "resume",
] as const;

export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

const TERMINAL_STATES = new Set<WorkflowState>(["finalized", "cancelled", "failed_terminal"]);

/** Matches a transition rule "from" any non-terminal state. */
const ANY_STATE = "*" as const;

export interface TransitionRequest {
  tripId: string;
  fromState: WorkflowState;
  event: WorkflowEvent;
  /** Not used for transition logic here — carried through so the caller can
   * stamp the resulting `trip_state_versions` write with the version this
   * decision was made against (optimistic concurrency is enforced at the
   * write, in Phase 3). */
  currentStateVersion: number;
  /** Required for `user_confirmed` from `awaiting_confirmation`: does the proposal the user is confirming match the current state? */
  proposalHashMatches?: boolean;
  /** Required for `user_confirmed`: have all guardrails passed? */
  guardrailsPassed?: boolean;
  /** Required for `resume` from `failed_recoverable`: the state to resume into. */
  resumeState?: WorkflowState;
}

export interface TransitionResult {
  allowed: boolean;
  toState?: WorkflowState;
  reason?: string;
}

interface TransitionRule {
  from: WorkflowState | typeof ANY_STATE;
  event: WorkflowEvent;
  /** Omitted only when the destination is caller-supplied (see the `resume` rule, resolved via `resumeState`). */
  to?: WorkflowState;
  /** Extra preconditions beyond "this transition exists in the table." Returns a reason string if not met. */
  precondition?: (req: TransitionRequest) => string | undefined;
}

const RULES: TransitionRule[] = [
  { from: "created", event: "start_intake", to: "collecting_requirements" },
  { from: "collecting_requirements", event: "clarification_needed", to: "awaiting_clarification" },
  { from: "awaiting_clarification", event: "clarification_resolved", to: "collecting_requirements" },
  { from: "collecting_requirements", event: "requirements_complete", to: "requirements_ready" },
  { from: "requirements_ready", event: "begin_search", to: "searching_inventory" },
  { from: "searching_inventory", event: "search_completed", to: "validating_candidates" },
  { from: "validating_candidates", event: "candidates_valid", to: "assembling_options" },
  { from: "assembling_options", event: "combinations_assembled", to: "validating_itinerary" },
  { from: "validating_itinerary", event: "itinerary_valid", to: "presenting_draft" },
  { from: "validating_itinerary", event: "itinerary_invalid", to: "assembling_options" },
  { from: "presenting_draft", event: "confirmation_requested", to: "awaiting_confirmation" },
  { from: "presenting_draft", event: "revision_requested", to: "awaiting_user_revision" },
  { from: "awaiting_confirmation", event: "revision_requested", to: "awaiting_user_revision" },
  { from: "awaiting_user_revision", event: "revision_submitted", to: "applying_revision" },
  { from: "applying_revision", event: "revision_applied", to: "validating_itinerary" },
  {
    from: "awaiting_confirmation",
    event: "user_confirmed",
    to: "finalized",
    precondition: (req) => {
      if (!req.proposalHashMatches) {
        return "The proposal has changed since it was presented — re-confirm the current version.";
      }
      if (!req.guardrailsPassed) {
        return "One or more guardrails did not pass.";
      }
      return undefined;
    },
  },
  { from: "presenting_draft", event: "inventory_changed", to: "stale" },
  { from: "awaiting_confirmation", event: "inventory_changed", to: "stale" },
  { from: "stale", event: "refresh", to: "assembling_options" },

  // Legal from any non-terminal state (terminal states are rejected before
  // the table is even consulted — see `validateStateTransition`).
  { from: ANY_STATE, event: "cancel", to: "cancelled" },
  { from: ANY_STATE, event: "recoverable_error", to: "failed_recoverable" },
  { from: ANY_STATE, event: "fatal_error", to: "failed_terminal" },
  {
    from: "failed_recoverable",
    event: "resume",
    // `to` is intentionally absent: the destination is caller-supplied via
    // `resumeState`, resolved in `validateStateTransition` once the
    // precondition below has validated it.
    precondition: (req) => {
      if (!req.resumeState) return "A resumeState is required to resume from failed_recoverable.";
      if (!WORKFLOW_STATES.includes(req.resumeState)) return `Unknown resumeState "${req.resumeState}".`;
      if (TERMINAL_STATES.has(req.resumeState)) return `Cannot resume directly into terminal state "${req.resumeState}".`;
      return undefined;
    },
  },
];

export function validateStateTransition(req: TransitionRequest): TransitionResult {
  if (TERMINAL_STATES.has(req.fromState)) {
    return { allowed: false, reason: `"${req.fromState}" is a terminal state; no further transitions are allowed.` };
  }

  const rule = RULES.find(
    (r) => (r.from === req.fromState || r.from === ANY_STATE) && r.event === req.event,
  );
  if (!rule) {
    return {
      allowed: false,
      reason: `Event "${req.event}" is not permitted from state "${req.fromState}".`,
    };
  }

  const violation = rule.precondition?.(req);
  if (violation) {
    return { allowed: false, reason: violation };
  }

  return { allowed: true, toState: rule.to ?? req.resumeState! };
}
