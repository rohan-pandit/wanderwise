# Architecture Decision Record Index

Tracks decisions under the five ADR areas defined in `PROJECT_BRIEF.md` §5. Per the project's own coding-agent instructions (`PROJECT_BRIEF.md` §17.1, §23), this index is updated as decisions are made — detailed ADRs are written only for decisions that have actually been made, not speculatively for the full backlog.

| # | Title | Area | Status |
|---|---|---|---|
| [ADR-000](ADR-000-tech-stack-and-topology.md) | Tech stack and app topology | Cross-cutting | Decided |
| ADR-001 | System boundaries and AI responsibilities | 1 | Adopted from `PROJECT_BRIEF.md` §4.1, §6 — no deviation yet requiring a standalone ADR |
| ADR-002 | Agent roster and responsibilities | 1 | Adopted from `PROJECT_BRIEF.md` §6.2 — no deviation yet |
| [ADR-003](ADR-003-state-and-data-model.md) | State and data model — identity, auth, RLS | 2 | Decided (identity/auth scope); rest of state model adopted from `PROJECT_BRIEF.md` §7 |
| ADR-004 | Workflow orchestration and execution | 3 | Custom loop confirmed (`PROJECT_BRIEF.md` §4.3); state machine adopted from §8 — not yet implemented |
| ADR-005 | Validation, guardrails, and evaluation | 4 | Adopted from `PROJECT_BRIEF.md` §9, no deviation — all four layers wired end to end since Phase 6, no standalone ADR needed |
| [ADR-006](ADR-006-evaluation-strategy.md) | Evaluation strategy | 4 | Decided, Phase 8 (2026-09-17); written up Phase 9 (2026-09-17) — deterministic grading throughout (no LLM-as-judge), a real direct-call harness against real Supabase/Anthropic/Voyage rather than a full authenticated-session one |
| [ADR-007](ADR-007-observability.md) | Observability | 5 | Decided, Phase 8 (2026-09-17); written up Phase 9 (2026-09-17), including the telemetry retention/redaction policy (`docs/IMPLEMENTATION_PLAN.md` §5) — `requiredAccessibility` redacted at write time via `src/observability/redaction.ts`, retention documented but not yet automated |
| ADR-008 | Booking boundaries | 1 | Adopted from `PROJECT_BRIEF.md` §6.5 — no deviation, no standalone ADR needed unless one arises |

## Area 1 — System Boundaries and AI Responsibilities

