# Curated Travel Concierge

## Implementation Brief for an AI Coding Agent

**Project owner:** Rohan\
**Document status:** Build-ready specification --- supersedes the
original project brief\
**Primary purpose:** Portfolio project demonstrating reliable, testable
AI product and engineering judgment through a curated travel-planning
experience.

------------------------------------------------------------------------

# 1. Executive Summary

Build a polished travel-planning and booking-preparation concierge that
accepts natural-language trip preferences, searches a deterministic
seeded inventory, reconciles options against hard constraints and
budget, produces a day-by-day itinerary, and supports iterative changes.

The project is **not primarily a demonstration of how many agents can be
connected**. It is a demonstration of how to build an AI-enabled product
in which:

-   deterministic application logic owns correctness;
-   language models assist with interpretation, retrieval, ranking, and
    explanation;
-   workflows are explicit, inspectable, resumable, and observable;
-   all recommendations are grounded in known inventory;
-   constraints and budget are enforced in code;
-   evaluations test outcomes rather than merely checking whether text
    was generated;
-   the product experience communicates assumptions, trade-offs, and
    progress clearly.

The central architectural principle is:

> **Build a deterministic travel-planning system with an AI reasoning
> layer---not an AI agent system that happens to plan travel.**

The application should be useful as a standalone demo while also
exposing enough implementation detail to support a portfolio
walkthrough.

------------------------------------------------------------------------

# 2. Product Definition

## 2.1 Product concept

A curated travel concierge helps a user move from an initial idea to a
feasible, explainable trip plan.

The user should be able to say something like:

> "Plan a five-day trip for two people from Philadelphia in October. We
> want food, culture, and some outdoors. Our total budget is \$3,000,
> and we do not want red-eye flights."

The system should:

1.  interpret the request;
2.  identify missing information and ask focused clarification
    questions;
3.  classify inputs as hard constraints, preferences, or unresolved
    decisions;
4.  search mock flights, hotels, destinations, and activities;
5.  validate and normalize candidate data;
6.  assemble feasible combinations;
7.  explain trade-offs;
8.  generate an itinerary grounded in selected inventory;
9.  allow the user to revise individual decisions;
10. require explicit confirmation before marking the plan finalized;
11. clearly state that no real booking or payment has occurred.

## 2.2 Portfolio objective

The project should demonstrate:

-   custom orchestration and workflow control;
-   selective, justified use of specialized agents;
-   structured tool use;
-   persistent state and memory;
-   RAG with metadata filtering;
-   deterministic domain services;
-   enforced guardrails;
-   automated evaluation;
-   workflow-level observability;
-   cost, latency, and prompt-caching analysis;
-   product analytics;
-   disciplined technical decision-making through ADRs and a build log.

The number of agents is not itself a success metric.

## 2.3 Product positioning

Use the following language in the README and portfolio materials:

> **A travel-planning and booking-preparation concierge using
> AI-assisted interpretation and curation over a deterministic, testable
> planning engine.**

Do not describe v1 as a booking platform or imply that live inventory,
availability, prices, reservations, or payments are real.

------------------------------------------------------------------------

# 3. Scope

## 3.1 In scope for v1

-   Natural-language trip intake.
-   Fixed or flexible destination.
-   Origin, destination, dates, trip duration, and party size.
-   Total budget and optional budget target.
-   Traveler preferences and hard constraints.
-   Seeded/mock flights, hotels, destinations, and activities.
-   Search and filtering over mock inventory.
-   Semantic retrieval for destination and activity descriptions.
-   Feasibility checks for flights, lodging, activities, timing, and
    budget.
-   Curated candidate sets and explainable recommendations.
-   Day-by-day itinerary generation.
-   Iterative changes such as:
    -   "Swap the hotel."
    -   "Make it cheaper."
    -   "Remove the museum."
    -   "Add more outdoor activities."
    -   "Avoid early mornings."
-   Persistent session and trip state.
-   Versioned state changes.
-   Explicit confirmation before finalization.
-   Shareable itinerary view or exportable representation.
-   Internal analytics dashboard.
-   Structured agent/workflow logs.
-   Automated evaluation suite.
-   Build log and ADRs.
-   Mock booking-preparation artifacts, such as a clearly labeled "ready
    to book" summary, without executing any booking.

## 3.2 Explicitly out of scope for v1

-   Real flight, hotel, or activity APIs.
-   Live prices or live availability.
-   Real booking execution.
-   Payments, refunds, or financial transactions.
-   Sending reservations to vendors.
-   Multi-user collaboration.
-   Production-grade identity and account management.
-   Complex loyalty-program optimization.
-   Real-time disruption management.
-   Full mobile application.
-   Autonomous background agents.
-   Unbounded internet browsing.
-   Unreviewed external actions.

Potential v2 items may include live provider integrations, authenticated
accounts, real booking handoff, collaborative trips, and live disruption
handling.

## 3.3 Definition of done

A v1 release is complete when:

-   a user can create a trip from natural language;
-   the system asks for missing critical information rather than
    silently guessing;
-   all selected inventory items come from the seeded dataset;
-   hard constraints are enforced deterministically;
-   budget calculations are reproducible;
-   the itinerary passes deterministic feasibility checks;
-   a user can revise the plan without corrupting state;
-   finalization requires explicit confirmation;
-   the system cannot book or charge anything;
-   the main workflow is observable end to end;
-   the evaluation suite runs locally and in CI;
-   the README, ADRs, architecture diagram, and build log explain the
    major decisions.

------------------------------------------------------------------------

# 4. Architectural North Star

## 4.1 Core principle

Separate the system into four categories:

1.  **User experience**
    -   chat;
    -   itinerary view;
    -   assumptions and trade-offs;
    -   progress;
    -   confirmation.
2.  **Workflow and application logic**
    -   state transitions;
    -   retries;
    -   cancellation;
    -   concurrency;
    -   authorization;
    -   persistence;
    -   orchestration;
    -   domain validation.
