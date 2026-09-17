# Implementation Plan

Milestones, domain model, schema, and service-interface proposals from the first build session (2026-09-16). This is a living document — update it as milestones complete or scope shifts, per `PROJECT_BRIEF.md` §17.1.

Source of truth for *why* is `PROJECT_BRIEF.md`. This doc is the *how* and *in what order*.

---

## 1. Milestones (mapped to `PROJECT_BRIEF.md` §16 build sequence)

### Phase 0 — Architecture and project setup
- [x] Consolidate and finalize `PROJECT_BRIEF.md`
- [x] Decide app topology (single Next.js/TS app) — ADR-000
- [x] Decide identity/auth strategy (mandatory magic-link) — ADR-003
- [x] Initialize git, create public GitHub repo (`rohan-pandit/wanderwise`)
- [x] Create `CLAUDE.md`
- [x] Create ADR index and the two decided ADRs
- [x] Propose initial domain model and schema (this doc + migration)
- [x] Create `BUILD_LOG.md`
- [x] Scaffold the actual Next.js app (`create-next-app`, TypeScript, App Router, Tailwind)
- [x] Configure environment variables — `.env.local` populated with a **hosted** Supabase project's URL/anon/service-role keys, plus `ANTHROPIC_API_KEY` (see below for why hosted instead of local)
- [x] Supabase workflow established — **against a hosted project, not local Docker** (see below). Migration `0001_initial_schema.sql` pushed via `supabase db push --db-url`. Local Supabase (`supabase start`) remains blocked by a machine-level Windows issue (see `BUILD_LOG.md`, 2026-09-16 "Docker/local Supabase blocker" entry) — `supabase/config.toml` from `supabase init` is still in the repo in case local dev becomes viable again later, but the working setup for now is hosted-only.
- [x] Set up route skeleton: `/` (landing + magic-link sign-in), `/auth/callback`, `/app` (protected — chat + itinerary placeholder), `/app/trips` (history list, live query), `/app/trips/[tripId]` (placeholder)
- [x] Set up test runner (Vitest) with a trivial passing test, wired into `npm test`