- [x] System boundary: deterministic services vs. AI reasoning — adopted from brief, no deviation.
- [x] Agent roster and justification — adopted from brief (4 agents: Intake/Revision Interpreter, Destination/Activity Curator, Trip Explanation Agent, Itinerary Writer), no deviation.
- [x] Model-facing tool policy — adopted from brief §6.4/§12, no deviation.
- [x] App topology / provider abstraction — **ADR-000**.
- [x] Model selection (specific Claude model per agent) — resolved 2026-09-16 for the Intake/Revision Interpreter: **Sonnet 5**, confirmed by a component eval run (Sonnet 5 6/6 cases, Haiku 4.5 5/6 — missed a revision-interpretation case) rather than assumed. Model-client interface (`src/agents/model-client.ts`) stays provider/model-agnostic so this can be revisited per-agent as later agents are built.
- [x] Booking and external-action boundary — adopted from brief §6.5, no deviation.
- [ ] Security and prompt-injection handling — adopted in principle (brief §6.6). Partially implemented: input-size limits for the Intake agent (Phase 6, `src/workflow/intake-orchestrator.ts`'s Layer 1 guardrail) and retrieved-content delimiting/untrusted-labeling for the Curator/Explanation agents (Phase 5, §10.4 — `<candidate_data>`/`<explanation_data>` blocks, explicit "not instructions" framing in both system prompts). Still open: a deterministic scope classifier (non-travel request detection) and adversarial testing against actual injection attempts (Phase 8). Not yet an ADR.
- [x] Prompt-caching experiment — measured for the Intake agent, twice: real cache-read hits confirmed via `npm run eval:intake` (Phase 4/6), then a real caching-on-vs-forced-off comparison (`evals/runners/run-cache-comparison.ts`, Phase 8 slice 6, 2026-09-17) quantified it — **45.5% cost reduction, no latency benefit** for claude-sonnet-5. Decision: keep caching on (real cost win); don't assume it also helps latency. Not yet measured for the Curator/Writer agents, which also use the same static-system-prompt structure — revisit if their cost profile ever becomes a concern.

## Area 2 — State and Data Architecture

- [x] Requirements/preferences/decisions model — adopted from brief §7.1, no deviation.
- [x] State versioning and event history — adopted from brief §7.3, no deviation.
- [ ] Inventory normalization and freshness — adopted in principle (brief §7.4); concrete seed-data decisions are a Phase 1 task.
- [x] Provenance model — adopted from brief §7.2, no deviation.
- [x] Approval model — adopted from brief §7.6, no deviation.
- [x] Supabase schema and RLS strategy — **ADR-003** (identity/auth); rest of schema in `supabase/migrations/0001_initial_schema.sql`.
- [x] Concurrency strategy — adopted from brief §7.7 (optimistic concurrency via version checks), no deviation.

## Area 3 — Workflow Execution

- [x] Custom workflow controller (not a framework) — adopted from brief §4.3, no deviation.
- [x] Workflow state machine — adopted from brief §8.1, no deviation; implementation is a Phase 3 task.
- [x] Retry and recovery policy — implemented for the transition layer (`advanceTrip`'s per-write correlation-ID guards, Phase 3) and reused for multi-hop transitions within one orchestrator turn (Phase 6, `src/workflow/intake-orchestrator.ts`'s event-name-keyed chaining — an index-keyed version of this had a real retry-breaking bug, found and fixed during Phase 6's review). **Known gap, tracked** (`docs/IMPLEMENTATION_PLAN.md` §5): a retry of a whole orchestrator turn isn't yet idempotent across the non-transition writes (`messages`/`agent_runs`/`tool_calls`/`guardrail_events`) the way transition mirrors are.
- [x] Cancellation behavior — adopted from brief §8.2/§8.4 (Phase 2's wildcard-`from` `cancel` rule); no dedicated cancellation caller exists yet (Phase 7+).
- [x] Idempotency strategy — `correlationId`-based, per §8.3; see the retry/recovery item above for the one known gap.
- [ ] Checkpointing and replay — adopted in principle (brief §8.3–§8.4); not yet a distinct concern from idempotency above.
- [x] Revision and finalization flow — adopted from brief §8.2, §8.7, no deviation.

## Area 4 — Validation and Evaluation

- [x] Guardrail layers — adopted from brief §9.1, no deviation; all four layers actually wired end to end for the Intake agent in Phase 6 (`src/workflow/intake-orchestrator.ts`, writing real `guardrail_events` rows), not just adopted in principle.
- [x] Budget model — adopted from brief §9.3, no deviation.
- [x] Itinerary feasibility model — adopted from brief §9.2, no deviation.
- [x] Deterministic vs. LLM-based grading — decided, Phase 8, 2026-09-17: every eval assertion (component, end-to-end scenario, adversarial) checks persisted state/structured output deterministically, per §9.6's own preference. No LLM-graded assertions exist anywhere in the suite.
- [x] Evaluation dataset and scenario replay — decided, Phase 8 slice 1, 2026-09-17: `evals/lib/scenario-harness.ts` + `evals/cases/scenarios.ts` drive the real stepwise chain against a real Supabase trip + real Anthropic/Voyage calls, persisted to `eval_runs`/`eval_results`. 6 of brief §19's 16 scenarios implemented; the other 10 (stale inventory, duplicate/idempotent request, cross-session isolation, cancellation, prompt injection in retrieved inventory text, failure/recovery) need real RLS/JWT-authenticated sessions or fault-injection infrastructure this harness's service-role/direct-function-call approach doesn't provide — tracked in `docs/IMPLEMENTATION_PLAN.md` §5, not silently dropped.
- [x] Adversarial testing approach — decided, Phase 8 slice 3, 2026-09-17: `evals/cases/adversarial.ts`, run by the same harness. 4 of §9.6's 8 categories covered (fabricated inventory IDs, budget-exceeding wording, contradictory user messages, cross-session references); "attempts to trigger booking" already covered by `scenarios.ts`'s `out_of_scope_request`. Prompt injection *in retrieved inventory text* and malformed/malicious inventory records need a seeded adversarial fixture — tracked, not yet built.

## Area 5 — Observability and Measurement

- [x] Event taxonomy — adopted from brief §8.5, §13.1, no deviation.
- [x] Trace and correlation IDs — adopted from brief §13.1, no deviation (schema already includes `correlation_id`/`workflow_run_id` columns); `agent_runs`/`tool_calls`/`guardrail_events` are now actually populated (Phase 6), not just schema-ready.
- [x] Telemetry retention and redaction policy — decided, Phase 9 (2026-09-17), see **ADR-007**: `requiredAccessibility` (the one genuinely sensitive extracted field) is redacted at write time in `src/repositories/agent-runs.ts`'s `recordToolCalls` via `src/observability/redaction.ts`. Time-based retention/deletion is a documented policy (90 days for raw payloads in a real deployment), not yet automated — every row in the hosted DB today is synthetic demo/eval data, so a real cleanup job has no privacy benefit yet. Revisit before treating this as production-ready.
- [x] Engineering dashboard — decided and built, Phase 8 slice 4, 2026-09-17: `app/internal/analytics/page.tsx`.
- [x] Product metrics — decided and built, Phase 8 slice 5, 2026-09-17: `app/internal/product-metrics/page.tsx`, deliberately a separate page per §13.4's own rule.
- [x] CI evaluation reporting — decided and built, Phase 8 slice 2, 2026-09-17: `.github/workflows/ci.yml` + `npm run eval:ci` (see `PROJECT_BRIEF.md` §22, item 5 — now resolved).
- [x] Build-log conventions — adopted from brief §17.4 (`BUILD_LOG.md` template), no deviation.