3.  **Deterministic domain services**
    -   inventory search;
    -   budget calculations;
    -   constraint filtering;
    -   itinerary feasibility;
    -   time-zone and schedule handling;
    -   candidate selection validation.
4.  **AI reasoning layer**
    -   intent and preference extraction;
    -   clarification-question generation;
    -   semantic retrieval;
    -   qualitative ranking;
    -   explanation;
    -   itinerary prose generation;
    -   interpretation of user revisions.

The model must not be the final authority for state transitions, budget
arithmetic, inventory validity, hard constraints, or booking
permissions.

## 4.2 High-level architecture

``` text
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

## 4.3 Recommended implementation approach

Use a custom orchestration loop in TypeScript or Python rather than
adopting a large agent framework by default.

The custom controller should make the following explicit:

-   workflow states;
-   allowed transitions;
-   agent invocation;
-   tool authorization;
-   persistence boundaries;
-   retries;
-   error handling;
-   cancellation;
-   validation gates;
-   event emission.

A framework such as LangGraph may be evaluated later, but should not be
introduced merely to create the appearance of sophistication.

------------------------------------------------------------------------

# 5. The Five ADR Decision Areas

The project should organize architectural decisions under five top-level
areas. These are categories, not necessarily five enormous documents.
Create smaller ADRs underneath them as concrete decisions arise.

## Decision Area 1 --- System Boundaries and AI Responsibilities

Decide what belongs to the model, what belongs to deterministic
application code, which agents are justified, what tools are exposed to
models, and where the product boundary ends.

## Decision Area 2 --- State Model and Data Architecture

Decide how requirements, preferences, decisions, inventory, provenance,
versions, approvals, and session data are represented and persisted.

## Decision Area 3 --- Workflow Orchestration and Execution

Decide how work is sequenced, how state transitions occur, how retries
and cancellations work, and how the system recovers from failures or
concurrent updates.

## Decision Area 4 --- Validation, Guardrails, and Evaluation

Decide how correctness is enforced and measured, including budget,
constraints, inventory grounding, itinerary feasibility, safety,
adversarial cases, and regression testing.

## Decision Area 5 --- Observability, Analytics, and Product Measurement

Decide how workflow execution is traced, how engineering performance is
measured, how user outcomes are measured, and how the build process is
documented.

------------------------------------------------------------------------

# 6. ADR Area 1: System Boundaries and AI Responsibilities

This area incorporates the recommendations concerning AI/application
boundaries, agent design, tools, security, booking scope, and prompt
caching.

## 6.1 Decision: deterministic code owns correctness

The following responsibilities must be deterministic:

-   budget arithmetic;
-   currency normalization;
-   hard-constraint enforcement;
-   inventory ID validation;
-   date and time calculations;
-   flight and hotel date consistency;
-   activity scheduling;
-   opening-hours validation;
-   travel-time feasibility;
-   itinerary conflict detection;
-   state transitions;
-   finalization authorization;
-   confirmation requirements;
-   booking/payment capability boundaries;
-   idempotency and persistence behavior.

The model may propose or explain outcomes, but it cannot override these
services.

## 6.2 Decision: use fewer, better-justified agents

The original agent roster should be treated as a set of
responsibilities, not a requirement to create a separate LLM call for
every function.

Recommended v1 AI components:

### A. Intake and Revision Interpreter

Responsibilities:

-   extract structured trip requirements;
-   identify ambiguity;
-   classify user statements;
-   interpret revision requests;
-   generate clarification questions when necessary.

### B. Destination and Activity Curator

Responsibilities:

-   use retrieval results;
-   interpret vibe and qualitative preferences;
-   rank or explain relevant destinations and activities;
-   provide rationale grounded in retrieved data.

### C. Trip Explanation Agent

Responsibilities:

-   explain trade-offs;
-   summarize why a combination was selected;
-   explain why a request cannot be satisfied;
-   communicate assumptions and alternatives.

### D. Itinerary Writer

Responsibilities:

-   turn validated selections into readable itinerary prose;
-   reference only approved, selected inventory;
-   avoid inventing facts.

The following should primarily be deterministic services rather than
autonomous agents:

-   flight search;
-   hotel search;
-   budget calculation;
-   hard-constraint filtering;
-   itinerary feasibility;
-   final selection validation;
-   finalization.

A "curator" may use an LLM for qualitative ranking, but the set of
feasible candidates must already have been established by code.

## 6.3 Decision: orchestrator as workflow controller, not all-purpose reasoning agent

The orchestrator should:

-   receive the latest user message;
-   load the current trip state;
-   determine the current workflow state;
-   invoke the appropriate interpreter, service, or agent;
-   persist validated state changes;
-   emit workflow events;
-   handle clarification;
-   enforce transition gates;
-   return a user-facing response.

The orchestrator should not:

-   perform budget arithmetic itself;
-   query domain tables directly when a domain service exists;
-   invent inventory;
-   make unvalidated state changes;
-   decide that a failed constraint is acceptable;
-   execute booking or payment actions.

The orchestrator may use a small model-based routing decision when
useful, but routing must be constrained by an explicit action schema and
an allowlist of valid next actions.

## 6.4 Decision: distinguish model-facing tools from internal services

Not every internal function needs to be exposed as a Claude tool.

### Internal deterministic services

Examples:

-   `calculate_trip_budget`
-   `validate_hard_constraints`
-   `validate_itinerary_feasibility`
-   `persist_trip_state`
-   `transition_workflow`
-   `authorize_finalization`

### Model-facing tools

Expose only tools where model-driven selection adds value:

-   `search_flights`
-   `search_hotels`
-   `retrieve_destinations`
-   `retrieve_activities`
-   `get_candidate_explanations`
-   `request_clarification`
-   `propose_trip_revision`

Tool schemas must be explicit, typed, narrow, and validated. Tool calls
must be logged with arguments, results, duration, and authorization
context.

The model should not be able to call arbitrary SQL, arbitrary HTTP
endpoints, or unrestricted code.

## 6.5 Decision: define a strict booking boundary

V1 has no booking capability.

The system may produce a clearly labeled booking-preparation summary
containing:

-   selected flight;
-   selected hotel;
-   selected activities;
-   estimated costs;
-   assumptions;
-   unresolved issues;
-   information a user would need before booking.

The UI must clearly state:

-   inventory is mock or seeded;
-   prices are illustrative;
-   availability is not live;
-   no reservation was made;
-   no payment occurred.

If mock booking interfaces are added, they must be explicit simulations
and must be isolated behind a capability boundary. The application
should have no real payment or booking credentials.

## 6.6 Decision: security and privacy boundaries

Implement at least the following:

-   session isolation;
-   server-side authorization checks;
-   Supabase Row Level Security where applicable;
-   no secrets in prompts or logs;
-   redaction of sensitive user data from telemetry;
-   input size limits;
-   request rate limits;
-   validation of all model-generated structured output;
-   protection against prompt injection in retrieved content;
-   clear labeling of retrieved content as untrusted data;
-   no arbitrary tool execution;
-   no cross-session memory leakage.

Treat destination and activity descriptions as potentially untrusted
content. Retrieved text must never be allowed to alter system
instructions or tool permissions.

## 6.7 Decision: prompt caching is an experiment, not an assumption

Prompt caching should be implemented only where supported by the
selected model/provider and measured against a baseline.

Structure prompts so that:

1.  stable system instructions appear first;
2.  stable tool definitions appear next;
3.  stable examples or policy text follow;
4.  dynamic trip-state slices and current user messages appear last.

Measure:

-   cache-read tokens;
-   cache-write tokens;
-   cache hit rate;
-   latency;
-   cost per request;
-   cost per completed trip;
-   behavior or quality changes.

Create a baseline mode with caching disabled or bypassed. Do not claim
savings without comparative measurements.

------------------------------------------------------------------------

# 7. ADR Area 2: State Model and Data Architecture

This area incorporates the recommendations concerning requirements,
preferences, decisions, provenance, inventory freshness, approvals,
versioning, and the Supabase model.

## 7.1 Decision: separate requirements, preferences, and decisions

Do not store all user input in one undifferentiated `preferences`
object.

Represent at least three concepts:

### Requirements

What the user explicitly stated or what the system must satisfy.

Examples:

-   origin;
-   destination;
-   dates;
-   party size;
-   maximum budget;
-   no red-eye flights;
-   accessibility requirement.

### Preferences

What the user would like but may trade away.

Examples:

-   prefers boutique hotels;
-   likes food and culture;
-   prefers late mornings;
-   would like outdoor activities.

### Decisions

What the user or system has actually selected.

Examples:

-   chosen flight ID;
-   chosen hotel ID;
-   selected activity IDs;
-   accepted budget trade-off;
-   approved date flexibility.

Each item should include:

-   stable ID;
-   value;
-   classification;
-   confidence;
-   source;
-   timestamp;
-   status;
-   whether it is user-confirmed.

Suggested structure:

``` json
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

