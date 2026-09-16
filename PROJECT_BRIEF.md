# Curated Travel Concierge

## Project Brief & Implementation Specification

**Owner:** Rohan
**Document status:** Build-ready specification. Consolidates the original project brief and the later build-ready brief into a single non-redundant document. Update it as decisions change — it should evolve alongside the build log, not be treated as frozen.
**Primary purpose:** Portfolio project demonstrating reliable, testable AI product and engineering judgment through a curated travel-planning experience.

---

# 1. Executive Summary

Build a polished travel-planning and booking-preparation concierge that accepts natural-language trip preferences, searches a deterministic seeded inventory, reconciles options against hard constraints and budget, produces a day-by-day itinerary, and supports iterative changes.

The point of the project is **not** the travel domain itself, and it is **not** a demonstration of how many agents can be connected. It is a demonstration vehicle for:

- Multi-agent orchestration with clean, justified separation of responsibility
- Persistent context, memory, and RAG via Supabase
- Real observability (cost, latency, failure modes) via a Supabase-backed analytics dashboard
- Prompt caching for cost/latency efficiency — measured, not assumed
- Defined tool use (not just chat completions)
- Guardrails that are testable and enforced in code, not just prompted for
- A real evaluation suite with test cases and deterministic pass/fail grading
- A build log documenting the journey (decisions, dead ends, what changed and why)

More specifically, it is a demonstration of how to build an AI-enabled product in which:

- deterministic application logic owns correctness;
- language models assist with interpretation, retrieval, ranking, and explanation;
- workflows are explicit, inspectable, resumable, and observable;
- all recommendations are grounded in known inventory;
- constraints and budget are enforced in code;
- evaluations test outcomes rather than merely checking whether text was generated;
- the product experience communicates assumptions, trade-offs, and progress clearly.

The central architectural principle is:

> **Build a deterministic travel-planning system with an AI reasoning layer — not an AI agent system that happens to plan travel.**

Every architectural choice in this document should be made with "does this make a good demo of agentic engineering judgment" as a tiebreaker, not just "does this work." The application should be useful as a standalone demo while also exposing enough implementation detail to support a portfolio walkthrough.

---

# 2. Product Definition

## 2.1 Product concept

A curated travel concierge helps a user move from an initial idea to a feasible, explainable trip plan.

The user should be able to say something like:

> "Plan a five-day trip for two people from Philadelphia in October. We want food, culture, and some outdoors. Our total budget is $3,000, and we do not want red-eye flights."

The system should:

1. interpret the request;
2. identify missing information and ask focused clarification questions;
3. classify inputs as hard constraints, preferences, or unresolved decisions;
4. search mock flights, hotels, destinations, and activities;
5. validate and normalize candidate data;
6. assemble feasible combinations;
7. explain trade-offs;
8. generate an itinerary grounded in selected inventory;
9. allow the user to revise individual decisions;
10. require explicit confirmation before marking the plan finalized;
11. clearly state that no real booking or payment has occurred.

## 2.2 Portfolio objective

The project should demonstrate:

- custom orchestration and workflow control;
- selective, justified use of specialized agents;
- structured tool use;
- persistent state and memory;
- RAG with metadata filtering;
- deterministic domain services;
- enforced guardrails;
- automated evaluation;
- workflow-level observability;
- cost, latency, and prompt-caching analysis;
- product analytics;
- disciplined technical decision-making through ADRs and a build log.

**The number of agents is not itself a success metric.**

## 2.3 Product positioning

Use the following language in the README and portfolio materials:

> **A travel-planning and booking-preparation concierge using AI-assisted interpretation and curation over a deterministic, testable planning engine.**

Do not describe v1 as a booking platform or imply that live inventory, availability, prices, reservations, or payments are real.

---

# 3. Scope

## 3.1 In scope for v1

- Natural-language trip intake.
- Fixed or flexible destination.
- Origin, destination, dates, trip duration, and party size.
- Total budget and optional budget target.
- Traveler preferences and hard constraints.
- Seeded/mock flights, hotels, destinations, and activities — not live third-party APIs, which keeps the demo deterministic, cheap, and fast to iterate on.
- Search and filtering over mock inventory.
- Semantic retrieval for destination and activity descriptions.
- Feasibility checks for flights, lodging, activities, timing, and budget.
- Curated candidate sets and explainable recommendations.
- Day-by-day itinerary generation.
- Iterative changes such as:
  - "Swap the hotel."
  - "Make it cheaper."
  - "Remove the museum."
  - "Add more outdoor activities."
  - "Avoid early mornings."
- Persistent session and trip state.
- Versioned state changes.
- Explicit confirmation before finalization.
- Shareable itinerary view or exportable representation.
- Internal analytics dashboard.
- Structured agent/workflow logs.
- Automated evaluation suite.
- Build log and ADRs.
- Mock booking-preparation artifacts, such as a clearly labeled "ready to book" summary, without executing any booking.

## 3.2 Explicitly out of scope for v1

- Real flight, hotel, or activity APIs.
- Live prices or live availability.
- Real booking execution.
- Payments, refunds, or financial transactions.
- Sending reservations to vendors.
- Multi-user collaboration on one trip.
- Production-grade identity and account management (session-based only, unless Supabase Auth is deliberately showcased — see §22).
- Complex loyalty-program optimization.
- Real-time disruption management.
- Full mobile application.
- Autonomous background agents.
- Unbounded internet browsing.
- Unreviewed external actions.

Potential v2 items: live provider integrations, authenticated accounts, real booking handoff, collaborative trips, and live disruption handling. Note live third-party API integration explicitly as a "v2" stretch goal in the README — it's a good follow-up demo of tool integration maturity.

## 3.3 Definition of done

A v1 release is complete when:

- a user can create a trip from natural language;
- the system asks for missing critical information rather than silently guessing;
- all selected inventory items come from the seeded dataset;
- hard constraints are enforced deterministically;
- budget calculations are reproducible;
- the itinerary passes deterministic feasibility checks;
- a user can revise the plan without corrupting state;
- finalization requires explicit confirmation;
- the system cannot book or charge anything;
- the main workflow is observable end to end;
- the evaluation suite runs locally and in CI;
- the README, ADRs, architecture diagram, and build log explain the major decisions.

---

# 4. Architectural North Star

## 4.1 Core principle

Separate the system into four categories:

1. **User experience**
   - chat;
   - itinerary view;
   - assumptions and trade-offs;
   - progress;
   - confirmation.
2. **Workflow and application logic**
   - state transitions;
   - retries;
   - cancellation;
   - concurrency;
   - authorization;
   - persistence;
   - orchestration;
   - domain validation.
3. **Deterministic domain services**
   - inventory search;
   - budget calculations;
   - constraint filtering;
   - itinerary feasibility;
   - time-zone and schedule handling;
   - candidate selection validation.
4. **AI reasoning layer**
   - intent and preference extraction;
   - clarification-question generation;
   - semantic retrieval;
   - qualitative ranking;
   - explanation;
   - itinerary prose generation;
   - interpretation of user revisions.

The model must not be the final authority for state transitions, budget arithmetic, inventory validity, hard constraints, or booking permissions.

## 4.2 High-level architecture

