import { describe, expect, it } from "vitest";
import {
  validateStateTransition,
  type TransitionRequest,
  type WorkflowEvent,
  type WorkflowState,
} from "./state-machine";

function req(overrides: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    tripId: "trip-1",
    fromState: "created",
    event: "start_intake",
    currentStateVersion: 1,
    ...overrides,
  };
}

describe("validateStateTransition", () => {
  it("allows each step of the happy path in order", () => {
    const steps: [WorkflowState, WorkflowEvent, WorkflowState][] = [
      ["created", "start_intake", "collecting_requirements"],
      ["collecting_requirements", "requirements_complete", "requirements_ready"],
      ["requirements_ready", "begin_search", "searching_inventory"],
      ["searching_inventory", "search_completed", "validating_candidates"],
      ["validating_candidates", "candidates_valid", "assembling_options"],
      ["assembling_options", "combinations_assembled", "validating_itinerary"],
      ["validating_itinerary", "itinerary_valid", "presenting_draft"],
      ["presenting_draft", "confirmation_requested", "awaiting_confirmation"],
    ];
    for (const [fromState, event, toState] of steps) {
      const result = validateStateTransition(req({ fromState, event }));
      expect(result).toEqual({ allowed: true, toState });
    }
  });

  it("finalizes only when the proposal hash matches and guardrails passed", () => {
    const base = req({ fromState: "awaiting_confirmation", event: "user_confirmed" });

    expect(validateStateTransition(base)).toEqual({
      allowed: false,
      reason: expect.stringContaining("changed since it was presented"),
    });
    expect(
      validateStateTransition({ ...base, proposalHashMatches: true }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("guardrails") });
    expect(
      validateStateTransition({ ...base, proposalHashMatches: true, guardrailsPassed: true }),
    ).toEqual({ allowed: true, toState: "finalized" });
  });

  it("a model can never jump straight from presenting_draft to finalized", () => {
    const result = validateStateTransition(
      req({ fromState: "presenting_draft", event: "user_confirmed" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("routes the revision loop back through itinerary validation", () => {
    expect(
      validateStateTransition(req({ fromState: "presenting_draft", event: "revision_requested" })),
    ).toEqual({ allowed: true, toState: "awaiting_user_revision" });
    expect(
      validateStateTransition(req({ fromState: "awaiting_user_revision", event: "revision_submitted" })),
    ).toEqual({ allowed: true, toState: "applying_revision" });
    expect(
      validateStateTransition(req({ fromState: "applying_revision", event: "revision_applied" })),
    ).toEqual({ allowed: true, toState: "validating_itinerary" });
  });

  it("loops assembling options back when itinerary validation fails", () => {
    const result = validateStateTransition(
      req({ fromState: "validating_itinerary", event: "itinerary_invalid" }),
    );
    expect(result).toEqual({ allowed: true, toState: "assembling_options" });
  });

  it("marks a presented or awaiting-confirmation proposal stale on inventory change, and lets it refresh", () => {
    expect(
      validateStateTransition(req({ fromState: "presenting_draft", event: "inventory_changed" })),
    ).toEqual({ allowed: true, toState: "stale" });
    expect(validateStateTransition(req({ fromState: "stale", event: "refresh" }))).toEqual({
      allowed: true,
      toState: "assembling_options",
    });
  });

  it("allows cancellation from any non-terminal state", () => {
    const activeStates: WorkflowState[] = [
      "created",
      "collecting_requirements",
      "searching_inventory",
      "presenting_draft",
      "awaiting_confirmation",
      "stale",
      "failed_recoverable",
    ];
    for (const fromState of activeStates) {
      expect(validateStateTransition(req({ fromState, event: "cancel" }))).toEqual({
        allowed: true,
        toState: "cancelled",
      });
    }
  });

  it("routes errors to recoverable or terminal failure states from anywhere active", () => {
    expect(
      validateStateTransition(req({ fromState: "searching_inventory", event: "recoverable_error" })),
    ).toEqual({ allowed: true, toState: "failed_recoverable" });
    expect(
      validateStateTransition(req({ fromState: "searching_inventory", event: "fatal_error" })),
    ).toEqual({ allowed: true, toState: "failed_terminal" });
  });

  it("resumes failed_recoverable only into a valid, non-terminal resumeState", () => {
    const base = req({ fromState: "failed_recoverable", event: "resume" });

    expect(validateStateTransition(base)).toEqual({
      allowed: false,
      reason: expect.stringContaining("resumeState is required"),
    });
    expect(
      validateStateTransition({ ...base, resumeState: "finalized" }),
    ).toEqual({ allowed: false, reason: expect.stringContaining("terminal state") });
    expect(
      validateStateTransition({ ...base, resumeState: "requirements_ready" }),
    ).toEqual({ allowed: true, toState: "requirements_ready" });
  });

  it("rejects resuming into failed_recoverable itself as a no-op", () => {
    const result = validateStateTransition(
      req({ fromState: "failed_recoverable", event: "resume", resumeState: "failed_recoverable" }),
    );
    expect(result).toEqual({ allowed: false, reason: expect.stringContaining("no-op") });
  });

  it("rejects any transition once a trip has reached a terminal state", () => {
    for (const fromState of ["finalized", "cancelled", "failed_terminal"] as WorkflowState[]) {
      const result = validateStateTransition(req({ fromState, event: "start_intake" }));
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("terminal state");
    }
  });

  it("rejects an event that isn't permitted from the given state", () => {
    const result = validateStateTransition(
      req({ fromState: "created", event: "user_confirmed" }),
    );
    expect(result).toEqual({
      allowed: false,
      reason: 'Event "user_confirmed" is not permitted from state "created".',
    });
  });
});