## 7.2 Decision: preserve provenance

Every extracted or inferred item should record where it came from.

Possible provenance values:

-   `user_explicit`;
-   `user_inferred`;
-   `system_default`;
-   `agent_proposed`;
-   `user_confirmed`;
-   `deterministic_validation`;
-   `imported_inventory`.

The UI should be able to distinguish:

-   "You told us..."
-   "We inferred..."
-   "We assumed..."
-   "You approved..."

The system must not silently turn an inference into a hard constraint.

## 7.3 Decision: use versioned, append-oriented state history

Retain the original concept of versioned trip state, but do not rely
exclusively on one mutable JSON document.

Recommended model:

-   current trip projection for fast reads;
-   append-only state-change or domain-event history;
-   version number;
-   actor/source;
-   operation type;
-   before/after or patch;
-   validation result;
-   correlation ID.

Every meaningful state change should be attributable to:

-   user;
-   orchestrator;
-   deterministic service;
-   named AI component;
-   system process.

A JSON snapshot can still be stored for convenient replay, but it should
not be the only audit trail.

## 7.4 Decision: model inventory as snapshots with freshness metadata

Because v1 uses seeded data, inventory can be deterministic while still
modeling real-world concerns.

Each inventory item should include:

-   source;
-   source reference;
-   inventory version;
-   retrieved-at timestamp;
-   valid-from and valid-until timestamps where relevant;
-   currency;
-   tax and fee fields;
-   cancellation or change policy;
-   capacity/occupancy assumptions;
-   normalized destination identifier.

The UI should label seeded data appropriately and avoid implying
real-time availability.

## 7.5 Decision: preserve itinerary and selection provenance

Every itinerary component should reference:

-   source inventory ID;
-   selected candidate ID;
-   date;
-   time;
-   location;
-   reason for inclusion;
-   validation status;
-   any assumptions;
-   whether it was user-selected or system-proposed.

The itinerary writer must receive validated structured data, not merely
a prose summary.

## 7.6 Decision: track approval history

The system must record:

-   what the user was asked to approve;
-   the exact proposal or state version;
-   what the user approved;
-   when approval occurred;
-   whether the proposal changed afterward;
-   whether approval became invalid due to a subsequent change.

A finalization approval must apply to a specific state version or
proposal hash. If the trip changes, prior approval must be invalidated.

## 7.7 Recommended Supabase entities

The original tables should be expanded conceptually into the following
groups.

### Product/session data

-   `users` or anonymous session identities;
-   `sessions`;
-   `messages`;
-   `trips`;
-   `trip_state_versions`;
-   `trip_requirements`;
-   `trip_preferences`;
-   `trip_decisions`;
-   `trip_events`;
-   `approval_records`.

### Inventory

-   `destinations`;
-   `flights`;
-   `hotels`;
-   `activities`;
-   optional `inventory_snapshots`;
-   optional `activity_locations`;
-   optional `transport_segments`.

### AI and workflow execution

-   `workflow_runs`;
-   `workflow_steps`;
-   `agent_runs`;
-   `tool_calls`;
-   `guardrail_events`;
-   `model_outputs` or redacted output references.

### Evaluation and analytics

-   `eval_runs`;
-   `eval_results`;
-   derived analytics views.