```text
Frontend
  |
  v
Application API
  |
  v
Workflow Controller / Orchestrator
  |
  +--> Session and Trip State Repository
  |
  +--> Intake / Interpretation Agent
  |
  +--> Inventory Search Services
  |      +--> Flight search
  |      +--> Hotel search
  |      +--> Destination retrieval
  |      +--> Activity retrieval
  |
  +--> Deterministic Planning Services
  |      +--> Constraint engine
  |      +--> Budget engine
  |      +--> Itinerary feasibility engine
  |      +--> Candidate combination engine
  |
  +--> Curator / Explanation Agent
  |
  +--> Itinerary Writer Agent
  |
  +--> Validation and Guardrail Layer
  |
  +--> Observability / Event Pipeline
  |
  v
Supabase
  +--> session data
  +--> trip state versions
  +--> messages
  +--> inventory
  +--> embeddings
  +--> workflow events
  +--> agent runs
  +--> guardrail events
  +--> evaluations
```

The orchestrator reads and writes a single logical **Trip State**, persisted in Supabase after every meaningful write (see §7 for the full versioned data model — a flat mutable JSON document is *not* the recommended implementation, only the simplified mental model).

## 4.3 Recommended implementation approach

Use a **custom orchestration loop** in TypeScript or Python rather than adopting a large agent framework by default.

The custom controller should make the following explicit:

- workflow states;
- allowed transitions;
- agent invocation;
- tool authorization;
- persistence boundaries;
- retries;
- error handling;
- cancellation;
- validation gates;
- event emission.

A framework such as LangGraph may be evaluated later, but should not be introduced merely to create the appearance of sophistication.

**Why a custom loop instead of peer-to-peer agent handoff or an off-the-shelf framework:** it keeps a single source of truth for "what has happened so far," which both the eval suite and the observability dashboard can key off of. It's also more honest about where a real production version of this would need deterministic control — reviewers evaluating agentic engineering judgment will notice if you can articulate why you *didn't* pick a fully autonomous multi-agent chat pattern. It is also the single highest-signal piece of code for a PM/engineer portfolio: it's the part that proves you understand agent control flow rather than just calling a framework.

---

# 5. The Five ADR Decision Areas

The project should organize architectural decisions under five top-level areas. These are categories, not necessarily five enormous documents. Create smaller ADRs underneath them as concrete decisions arise.

| Area | Covers |
|---|---|
| **1 — System Boundaries and AI Responsibilities** | What belongs to the model vs. deterministic application code, which agents are justified, what tools are exposed to models, where the product boundary ends. |
| **2 — State Model and Data Architecture** | How requirements, preferences, decisions, inventory, provenance, versions, approvals, and session data are represented and persisted. |
| **3 — Workflow Orchestration and Execution** | How work is sequenced, how state transitions occur, how retries and cancellations work, how the system recovers from failures or concurrent updates. |
| **4 — Validation, Guardrails, and Evaluation** | How correctness is enforced and measured, including budget, constraints, inventory grounding, itinerary feasibility, safety, adversarial cases, and regression testing. |
| **5 — Observability, Analytics, and Product Measurement** | How workflow execution is traced, how engineering performance is measured, how user outcomes are measured, how the build process is documented. |

---

# 6. System Boundaries, Agent Roster, and Tools

## 6.1 Deterministic code owns correctness

The following responsibilities **must** be deterministic — never delegated to the model:

- budget arithmetic;
- currency normalization;
- hard-constraint enforcement;
- inventory ID validation;
- date and time calculations;
- flight and hotel date consistency;
- activity scheduling;
- opening-hours validation;
- travel-time feasibility;
- itinerary conflict detection;
- state transitions;
- finalization authorization;
- confirmation requirements;
- booking/payment capability boundaries;
- idempotency and persistence behavior.

The model may propose or explain outcomes, but it cannot override these services.

## 6.2 Use fewer, better-justified agents

Treat a broad agent roster as a set of *responsibilities*, not a requirement to create a separate LLM call for every function. Flight search, hotel search, budget calculation, hard-constraint filtering, itinerary feasibility, final selection validation, and finalization are **deterministic services**, not autonomous agents — a "curator" may use an LLM for qualitative ranking, but the set of feasible candidates must already have been established by code.

**Recommended v1 AI components:**

| Agent | Responsibility | Inputs | Outputs | Tools used |
|---|---|---|---|---|
| **Orchestrator** (workflow controller, not a freeform reasoning agent) | Loads trip state, determines workflow state, invokes the right interpreter/service/agent, persists validated state changes, emits workflow events, enforces transition gates, returns a user-facing response | Latest user message, current trip state | Next workflow action, user-facing message | None — never queries domain tables directly, never executes booking/payment |
| **A. Intake and Revision Interpreter** | Extract structured trip requirements; identify ambiguity; classify user statements (requirement / preference / decision); interpret revision requests; generate clarification questions when necessary | Raw user message, current trip state | Structured requirements/preferences objects, clarification questions, revision proposals | `request_clarification`, `propose_trip_revision` |
| **B. Destination and Activity Curator** | Use retrieval results; interpret vibe/qualitative preferences; rank or explain relevant destinations and activities; provide rationale grounded in retrieved data | Preferences, retrieved candidates | Ranked/curated candidate subset with rationale | `retrieve_destinations`, `retrieve_activities`, `get_candidate_explanations` |
| **C. Trip Explanation Agent** | Explain trade-offs; summarize why a combination was selected; explain why a request cannot be satisfied; communicate assumptions and alternatives | Validated candidate/selection set, budget breakdown, constraint results | User-facing explanation text | `get_candidate_explanations` |
| **D. Itinerary Writer** | Turn validated selections into readable itinerary prose; reference only approved, selected inventory; avoid inventing facts | Validated final selections (structured, not prose) | Formatted itinerary (markdown/structured) | None (formatting only, reads structured data) |

Deterministic services backing these agents (`search_flights`, `search_hotels`, `calculate_budget`, `filter_hard_constraints`, `validate_itinerary`, etc.) are enumerated in §12.

## 6.3 Orchestrator as workflow controller, not all-purpose reasoning agent

The orchestrator should:

- receive the latest user message;
- load the current trip state;
- determine the current workflow state;
- invoke the appropriate interpreter, service, or agent;
- persist validated state changes;
- emit workflow events;
- handle clarification;
- enforce transition gates;
- return a user-facing response;
- be the single place guardrail checks gate on before any state transition to "confirmed"/"finalized".

The orchestrator should **not**:

- perform budget arithmetic itself;
- query domain tables directly when a domain service exists;
- invent inventory;
- make unvalidated state changes;
- decide that a failed constraint is acceptable;
- execute booking or payment actions.

The orchestrator may use a small model-based routing decision when useful, but routing must be constrained by an explicit action schema and an allowlist of valid next actions.

Agents never talk to each other directly — all reads/writes go through the orchestrator and land in trip state. Each agent is stateless between calls and receives only the slice of state it needs (not full conversation history) — this is both good agentic-design practice to showcase and directly supports prompt caching (§6.7). Full conversation history is stored separately (`messages` table) for user-facing chat continuity, but is **not** what agents reason over — this separation is worth calling out explicitly in the write-up, since conflating "chat history" with "agent working memory" is a common design mistake.

## 6.4 Distinguish model-facing tools from internal services

Not every internal function needs to be exposed as a Claude tool.

