# ADR-006: Evaluation Strategy

**Status:** Decided — 2026-09-17 (Phase 8)
**Area:** 4 — Validation and Evaluation (`PROJECT_BRIEF.md` §5, §9.6, §19)

## Scope of this ADR

The four guardrail layers, the budget model, and the itinerary feasibility model (`PROJECT_BRIEF.md` §9.1–§9.5) are adopted as-is from the brief and implemented in Phase 2/6 — no deviation, no separate ADR. This ADR covers the two genuinely open sub-decisions from §9.6/§19: **how evaluation cases are graded, and what infrastructure runs them.**

## Context

`PROJECT_BRIEF.md` §9.6 describes three kinds of eval cases (component, end-to-end scenario, adversarial) and explicitly prefers deterministic grading over LLM-as-judge where possible. §19 lists 16 target end-to-end scenarios. Two things needed deciding before any of that could be built:

1. **Grading mechanism.** LLM-as-judge scales to open-ended output quality but is itself non-deterministic and adds cost/latency to the eval suite — a poor fit for gating CI. Deterministic assertions against persisted state or structured tool output are cheaper, reproducible, and directly testable, but only work where the thing being checked has a checkable structural shape (did the right requirement get recorded, did the right guardrail fire, did finalization get blocked) rather than a judgment about prose quality.
2. **Test harness shape.** A real end-to-end scenario needs a real trip moving through real workflow steps against real inventory — not a mock of the whole system, which would test the mocks more than the app. But "real" has a range: real Supabase rows + real Anthropic/Voyage API calls direct against the orchestrator functions (cheap to build, no auth/session plumbing) versus a fully authenticated RLS/JWT session driving the actual `app/app/actions.ts` server actions (closer to production traffic, needs auth infrastructure the eval suite didn't otherwise need).

## Decision

**Deterministic grading throughout — no LLM-graded assertions anywhere in the suite.** Every component, scenario, and adversarial case asserts against persisted database state or structured tool-call output (e.g., "does `trip_requirements` contain a `budgetTotalUsd` row with this value," "did `finalizeTrip` throw," "does the rejected-candidate list include this fabricated ID"), never "does this response read as reasonable."

**A real, direct-call harness, not a full-stack authenticated one.** `evals/lib/scenario-harness.ts` drives the actual orchestrator/workflow-controller functions (`processIntakeTurn`, `runSearchAndCuration`, `advanceTrip`, etc.) against a real Supabase project and real Anthropic/Voyage API calls, using the service-role client directly rather than going through `app/app/actions.ts` with an authenticated session. This exercises the real decision logic and real model behavior end to end, but not RLS policy enforcement or the HTTP/auth layer itself.

Component-level cases (`evals/cases/intake.ts`) test one agent in isolation via the same real-API approach, one level below the scenario harness.

## Rationale

- §9.6 itself expresses a preference for deterministic assertions; every eval case in this project's domain (requirement extraction, guardrail firing, budget/feasibility outcomes, state transitions) has a checkable structural shape, so there was never a case that actually needed LLM-as-judge to express what "correct" means.
- Deterministic assertions are what make `npm run eval:scenarios` a real regression suite rather than a demo script — a flaky judge model would undermine the exact CI-gating property the suite is built for.
- The direct-call harness gets real model behavior and real persisted state — the two things that actually matter for catching regressions in extraction quality, guardrail wiring, and workflow correctness — without needing to first build authenticated-session test infrastructure that nothing else in the eval suite requires.
- This is a real, acknowledged trade-off, not a free lunch: RLS enforcement, cross-session isolation, and true concurrent/duplicate-request handling are exactly the properties this harness *can't* verify, because it bypasses the auth layer those properties live in.

## Consequences

- 10 of §19's 16 scenarios remain unimplemented as of Phase 8: stale inventory, duplicate/idempotent request, cross-session isolation, cancellation, prompt injection in retrieved inventory text, and failure/recovery all need either a real RLS/JWT-authenticated session or fault-injection infrastructure (temporarily broken connections, mutated shared inventory rows) this harness doesn't provide. Tracked in `docs/IMPLEMENTATION_PLAN.md` §5, not silently dropped.
- 4 of §9.6's 8 adversarial categories are covered (`evals/cases/adversarial.ts`: fabricated inventory IDs, budget-pressure wording, contradictory dates, cross-session `tripId`/`sessionId` mismatch); prompt injection in retrieved inventory text and malformed/malicious inventory records need a seeded adversarial fixture, deferred as a separate, bigger piece of work.
- `.github/workflows/ci.yml` only gates on `npm run eval:ci` (typecheck + lint + mocked unit tests, zero network calls) — the real-API eval runners (`eval:intake`, `eval:retrieval`, `eval:scenarios`, `eval:cache-comparison`) stay manual, per §9.6's own "keep the eval suite cheap enough for CI" guidance. This means a regression in real model/API behavior is caught by whoever runs the manual suite, not automatically on every push.
- Every eval run persists to `eval_runs`/`eval_results` (real Supabase rows, not local-only output), which is what makes the engineering dashboard's eval-pass-rate trend (`app/internal/analytics`) possible — the grading decision and the observability decision (ADR-007) are linked for this reason.
- If a future eval case genuinely needs judgment about prose quality (e.g., grading the Itinerary Writer's explanation text for tone or coherence), that's a deliberate, separate decision to introduce LLM-as-judge for that one case — not a default to fall back into for cases this ADR's scope already covers deterministically.