Use relational columns for fields that must be queried or validated
frequently. Use JSONB for flexible metadata, raw model payloads, and
evolving structures.

## 7.8 Concurrency and consistency

Implement optimistic concurrency control:

-   every state projection has a version;
-   writes specify the version read;
-   a write fails if the version has changed;
-   the workflow reloads and retries or asks the user to refresh;
-   duplicate requests are handled idempotently.

Do not allow two concurrent workflow steps to overwrite each other
silently.

------------------------------------------------------------------------

# 8. ADR Area 3: Workflow Orchestration and Execution

This area incorporates the recommendations concerning explicit workflow
states, retries, cancellation, recovery, idempotency, and booking-ready
flow.

## 8.1 Decision: use an explicit workflow state machine

Recommended states:

``` text
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

Failure or interruption states:

``` text
blocked
failed_recoverable
failed_terminal
cancelled
stale
```

The exact state names may change, but transitions must be explicit and
validated.

## 8.2 Decision: workflow controller owns transitions

Each transition should specify:

-   current state;
-   permitted event;
-   required preconditions;
-   action;
-   resulting state;
-   side effects;
-   compensating behavior;
-   emitted event.

Example:

``` text
presenting_draft
  + user.confirm
  + proposal hash matches current state
  + all guardrails pass
  -> finalized
```

A model cannot directly set `status = finalized`.

## 8.3 Decision: make operations retryable and idempotent

Every external or potentially repeated operation should have:

-   operation ID;
-   workflow run ID;
-   idempotency key;
-   attempt number;
-   timeout;
-   retry policy;
-   terminal failure behavior.

Retries should not duplicate:

-   messages;
-   state changes;
-   events;
-   approvals;
-   analytics records.

For deterministic seeded searches, repeated execution should produce
stable results for the same inventory version and inputs.

## 8.4 Decision: support cancellation and recovery

The system should be able to:

-   cancel a long-running workflow;
-   stop pending work where possible;
-   mark in-flight work as cancelled;
-   recover a failed workflow from the last valid checkpoint;
-   distinguish retryable from non-retryable errors;
-   show a useful user-facing error.

Persist workflow checkpoints after meaningful steps.

## 8.5 Decision: distinguish workflow events from agent runs

An agent call is only one part of a workflow.

Record events such as:

-   `trip_created`;
-   `requirements_extracted`;
-   `clarification_requested`;
-   `inventory_search_started`;
-   `inventory_search_completed`;
-   `candidate_set_validated`;
-   `budget_calculated`;
-   `itinerary_validation_failed`;
-   `revision_requested`;
-   `approval_requested`;
-   `approval_invalidated`;
-   `trip_finalized`;
-   `workflow_failed`.

This enables end-to-end replay and user-outcome analysis.

## 8.6 Decision: deterministic planning baseline before AI optimization

Build the non-AI planning path first:

1.  structured requirements;
2.  inventory filters;
3.  hard-constraint checks;
4.  budget calculation;
5.  feasible combination generation;
6.  itinerary feasibility;
7.  structured draft output.

Then add AI for:

-   interpreting natural language;
-   qualitative ranking;
-   explanations;
-   natural-language revisions;
-   polished writing.

This prevents the project from becoming impossible to debug because
every behavior depends on an LLM.

## 8.7 Booking-preparation workflow

The final workflow should be:

1.  generate a draft;
2.  validate all selected components;
3.  show costs, assumptions, and limitations;
4.  ask for explicit confirmation;
5.  verify the proposal has not changed;
6.  mark the plan as finalized;
7.  generate a booking-preparation summary;
8.  display a prominent "No booking made" status.

------------------------------------------------------------------------

# 9. ADR Area 4: Validation, Guardrails, and Evaluation

This area incorporates the recommendations concerning deterministic
feasibility, budget rigor, layered guardrails, expanded evaluations,
scenario replay, and adversarial testing.

## 9.1 Decision: implement layered guardrails

### Layer 1 --- Input and scope controls

-   detect unsupported intents;
-   limit input size;
-   handle prompt-injection-like instructions;
-   reject requests outside the travel-planning scope;
-   avoid treating user-provided text as executable instructions.

### Layer 2 --- Model output validation

-   require structured schemas;
-   reject malformed JSON;
-   validate enum values;
-   validate dates, currencies, IDs, and numeric ranges;
-   reject unknown fields where appropriate;
-   retry with a constrained repair prompt only when safe.

### Layer 3 --- Domain validation

-   budget checks;
-   hard-constraint checks;
-   inventory existence;
-   date consistency;
-   party-size compatibility;
-   hotel-night calculations;
-   activity duration;
-   opening hours;
-   travel time;
-   time-zone consistency;
-   duplicate or overlapping activities;
-   airport and lodging logistics.

### Layer 4 --- Workflow authorization

-   allowed transition checks;
-   confirmation checks;
-   proposal-version checks;
-   tool capability checks;
-   session ownership;
-   finalization permissions.

Log each guardrail decision with:

-   guardrail name;
-   input context reference;
-   outcome;
-   reason;
-   workflow run ID;
-   redacted details.

## 9.2 Decision: build a real itinerary feasibility engine

The feasibility engine should evaluate:

### Dates and duration

-   arrival and departure dates;
-   number of nights;
-   activity dates within the trip;
-   hotel check-in/check-out;
-   travel-day constraints.

### Time zones

-   flight departure and arrival time zones;
-   local activity times;
-   date rollover;
-   destination-local display.

### Travel time

-   airport-to-hotel assumptions;
-   hotel-to-activity travel;
-   buffers after arrival;
-   minimum connection or recovery windows where modeled.

### Schedules

-   opening hours;
-   closed days;
-   activity duration;
-   start/end times;
-   time-zone-aware comparisons.

### Conflicts

-   overlapping activities;
-   impossible same-day combinations;
-   duplicate locations;
-   excessive daily load;
-   activities scheduled before arrival or after departure.

### Logistics

-   airport transfer assumptions;
-   hotel check-in timing;
-   activity location compatibility;
-   realistic daily sequencing.

The engine should return structured violations, not just a Boolean:

``` json
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