**Internal deterministic services** (never model-facing): `calculate_trip_budget`, `validate_hard_constraints`, `validate_itinerary_feasibility`, `persist_trip_state`, `transition_workflow`, `authorize_finalization`.

**Model-facing tools** (expose only where model-driven selection adds value): `search_flights`, `search_hotels`, `retrieve_destinations`, `retrieve_activities`, `get_candidate_explanations`, `request_clarification`, `propose_trip_revision`.

Tool schemas must be explicit, typed, narrow, and validated — define them as proper Claude tool-use function schemas, not just internal function calls the model doesn't see structured. This is part of what "showcasing agentic development" means concretely, and it's what makes `agent_runs`/`tool_calls` logging meaningful (log tool call name, args, and result, not just raw text). Tool calls must be logged with arguments, results, duration, and authorization context. The model should not be able to call arbitrary SQL, arbitrary HTTP endpoints, or unrestricted code.

## 6.5 Strict booking boundary

V1 has no booking capability. The absence of booking/payment tools *is* the guardrail.

The system may produce a clearly labeled booking-preparation summary containing: selected flight; selected hotel; selected activities; estimated costs; assumptions; unresolved issues; information a user would need before booking.

The UI must clearly state: inventory is mock or seeded; prices are illustrative; availability is not live; no reservation was made; no payment occurred.

If mock booking interfaces are added, they must be explicit simulations and must be isolated behind a capability boundary. The application should have no real payment or booking credentials.

## 6.6 Security and privacy boundaries

Implement at least the following:

- session isolation;
- server-side authorization checks;
- Supabase Row Level Security where applicable;
- no secrets in prompts or logs;
- redaction of sensitive user data from telemetry;
- input size limits;
- request rate limits;
- validation of all model-generated structured output;
- protection against prompt injection in retrieved content;
- clear labeling of retrieved content as untrusted data;
- no arbitrary tool execution;
- no cross-session memory leakage.

Treat destination and activity descriptions as potentially untrusted content. Retrieved text must never be allowed to alter system instructions or tool permissions.

## 6.7 Prompt caching is an experiment, not an assumption

Prompt caching should be implemented only where supported by the selected model/provider and measured against a baseline.

Structure prompts so that:

1. stable system instructions appear first;
2. stable tool definitions appear next;
3. stable examples or policy text follow;
4. dynamic trip-state slices and current user messages appear last.

This also applies at the agent level: cache system prompts and tool definitions per agent (static per agent, reused across every session, high cache-hit value), and cache RAG context blocks (retrieved destination/activity chunks) when the same destination is queried repeatedly within a session.

Measure: cache-read tokens; cache-write tokens; cache hit rate; latency; cost per request; cost per completed trip; behavior or quality changes. Log cache read/write token counts per agent call into `agent_runs` so the dashboard can show actual cache hit rate and $ saved — this is a strong, concrete metric for a portfolio demo.

Create a baseline mode with caching disabled or bypassed. **Do not claim savings without comparative measurements.**

---

# 7. State Model and Data Architecture

## 7.1 Separate requirements, preferences, and decisions

Do not store all user input in one undifferentiated `preferences` object. Represent at least three concepts:

- **Requirements** — what the user explicitly stated or what the system must satisfy (origin, destination, dates, party size, maximum budget, "no red-eye flights", accessibility requirement).
- **Preferences** — what the user would like but may trade away (prefers boutique hotels, likes food and culture, prefers late mornings, would like outdoor activities).
- **Decisions** — what the user or system has actually selected (chosen flight ID, chosen hotel ID, selected activity IDs, accepted budget trade-off, approved date flexibility).

Each item should include: stable ID; value; classification; confidence; source; timestamp; status; whether it is user-confirmed.

```json
{
  "requirements": [
    {
      "id": "req_123",
      "field": "budget.total",
      "value": 3000,
      "unit": "USD",
      "source": "user",
      "confidence": 1.0,
      "status": "confirmed"
    }
  ],
  "preferences": [
    {
      "id": "pref_123",
      "field": "travel_style",
      "value": ["food", "culture"],
      "source": "user",
      "confidence": 0.96,
      "status": "active"
    }
  ],
  "decisions": [
    {
      "id": "decision_123",
      "field": "hotel",
      "value": "hotel_456",
      "source": "user",
      "status": "confirmed"
    }
  ]
}
```

## 7.2 Preserve provenance

Every extracted or inferred item should record where it came from: `user_explicit`, `user_inferred`, `system_default`, `agent_proposed`, `user_confirmed`, `deterministic_validation`, `imported_inventory`.

The UI should be able to distinguish "You told us...", "We inferred...", "We assumed...", "You approved...". The system must not silently turn an inference into a hard constraint.

## 7.3 Use versioned, append-oriented state history

Do not rely exclusively on one mutable JSON document. Recommended model:

- current trip projection for fast reads;
- append-only state-change or domain-event history;
- version number;
- actor/source;
- operation type;
- before/after or patch;
- validation result;
- correlation ID.

Every meaningful state change should be attributable to: user; orchestrator; deterministic service; named AI component; system process.

A JSON snapshot can still be stored for convenient replay, but it should not be the only audit trail. Every agent call should also be logged with a pointer to the trip-state version it read and the version it produced — this is what makes the observability dashboard meaningful, since it lets you replay exactly what any agent saw.

## 7.4 Model inventory as snapshots with freshness metadata

Because v1 uses seeded data, inventory can be deterministic while still modeling real-world concerns. Each inventory item should include: source; source reference; inventory version; retrieved-at timestamp; valid-from and valid-until timestamps where relevant; currency; tax and fee fields; cancellation or change policy; capacity/occupancy assumptions; normalized destination identifier.

The UI should label seeded data appropriately and avoid implying real-time availability.

## 7.5 Preserve itinerary and selection provenance

Every itinerary component should reference: source inventory ID; selected candidate ID; date; time; location; reason for inclusion; validation status; any assumptions; whether it was user-selected or system-proposed.

The itinerary writer must receive validated structured data, not merely a prose summary.

## 7.6 Track approval history

The system must record: what the user was asked to approve; the exact proposal or state version; what the user approved; when approval occurred; whether the proposal changed afterward; whether approval became invalid due to a subsequent change.

A finalization approval must apply to a specific state version or proposal hash. If the trip changes, prior approval must be invalidated.

## 7.7 Concurrency and consistency

Implement optimistic concurrency control: every state projection has a version; writes specify the version read; a write fails if the version has changed; the workflow reloads and retries or asks the user to refresh; duplicate requests are handled idempotently. Do not allow two concurrent workflow steps to overwrite each other silently.

## 7.8 Illustrative Supabase schema

The table groups below (product/session data, inventory, AI/workflow execution, evaluation/analytics) implement the model in §7.1–§7.7. Use relational columns for fields that must be queried or validated frequently; use JSONB for flexible metadata, raw model payloads, and evolving structures. Treat this as a starting sketch to refine once concrete migrations are written, not a frozen schema.