### Phase 1 — Domain model and seeded data
- [x] Finalize normalized money/date types — `src/domain/money.ts` (`Money`, currency-checked arithmetic) and `src/domain/dates.ts` (`DateRange`, ISO-date-string based, no `Date` objects in domain code), both unit-tested
- [x] Implement inventory repositories — `src/repositories/{destinations,flights,hotels,activities}.ts`, typed query functions over a `SupabaseClient<Database>`, backing the future `search_flights`/`search_hotels`/`retrieve_activities` tools
- [x] Hand-wrote `src/config/supabase/database.types.ts` (the `Database` type for all Supabase clients) since `supabase gen types` requires Docker, which is still unavailable — keep in sync by hand until Docker works, then regenerate and diff
- [x] Write seed data — 6 destinations, 22 flights, 17 hotels, 27 activities in `supabase/migrations/0002_seed_data.sql` (lives in `migrations/`, not `seed.sql`, so one copy of the data works for both `db push` against hosted and a future local `db reset` — see the file's header comment), pushed to the hosted project and spot-verified against live queries
- [x] Edge-case fixtures — deliberately included: red-eye flights (including the cheapest option on a route, for eval scenario 5), a stale `inventory_version = 0` row in each of the four inventory tables (eval scenario 10), a Monday-closed activity, two activities in Barcelona with overlapping opening hours (for later itinerary-feasibility-engine testing), a full-day (480 min) activity, null `description`/`rating` fields, a non-refundable hotel, a 2-person-capacity hotel (occupancy constraint), and two near-duplicate-looking Lisbon hotels

### Phase 2 — Deterministic services (no LLM)
- [x] `calculateBudget()` — `src/domain/budget.ts`
- [x] `filterHardConstraints()` — `src/domain/constraints.ts`
- [x] `assembleCandidateCombinations()` — `src/domain/combinations.ts`
- [x] `validateItineraryFeasibility()` — `src/domain/feasibility.ts`
- [x] `validateInventoryReferences()` — `src/validation/inventory-references.ts`
- [x] `validateStateTransition()` — `src/workflow/state-machine.ts`
- [x] Unit tests for all of the above, independent of any LLM call (82 total, all passing)

### Phase 3 — State and workflow foundation
- [x] Session/trip repositories (typed CRUD) — `src/repositories/{sessions,trips}.ts`
- [x] State versioning writes, optimistic concurrency — `src/repositories/trip-state.ts` (`unique(trip_id, version)`, plus a partial unique index on `(trip_id, correlation_id)` — `supabase/migrations/0003_trip_state_idempotency.sql`)
- [x] Event history writes — `src/repositories/trip-events.ts`
- [x] Explicit workflow state machine — built in Phase 2 (`src/workflow/state-machine.ts`); Phase 3 wires it into an actual controller
- [x] Retry/idempotency/cancellation handling — `src/workflow/controller.ts` (`startTrip`/`advanceTrip`); cancellation is just the `cancel` event through the same controller (Phase 2's wildcard-from rule)
- [x] Workflow telemetry (`workflow_runs`/`workflow_steps` writes) — `src/repositories/workflow-runs.ts`

### Phase 4 — Intake and revision interpretation

- [x] Structured output schemas (Zod) for requirement/preference/decision extraction — `src/domain/extraction.ts` (`ExtractedRequirement` discriminated union over 14 fields, `ExtractedPreference`, `ClarificationRequest`, `RevisionProposal`, `checkRequirementsComplete()`), pure TypeScript, no model calls, unit-tested (28 tests including calendar-validity edge cases).
- [x] Intake and Revision Interpreter agent — `src/agents/intake.ts` (`runIntakeAgent`), one agent covering both responsibilities per `PROJECT_BRIEF.md` §6.2 row A (intake vs. revision is a framing difference driven by whether `currentDecisions` is non-empty, not a separate code path). Calls a `ModelClient` it doesn't own (`src/agents/model-client.ts`), so its parsing/aggregation logic is unit-tested (14 tests) with a fake client — no real API calls in `npm test`.
- [x] Clarification behavior — built as designed: a single `request_clarification(missing_fields, reason)` tool call the agent makes each turn; the agent decides what to ask and how to phrase it, only the `REQUIRED_FOR_READY` completeness check is deterministic code.
- [x] Revision interpretation — `propose_trip_revision` tool, same agent as intake.
- [x] Component evals for extraction/classification accuracy — `evals/cases/intake.ts` (6 cases: explicit multi-field, ambiguity detection, preference extraction, revision interpretation, adversarial prompt injection, contradictory-input resolution) + `evals/runners/run-intake-eval.ts` (`npm run eval:intake`, real API calls against both candidate models).
- [x] **Model selection — resolved 2026-09-16.** User declined both the bare Sonnet-5 recommendation and Haiku-4.5-only; chose to keep the model-client interface (`ModelClient`) provider/model-agnostic, wire **Sonnet 5** as the working default (`src/config/models.ts`), and let the component eval decide. First real eval run: **Sonnet 5 passed 6/6 cases** ($0.0345 total, ~4.6s avg latency, prompt caching confirmed working — 4,216 cache-read tokens/call from the 2nd call onward); **Haiku 4.5 passed 5/6** ($0.0303 total, ~2.4s avg latency, faster but failed the `revision_request` case — never called `propose_trip_revision` at all) and showed **zero cache hits** across all 6 calls, because Haiku 4.5's minimum cacheable prefix is 4,096 tokens (vs. 1,024 for Sonnet 5 — see the `claude-api` skill's caching doc) and this agent's static system+tools block apparently tokenizes just under that threshold on Haiku's tokenizer. **Sonnet 5 is the confirmed choice** — a real quality gap on revision interpretation, not just a hypothetical judgment concern. Re-run `npm run eval:intake` if the prompt/tools change materially enough to revisit this.
- [x] Set up prompt caching structure — `src/agents/providers/anthropic-model-client.ts`: system prompt cached (`cache_control` on the system block), tool definitions cached (breakpoint after the last tool), dynamic trip-state slice + user message passed last in `messages`, after the cache boundary (`PROJECT_BRIEF.md` §6.7 ordering). Measured via the eval run above (cache-read tokens logged per call), not assumed — a dedicated caching-disabled baseline mode wasn't built separately since the per-case cache-read counts in the eval output already make the on/off contrast visible (call 1 writes the cache, calls 2–6 read it); revisit if a more rigorous A/B comparison is needed later.

### Phase 5 — Retrieval and curation

**Embedding provider — decided 2026-09-16: Voyage AI.** Discussed against OpenAI `text-embedding-3-small` before any code was written (see `BUILD_LOG.md` for the full pros/cons). Anthropic doesn't offer embeddings itself, so some second provider is unavoidable either way; the two weren't a clean win for either side at this project's actual scale (6 destinations, 27 activities) — the deciding factors were narrative fit (Anthropic acquired Voyage AI in 2025, so it's now part of the same vendor relationship rather than a genuinely separate one) and that the schema-migration cost is cheap right now since the `embedding` columns are still empty. **Implementation consequence:** `supabase/migrations/0001_initial_schema.sql`'s `embedding vector(1536)` columns (`destinations`, `activities`) don't match any Voyage model's native output — Voyage's flexible-dimension models support Matryoshka truncation to specific values (256/512/1024/2048, to be confirmed against current API docs when implementing), not 1536. Needs a new migration narrowing the column to whichever supported dimension is chosen (1024 is the likely pick — a reasonable quality/index-size tradeoff) before any embeddings are generated.