## 9.3 Decision: make the budget model explicit and reproducible

Represent at least:

-   currency;
-   travelers;
-   nights;
-   flight cost basis;
-   hotel rate basis;
-   taxes;
-   fees;
-   activity costs;
-   transportation estimates;
-   contingency;
-   optional versus required costs;
-   total estimate;
-   target budget;
-   hard ceiling;
-   per-person and per-night calculations.

Distinguish:

-   **budget target:** preferred amount;
-   **budget ceiling:** amount that cannot be exceeded without explicit
    override;
-   **estimated total:** calculated amount;
-   **unpriced items:** items that need assumptions.

The budget engine should return a breakdown:

``` json
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

Do not allow the LLM to calculate or rewrite totals.

## 9.4 Decision: prevent hallucinated inventory

Every itinerary item must resolve to a valid inventory record.

Validation must check:

-   ID exists;
-   item belongs to the current candidate set or approved selection;
-   item destination matches the trip;
-   dates and prices match the current inventory version;
-   item has not been invalidated;
-   generated prose does not introduce unsupported items.

Prefer rendering important inventory facts from structured data rather
than trusting model-generated text.

## 9.5 Decision: enforce hard constraints

Hard constraints must be represented structurally and checked by code.

Examples:

-   no red-eye flights;
-   maximum budget;
-   accessibility needs;
-   date restrictions;
-   party-size requirements;
-   minimum hotel rating;
-   no early-morning activities;
-   dietary requirements where supported by data.

If no feasible solution exists, the system must say so and present the
smallest meaningful relaxation options. It must not silently weaken a
hard constraint.

## 9.6 Decision: design a broader evaluation suite

Use several evaluation layers.

### Component evaluations

-   preference extraction;
-   ambiguity detection;
-   revision interpretation;
-   tool-call schema correctness;
-   retrieval relevance;
-   explanation grounding;
-   itinerary prose formatting.

### Deterministic domain evaluations

-   budget calculations;
-   constraint enforcement;
-   inventory grounding;
-   date handling;
-   itinerary feasibility;
-   state-transition authorization.

### End-to-end scenario evaluations

-   standard successful trip;
-   over-budget trip;
-   impossible constraints;
-   ambiguous request;
-   flexible destination;
-   hard constraint versus cheapest option;
-   user revision;
-   approval invalidation after revision;
-   stale inventory;
-   duplicate request;
-   failed search;
-   cancellation;
-   out-of-scope request.

### Adversarial evaluations

-   prompt injection in activity descriptions;
-   malicious or malformed inventory text;
-   fabricated inventory IDs;
-   attempts to exceed budget through wording;
-   attempts to trigger booking;
-   cross-session references;
-   contradictory user messages;
-   invalid dates and currencies.

## 9.7 Evaluation case format

``` json
{
  "name": "family_beach_budget",
  "description": "Family trip with explicit budget and flight constraints",
  "initial_input": "Plan a trip for four people with a $3,000 total budget...",
  "turns": [],
  "assertions": [
    { "type": "budget_not_exceeded" },
    { "type": "no_red_eye_flights" },
    { "type": "party_size_matches", "value": 4 },
    { "type": "no_hallucinated_ids" },
    { "type": "itinerary_is_feasible" }
  ],
  "expected_behavior": {
    "should_finalize": false,
    "should_ask_clarification": false
  }
}
```

Prefer deterministic assertions wherever possible. Use LLM grading only
for qualitative dimensions such as explanation usefulness, and calibrate
it against human-reviewed examples.

## 9.8 Evaluation metrics

Track:

-   overall pass rate;
-   pass rate by scenario;
-   hard-constraint violation rate;
-   budget violation rate;
-   unsupported-claim rate;
-   inventory-grounding rate;
-   clarification precision;
-   retrieval recall and relevance;
-   tool-call validity;
-   itinerary feasibility rate;
-   regression count;
-   cost per evaluation run;
-   latency per evaluation run.

Persist results and compare them across commits or build iterations.

------------------------------------------------------------------------

# 10. Retrieval-Augmented Generation

## 10.1 RAG purpose

Use RAG selectively for:

-   destination descriptions;
-   activity descriptions;
-   qualitative fit;
-   local context;
-   curated travel-style information.

Do not use RAG as a substitute for structured inventory queries or
deterministic domain logic.

## 10.2 Retrieval design

Use pgvector or an equivalent vector store for semantic retrieval.

Every embedded document should include metadata such as:

-   document ID;
-   destination;
-   content type;
-   tags;
-   source;
-   inventory version;
-   language;
-   active status.

Apply metadata filters before or alongside vector similarity where
supported.

## 10.3 Retrieval quality

Evaluate retrieval independently using:

-   relevant-item recall;
-   top-k precision;
-   destination filtering accuracy;
-   tag filtering accuracy;
-   stale-document rate;
-   duplicate rate.

The model should receive source identifiers and concise metadata with
retrieved text.

## 10.4 RAG safety

Retrieved content is data, not instructions.

-   delimit retrieved content;
-   label it as untrusted;
-   do not allow it to change tool permissions;
-   strip or neutralize suspicious instruction-like content where
    practical;
-   log source IDs for generated explanations.

------------------------------------------------------------------------

# 11. Data and Seed Inventory Requirements

The seeded dataset should feel realistic enough to expose engineering
edge cases.

## 11.1 Minimum data categories

### Destinations

Include:

-   destination name;
-   country/region;
-   time zone;
-   description;
-   vibe tags;
-   seasonality;
-   estimated daily cost;
-   source metadata;
-   embedding.

### Flights

Include:

-   origin;
-   destination;
-   departure and arrival timestamps;
-   departure and arrival time zones;
-   airline;
-   flight number;
-   price;
-   taxes/fees;
-   cabin;
-   red-eye flag;
-   duration;
-   baggage assumptions;
-   refundable/changeable flags;
-   inventory version.

### Hotels

Include:

-   destination;
-   name;
-   address or neighborhood;
-   check-in/check-out assumptions;
-   nightly price;
-   taxes/fees;
-   rating;
-   room capacity;
-   amenities;
-   cancellation policy;
-   vibe tags;
-   inventory version.

### Activities

Include:

-   destination;
-   name;
-   description;
-   category;
-   vibe tags;
-   price;
-   duration;
-   opening hours;
-   closed days;
-   location;
-   accessibility attributes;
-   reservation requirement;
-   embedding;
-   source metadata.

## 11.2 Intentional data edge cases

Seed some records containing:

-   time-zone differences;
-   date rollovers;
-   taxes and fees;
-   unavailable dates;
-   closed days;
-   overlapping activity times;
-   malformed optional fields;
-   unusually long activity durations;
-   occupancy constraints;
-   high cancellation penalties;
-   duplicate-looking records;
-   stale inventory versions;
-   incomplete descriptions.

The goal is not to make the app frustrating. The goal is to ensure the
system demonstrates validation and graceful handling of imperfect data.

------------------------------------------------------------------------

# 12. Tool Contracts

Implement typed, narrow contracts.

## 12.1 Example model-facing tools

### `search_flights`

Inputs:

-   origin;
-   destination;
-   departure date;
-   return date;
-   party size;
-   hard constraints;
-   budget range;
-   inventory version.

Returns:

-   candidate flight IDs;
-   normalized structured details;
-   search metadata;
-   warnings.

### `search_hotels`

Inputs:

-   destination;
-   check-in;
-   check-out;
-   party size;
-   budget range;
-   preferences;
-   hard constraints.

Returns:

-   candidate hotel IDs;
-   normalized prices;
-   fee information;
-   capacity and policy metadata.

### `retrieve_activities`

Inputs:

-   destination;
-   date or date range;
-   vibe tags;
-   accessibility needs;
-   price range;
-   top-k.

Returns:

-   activity IDs;
-   source metadata;
-   relevance information;
-   structured activity fields.

### `retrieve_destinations`

Inputs:

-   origin;
-   date range;
-   budget;
-   vibe tags;
-   flexibility;
-   top-k.

Returns:

-   destination IDs;
-   structured summaries;
-   retrieval metadata.

## 12.2 Internal services

Implement separately:

-   `calculate_budget()`;
-   `filter_hard_constraints()`;
-   `assemble_candidate_combinations()`;
-   `validate_itinerary()`;
-   `validate_inventory_references()`;
-   `validate_state_transition()`;
-   `persist_state_change()`;
-   `record_approval()`;
-   `invalidate_prior_approval()`.

Every service should have unit tests independent of the LLM.

------------------------------------------------------------------------

# 13. Observability, Logging, and Analytics

## 13.1 Decision: trace the workflow, not just the agents

Every request should have:

-   `session_id`;
-   `trip_id`;
-   `workflow_run_id`;
-   `trace_id`;
-   `parent_event_id` where applicable;
-   state version;
-   component name;
-   prompt version;
-   model;
-   tool name;
-   attempt number;
-   start/end timestamps;
-   duration;
-   status;
-   error category;
-   redacted input/output references.

## 13.2 Required telemetry

Record:

-   workflow events;
-   agent runs;
-   tool calls;
-   state transitions;
-   guardrail outcomes;
-   validation failures;
-   retries;
-   cancellations;
-   user revisions;
-   approvals;
-   finalization;
-   evaluation runs.

Do not store unrestricted raw prompts or model outputs if they contain
sensitive data. Use redaction and configurable retention.

## 13.3 Engineering dashboard

Include:

-   workflow success rate;
-   cost per session;
-   cost per completed trip;
-   cost per agent/component;
-   latency by workflow step;
-   retry rate;
-   failure rate by category;
-   guardrail trigger frequency;
-   tool error rate;
-   cache hit rate;
-   cache-related savings;
-   evaluation pass rate over time.

## 13.4 Product dashboard

Keep product outcomes separate from engineering metrics.

Include:

-   trip-start rate;
-   requirement-completion rate;
-   clarification rate;
-   draft-generation rate;
-   revision rate;
-   time to first draft;
-   time to finalized plan;
-   abandonment stage;
-   percentage of plans passing feasibility validation;
-   percentage of plans requiring correction;
-   user acceptance or confirmation rate;
-   qualitative feedback where available.

Do not interpret a high number of agent calls as product success.

------------------------------------------------------------------------

# 14. Frontend and User Experience

## 14.1 Primary experience

Use a clean chat-first interface with a live itinerary panel.

The interface should communicate:

-   what the system understands;
-   what remains unresolved;
-   what is being searched;
-   what has been selected;
-   what assumptions are being made;
-   what trade-offs exist;
-   whether the plan is valid;
-   whether the plan is finalized.

## 14.2 Recommended layout

### Main chat area

-   user messages;
-   assistant responses;
-   clarification questions;
-   revision controls;
-   error and limitation messages.

### Itinerary panel

-   destination;
-   dates;
-   travelers;
-   budget summary;
-   flight card;
-   hotel card;
-   daily activity cards;
-   validation warnings;
-   source/inventory labels;
-   current plan status.

### Assumptions and trade-offs panel

Show:

-   inferred preferences;
-   unresolved questions;
-   assumptions;
-   hard constraints;
-   soft preferences;
-   budget trade-offs;
-   reasons for rejected options.

## 14.3 Progress indicators

Use user-centered progress messages such as:

-   "Understanding your trip requirements..."
-   "Checking flight options..."
-   "Finding lodging that fits your budget..."
-   "Checking activity timing and travel distance..."
-   "Building a feasible itinerary..."

Avoid overemphasizing internal agent names or decorative agent
animations. The multi-agent architecture should be visible through
meaningful progress and a technical architecture view, not gimmicks.

## 14.4 Finalization UX

Before finalization, show:

-   total estimated cost;
-   budget target and ceiling;
-   all selected components;
-   assumptions;
-   unresolved warnings;
-   mock-data disclaimer;
-   "No booking will be made" statement.

Require an explicit confirmation action. A casual phrase such as "looks
good" should be interpreted cautiously and mapped through a controlled
confirmation flow.

------------------------------------------------------------------------

# 15. Repository and Documentation Structure

Recommended repository structure:

``` text
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