```sql
-- ============================================================
-- Product / session data
-- ============================================================

create table users (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  display_name text
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  created_at timestamptz default now(),
  status text default 'active'
);

-- Conversation history (user-facing chat, separate from agent working memory)
create table messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  role text check (role in ('user','assistant','system')),
  content text,
  created_at timestamptz default now()
);

create table trips (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  status text not null default 'created',
  created_at timestamptz default now()
);

-- Current fast-read projection of a trip, one row per version (append-only)
create table trip_state_versions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  version int not null,
  state jsonb not null,
  actor text not null,          -- 'user' | 'orchestrator' | 'deterministic_service' | agent name | 'system'
  operation_type text not null,
  correlation_id uuid,
  created_at timestamptz default now(),
  unique (trip_id, version)
);

-- Individual requirement / preference / decision items (typed, provenance-tracked)
create table trip_requirements (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  field text not null,
  value jsonb not null,
  unit text,
  source text not null,          -- 'user_explicit' | 'user_inferred' | 'system_default' | 'agent_proposed' | ...
  confidence numeric,
  status text not null,          -- 'active' | 'confirmed' | 'retracted'
  created_at timestamptz default now()
);

create table trip_preferences (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  field text not null,
  value jsonb not null,
  source text not null,
  confidence numeric,
  status text not null,
  created_at timestamptz default now()
);

create table trip_decisions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  field text not null,           -- 'flight' | 'hotel' | 'activity' | ...
  value jsonb not null,           -- selected inventory ID(s)
  source text not null,
  status text not null,           -- 'proposed' | 'confirmed' | 'superseded'
  created_at timestamptz default now()
);

-- Append-only domain event history (see also workflow_steps in §8 tables)
create table trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  event_type text not null,       -- 'trip_created' | 'requirements_extracted' | 'budget_calculated' | ...
  payload jsonb not null,
  correlation_id uuid,
  created_at timestamptz default now()
);

create table approval_records (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  proposal_state_version int not null,
  proposal_hash text not null,
  approved_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz default now()
);

-- ============================================================
-- Inventory (seeded/mock)
-- ============================================================

create table destinations (
  id uuid primary key default gen_random_uuid(),
  name text,
  country text,
  time_zone text,
  description text,
  vibe_tags text[],
  seasonality jsonb,
  estimated_daily_cost_usd numeric,
  inventory_version int not null default 1,
  source text default 'seed',
  embedding vector(1536)         -- pgvector, for RAG over destination descriptions
);

create table flights (
  id uuid primary key default gen_random_uuid(),
  origin text,
  destination text,
  departure_time timestamptz,
  arrival_time timestamptz,
  departure_time_zone text,
  arrival_time_zone text,
  airline text,
  flight_number text,
  price_usd numeric,
  taxes_fees_usd numeric,
  cabin text,
  is_red_eye boolean,
  duration_minutes int,
  refundable boolean,
  changeable boolean,
  inventory_version int not null default 1
);

create table hotels (
  id uuid primary key default gen_random_uuid(),
  destination text,
  name text,
  neighborhood text,
  price_per_night_usd numeric,
  taxes_fees_usd numeric,
  rating numeric,
  room_capacity int,
  amenities text[],
  cancellation_policy text,
  vibe_tags text[],
  inventory_version int not null default 1
);

create table activities (
  id uuid primary key default gen_random_uuid(),
  destination text,
  name text,
  description text,
  category text,
  vibe_tags text[],
  price_usd numeric,
  duration_minutes int,
  opening_hours jsonb,
  closed_days text[],
  location text,
  accessibility_attributes text[],
  reservation_required boolean,
  inventory_version int not null default 1,
  embedding vector(1536)
);

-- ============================================================
-- AI and workflow execution
-- ============================================================

create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id),
  status text not null,           -- see workflow states in §8.1
  started_at timestamptz default now(),
  completed_at timestamptz
);

create table workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid references workflow_runs(id),
  from_state text,
  to_state text,
  event text not null,
  actor text not null,
  correlation_id uuid,
  created_at timestamptz default now()
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  trip_id uuid references trips(id),
  workflow_run_id uuid references workflow_runs(id),
  agent_name text,
  prompt_version text,
  model text,
  input_state_version int,
  output_state_version int,
  input_tokens int,
  output_tokens int,
  cache_read_tokens int,
  cache_write_tokens int,
  latency_ms int,
  cost_usd numeric,
  status text check (status in ('success','error','guardrail_blocked')),
  error_message text,
  correlation_id uuid,
  created_at timestamptz default now()
);

create table tool_calls (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid references agent_runs(id),
  tool_name text not null,
  arguments jsonb not null,
  result jsonb,
  duration_ms int,
  status text check (status in ('success','error')),
  created_at timestamptz default now()
);

-- Guardrail events (separate from generic errors — queryable on their own)
create table guardrail_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references sessions(id),
  trip_id uuid references trips(id),
  agent_name text,
  guardrail_name text,
  layer text,                     -- 'input_scope' | 'output_validation' | 'domain_validation' | 'workflow_authorization'
  triggered boolean,
  detail text,
  workflow_run_id uuid references workflow_runs(id),
  created_at timestamptz default now()
);

-- ============================================================
-- Evaluation and analytics
-- ============================================================

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  run_label text,
  created_at timestamptz default now()
);

create table eval_results (
  id uuid primary key default gen_random_uuid(),
  eval_run_id uuid references eval_runs(id),
  test_case_name text,
  passed boolean,
  score numeric,
  details jsonb,
  created_at timestamptz default now()
);
```

**RAG usage:** `destinations` and `activities` use `pgvector` embeddings so the Curator agent can do semantic search over vibe-tagged descriptions rather than exact keyword match — a clean, contained showcase of RAG without needing it to carry the whole app.

**Analytics dashboards** query against `agent_runs`, `tool_calls`, `guardrail_events`, `workflow_steps`, and `eval_results`. Build these as a separate simple view (a second small app/route, or a lightweight Supabase-connected BI tool) rather than bolting metrics UI onto the main chat frontend — see also §22 for this as an open decision on implementation form.

---

# 8. Workflow Orchestration and Execution

## 8.1 Use an explicit workflow state machine

Recommended states:

```text
created
  -> collecting_requirements
  -> awaiting_clarification
  -> requirements_ready
  -> searching_inventory
  -> validating_candidates
  -> assembling_options
  -> validating_itinerary
  -> presenting_draft
  -> awaiting_user_revision
  -> applying_revision
  -> awaiting_confirmation
  -> finalized
```

Failure or interruption states: `blocked`, `failed_recoverable`, `failed_terminal`, `cancelled`, `stale`.

The exact state names may change, but transitions must be explicit and validated.

## 8.2 Workflow controller owns transitions

Each transition should specify: current state; permitted event; required preconditions; action; resulting state; side effects; compensating behavior; emitted event.

Example:

```text
presenting_draft
  + user.confirm
  + proposal hash matches current state
  + all guardrails pass
  -> finalized
```

A model cannot directly set `status = finalized`.

## 8.3 Make operations retryable and idempotent

Every external or potentially repeated operation should have: operation ID; workflow run ID; idempotency key; attempt number; timeout; retry policy; terminal failure behavior.

Retries should not duplicate: messages; state changes; events; approvals; analytics records.

For deterministic seeded searches, repeated execution should produce stable results for the same inventory version and inputs.

## 8.4 Support cancellation and recovery

The system should be able to: cancel a long-running workflow; stop pending work where possible; mark in-flight work as cancelled; recover a failed workflow from the last valid checkpoint; distinguish retryable from non-retryable errors; show a useful user-facing error.

Persist workflow checkpoints after meaningful steps.

