# Architecture Decision Record Index

Tracks decisions under the five ADR areas defined in `PROJECT_BRIEF.md` §5. Per the project's own coding-agent instructions (`PROJECT_BRIEF.md` §17.1, §23), this index is updated as decisions are made — detailed ADRs are written only for decisions that have actually been made, not speculatively for the full backlog.

| # | Title | Area | Status |
|---|---|---|---|
| [ADR-000](ADR-000-tech-stack-and-topology.md) | Tech stack and app topology | Cross-cutting | Decided |
| ADR-001 | System boundaries and AI responsibilities | 1 | Adopted from `PROJECT_BRIEF.md` §4.1, §6 — no deviation yet requiring a standalone ADR |
| ADR-002 | Agent roster and responsibilities | 1 | Adopted from `PROJECT_BRIEF.md` §6.2 — no deviation yet |
| [ADR-003](ADR-003-state-and-data-model.md) | State and data model — identity, auth, RLS | 2 | Decided (identity/auth scope); rest of state model adopted from `PROJECT_BRIEF.md` §7 |
| ADR-004 | Workflow orchestration and execution | 3 | Custom loop confirmed (`PROJECT_BRIEF.md` §4.3); state machine adopted from §8 — not yet implemented |
| ADR-005 | Validation, guardrails, and evaluation | 4 | Not yet decided — layered guardrail design adopted from `PROJECT_BRIEF.md` §9 as the starting point |
| ADR-006 | Evaluation strategy | 4 | Not yet decided — deferred to Phase 4/8 of the build sequence |
| ADR-007 | Observability | 5 | Not yet decided — deferred to Phase 3/8 |
| ADR-008 | Booking boundaries | 1 | Adopted from `PROJECT_BRIEF.md` §6.5 — no deviation, no standalone ADR needed unless one arises |

## Area 1 — System Boundaries and AI Responsibilities

- [x] System boundary: deterministic services vs. AI reasoning — adopted from brief, no deviation.
- [x] Agent roster and justification — adopted from brief (4 agents: Intake/Revision Interpreter, Destination/Activity Curator, Trip Explanation Agent, Itinerary Writer), no deviation.
- [x] Model-facing tool policy — adopted from brief §6.4/§12, no deviation.
- [x] App topology / provider abstraction — **ADR-000**.
- [x] Model selection (specific Claude model per agent) — resolved 2026-09-16 for the Intake/Revision Interpreter: **Sonnet 5**, confirmed by a component eval run (Sonnet 5 6/6 cases, Haiku 4.5 5/6 — missed a revision-interpretation case) rather than assumed. Model-client interface (`src/agents/model-client.ts`) stays provider/model-agnostic so this can be revisited per-agent as later agents are built.
- [x] Booking and external-action boundary — adopted from brief §6.5, no deviation.
- [ ] Security and prompt-injection handling — adopted in principle (brief §6.6); concrete implementation (input sanitization, retrieved-content delimiting) is a Phase 5/6 task, not yet an ADR.
- [x] Prompt-caching experiment — measured for the Intake agent (`src/agents/providers/anthropic-model-client.ts`, `PROJECT_BRIEF.md` §6.7 static-first ordering); real cache-read hits confirmed via `npm run eval:intake`. Revisit per-agent as later agents (Curator, Explanation, Writer) are built.

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
- [ ] Retry and recovery policy — adopted in principle (brief §8.3–§8.4); concrete policy (backoff, retry limits) is a Phase 3 implementation detail, not yet an ADR.
- [ ] Cancellation behavior — same as above.
- [ ] Idempotency strategy — same as above.
- [ ] Checkpointing and replay — same as above.
- [x] Revision and finalization flow — adopted from brief §8.2, §8.7, no deviation.

## Area 4 — Validation and Evaluation

- [x] Guardrail layers — adopted from brief §9.1, no deviation.
- [x] Budget model — adopted from brief §9.3, no deviation.
- [x] Itinerary feasibility model — adopted from brief §9.2, no deviation.
- [ ] Deterministic vs. LLM-based grading — adopted in principle (brief §9.6, prefer deterministic); concrete eval harness design is a Phase 8 task.
- [ ] Evaluation dataset and scenario replay — the 16 scenarios in brief §19 are the starting backlog; harness design not yet decided.
- [ ] Adversarial testing approach — deferred to Phase 8.

## Area 5 — Observability and Measurement

- [x] Event taxonomy — adopted from brief §8.5, §13.1, no deviation.
- [x] Trace and correlation IDs — adopted from brief §13.1, no deviation (schema already includes `correlation_id`/`workflow_run_id` columns).
- [ ] Telemetry retention and redaction policy — not yet decided, needed before Phase 3 is complete.
- [ ] Engineering dashboard — deferred to Phase 8.
- [ ] Product metrics — deferred to Phase 8.
- [ ] CI evaluation reporting — deferred to Phase 8 (see `PROJECT_BRIEF.md` §22, item 5).
- [x] Build-log conventions — adopted from brief §17.4 (`BUILD_LOG.md` template), no deviation.