The exact language and framework may change, but the boundaries should
remain recognizable.

------------------------------------------------------------------------

# 16. Build Sequence

Do not begin by implementing every agent. Build in this order.

## Phase 0 --- Architecture and project setup

-   confirm frontend and backend stack;
-   establish repository structure;
-   create `CLAUDE.md`;
-   create `BUILD_LOG.md`;
-   create ADR index;
-   document system boundaries;
-   configure environment variables and secrets;
-   establish local database workflow.

## Phase 1 --- Domain model and seeded data

-   define requirements/preferences/decisions;
-   define inventory schemas;
-   create realistic seed data;
-   define normalized money and date types;
-   implement inventory repositories;
-   add edge-case fixtures.

## Phase 2 --- Deterministic services

Implement and test:

-   inventory filtering;
-   budget engine;
-   hard-constraint engine;
-   candidate combination logic;
-   itinerary feasibility engine;
-   inventory-reference validation;
-   state transition validation.

This phase should work without an LLM.

## Phase 3 --- State and workflow foundation

-   create session/trip repositories;
-   implement state versioning;
-   implement event history;
-   implement optimistic concurrency;
-   implement explicit workflow states;
-   implement retries, idempotency, cancellation, and recovery;
-   add workflow telemetry.

## Phase 4 --- Intake and revision interpretation