## 8.5 Distinguish workflow events from agent runs

An agent call is only one part of a workflow. Record events such as: `trip_created`, `requirements_extracted`, `clarification_requested`, `inventory_search_started`, `inventory_search_completed`, `candidate_set_validated`, `budget_calculated`, `itinerary_validation_failed`, `revision_requested`, `approval_requested`, `approval_invalidated`, `trip_finalized`, `workflow_failed`.

This enables end-to-end replay and user-outcome analysis.

## 8.6 Deterministic planning baseline before AI optimization

Build the non-AI planning path first:

1. structured requirements;
2. inventory filters;
3. hard-constraint checks;
4. budget calculation;
5. feasible combination generation;
6. itinerary feasibility;
7. structured draft output.

Then add AI for: interpreting natural language; qualitative ranking; explanations; natural-language revisions; polished writing.

This prevents the project from becoming impossible to debug because every behavior depends on an LLM.

## 8.7 Booking-preparation workflow

The final workflow should be:

1. generate a draft;
2. validate all selected components;
3. show costs, assumptions, and limitations;
4. ask for explicit confirmation;
5. verify the proposal has not changed;
6. mark the plan as finalized;
7. generate a booking-preparation summary;
8. display a prominent "No booking made" status.

---

# 9. Validation, Guardrails, and Evaluation

## 9.1 Implement layered guardrails

Guardrails should be enforced in code, with the model's own behavior as a first layer and a deterministic check as the backstop — don't rely on prompting alone.

**Layer 1 — Input and scope controls:** detect unsupported intents; limit input size; handle prompt-injection-like instructions; reject requests outside the travel-planning scope; avoid treating user-provided text as executable instructions.

**Layer 2 — Model output validation:** require structured schemas; reject malformed JSON; validate enum values; validate dates, currencies, IDs, and numeric ranges; reject unknown fields where appropriate; retry with a constrained repair prompt only when safe.

**Layer 3 — Domain validation:** budget checks; hard-constraint checks; inventory existence; date consistency; party-size compatibility; hotel-night calculations; activity duration; opening hours; travel time; time-zone consistency; duplicate or overlapping activities; airport and lodging logistics.

**Layer 4 — Workflow authorization:** allowed transition checks; confirmation checks; proposal-version checks; tool capability checks; session ownership; finalization permissions.

Log each guardrail decision with: guardrail name; input context reference; outcome; reason; workflow run ID; redacted details.

**Illustrative guardrail table (v1 minimum set):**

| Guardrail | Layer | Enforcement |
|---|---|---|
| Budget ceiling — total selections can't exceed stated budget without explicit user override | Domain validation | Orchestrator checks the budget engine's `remaining` before allowing state → `finalized` |
| No hallucinated inventory — itinerary can only reference items that exist in the current candidate/selection set | Domain validation | Itinerary Writer output validated against `trip_decisions` IDs before rendering |
| No booking/payment execution | Workflow authorization | Tools for actual booking simply don't exist in this system — the absence of the capability is the guardrail |
| Explicit confirmation before finalizing | Workflow authorization | Orchestrator requires a user confirmation message, matched against the current proposal hash, before state → `finalized` |
| Hard constraint violations blocked (e.g., red-eye flight when user said no red-eyes) | Domain validation | Constraint engine filters candidates; a violating selection is rejected, not just discouraged |
| Scope containment — refuses non-travel requests gracefully | Input/scope | Orchestrator system prompt + a lightweight intent classifier if you want it deterministic too |

## 9.2 Build a real itinerary feasibility engine

The feasibility engine should evaluate:

- **Dates and duration** — arrival/departure dates, number of nights, activity dates within the trip, hotel check-in/check-out, travel-day constraints.
- **Time zones** — flight departure/arrival time zones, local activity times, date rollover, destination-local display.
- **Travel time** — airport-to-hotel assumptions, hotel-to-activity travel, buffers after arrival, minimum connection or recovery windows where modeled.
- **Schedules** — opening hours, closed days, activity duration, start/end times, time-zone-aware comparisons.
- **Conflicts** — overlapping activities, impossible same-day combinations, duplicate locations, excessive daily load, activities scheduled before arrival or after departure.
- **Logistics** — airport transfer assumptions, hotel check-in timing, activity location compatibility, realistic daily sequencing.

The engine should return structured violations, not just a Boolean:

```json
{
  "valid": false,
  "violations": [
    {
      "code": "ACTIVITY_OUTSIDE_OPENING_HOURS",
      "severity": "error",
      "item_id": "activity_123",
      "message": "The activity is closed on Monday."
    }
  ],
  "warnings": [
    {
      "code": "TIGHT_TRANSFER_BUFFER",
      "message": "The proposed transfer leaves little recovery time."
    }
  ]
}
```

## 9.3 Make the budget model explicit and reproducible

Represent at least: currency; travelers; nights; flight cost basis; hotel rate basis; taxes; fees; activity costs; transportation estimates; contingency; optional versus required costs; total estimate; target budget; hard ceiling; per-person and per-night calculations.

Distinguish:

- **budget target:** preferred amount;
- **budget ceiling:** amount that cannot be exceeded without explicit override;
- **estimated total:** calculated amount;
- **unpriced items:** items that need assumptions.

The budget engine should return a breakdown:

```json
{
  "currency": "USD",
  "target": 3000,
  "ceiling": 3000,
  "subtotal": 2675,
  "taxes_and_fees": 210,
  "contingency": 100,
  "total_estimate": 2985,
  "remaining": 15,
  "unpriced_items": [],
  "violations": []
}
```

**Do not allow the LLM to calculate or rewrite totals.**

## 9.4 Prevent hallucinated inventory

Every itinerary item must resolve to a valid inventory record. Validation must check: ID exists; item belongs to the current candidate set or approved selection; item destination matches the trip; dates and prices match the current inventory version; item has not been invalidated; generated prose does not introduce unsupported items.

Prefer rendering important inventory facts from structured data rather than trusting model-generated text.

## 9.5 Enforce hard constraints

Hard constraints must be represented structurally and checked by code. Examples: no red-eye flights; maximum budget; accessibility needs; date restrictions; party-size requirements; minimum hotel rating; no early-morning activities; dietary requirements where supported by data.

If no feasible solution exists, the system must say so and present the smallest meaningful relaxation options. It must not silently weaken a hard constraint.

## 9.6 Design a broader evaluation suite

Use several evaluation layers, and prefer deterministic assertions wherever possible (budget math, constraint tag matching, ID validity) rather than LLM-graded, so the eval suite itself stays cheap, fast, and reliable enough to run in CI. Use LLM grading only for qualitative dimensions such as explanation usefulness, and calibrate it against human-reviewed examples.

**Component evaluations:** preference extraction; ambiguity detection; revision interpretation; tool-call schema correctness; retrieval relevance; explanation grounding; itinerary prose formatting.

**Deterministic domain evaluations:** budget calculations; constraint enforcement; inventory grounding; date handling; itinerary feasibility; state-transition authorization.

**End-to-end scenario evaluations:** standard successful trip; over-budget trip; impossible constraints; ambiguous request; flexible destination; hard constraint versus cheapest option; user revision; approval invalidation after revision; stale inventory; duplicate request; failed search; cancellation; out-of-scope request.

