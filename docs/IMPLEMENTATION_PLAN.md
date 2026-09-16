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
- [ ] Scaffold the actual Next.js app (`create-next-app`, TypeScript, App Router, Tailwind or equivalent)
- [ ] Configure environment variables (`.env.local`: Supabase URL/keys, Anthropic API key) and confirm `.env*` stays gitignored
- [ ] Establish local Supabase workflow (Supabase CLI, `supabase start`, apply `0001_initial_schema.sql`)
- [ ] Set up route skeleton: `/` (landing + magic-link sign-in), `/app` (protected — chat + itinerary), `/app/trips` (history list)
- [ ] Set up test runner (Vitest) with a trivial passing test, wired into a `npm test` script

### Phase 1 — Domain model and seeded data
- [ ] Finalize normalized money/date types (shared TS types for currency amounts, date ranges)
- [ ] Implement inventory repositories (typed query functions over `destinations`/`flights`/`hotels`/`activities`)
- [ ] Write seed data: target ~4-6 destinations, ~20-25 flights, ~15-20 hotels, ~25-30 activities — enough to make search feel real and to hit the edge cases in `PROJECT_BRIEF.md` §11.2 (red-eyes, closed days, overlapping activities, stale inventory versions, etc.) without hand-authoring an unreasonable volume of mock data
- [ ] Add edge-case fixtures deliberately (at least one of each edge case listed in §11.2)

### Phase 2 — Deterministic services (no LLM)
- [ ] `calculateBudget()`
- [ ] `filterHardConstraints()`
- [ ] `assembleCandidateCombinations()`
- [ ] `validateItineraryFeasibility()`
- [ ] `validateInventoryReferences()`
- [ ] `validateStateTransition()`
- [ ] Unit tests for all of the above, independent of any LLM call

### Phase 3 — State and workflow foundation
- [ ] Session/trip repositories (typed CRUD over the schema in `0001_initial_schema.sql`)
- [ ] State versioning writes (append to `trip_state_versions`, enforce optimistic concurrency)
- [ ] Event history writes (`trip_events`)
- [ ] Explicit workflow state machine implementation (`PROJECT_BRIEF.md` §8.1)
- [ ] Retry/idempotency/cancellation handling
- [ ] Workflow telemetry (`workflow_runs`/`workflow_steps` writes)

### Phase 4 — Intake and revision interpretation
- [ ] Structured output schemas (Zod or similar) for requirement/preference/decision extraction
- [ ] Intake and Revision Interpreter agent
- [ ] Clarification behavior
- [ ] Revision interpretation
- [ ] Component evals for extraction/classification accuracy
- [ ] Decide concrete model per agent (open item from ADR-INDEX Area 1) and set up prompt caching structure (static-first ordering per `PROJECT_BRIEF.md` §6.7) — with a caching-disabled baseline to compare against

### Phase 5 — Retrieval and curation
- [ ] Generate embeddings for seed `destinations`/`activities`
- [ ] Metadata-filtered retrieval functions
- [ ] Destination/Activity Curator agent
- [ ] Trip Explanation Agent
- [ ] Retrieval quality checks (recall/precision spot checks against seed data)

### Phase 6 — Orchestration integration
- [ ] Wire agents into the workflow controller
- [ ] Expose only the approved model-facing tools (`PROJECT_BRIEF.md` §12.1)
- [ ] Guardrail gates at each transition
- [ ] State persistence after each meaningful step
- [ ] Failure/retry behavior end to end

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

From `PROJECT_BRIEF.md` §22, still unresolved or deferred:

- **Seed data volume** — resolved as a working default above (Phase 1); revisit if search feels thin or evals need more edge-case density.
- **Analytics dashboard access control** — `/internal/analytics` is scoped to authenticated users for now; whether it needs its own elevated-permission check (vs. any signed-in user) is a Phase 8 decision.
- **CI setup** — deferred to Phase 8 per the build sequence; GitHub Actions is the likely choice given the repo is already on GitHub.

No other open items remain from §22 — app stack, auth, and git/GitHub are now decided (see ADR-000, ADR-003, and `BUILD_LOG.md`).