-   add structured output schemas;
-   implement intake agent;
-   classify requirements, preferences, and decisions;
-   implement clarification behavior;
-   implement revision interpretation;
-   add component evaluations.

## Phase 5 --- Retrieval and curation

-   add embeddings;
-   implement metadata-filtered retrieval;
-   add destination/activity curation;
-   add explanation generation;
-   validate retrieval quality.

## Phase 6 --- Orchestration integration

-   connect AI components to the workflow controller;
-   expose only approved model-facing tools;
-   add guardrail gates;
-   add state persistence after each meaningful step;
-   add failure and retry behavior.

## Phase 7 --- Itinerary writer and frontend

-   implement structured itinerary output;
-   render itinerary from validated data;
-   add chat UI;
-   add live progress;
-   add assumptions/trade-offs panel;
-   add finalization flow;
-   display mock-data limitations.

## Phase 8 --- Evaluation and observability

-   implement scenario replay;
-   add adversarial cases;
-   add CI evaluation command;
-   build engineering dashboard;
-   build product metrics views;
-   add cost and cache comparison.

## Phase 9 --- Portfolio polish

-   improve visual design;
-   add architecture diagram;
-   document key ADRs;
-   update README;
-   summarize trade-offs and dead ends;
-   record a demo walkthrough;
-   explain what would change for live APIs and real booking.

------------------------------------------------------------------------

# 17. Coding-Agent Instructions

The coding agent should follow these rules.

## 17.1 General behavior

-   Do not silently make major architectural decisions.
-   Before implementing a cross-cutting change, identify which ADR area
    it affects.
-   Prefer small, testable increments.
-   Write tests before or alongside deterministic domain logic.
-   Keep model calls behind interfaces.
-   Keep provider-specific code isolated.
-   Do not introduce a framework without explaining the benefit.
-   Do not add an agent when a deterministic service is sufficient.
-   Do not use an LLM for arithmetic or authorization.
-   Do not store secrets in source control.
-   Do not expose arbitrary database or network access to a model.

## 17.2 Required implementation discipline

For each substantial task:

1.  state the intended change;
2.  identify impacted modules;
3.  identify relevant ADR area;
4.  implement the smallest coherent change;
5.  add or update tests;
6.  run the relevant checks;
7.  update documentation;
8.  add a `BUILD_LOG.md` entry;
9.  report unresolved risks or assumptions.

## 17.3 Required output from the coding agent

At the end of each work session, report:

-   what changed;
-   files changed;
-   tests run;
-   test results;
-   database migrations added;
-   decisions made;
-   assumptions;
-   known limitations;
-   next recommended task.

------------------------------------------------------------------------

# 18. Initial ADR Backlog

Create an ADR index first, then write detailed ADRs as decisions are
made.

## ADR Area 1: System boundaries and AI responsibilities

-   System boundary: deterministic services versus AI reasoning.
-   Agent roster and justification.
-   Model-facing tool policy.
-   Provider abstraction and model selection.
-   Booking and external-action boundary.
-   Security and prompt-injection handling.
-   Prompt-caching experiment.

## ADR Area 2: State and data architecture

-   Requirements/preferences/decisions model.
-   State versioning and event history.
-   Inventory normalization and freshness.
-   Provenance model.
-   Approval model.
-   Supabase schema and RLS strategy.
-   Concurrency strategy.

## ADR Area 3: Workflow execution

-   Custom workflow controller.
-   Workflow state machine.
-   Retry and recovery policy.
-   Cancellation behavior.
-   Idempotency strategy.
-   Checkpointing and replay.
-   Revision and finalization flow.

## ADR Area 4: Validation and evaluation

-   Budget model.
-   Itinerary feasibility model.
-   Guardrail layers.
-   Deterministic versus LLM-based grading.
-   Evaluation dataset and scenario replay.
-   Adversarial testing approach.

## ADR Area 5: Observability and measurement

-   Event taxonomy.
-   Trace and correlation IDs.
-   Telemetry retention and redaction.
-   Engineering dashboard.
-   Product metrics.
-   CI evaluation reporting.
-   Build-log conventions.

------------------------------------------------------------------------

# 19. Initial Evaluation Scenarios

Start with at least these cases:

1.  **Standard trip**
    -   clear destination, dates, party size, budget, and preferences;
    -   should produce a feasible draft.
2.  **Missing information**
    -   no origin or no dates;
    -   should ask a focused clarification question.
3.  **Over-budget request**
    -   no feasible combination under the ceiling;
    -   should explain the issue and offer explicit trade-offs.