**Adversarial evaluations:** prompt injection in activity descriptions; malicious or malformed inventory text; fabricated inventory IDs; attempts to exceed budget through wording; attempts to trigger booking; cross-session references; contradictory user messages; invalid dates and currencies.

## 9.7 Evaluation case format

```json
{
  "name": "family_beach_budget",
  "description": "Family trip with explicit budget and flight constraints",
  "initial_input": "Plan a trip for four people with a $3,000 total budget, beach + kid-friendly activities, no red-eye flights, traveling in July.",
  "turns": [],
  "assertions": [
    { "type": "budget_not_exceeded" },
    { "type": "no_red_eye_flights" },
    { "type": "party_size_matches", "value": 4 },
    { "type": "activity_tags_include", "value": ["beach", "family"] },
    { "type": "no_hallucinated_ids" },
    { "type": "itinerary_is_feasible" }
  ],
  "expected_behavior": {
    "should_finalize": false,
    "should_ask_clarification": false
  }
}
```

## 9.8 Evaluation metrics

Track: overall pass rate; pass rate by scenario; hard-constraint violation rate; budget violation rate; unsupported-claim rate; inventory-grounding rate; clarification precision; retrieval recall and relevance; tool-call validity; itinerary feasibility rate; regression count; cost per evaluation run; latency per evaluation run.

Persist results and compare them across commits or build iterations — pass-rate trend over build iterations is a genuinely good story arc for the build log.

---

# 10. Retrieval-Augmented Generation

## 10.1 RAG purpose

Use RAG selectively for: destination descriptions; activity descriptions; qualitative fit; local context; curated travel-style information.

Do not use RAG as a substitute for structured inventory queries or deterministic domain logic.

## 10.2 Retrieval design

Use pgvector (or an equivalent vector store) for semantic retrieval. Every embedded document should include metadata such as: document ID; destination; content type; tags; source; inventory version; language; active status.

Apply metadata filters before or alongside vector similarity where supported.

## 10.3 Retrieval quality

Evaluate retrieval independently using: relevant-item recall; top-k precision; destination filtering accuracy; tag filtering accuracy; stale-document rate; duplicate rate.

The model should receive source identifiers and concise metadata with retrieved text.

## 10.4 RAG safety

Retrieved content is data, not instructions.

- delimit retrieved content;
- label it as untrusted;
- do not allow it to change tool permissions;
- strip or neutralize suspicious instruction-like content where practical;
- log source IDs for generated explanations.

---

# 11. Data and Seed Inventory Requirements

The seeded dataset should feel realistic enough to expose engineering edge cases.

## 11.1 Minimum data categories

**Destinations:** destination name; country/region; time zone; description; vibe tags; seasonality; estimated daily cost; source metadata; embedding.

**Flights:** origin; destination; departure and arrival timestamps; departure and arrival time zones; airline; flight number; price; taxes/fees; cabin; red-eye flag; duration; baggage assumptions; refundable/changeable flags; inventory version.

**Hotels:** destination; name; address or neighborhood; check-in/check-out assumptions; nightly price; taxes/fees; rating; room capacity; amenities; cancellation policy; vibe tags; inventory version.

**Activities:** destination; name; description; category; vibe tags; price; duration; opening hours; closed days; location; accessibility attributes; reservation requirement; embedding; source metadata.

## 11.2 Intentional data edge cases

Seed some records containing: time-zone differences; date rollovers; taxes and fees; unavailable dates; closed days; overlapping activity times; malformed optional fields; unusually long activity durations; occupancy constraints; high cancellation penalties; duplicate-looking records; stale inventory versions; incomplete descriptions.

The goal is not to make the app frustrating. The goal is to ensure the system demonstrates validation and graceful handling of imperfect data.

---

# 12. Tool Contracts

Implement typed, narrow contracts. Model-facing tools are summarized below; see §6.4 for the full model-facing vs. internal-service split.

| Tool | Used by | Notes |
|---|---|---|
| `search_flights(origin, destination, departure_date, return_date, party_size, hard_constraints, budget_range, inventory_version)` | Intake / orchestrator-driven search step | Queries the `flights` table; returns candidate flight IDs, normalized details, search metadata, warnings |
| `search_hotels(destination, check_in, check_out, party_size, budget_range, preferences, hard_constraints)` | Orchestrator-driven search step | Queries the `hotels` table; returns candidate hotel IDs, normalized prices, fee info, capacity/policy metadata |
| `retrieve_activities(destination, date_range, vibe_tags, accessibility_needs, price_range, top_k)` | Destination and Activity Curator | Vector similarity search against `activities.embedding`; returns activity IDs, source metadata, relevance info, structured fields |
| `retrieve_destinations(origin, date_range, budget, vibe_tags, flexibility, top_k)` | Intake / Curator (flexible-destination case) | RAG lookup against `destinations`; returns destination IDs, structured summaries, retrieval metadata |
| `get_candidate_explanations(candidate_set, criteria)` | Curator, Trip Explanation Agent | Pure reasoning over already-validated candidates — grounds explanations in retrieved/validated data |
| `request_clarification(missing_fields, reason)` | Intake and Revision Interpreter | Structured clarification request back to the orchestrator, not a free-text guess |
| `propose_trip_revision(revision_type, target, value)` | Intake and Revision Interpreter | Structured revision proposal; still passes through domain validation before becoming a decision |

**Internal services** (never exposed as model-facing tools — see §6.1, §6.4): `calculate_budget()`, `filter_hard_constraints()`, `assemble_candidate_combinations()`, `validate_itinerary()`, `validate_inventory_references()`, `validate_state_transition()`, `persist_state_change()`, `record_approval()`, `invalidate_prior_approval()`.

Every service should have unit tests independent of the LLM.

---

# 13. Observability, Logging, and Analytics

## 13.1 Trace the workflow, not just the agents

Every request should carry: `session_id`; `trip_id`; `workflow_run_id`; `trace_id`; `parent_event_id` where applicable; state version; component name; prompt version; model; tool name; attempt number; start/end timestamps; duration; status; error category; redacted input/output references.

## 13.2 Required telemetry

Record: workflow events; agent runs; tool calls; state transitions; guardrail outcomes; validation failures; retries; cancellations; user revisions; approvals; finalization; evaluation runs.

Do not store unrestricted raw prompts or model outputs if they contain sensitive data. Use redaction and configurable retention.

## 13.3 Engineering dashboard

Include: workflow success rate; cost per session; cost per completed trip; cost per agent/component; latency by workflow step; retry rate; failure rate by category; guardrail trigger frequency (which guardrail fires most tells you where the model struggles); tool error rate; cache hit rate; cache-related savings; evaluation pass rate over time.

## 13.4 Product dashboard

Keep product outcomes separate from engineering metrics — **do not interpret a high number of agent calls as product success.**

Include: trip-start rate; requirement-completion rate; clarification rate; draft-generation rate; revision rate; time to first draft; time to finalized plan; abandonment stage; percentage of plans passing feasibility validation; percentage of plans requiring correction; user acceptance or confirmation rate; qualitative feedback where available.

---

# 14. Frontend and User Experience

## 14.1 Primary experience

Use a clean chat-first interface with a live itinerary panel. The interface should communicate: what the system understands; what remains unresolved; what is being searched; what has been selected; what assumptions are being made; what trade-offs exist; whether the plan is valid; whether the plan is finalized.