- [x] Migration: narrow `destinations.embedding`/`activities.embedding` from `vector(1536)` to the chosen Voyage output dimension — `supabase/migrations/0005_retrieval.sql`, narrowed to `vector(1024)` (`voyage-4-lite`'s default, well-supported Matryoshka truncation point). Same migration adds `match_destinations`/`match_activities` — Postgres functions doing cosine-similarity search with metadata pre-filtering (budget/vibe tags for destinations; price/accessibility/vibe tags for activities) inside the database, not fetched-then-filtered client-side.
- [x] Generate embeddings for seed `destinations`/`activities` (Voyage AI) — `scripts/generate-embeddings.ts` (`npm run generate-embeddings`), idempotent/re-runnable, scoped to `CURRENT_INVENTORY_VERSION` so stale fixture rows are never embedded. Ran live: 6 destinations + 23 current-version activities, well within Voyage's free tier.
- [x] Metadata-filtered retrieval functions — `src/retrieval/{destinations,activities}-retrieval.ts` (`retrieveDestinations`/`retrieveActivities`, the `retrieve_destinations`/`retrieve_activities` tools from `PROJECT_BRIEF.md` §12): embed the query, delegate to the SQL functions above, and — for activities — apply the one filter deliberately kept out of SQL (`excludeClosedOnDaysConstraint`, Phase 2's constraint engine, made generic and reused rather than reimplemented). New provider-agnostic `EmbeddingClient` interface (`src/retrieval/embedding-client.ts`) + Voyage implementation, mirroring Phase 4's `ModelClient` pattern.
- [x] Destination/Activity Curator agent — `src/agents/curator.ts`. **Design departure, documented in-file:** `retrieve_destinations`/`retrieve_activities` are NOT live tool calls this agent makes mid-turn — the orchestrator retrieves candidates first (deterministic params: inventory version, budget ceiling) and hands them to the agent as input, which only ranks/explains via one output-shaping tool (`record_curation`). Avoids introducing a multi-turn tool-execution loop into `ModelClient` for what this phase only needs as a single rank-and-explain step. Hallucination guardrail (`src/domain/curation.ts`): every ranked/excluded ID must come from the candidate set given, checked deterministically.
- [x] Trip Explanation Agent — `src/agents/explanation.ts`, same non-looping/output-shaping/hallucination-guardrail pattern as the Curator, over an already-validated candidate/selection set plus optional budget/constraint context.
- [x] Retrieval quality checks (recall/precision spot checks against seed data) — `evals/cases/retrieval.ts` + `evals/runners/run-retrieval-eval.ts` (`npm run eval:retrieval`), 10 deterministic cases against known seed-data content (semantic ranking, budget filtering, vibe-tag hard-filtering, closed-day exclusion, accessibility filtering). Batches all query embeddings into one Voyage call rather than one per case — Voyage's free-tier rate limit (3 requests/minute without a payment method on file) makes per-case embedding calls impractical; ran live, 10/10 passed.

**Known limitation, tracked (see §5):** `retrieveActivities`'s closed-days post-filter uses a fixed overfetch heuristic (`OVERFETCH_FACTOR = 2`), not a guarantee — the SQL `LIMIT` still runs before the filter, so it could under-fill `topK` at a larger catalog size than this project's seed data. Also worth doing before Phase 7 puts real traffic through retrieval: add a payment method to the Voyage account (still free within the 200M-token tier) to lift the 3 RPM/10K TPM restriction, since the Curator agent will call retrieval roughly once per relevant chat turn.

### Phase 6 — Orchestration integration

Scoped to the one agent that exists so far — the Intake and Revision Interpreter. Wiring later agents (Curator, Explanation Writer, Itinerary Writer — Phase 5/7) follows the same shape once they exist.

- [x] Wire agents into the workflow controller — `src/workflow/intake-orchestrator.ts` (`processIntakeTurn`): loads trip state + requirements/preferences, calls `runIntakeAgent` through a `ModelClient`, persists validated output, drives `advanceTrip`. Reachable through a real authenticated path via a new Server Action (`app/app/actions.ts`, `sendMessage`) — no chat UI consumes it yet (Phase 7), but it's not just exercised by mocked tests.
- [x] Expose only the approved model-facing tools (`PROJECT_BRIEF.md` §6.4/§12) — unchanged from Phase 4's three tools; the orchestrator doesn't add any new model-facing surface.
- [x] Guardrail gates at each transition — all four `PROJECT_BRIEF.md` §9.1 layers logged to `guardrail_events`: input/scope (message length), output validation (malformed tool calls, invalid revision values), domain validation (the deterministic `checkRequirementsComplete` gate, unsupported decision revisions), workflow authorization (every `advanceTrip` call, triggered or not).
- [x] State persistence after each meaningful step — `trip_requirements`/`trip_preferences` (new repositories, with a retract-before-append primitive so a revised or re-stated field never leaves two active rows for the same field), `messages`, `agent_runs`/`tool_calls` telemetry (tokens, cache stats, latency, cost — `PROJECT_BRIEF.md` §13.2/§6.7), all via the existing `trip_state_versions`/`advanceTrip` path for workflow state itself.
- [x] Failure/retry behavior end to end, for what's reachable in this slice — `advanceTrip`'s own retry-safety (Phase 3) reused via event-name-keyed (not position-keyed — an index-based bug was found and fixed) per-step correlation IDs for multi-hop transitions within one turn; a `"conflict"` (optimistic-concurrency race) is now a distinct, catchable `OrchestrationConflictError` instead of being conflated with a rejected transition. **Known limitation, tracked deliberately (see §5):** a retry of the *whole* `processIntakeTurn` call (e.g. after a mid-turn crash) is not yet idempotent across `appendMessage`/`agent_runs`/`tool_calls`/`guardrail_events` the way `advanceTrip`'s own mirror writes are — asked the user now-vs-later per the standing rule, tracked rather than fixed this session (no caller retries yet; nothing to break in practice today).

#### Phase 6, continued — wiring search, curation, and combination

Phase 5 built the Curator/Explanation agents, retrieval, and (already, from Phase 2) the budget/combination/feasibility engines — none were wired into any orchestrator as of the previous session. Four open questions were recorded here rather than silently assumed; all four were put to the user directly at the start of this session and resolved before any code was written:

1. **`search_flights`/`search_hotels`: deterministic pre-fetch, or live model-driven tool calls?** **Resolved: deterministic pre-fetch**, consistent with Phase 5's `retrieve_destinations`/`retrieve_activities` precedent — `PROJECT_BRIEF.md` §12's own tool-table notes column already describes these as an "orchestrator-driven search step," which was the deciding evidence.
2. **New orchestrator module, or extend `intake-orchestrator.ts`?** **Resolved: new module**, `src/workflow/search-orchestrator.ts` (`runSearchAndCuration`) — mirrors `runIntakeAgent`/`runCuratorAgent` already being separate agent modules; `intake-orchestrator.ts` stays scoped to the `collecting_requirements`/`awaiting_clarification` loop.
3. **`trip_decisions` repository shape.** **Resolved: same append/retire-by-field shape** `trip_requirements`/`trip_preferences` already use, with the schema's own `proposed`/`confirmed`/`superseded` status vocabulary (not `active`/`retracted`) for the §7.6 approval lifecycle — **not yet built**, deferred to the next slice below.
4. **Scope for one session.** **Resolved: sliced.** Slice 1 (this session) = search_flights/search_hotels + Curator wiring only, stopping at `assembling_options` with a ranked candidate set. Slice 2 (next session) = `assembleCandidateCombinations`/`calculateBudget`/`validateItineraryFeasibility`/`validateInventoryReferences`, the `trip_decisions` repository, and the remaining state-machine transitions through `presenting_draft`.

**Slice 1 — done this session:**

- [x] Wire `search_flights`/`search_hotels` — `src/workflow/search-orchestrator.ts` (`runSearchAndCuration`) calls `findFlights`/`findHotels` (`src/repositories/flights.ts`/`hotels.ts`) with params built deterministically from validated `trip_requirements`, then re-validates the results through Phase 2's `filterHardConstraints` (defense in depth beyond whatever the repository query params already narrowed — §9.5 requires hard constraints enforced by code, not assumed correct because a query happened to include them).
- [x] Wire the Curator agent into a real orchestrator step — candidates in (activities from Phase 5's `retrieveActivities`), curation out (ranked/excluded IDs + rationale), persisted as an `activities_curated` `trip_events` row (no `trip_decisions` repository exists yet — see slice 2). Destinations are not curated here: `destination` is a required `trip_requirements` field, so it's already fixed by the time a trip reaches `requirements_ready` — the "flexible destination" case doesn't arise in this project's required-field model.
- [x] Drive `begin_search` → `search_completed` → `candidates_valid`, landing in `assembling_options`. A genuine "no viable candidates after hard-constraint filtering" outcome drives `recoverable_error` (§8.4) rather than leaving the workflow state ambiguous, and throws a typed `NoViableCandidatesError`.
- [x] Reachable through a real authenticated path — `beginSearch` Server Action (`app/app/actions.ts`), same rationale as `sendMessage`.
- [x] Extracted `deriveCorrelationId`/`OrchestrationConflictError`/`OrchestrationTransitionError`/the `advanceTrip`+guardrail-log+branch sequence (now `advanceOrThrow`) out of `intake-orchestrator.ts` into shared `src/workflow/{correlation,orchestration-errors,advance}.ts` — needed by both orchestrators now, so duplicating a third copy in `search-orchestrator.ts` would have been the wrong call. Behavior-preserving; `intake-orchestrator.test.ts` still passes unchanged.
- [x] Live-verified end to end against the real hosted Supabase project + real Anthropic/Voyage APIs with a throwaway script (not committed, created and deleted its own auth user): a trip driven to `requirements_ready`, then `runSearchAndCuration` reached `assembling_options` with 2 real flights, 3 real hotels, 4 real activities, a successful Curator ranking (hallucination reference check passed), and every expected table populated (`trip_events`: `inventory_searched`/`activities_curated`; `guardrail_events`: `flight_hard_constraints`/`hotel_hard_constraints`/`curation_reference_check`/`workflow_transition_authorization`, none triggered; `agent_runs`: one successful Curator call, 2,276 input / 726 output tokens).

**Slice 2 — done this session:**

Two more genuine architectural gaps were found and resolved with the user mid-implementation, not silently decided (same standing rule as the four questions above):

5. **No day-scheduler exists.** `assembleCandidateCombinations` only decides *which* activities fit the budget — nothing assigned a day/time, but `validateItineraryFeasibility` requires a fully dated `ScheduledActivity[]`. **Resolved: build a real (naive but genuine) day-scheduler now** — `src/domain/scheduling.ts` (`scheduleActivities`), rather than a placeholder or skipping feasibility validation this slice.
6. **`assembleCandidateCombinations` only ever picks one `Flight` (one-way), but `flights` is a one-way table and a round trip needs both legs — Slice 1 never searched a return flight at all.** **Resolved: do it properly** — search both legs, widen `assembleCandidateCombinations` to pair an outbound+return candidate per combination, feed both legs' cost into `calculateBudget` (whose `BudgetInput.flights` array was already built to hold more than one leg).

- [x] `trip_decisions` repository — `src/repositories/trip-decisions.ts`, the resolved append/retire-by-field shape with `proposed`/`confirmed`/`superseded` status.
- [x] **Slice 1 retrofit: round-trip flight search.** `src/workflow/search-orchestrator.ts` now also searches a reversed-direction return leg when `returnDate` is stated (skipped for a one-way trip), hard-constraint-filters it the same way as the outbound leg, and returns `outboundFlights`/`returnFlights` separately (renamed from the old single `flights` field). `supabase/migrations/0006_return_flights.sql` + a one-off service-role script (not committed) added 17 real return-leg rows to the hosted project — Phase 1's seed data had only ever seeded one direction per route, a gap invisible until round-trip search was actually exercised live.
- [x] Widened `assembleCandidateCombinations` (`src/domain/combinations.ts`) to `outboundFlights`/`returnFlights?` (optional — one-way trips get `returnFlight: null` on every combination), cross-joining outbound × return × hotel and summing both legs' cost via `calculateBudget`'s already-array-typed `flights` field. Also genericized `activities`/`ActivityCandidate` so it accepts Phase 5's `MatchedActivity` retrieval projection directly, no unsafe cast.
- [x] Fixed a consequence of round-trip support in `validateInventoryReferences` (`src/validation/inventory-references.ts`): a return leg's own `.destination` column is the trip's *origin* (it's the reverse direction), so the old single-field destination check would have flagged every legitimate return flight as belonging to the wrong destination. Flights now get their own check — belongs to the trip if *either* endpoint matches — while hotels/activities keep the original single-field check. Also genericized `ApprovedCandidateSet.activities` the same way as `combinations.ts`.
- [x] `src/domain/scheduling.ts` (`scheduleActivities`) — day-scheduler surfaced as gap 5 above. Naive greedy placer (first-fit, respects `closedDays`/`openingHours`, back-to-back with a gap), explicitly not an optimizer — revisit once the Itinerary Writer (Phase 7) needs a more natural-feeling schedule. Exported `DEFAULT_TRANSFER_BUFFER_MINUTES` from `feasibility.ts` so the scheduler can respect the same arrival/departure buffers feasibility validates against, via new per-date `earliestStartByDate`/`latestEndByDate` params — without this, the scheduler would place an activity at the default 10:00 start right on the arrival day, which feasibility is guaranteed to reject. A second real bug (caught by the live spot-check, not a review): the scheduler originally only ever tested one candidate start time per day, so an evening-only activity (e.g. open 19:30-23:00) could never be placed at all — fixed to advance into the activity's own opening window instead of skipping the whole day.
- [x] `src/workflow/itinerary-orchestrator.ts` (`assembleItinerary`) — picks up from `assembling_options`: builds combinations from the Curator's ranked (non-excluded) activities, tries up to 5 best-ranked combinations (schedule + `validateItineraryFeasibility`, best-first) until one is feasible, defense-in-depth `validateInventoryReferences` check, persists the winner to `trip_decisions` (`outboundFlight`/`returnFlight`/`hotel`/`activities` with their scheduled dates/times/`budget`), and drives `combinations_assembled` → `itinerary_valid` (or `itinerary_invalid` back to `assembling_options` if none of the attempted combinations were feasible) to reach `presenting_draft`.
- [x] **Deliberately scoped out, documented in code: one-way trips (no `returnDate`).** `REQUIRED_FOR_READY` doesn't require `returnDate`, but without it there's no way to derive a hotel-stay length or checkout date — `assembleItinerary` refuses with a typed `OneWayTripNotSupportedError` rather than guessing a default trip length (a product decision out of scope here).
- [x] `assembleTripItinerary` Server Action (`app/app/actions.ts`) — composes `runSearchAndCuration` then `assembleItinerary` in one round trip, since there's no user-facing checkpoint between `assembling_options` and `presenting_draft` (those are implementation-level retry/telemetry states, not something a chat UI would ever pause at). `beginSearch` stays separately callable for testing one slice at a time.
- [x] Live-verified end to end against the real hosted Supabase project + real Anthropic/Voyage APIs with a throwaway script (not committed): a round-trip Lisbon trip reached `presenting_draft` with a feasible, scheduled itinerary (2 outbound/1 return flight candidates, 3 hotels, 4 curated activities, one benign `TIGHT_TRANSFER_BUFFER` warning, zero violations) and all 5 `trip_decisions` rows + every expected `trip_events`/`guardrail_events` row persisted correctly.

**Known limitations / new tracked items from this slice (see §5):** the scheduler is a naive first-fit placer, not an optimizer; `nights` fed to `calculateBudget` is approximated from the requirement-stated `departureDate`/`returnDate`, which can differ by a day from the *actual* hotel-stay length derived from the chosen flights' real arrival/departure times (destination-local, via `localDateInTimeZone`); `assembleItinerary` only tries the best 5 combinations before giving up, not the full candidate list.

### Phase 7 — Itinerary writer and frontend
- [ ] Itinerary Writer agent (structured input only, no free prose reasoning over raw state)
- [ ] Chat UI
- [ ] Live itinerary side panel
- [ ] Assumptions/trade-offs panel
- [ ] Finalization flow (confirmation + proposal-hash check + "No booking made" messaging)
- [ ] Trip history list (`/app/trips`)

### Phase 8 — Evaluation and observability
- [ ] Eval harness (`evals/runners`) running the scenarios in `PROJECT_BRIEF.md` §19
- [ ] Adversarial eval cases
- [ ] CI evaluation command + GitHub Actions workflow (open item from `PROJECT_BRIEF.md` §22)
- [ ] Engineering dashboard (cost/latency/cache/guardrail views)
- [ ] Product metrics view
- [ ] Cache-hit / cost comparison (caching on vs. baseline)

### Phase 9 — Portfolio polish
- [ ] Visual design pass
- [ ] Architecture diagram
- [ ] Fill in remaining ADRs for any decisions made along the way
- [ ] Final README pass, demo walkthrough recording

---

## 2. Domain model (proposed)

Implemented in `supabase/migrations/0001_initial_schema.sql`. Summary of each entity's role:

| Entity | Role |
|---|---|
| `sessions` | One browser/chat session, owned by an authenticated user. Scopes `messages`. |
| `trips` | The actual planning unit. Owned by a user, has a `status` tracking workflow state. A user can have many. |
| `messages` | Raw chat history for UI continuity — **not** what agents reason over (see `PROJECT_BRIEF.md` §6.3). |
| `trip_state_versions` | Append-only, versioned snapshot of trip state — fast-read projection + optimistic concurrency anchor. |
| `trip_requirements` / `trip_preferences` / `trip_decisions` | The three distinct classifications from §7.1 — hard musts, soft wants, and actual selections — each with provenance and status. |
| `trip_events` | Append-only domain event log (`trip_created`, `budget_calculated`, etc.) — the replay/audit trail. |
| `approval_records` | Tracks what was proposed, what was approved, and invalidates prior approval on subsequent change. |
| `destinations` / `flights` / `hotels` / `activities` | Seeded/mock inventory, world-readable, versioned via `inventory_version`. `destinations`/`activities` carry `pgvector` embeddings for RAG. |
| `workflow_runs` / `workflow_steps` | One row per workflow execution and per transition within it — internal, service-role only. |
| `agent_runs` / `tool_calls` | Per-agent-call and per-tool-call telemetry (tokens, cache stats, latency, cost) — internal, service-role only. |
| `guardrail_events` | Every guardrail check and outcome, across all four layers — internal, service-role only. |
| `eval_runs` / `eval_results` | Eval suite execution history — internal, service-role only. |

---

## 3. Deterministic service interfaces (proposed)

Signatures only — no implementations yet. These are the internal services from `PROJECT_BRIEF.md` §6.4/§12.2; none of them are model-facing tools.

```typescript
// --- Inventory search (backs the model-facing search_flights / search_hotels /
//     retrieve_destinations / retrieve_activities tools — the tool layer is a
//     thin wrapper around these, adding logging and schema validation) ---

interface FlightSearchParams {
  origin: string;
  destination: string;
  departureDate: string; // ISO date
  returnDate?: string;
  partySize: number;
  hardConstraints: HardConstraint[];
  budgetRangeUsd?: [number, number];
  inventoryVersion: number;
}
function searchFlights(params: FlightSearchParams): Promise<FlightCandidate[]>;

interface HotelSearchParams {
  destination: string;
  checkIn: string;
  checkOut: string;
  partySize: number;
  budgetRangeUsd?: [number, number];
  preferences: Preference[];
  hardConstraints: HardConstraint[];
}
function searchHotels(params: HotelSearchParams): Promise<HotelCandidate[]>;

interface ActivityRetrievalParams {
  destination: string;
  dateRange?: [string, string];
  vibeTags: string[];
  accessibilityNeeds?: string[];
  priceRangeUsd?: [number, number];
  topK: number;
}
function retrieveActivities(params: ActivityRetrievalParams): Promise<ActivityCandidate[]>;

// --- Budget engine (PROJECT_BRIEF.md §9.3) ---

interface BudgetBreakdown {
  currency: string;
  target: number;
  ceiling: number;
  subtotal: number;
  taxesAndFees: number;
  contingency: number;
  totalEstimate: number;
  remaining: number;
  unpricedItems: string[];
  violations: BudgetViolation[];
}
function calculateBudget(trip: TripSelectionSnapshot): BudgetBreakdown;

// --- Hard-constraint engine (PROJECT_BRIEF.md §9.5) ---

function filterHardConstraints<T extends Candidate>(
  candidates: T[],
  constraints: HardConstraint[]
): { passing: T[]; rejected: { candidate: T; reason: string }[] };

// --- Candidate combination (PROJECT_BRIEF.md §9.6 end-to-end scenarios) ---

function assembleCandidateCombinations(
  candidates: { flights: FlightCandidate[]; hotels: HotelCandidate[]; activities: ActivityCandidate[] },
  budget: BudgetConstraints
): CandidateCombination[];

// --- Itinerary feasibility engine (PROJECT_BRIEF.md §9.2) ---

interface FeasibilityResult {
  valid: boolean;
  violations: FeasibilityViolation[];
  warnings: FeasibilityWarning[];
}
function validateItineraryFeasibility(itinerary: DraftItinerary): FeasibilityResult;

// --- Inventory-reference validation (PROJECT_BRIEF.md §9.4) ---

function validateInventoryReferences(
  itinerary: DraftItinerary,
  approvedCandidateSet: CandidateSet
): { valid: boolean; unresolvedIds: string[] };

// --- Workflow transition validation (PROJECT_BRIEF.md §8.2) ---

interface TransitionRequest {
  tripId: string;
  fromState: WorkflowState;
  event: WorkflowEvent;
  currentStateVersion: number;
}
function validateStateTransition(req: TransitionRequest): { allowed: boolean; reason?: string };
```

Every one of these gets unit tests with no LLM involved, per `PROJECT_BRIEF.md` §12.2 and §17.1.

**As implemented in Phase 2, the actual signatures deviate slightly from this sketch** (this section was "proposed," not locked):
- `calculateBudget`/`BudgetBreakdown` use the existing `Money` type (`src/domain/money.ts`) throughout rather than raw numbers with a separate `currency` string, for currency-checked arithmetic.
- `filterHardConstraints` takes an array of small `HardConstraint<T>` objects (each with its own `code`/`describe()`/`isSatisfiedBy()`) rather than a `HardConstraint[]` union type — each constraint is independently constructed and testable (`noRedEyeConstraint()`, `minHotelRatingConstraint(4)`, etc., in `src/domain/constraints.ts`).
- `validateInventoryReferences` takes a lightweight `{ flightIds, hotelIds, activityIds }` reference struct plus an `ApprovedCandidateSet`, not a full `DraftItinerary` — it doesn't need the itinerary's dates/schedule, only which IDs were referenced.
- `validateStateTransition`'s `TransitionRequest` gained `proposalHashMatches`, `guardrailsPassed`, and `resumeState` fields to carry the extra preconditions from `PROJECT_BRIEF.md` §8.2's example (finalization requires a matching proposal hash and passing guardrails) and the `failed_recoverable` → resume path from §8.4.

---

## 4. Route structure (proposed)

| Route | Access | Purpose |
|---|---|---|
| `/` | Public | Landing page + magic-link sign-in. No app functionality lives here. |
| `/auth/callback` | Public | Completes the magic-link sign-in (Supabase Auth callback). |
| `/app` | Authenticated | Chat + live itinerary panel — the core product experience. |
| `/app/trips` | Authenticated | Trip history — list of past trips (in-progress and finalized), each opening back into its itinerary. |
| `/app/trips/[tripId]` | Authenticated (owner only, enforced by RLS) | A specific trip's chat + itinerary, resumed. |
| `/internal/analytics` | Authenticated (deferred — see open items) | Engineering/product dashboard. Lives in the same app as a separate route group rather than a second deployable, per `PROJECT_BRIEF.md` §7.8. |

---

## 5. Open items carried forward

This section is the single place every deferred decision, known bug, and standing constraint gets tracked — **whenever a review, a build session, or a live-data check surfaces something deliberately not fixed on the spot, it goes here as an unchecked item before moving on, and a phase's checklist in §1 does not get marked done while a bug it introduced sits here unresolved.** Checked items are kept (struck through in spirit, not deleted) with the date/entry that closed them, so the history of what was found and when doesn't disappear.

### From `PROJECT_BRIEF.md` §22

- **Seed data volume** — resolved as a working default (Phase 1); revisit if search feels thin or evals need more edge-case density.
- **Analytics dashboard access control** — `/internal/analytics` is scoped to authenticated users for now; whether it needs its own elevated-permission check (vs. any signed-in user) is a Phase 8 decision.
- **CI setup** — deferred to Phase 8 per the build sequence; GitHub Actions is the likely choice given the repo is already on GitHub.

No other open items remain from §22 — app stack, auth, and git/GitHub are now decided (see ADR-000, ADR-003, and `BUILD_LOG.md`).

### Standing environment/tooling constraints

- **`src/config/supabase/database.types.ts` is hand-maintained, not generated.** `supabase gen types typescript` requires Docker/Podman, which is blocked on this machine at the OS level (see BUILD_LOG.md, 2026-09-16 "Docker/local Supabase blocker" — root cause never resolved, hosted Supabase is the permanent workaround). Every schema migration must be followed by a manual, matching edit to this file — nothing catches a drift between the two automatically. Revisit if the Docker blocker ever gets resolved (worth an occasional retry of `sfc /scannow`/a Process Monitor trace per that entry, but not on any schedule).

### Known bugs/gaps — unresolved

- [ ] **`validateInventoryReferences` (`src/validation/inventory-references.ts`) assumes `flights.destination`/`hotels.destination`/`activities.destination` and `destinations.name` share one identifier space** (plain city-name strings), since none of them are foreign keys. Two different real-world destinations that happened to share a display name could pass a reference check against the wrong approved set; not reachable today (all 6 seed destinations have unique names) but not prevented by the type system either. Found during Phase 2's review, 2026-09-16. Phase 5's retrieval work (`match_activities`) also matches on the same free-text `destination` column rather than an FK — passed through unchanged since retrieval doesn't cross-reference destinations in any new way that surfaces the gap. Real fix: a `destination_id uuid references destinations(id)` FK replacing the free-text columns — deferred to whenever decision-making (Phase 6/7) needs to cross-reference a selected destination against selected flights/hotels/activities, which is where this would actually bite. Phase 6 continued slice 2's flight-direction fix (`checkFlights` now accepting either `origin` or `destination` matching, for round-trip return legs) inherits the same underlying assumption — it's still plain city-name string identity, just checked against two columns instead of one.
- [ ] **`retrieveActivities`'s closed-days post-filter (`src/retrieval/activities-retrieval.ts`) uses a fixed overfetch heuristic (`OVERFETCH_FACTOR = 2`), not a guarantee.** `match_activities`'s SQL `LIMIT` runs before the closed-days filter, so if more than `topK * 2` of the closest semantic matches for a destination happen to be closed on the excluded day(s), fewer than `topK` results come back even though enough open ones exist further down the ranking. Found during Phase 5's review, 2026-09-16; not reachable today (seed data has only a handful of activities per destination) but not prevented by the type system either. Revisit if a larger activity catalog makes this a real gap — the fix would be re-querying with a larger limit when the post-filter under-fills, rather than a single fixed overfetch.
- [ ] **`startTrip` (`src/workflow/controller.ts`) is still not idempotency-keyed, even though Phase 6 built its first real caller.** `trips` has no correlation-id column, so a lost response followed by a naive client retry (e.g. a double form submit against `app/app/actions.ts`'s `sendMessage` when no `tripId` is given) creates a second, orphaned trip with its own genesis state and workflow run. Found during Phase 3's review, 2026-09-16, with a note that Phase 6 building the real caller was the natural point to close it — that point arrived (`app/app/actions.ts`), but with no chat UI yet actually driving repeated submissions, closing it was deliberately left for whenever a real client (Phase 7) makes double-submission an actual observed risk rather than a theoretical one.
- [ ] **A retry of a whole `processIntakeTurn` (or `runSearchAndCuration`) call (same `correlationId`, e.g. after a mid-turn crash) isn't idempotent across its non-transition writes.** Unlike `advanceTrip`'s own mirror writes (each individually guarded by a correlation-ID lookup — `src/workflow/controller.ts`'s `recordTransitionMirrors`), nothing in `src/workflow/intake-orchestrator.ts` (`appendMessage`/`agent_runs`/`tool_calls`/`guardrail_events`) or `src/workflow/search-orchestrator.ts` (`agent_runs`/`tool_calls`/`guardrail_events`/the `inventory_searched`/`activities_curated` `trip_events` rows) checks for a prior write before making them, so a retried call double-appends/double-inserts/re-logs each one (double-counting tokens/cost in the §13.3 dashboard). Found during Phase 6's review, 2026-09-16, for `processIntakeTurn`; the same characteristic was deliberately carried into `search-orchestrator.ts` rather than fixed piecemeal for one orchestrator only (2026-09-16, Phase 6 continued slice 1) — asked the user now-vs-later per the standing rule (memory: `feedback_deferred-items.md`) and tracked rather than fixed this session — no caller retries a failed turn yet (no chat UI exists), so nothing breaks in practice today. Natural point to close it: once Phase 7's chat UI makes retry-on-failure a real client behavior worth protecting against, alongside `startTrip`'s idempotency gap above — likely as one shared mechanism given three call sites will need it by then.
- [ ] **The Curator agent's malformed tool calls (`unknown tool`, `duplicate record_curation call`, a `CurationOutput` schema failure) aren't logged as a Layer 2 (output-validation) guardrail event**, unlike the Intake agent's equivalent tool-call errors (`src/workflow/intake-orchestrator.ts`'s dedicated loop over `toolCallLog` entries with `status: "error"`). Not a straightforward copy-paste: the Curator's hallucination-reference failure *also* surfaces as a `toolCallLog` error entry, and it's already logged as its own, correctly-layered `curation_reference_check` (domain_validation) guardrail — logging every error-status entry as Layer 2 too would double-count that one failure under two layers, skewing the §13.3 "which guardrail fires most"/layer-breakdown dashboard. Found during `search-orchestrator.ts`'s own post-implementation review, 2026-09-16; not fixed this session because the correct fix needs a way to distinguish "genuinely malformed call" from "valid call, failed the reference check" without fragile string-matching on `call.error` — worth a small refactor to `curator.ts`'s `ToolCallLogEntry` (e.g. a distinct error kind/code) rather than guessing from the message text.
- [ ] **Hotel bookings assume every room group fits the same room type at the same nightly rate.** The `hotels` table models one row as one bookable room type with no room-type variety or availability count, so `assembleCandidateCombinations` can't express "2 doubles + 1 twin" or check whether a hotel actually *has* enough rooms of that type free. Inherited from the Phase 1 schema, restated as an explicit limitation once the multi-room-booking feature made room count visible, 2026-09-16. Low priority — revisit only if a future phase wants richer room-type preferences.
- [ ] **The `"blocked"` workflow state is declared but unreachable.** `WORKFLOW_STATES` (`src/workflow/state-machine.ts`) lists it as a valid non-terminal state, but no `TransitionRule` ever sets `to: "blocked"`. Not an active bug (nothing can hit it), just a latent trap: a future rule that transitions into it could easily forget to decide whether that should end the workflow run. Found during Phase 3's review, 2026-09-16; skipped as not worth inventing a scenario for. Revisit only if a real need for a `"blocked"` state materializes.
- [ ] **One-way trips (no `returnDate`) aren't supported by combination/itinerary assembly.** `assembleItinerary` (`src/workflow/itinerary-orchestrator.ts`) throws a typed `OneWayTripNotSupportedError` rather than guessing a hotel-stay length/checkout date when `returnDate` isn't stated — a deliberate scope boundary from Phase 6 continued slice 2, 2026-09-16, not silently broken. Needs a product decision on default trip length (or an explicit "how many nights?" clarification) to close for real.
- [ ] **`calculateBudget`'s `nights` input is approximated from the requirement-stated `departureDate`/`returnDate`, not the actual hotel-stay length.** `assembleItinerary` derives the *real* `hotelStay.checkIn`/`checkOut` (and thus `tripDateRange`) from the chosen flights' actual local arrival/departure times (`localDateInTimeZone`) — which can land a day off from the raw requirement dates (e.g. an overnight outbound flight arriving the calendar day after `departureDate`). The budget estimate and the feasibility-checked schedule can therefore be based on a slightly different night count. Found while wiring Phase 6 continued slice 2, 2026-09-16; not fixed this session — the mismatch is at most ±1 night at this project's flight patterns, and recomputing `nights` from the chosen combination's actual dates would require restructuring `assembleCandidateCombinations` to accept dates after flight selection rather than before. Revisit if this proves confusing once the itinerary is actually shown to a user (Phase 7).
- [ ] **`src/domain/scheduling.ts`'s `scheduleActivities` is a naive first-fit greedy placer, not an optimizer.** No time-of-day preferences (e.g. meals at meal-times), no geographic clustering (activities on the same day could be scattered across the destination), and it tries each activity against the date range exactly once in the given order with no backtracking — a later activity can't "bump" an earlier lower-priority one to fit better. Built deliberately minimal (see the module's own docstring) to make `validateItineraryFeasibility` a real, exercised guardrail for Phase 6 continued slice 2, 2026-09-16. Revisit once the Itinerary Writer (Phase 7) needs a more natural-feeling schedule.
- [ ] **`assembleItinerary` only tries the best 5 candidate combinations (`MAX_COMBINATIONS_TO_TRY`) before declaring the itinerary infeasible**, not the full ranked list `assembleCandidateCombinations` returns. Bounded deliberately (retrying against already-computed candidates, not re-searching inventory) — at this project's seed-data scale the cross-join is small enough that 5 is generous, but a larger catalog could make this cap the actual reason a real, feasible-further-down combination never gets tried. Found while wiring Phase 6 continued slice 2, 2026-09-16.

### Known bugs — resolved

- [x] **`getOrCreateActiveWorkflowRun` (`src/repositories/workflow-runs.ts`) had an unguarded concurrent-insert race** — two concurrent calls for the same trip could both create an "active" `workflow_runs` row. Found during Phase 3's review, 2026-09-16; closed the same day via `supabase/migrations/0004_workflow_runs_single_active.sql` (a partial unique index) plus a catch-and-refetch in code, live-verified against a real concurrent-insert race on the hosted DB.