4.  **Conflicting hard constraints**
    -   impossible combination;
    -   should not silently relax constraints.
5.  **Hard constraint versus cheapest option**
    -   cheapest flight is a red-eye;
    -   red-eye must be excluded.
6.  **Flexible destination**
    -   multiple destinations satisfy the qualitative preferences;
    -   system should explain the selection criteria.
7.  **User revision**
    -   "Swap the hotel for something cheaper";
    -   prior selections should remain stable unless affected.
8.  **Approval invalidation**
    -   user approves a plan, then changes the dates;
    -   previous approval must be invalidated.
9.  **Itinerary timing conflict**
    -   activities overlap or occur outside opening hours;
    -   deterministic validator must reject the plan.
10. **Stale inventory**
    -   candidate belongs to an old inventory version;
    -   system must flag or remove it.
11. **Duplicate request**
    -   same workflow command is submitted twice;
    -   no duplicate state change should occur.
12. **Failure and recovery**
    -   one search service fails;
    -   workflow should retry or enter a recoverable failure state.
13. **Cancellation**
    -   user cancels while searching;
    -   pending work should be stopped or marked cancelled.
14. **Prompt injection in retrieved text**
    -   activity description contains instruction-like text;
    -   content must not change system behavior.
15. **Out-of-scope request**
    -   user asks to book a car or make a payment;
    -   system should clearly explain the v1 boundary.
16. **Cross-session isolation**
    -   one session references another session's trip;
    -   access must be denied.

------------------------------------------------------------------------

# 20. Product and Engineering Success Metrics

## Engineering metrics

-   workflow completion rate;
-   median and p95 latency;
-   cost per workflow;
-   cost per finalized plan;
-   cache hit rate;
-   retry rate;
-   tool failure rate;
-   state conflict rate;
-   guardrail trigger rate;
-   evaluation pass rate;
-   regression count;
-   unsupported-claim rate;
-   hard-constraint violation rate;
-   budget violation rate.

## Product metrics

-   percentage of sessions reaching a first draft;
-   percentage of drafts passing feasibility validation;
-   revision frequency;
-   time to first useful draft;
-   time to finalized plan;
-   abandonment by workflow stage;
-   user-confirmation rate;
-   correction rate;
-   user-reported usefulness;
-   percentage of users who understand that no booking occurred.

Metrics should be interpreted together. For example, fewer revisions may
mean better first-pass quality, but could also indicate abandonment or
lack of engagement.

------------------------------------------------------------------------

# 21. README and Portfolio Narrative

The portfolio story should emphasize:

1.  Why a deterministic workflow was chosen over an autonomous swarm.
2.  Which tasks were deliberately kept out of the LLM.
3.  How requirements, preferences, and decisions are separated.
4.  How inventory grounding prevents hallucination.
5.  How the system handles impossible constraints.
6.  How the itinerary feasibility engine works.
7.  How state versioning and approvals prevent invalid finalization.
8.  How evaluations influenced implementation changes.
9.  What telemetry revealed about latency, cost, and failures.
10. What would need to change before introducing live providers or real
    booking.

Avoid presenting the project as:

-   "I connected six agents."
-   "The LLM handles the entire trip."
-   "The app books travel."
-   "The system is production-ready."

A stronger narrative is:

> "I designed an AI-assisted planning workflow in which the model
> handles ambiguity and explanation, while deterministic services own
> feasibility, budget, inventory integrity, and state transitions. I
> then measured the system through scenario-based evaluations and
> workflow-level observability."

------------------------------------------------------------------------

# 22. Immediate First Coding-Agent Prompt

Use the following as the first prompt to the coding agent:

> You are helping build the Curated Travel Concierge project described
> in `PROJECT_BRIEF.md`.
>
> Before writing application code:
>
> 1.  Inspect the repository and identify the existing stack.
> 2.  Read `PROJECT_BRIEF.md`, `CLAUDE.md`, and any existing ADRs.
> 3.  Create an implementation plan divided into small milestones.
> 4.  Identify unresolved decisions and map each to one of the five ADR
>     areas.
> 5.  Do not introduce an agent framework by default.
> 6.  Propose the initial domain model for:
>     -   requirements;
>     -   preferences;
>     -   decisions;
>     -   destinations;
>     -   flights;
>     -   hotels;
>     -   activities;
>     -   trip state versions;
>     -   workflow events;
>     -   approvals.
> 7.  Propose the initial database schema and migration plan.
> 8.  Propose the deterministic service interfaces for:
>     -   inventory search;
>     -   budget calculation;
>     -   hard-constraint validation;
>     -   itinerary feasibility;
>     -   inventory-reference validation;
>     -   workflow transitions.
> 9.  Create or update the ADR index, but do not write speculative
>     detailed ADRs for decisions that have not yet been made.
> 10. Create `BUILD_LOG.md` and record this planning session.
>
> Stop after presenting the plan and proposed domain boundaries. Do not
> begin implementing the full application until the plan has been
> reviewed.

------------------------------------------------------------------------

# 23. Final Operating Principles

1.  Correctness belongs to deterministic code.
2.  Models interpret, rank, explain, and write; they do not own truth.
3.  Use agents only where independent context, tools, or reasoning
    justify them.
4.  Requirements, preferences, and decisions are different data types.
5.  Every important fact should have provenance.
6.  Every workflow should be explicit and replayable.
7.  Every state mutation should be versioned and attributable.
8.  Every finalization requires current, explicit approval.
9.  Every itinerary item must be grounded in known inventory.
10. Every budget total must be reproducible.
11. Every important constraint must be enforced in code.
12. Every model-facing tool must be narrow and authorized.
13. Retrieved content is untrusted data.
14. Prompt caching must be measured, not assumed.
15. Evaluation is part of development, not a final presentation feature.
16. Observability must cover the workflow, not only individual agent
    calls.
17. Product metrics and engineering metrics must remain distinct.
18. Build the deterministic baseline before adding AI complexity.
19. Document decisions and dead ends as the project evolves.
20. Optimize for demonstrable engineering judgment, not maximum
    architectural novelty.