A live-updating itinerary side panel that fills in as agents complete (flight selected → card appears, hotel selected → card appears, etc.) is the single highest-value UI decision for demo impact, since it visually narrates the multi-agent process instead of hiding it behind a spinner.

Simple, clean visual design — this is a portfolio piece, so restraint and polish matter more than feature count.

## 14.2 Recommended layout

**Main chat area:** user messages; assistant responses; clarification questions; revision controls; error and limitation messages.

**Itinerary panel:** destination; dates; travelers; budget summary; flight card; hotel card; daily activity cards; validation warnings; source/inventory labels; current plan status.

**Assumptions and trade-offs panel:** inferred preferences; unresolved questions; assumptions; hard constraints; soft preferences; budget trade-offs; reasons for rejected options.

## 14.3 Progress indicators

Use user-centered progress messages such as: "Understanding your trip requirements...", "Checking flight options...", "Finding lodging that fits your budget...", "Checking activity timing and travel distance...", "Building a feasible itinerary...".

Avoid overemphasizing internal agent names or decorative agent animations. The multi-agent architecture should be visible through meaningful progress and a technical architecture view, not gimmicks — a lightweight "agent activity" indicator is enough for anyone watching a demo to notice the multi-agent nature, without needing to read the code.

## 14.4 Finalization UX

Before finalization, show: total estimated cost; budget target and ceiling; all selected components; assumptions; unresolved warnings; mock-data disclaimer; "No booking will be made" statement.

Require an explicit confirmation action. A casual phrase such as "looks good" should be interpreted cautiously and mapped through a controlled confirmation flow, not treated as a literal `finalize` command.

---

# 15. Repository and Documentation Structure

```text
/
├── README.md
├── CLAUDE.md
├── BUILD_LOG.md
├── PROJECT_BRIEF.md
├── package.json or pyproject.toml
├── apps/
│   ├── web/
│   └── api/
├── src/
│   ├── domain/
│   │   ├── budget/
│   │   ├── constraints/
│   │   ├── itinerary/
│   │   ├── inventory/
│   │   └── planning/
│   ├── workflow/
│   ├── agents/
│   ├── tools/
│   ├── repositories/
│   ├── validation/
│   ├── observability/
│   └── config/
├── supabase/
│   ├── migrations/
│   ├── seed.sql
│   └── functions/
├── evals/
│   ├── cases/
│   ├── assertions/
│   ├── runners/
│   └── fixtures/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── end_to_end/
├── docs/
│   ├── architecture/
│   │   ├── ADR-001-system-boundaries.md
│   │   ├── ADR-002-agent-responsibilities.md
│   │   ├── ADR-003-state-and-data-model.md
│   │   ├── ADR-004-workflow-orchestration.md
│   │   ├── ADR-005-validation-and-guardrails.md
│   │   ├── ADR-006-evaluation-strategy.md
│   │   ├── ADR-007-observability.md
│   │   └── ADR-008-booking-boundaries.md
│   ├── MVP_SCOPE.md
│   ├── IMPLEMENTATION_PLAN.md
│   ├── METRICS_DEFINITION.md
│   └── architecture-diagram.md
└── scripts/
    ├── seed-data
    ├── run-evals
    └── generate-embeddings
```

The exact language and framework may change, but the boundaries should remain recognizable.

---

# 16. Build Sequence

Do not begin by implementing every agent. Build in this order.

**Phase 0 — Architecture and project setup:** confirm frontend and backend stack; establish repository structure; create `CLAUDE.md`; create `BUILD_LOG.md`; create ADR index; document system boundaries; configure environment variables and secrets; establish local database workflow.

**Phase 1 — Domain model and seeded data:** define requirements/preferences/decisions; define inventory schemas; create realistic seed data; define normalized money and date types; implement inventory repositories; add edge-case fixtures.

**Phase 2 — Deterministic services:** implement and test inventory filtering; budget engine; hard-constraint engine; candidate combination logic; itinerary feasibility engine; inventory-reference validation; state transition validation. This phase should work without an LLM.

**Phase 3 — State and workflow foundation:** create session/trip repositories; implement state versioning; implement event history; implement optimistic concurrency; implement explicit workflow states; implement retries, idempotency, cancellation, and recovery; add workflow telemetry.

**Phase 4 — Intake and revision interpretation:** add structured output schemas; implement intake agent; classify requirements, preferences, and decisions; implement clarification behavior; implement revision interpretation; add component evaluations.

**Phase 5 — Retrieval and curation:** add embeddings; implement metadata-filtered retrieval; add destination/activity curation; add explanation generation; validate retrieval quality.

**Phase 6 — Orchestration integration:** connect AI components to the workflow controller; expose only approved model-facing tools; add guardrail gates; add state persistence after each meaningful step; add failure and retry behavior.

**Phase 7 — Itinerary writer and frontend:** implement structured itinerary output; render itinerary from validated data; add chat UI; add live progress; add assumptions/trade-offs panel; add finalization flow; display mock-data limitations.

**Phase 8 — Evaluation and observability:** implement scenario replay; add adversarial cases; add CI evaluation command; build engineering dashboard; build product metrics views; add cost and cache comparison.

**Phase 9 — Portfolio polish:** improve visual design; add architecture diagram; document key ADRs; update README; summarize trade-offs and dead ends; record a demo walkthrough; explain what would change for live APIs and real booking.

---

# 17. Coding-Agent Instructions

## 17.1 General behavior

- Do not silently make major architectural decisions.
- Before implementing a cross-cutting change, identify which ADR area it affects.
- Prefer small, testable increments.
- Write tests before or alongside deterministic domain logic.
- Keep model calls behind interfaces.
- Keep provider-specific code isolated.
- Do not introduce a framework without explaining the benefit.
- Do not add an agent when a deterministic service is sufficient.
- Do not use an LLM for arithmetic or authorization.
- Do not store secrets in source control.
- Do not expose arbitrary database or network access to a model.

## 17.2 Required implementation discipline

For each substantial task: (1) state the intended change; (2) identify impacted modules; (3) identify relevant ADR area; (4) implement the smallest coherent change; (5) add or update tests; (6) run the relevant checks; (7) update documentation; (8) add a `BUILD_LOG.md` entry; (9) report unresolved risks or assumptions.

## 17.3 Required output from the coding agent

At the end of each work session, report: what changed; files changed; tests run; test results; database migrations added; decisions made; assumptions; known limitations; next recommended task.

## 17.4 Build log entry format

Maintain `BUILD_LOG.md` from day one, updated per work session, not retroactively. This file — alongside this brief and `CLAUDE.md` — is itself part of the portfolio deliverable, not just working notes: it's the artifact that demonstrates process and judgment, not just the finished code. Suggested entry format:

```markdown
## [Date] — [Phase/Milestone]
**What I built:** ...
**Why:** ...
**Decisions made:** ...
**What didn't work / dead ends:** ...
**Next up:** ...
```

---

# 18. Initial ADR Backlog

Create an ADR index first, then write detailed ADRs as decisions are made.

**ADR Area 1 — System boundaries and AI responsibilities:** system boundary (deterministic services vs. AI reasoning); agent roster and justification; model-facing tool policy; provider abstraction and model selection; booking and external-action boundary; security and prompt-injection handling; prompt-caching experiment.

