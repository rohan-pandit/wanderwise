# Wanderwise

> A travel-planning and booking-preparation concierge using AI-assisted interpretation and curation over a deterministic, testable planning engine.

This is a portfolio project. The travel domain is a vehicle — the actual point is demonstrating agentic AI product/engineering judgment: a clean deterministic/AI boundary, persistent versioned state, retrieval-augmented curation, enforced guardrails, a real evaluation suite, and workflow-level observability with cost/latency/cache analysis.

> I designed an AI-assisted planning workflow in which the model handles ambiguity and explanation, while deterministic services own feasibility, budget, inventory integrity, and state transitions. I then measured the system through scenario-based evaluations and workflow-level observability.

**This is not:**
- an app that books travel, or talks to any live flight/hotel/activity provider (all inventory is seeded/mock data — see [§3.2 of the brief](PROJECT_BRIEF.md#32-explicitly-out-of-scope-for-v1));
- "the LLM handles the whole trip" — four narrowly-scoped agents interpret, curate, and write, but never own truth (see [Architecture, below](#architecture));
- production-ready — see [What's not done](#whats-not-done-known-limitations).

---

## Table of contents

- [Try it](#try-it)
- [Why this architecture](#why-this-architecture)
- [How it works](#how-it-works)
- [Evaluation and observability](#evaluation-and-observability)
- [What would change for live providers or real booking](#what-would-change-for-live-providers-or-real-booking)
- [What's not done (known limitations)](#whats-not-done-known-limitations)
- [Notable trade-offs and dead ends](#notable-trade-offs-and-dead-ends)
- [Tech stack](#tech-stack)
- [Running it locally](#running-it-locally)
- [Where things live](#where-things-live)
- [Project status](#project-status)

---

## Try it

Sign-in is a Supabase magic link — no password. Tell it something like:

> "Plan a trip from New York to Lisbon, departing 2026-10-05 and returning 2026-10-12, for 2 people, budget $5000."

It'll extract your requirements, propose flight/hotel candidates from seeded inventory, curate activities by semantic retrieval, check budget/feasibility deterministically, and write a day-by-day itinerary — all against mock data, clearly labeled as such, with no live prices or bookable inventory.

## Why this architecture

**A custom deterministic workflow, not an autonomous agent swarm.** Trip planning has hard, checkable constraints — budgets that must total correctly, itineraries that must not double-book a day, inventory references that must resolve to real seeded rows. An autonomous multi-agent chat loop can't guarantee any of that; it can only make it *likely*. So the system is built the other way around: a small set of pure, unit-tested deterministic services (budget, hard constraints, feasibility, inventory-reference validation, state transitions) own every fact that has to be *correct*, and a handful of narrowly-scoped agents own everything that requires judgment — interpreting ambiguous language, ranking qualitative fit, writing readable prose. See [ADR-000](docs/architecture/ADR-000-tech-stack-and-topology.md) and the [architecture diagram](docs/architecture/architecture-diagram.md).

**Kept deliberately out of the LLM:** arithmetic (budget totals — one function computes every total, ever), authorization (RLS + the workflow state machine, not a prompt), and state transitions (`validateStateTransition` — an explicit table, not model judgment about what should happen next). A model interpreting a budget number is fine; a model *computing* one is not.

**Four agents, each replacing a specific kind of human judgment, not a generic "AI does everything" black box:**

| Agent | Judgment it replaces | Never does |
|---|---|---|
| Intake / Revision Interpreter | Turning "somewhere warm, not too pricey" into structured fields | Decide what's *required* — a deterministic completeness check gates that |
| Destination / Activity Curator | Ranking retrieved candidates by qualitative fit | Invent a candidate not in the retrieved set (checked, not trusted) |
| Trip Explanation Agent | Explaining *why* a recommendation fits | State a fact not present in the data it was given |
| Itinerary Writer | Turning a finalized selection into readable prose | Select, price, or schedule anything itself |

The number of agents was never the goal — each one exists because a specific piece of judgment doesn't have a clean deterministic answer, not because "more agents" reads as more sophisticated.

## How it works

**Requirements, preferences, and decisions are three different data types**, not one blob of "trip state." A requirement ("budget is $5,000") is a hard must with provenance (who/what said it, and how confident). A preference ("likes quiet neighborhoods") is a soft want that can be traded away. A decision ("confirmed this specific flight ID") is an actual selection, versioned, supersedable, and the only thing a budget or itinerary is ever computed from. Conflating these would make "the user said X but we picked Y anyway" impossible to explain or audit — keeping them separate makes every trade-off traceable.

**Inventory grounding prevents hallucination structurally, not by asking nicely.** Every flight/hotel/activity ID an agent's tool call references is checked against the actual retrieved/searched candidate set before it's ever persisted — `validateInventoryReferences` and each step's own reference check reject an invented ID outright, logged as a Layer 2 (output-validation) guardrail event. This is exercised for real by the adversarial eval suite (`evals/cases/adversarial.ts`'s `fabricated_inventory_ids` case), not just asserted in a system prompt.

**Impossible constraints fail loudly, not silently.** If no combination of seeded flights/hotels/activities can satisfy the stated hard constraints and budget, `assembleItinerary` reports infeasibility with the specific violated constraints rather than picking the closest thing and hoping — the user sees *why* it didn't work, not a degraded result presented as success.

**The itinerary feasibility engine** (`src/domain/feasibility.ts`) checks a scheduled draft for hotel-stay coverage, activity dates/hours (including overnight ranges, checked with a real seed-data case — Reykjavik's Northern Lights tour), arrival/departure transfer buffers (checked as absolute time instants, so a buffer spanning midnight is caught correctly), and same-day overlaps via a proper sweep-line — all pure functions, unit-tested with no model or database involved.

**State versioning and explicit approval prevent invalid finalization.** Every trip state change is an append-only, optimistically-concurrent version (`trip_state_versions`) — never an in-place mutation — and finalization requires the currently-confirmed decisions to match what was actually approved, gated by the workflow state machine (`validateStateTransition`), not by trusting that the UI only ever sends valid requests.

## Evaluation and observability

Deterministic grading throughout (see [ADR-006](docs/architecture/ADR-006-evaluation-strategy.md)) — every eval case asserts against persisted database state or structured tool output, never "does this response read as reasonable." Component cases exercise one agent in isolation; end-to-end scenario and adversarial cases drive the real orchestrator functions against a real Supabase project with real Anthropic/Voyage API calls — not mocks of the whole system.

**What evals actually changed, not just measured:** the `over_budget_request` scenario case caught a real gap — a trip whose confirmed decisions totaled well over its stated budget ceiling finalized anyway, because nothing read `calculateBudget`'s violations before allowing that transition. That's tracked as an open, deliberately-flagged item (not silently fixed and forgotten) in [`docs/IMPLEMENTATION_PLAN.md` §5](docs/IMPLEMENTATION_PLAN.md), because closing it well needs a small product decision (hard block vs. an explicit override path) the brief itself calls out.

**What telemetry revealed about cost, latency, and cache:** a real caching-on-vs-forced-off comparison (`npm run eval:cache-comparison`) against the live Anthropic API measured a **45.5% cost reduction** from prompt caching (repeated system-prompt/tool-definition tokens read from cache instead of resent) — but **no latency improvement** (slightly worse, in fact). Treating caching as "obviously also faster" would have been wrong; measuring it caught that. See [ADR-INDEX.md](docs/architecture/ADR-INDEX.md) Area 1.

Two dashboards, deliberately separate (per [ADR-007](docs/architecture/ADR-007-observability.md)) so a high agent-call count is never mistaken for product success:
- `/internal/analytics` — cost/latency/cache by agent, guardrail trigger frequency, workflow failure breakdown, eval pass-rate trend.
- `/internal/product-metrics` — trip-start/completion/confirmation/revision rates, time-to-draft/finalized, abandonment stage.

Sensitive telemetry (the one field that can reveal a disability/health condition — `requiredAccessibility`) is redacted at the single write boundary every caller shares, before it's ever persisted (`src/observability/redaction.ts`).

## What would change for live providers or real booking

The seeded/mock inventory (`destinations`/`flights`/`hotels`/`activities`) sits behind the same interface a live-provider integration would use — `searchFlights`/`searchHotels`/`retrieveActivities` already take an `inventoryVersion` and treat inventory as an opaque, versioned candidate set they don't generate themselves. Swapping in real supplier APIs means replacing what's behind that interface with a live cache or pass-through, not restructuring the deterministic services that consume it (budget, constraints, feasibility) — they were built decoupled from where inventory comes from on purpose.

Real booking would need a new boundary after a trip's decisions are confirmed, toward an actual payment/booking provider, with its own explicit-approval gate mirroring `approval_records`' existing "what was proposed vs. what was approved" model. That boundary doesn't exist today — deliberately out of scope for v1 (see [§3.2](PROJECT_BRIEF.md) and [the architecture diagram](docs/architecture/architecture-diagram.md#what-would-change-for-live-providers-or-real-booking)).

## What's not done (known limitations)

The full, honestly-tracked list — including which are fixed, which are open, and why — lives in [`docs/IMPLEMENTATION_PLAN.md` §5](docs/IMPLEMENTATION_PLAN.md). The headline ones:

- **The budget-ceiling guardrail isn't enforced at finalize time** — a trip can finalize over budget today (caught by eval, not yet fixed — needs a small product decision first, see above).
- **10 of the brief's 16 end-to-end scenarios aren't automated yet** (stale inventory, duplicate/idempotent requests, cross-session isolation, cancellation, prompt injection in retrieved inventory text, failure/recovery) — they need real RLS/JWT-authenticated test sessions or fault-injection infrastructure the current direct-call eval harness doesn't provide.
- **A retry of a full orchestrator turn isn't idempotent** across its non-transition writes (messages, telemetry rows) — no real client retries a failed turn yet, so this hasn't bitten in practice, but it's a known gap, not an assumption.
- **One-way trips aren't supported** — a deliberate scope boundary (`OneWayTripNotSupportedError`), not a silent failure.
- **Telemetry retention is a documented policy, not automated code** — every row in this project's database is synthetic demo/eval data, so a real scheduled-deletion job wasn't built yet (see [ADR-007](docs/architecture/ADR-007-observability.md)).

## Notable trade-offs and dead ends

The full, dated build history — including what didn't work and why — is in [`BUILD_LOG.md`](BUILD_LOG.md). A few worth calling out:

- **Local Supabase (Docker) was abandoned mid-project** after a multi-hour investigation traced a Docker Desktop startup failure down to a machine-level Windows AF_UNIX socket problem — confirmed with a plain Node.js reproduction that had nothing to do with Docker at all. Pivoted to a hosted Supabase project rather than keep chasing an OS-level bug; `supabase/config.toml` stays in the repo in case local dev becomes viable later.
- **The workflow went through a real mid-project redesign** — from an early one-shot "generate the whole itinerary in one agent turn" pipeline to a stepwise chain (flight → hotel → activities, each proposed and confirmed independently) once it became clear the one-shot version couldn't support the required "swap the hotel"/"make it cheaper" revision flows cleanly. That's a real architectural pivot, documented as one, not smoothed over in the history.
- **A standing practice emerged and stuck**: a full code review (correctness, reuse/simplification, efficiency, convention-adherence) after every phase, not just at the end. It caught real, sometimes serious bugs early — a timezone bug in flight search, an open redirect in the auth callback, an idempotency-replay path that permanently dropped telemetry after a partial failure — cheaply, before later phases built on top of them.
- **`database.types.ts` is hand-maintained**, not generated, for the whole project — `supabase gen types typescript` needs Docker/Podman, which hit the same OS-level blocker above. Every schema migration needs a matching manual edit; nothing catches drift automatically. A real, standing risk, tracked rather than ignored.

## Tech stack

Single Next.js (TypeScript, App Router) app — frontend, API layer (Server Actions), and the custom orchestration loop all in one codebase, no separate services. Supabase (Postgres + pgvector) for all persistent state, inventory, embeddings, and telemetry. Supabase Auth (magic link only). Claude (Anthropic API) behind a provider-agnostic `ModelClient` interface. Voyage AI for embeddings. Vitest for the deterministic-code test suite. See [ADR-000](docs/architecture/ADR-000-tech-stack-and-topology.md) for the full rationale.

## Running it locally

```bash
npm install
cp .env.local.example .env.local   # fill in Supabase + Anthropic + Voyage keys
npm run dev
```

You'll need a Supabase project (hosted or local) with `supabase/migrations/*.sql` applied, in order, via `supabase db push` (or the SQL editor). An Anthropic API key and a Voyage AI key are required for the chat/curation/embedding features — the app won't do anything useful without them, since there's no offline/mock model path.

```bash
npm test            # deterministic unit tests — no network calls, no API keys needed
npm run typecheck    # next typegen + tsc --noEmit
npm run lint
npm run eval:ci      # what CI runs: typecheck + lint + npm test
```

The `eval:intake` / `eval:retrieval` / `eval:scenarios` / `eval:cache-comparison` scripts make real Anthropic/Voyage API calls against a real Supabase project and cost real (small) amounts of money — they're not part of `eval:ci` and are meant to be run manually.

## Where things live

| | |
|---|---|
| Full specification, architecture rationale | [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) |
| Architecture decisions | [`docs/architecture/ADR-INDEX.md`](docs/architecture/ADR-INDEX.md) |
| Visual architecture diagram | [`docs/architecture/architecture-diagram.md`](docs/architecture/architecture-diagram.md) |
| Implementation plan / milestones / open items | [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) |
| Build history, session by session, including dead ends | [`BUILD_LOG.md`](BUILD_LOG.md) |
| Demo walkthrough script | [`docs/DEMO_WALKTHROUGH.md`](docs/DEMO_WALKTHROUGH.md) |
| Database schema/migrations | [`supabase/migrations/`](supabase/migrations/) |
| Coding-agent operating rules | [`CLAUDE.md`](CLAUDE.md) |

## Project status

Phase 9 (portfolio polish) of 9 planned phases — see [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) for the full phase breakdown and [`BUILD_LOG.md`](BUILD_LOG.md) for the complete, dated build history.