**ADR Area 2 — State and data architecture:** requirements/preferences/decisions model; state versioning and event history; inventory normalization and freshness; provenance model; approval model; Supabase schema and RLS strategy; concurrency strategy.

**ADR Area 3 — Workflow execution:** custom workflow controller; workflow state machine; retry and recovery policy; cancellation behavior; idempotency strategy; checkpointing and replay; revision and finalization flow.

**ADR Area 4 — Validation and evaluation:** budget model; itinerary feasibility model; guardrail layers; deterministic versus LLM-based grading; evaluation dataset and scenario replay; adversarial testing approach.

**ADR Area 5 — Observability and measurement:** event taxonomy; trace and correlation IDs; telemetry retention and redaction; engineering dashboard; product metrics; CI evaluation reporting; build-log conventions.

---

# 19. Initial Evaluation Scenarios

1. **Standard trip** — clear destination, dates, party size, budget, and preferences; should produce a feasible draft.
2. **Missing information** — no origin or no dates; should ask a focused clarification question.
3. **Over-budget request** — no feasible combination under the ceiling; should explain the issue and offer explicit trade-offs.
4. **Conflicting hard constraints** — impossible combination; should not silently relax constraints.
5. **Hard constraint versus cheapest option** — cheapest flight is a red-eye; red-eye must be excluded.
6. **Flexible destination** — multiple destinations satisfy the qualitative preferences; system should explain the selection criteria.
7. **User revision** — "Swap the hotel for something cheaper"; prior selections should remain stable unless affected.
8. **Approval invalidation** — user approves a plan, then changes the dates; previous approval must be invalidated.
9. **Itinerary timing conflict** — activities overlap or occur outside opening hours; deterministic validator must reject the plan.
10. **Stale inventory** — candidate belongs to an old inventory version; system must flag or remove it.
11. **Duplicate request** — same workflow command is submitted twice; no duplicate state change should occur.
12. **Failure and recovery** — one search service fails; workflow should retry or enter a recoverable failure state.
13. **Cancellation** — user cancels while searching; pending work should be stopped or marked cancelled.
14. **Prompt injection in retrieved text** — activity description contains instruction-like text; content must not change system behavior.
15. **Out-of-scope request** — user asks to book a car or make a payment; system should clearly explain the v1 boundary.
16. **Cross-session isolation** — one session references another session's trip; access must be denied.

---

# 20. Product and Engineering Success Metrics

**Engineering metrics:** workflow completion rate; median and p95 latency; cost per workflow; cost per finalized plan; cache hit rate; retry rate; tool failure rate; state conflict rate; guardrail trigger rate; evaluation pass rate; regression count; unsupported-claim rate; hard-constraint violation rate; budget violation rate.

**Product metrics:** percentage of sessions reaching a first draft; percentage of drafts passing feasibility validation; revision frequency; time to first useful draft; time to finalized plan; abandonment by workflow stage; user-confirmation rate; correction rate; user-reported usefulness; percentage of users who understand that no booking occurred.

Metrics should be interpreted together. For example, fewer revisions may mean better first-pass quality, but could also indicate abandonment or lack of engagement.

---

# 21. README and Portfolio Narrative

The portfolio story should emphasize:

1. Why a deterministic workflow was chosen over an autonomous swarm.
2. Which tasks were deliberately kept out of the LLM.
3. How requirements, preferences, and decisions are separated.
4. How inventory grounding prevents hallucination.
5. How the system handles impossible constraints.
6. How the itinerary feasibility engine works.
7. How state versioning and approvals prevent invalid finalization.
8. How evaluations influenced implementation changes.
9. What telemetry revealed about latency, cost, and failures.
10. What would need to change before introducing live providers or real booking.

Avoid presenting the project as:

- "I connected six agents."
- "The LLM handles the entire trip."
- "The app books travel."
- "The system is production-ready."

A stronger narrative is:

> "I designed an AI-assisted planning workflow in which the model handles ambiguity and explanation, while deterministic services own feasibility, budget, inventory integrity, and state transitions. I then measured the system through scenario-based evaluations and workflow-level observability."

---

# 22. Open Decisions for the First Build Session

These are flagged, not resolved, so the first Claude Code session should address them explicitly rather than silently picking defaults (per §17.1 — do not silently make major architectural decisions):

1. **Frontend stack** — Next.js is the likely default; confirm.
2. **Seed data volume/realism** for `flights`/`hotels`/`activities` — how much mock data is enough to make search feel real and to exercise the edge cases in §11.2.
3. **Auth** — add Supabase Auth, or keep session-based only for v1 (§3.2 keeps this optional/out of scope unless deliberately showcased).
4. **Analytics dashboard implementation** — a second small app/route within the same repo, or a separate tool entirely (e.g., a Supabase-connected BI view) — see §7.8.
5. **CI setup for the eval suite** — GitHub Actions (or equivalent) running eval cases on each push is a strong addition if time allows; confirm provider and what blocks a merge vs. what's advisory.

Orchestration implementation is **not** an open decision — §4.3 already resolves this in favor of a custom loop over LangGraph or another framework by default.

---

# 23. Immediate First Coding-Agent Prompt

Use the following as the first prompt to the coding agent:

> You are helping build the Curated Travel Concierge project described in `PROJECT_BRIEF.md`.
>
> Before writing application code:
>
> 1. Inspect the repository and identify the existing stack.
> 2. Read `PROJECT_BRIEF.md`, `CLAUDE.md`, and any existing ADRs.
> 3. Create an implementation plan divided into small milestones.
> 4. Identify unresolved decisions (§22) and map each to one of the five ADR areas (§5).
> 5. Do not introduce an agent framework by default.
> 6. Propose the initial domain model for: requirements; preferences; decisions; destinations; flights; hotels; activities; trip state versions; workflow events; approvals.
> 7. Propose the initial database schema and migration plan (§7.8 is a starting sketch, not final).
> 8. Propose the deterministic service interfaces for: inventory search; budget calculation; hard-constraint validation; itinerary feasibility; inventory-reference validation; workflow transitions.
> 9. Create or update the ADR index, but do not write speculative detailed ADRs for decisions that have not yet been made.
> 10. Create `BUILD_LOG.md` and record this planning session.
>
> Stop after presenting the plan and proposed domain boundaries. Do not begin implementing the full application until the plan has been reviewed.

---

# 24. Final Operating Principles

1. Correctness belongs to deterministic code.
2. Models interpret, rank, explain, and write; they do not own truth.
3. Use agents only where independent context, tools, or reasoning justify them.
4. Requirements, preferences, and decisions are different data types.
5. Every important fact should have provenance.
6. Every workflow should be explicit and replayable.
7. Every state mutation should be versioned and attributable.
8. Every finalization requires current, explicit approval.
9. Every itinerary item must be grounded in known inventory.
10. Every budget total must be reproducible.
11. Every important constraint must be enforced in code.
12. Every model-facing tool must be narrow and authorized.
13. Retrieved content is untrusted data.
14. Prompt caching must be measured, not assumed.
15. Evaluation is part of development, not a final presentation feature.
16. Observability must cover the workflow, not only individual agent calls.
17. Product metrics and engineering metrics must remain distinct.
18. Build the deterministic baseline before adding AI complexity.
19. Document decisions and dead ends as the project evolves.
20. Optimize for demonstrable engineering judgment, not maximum architectural novelty.
