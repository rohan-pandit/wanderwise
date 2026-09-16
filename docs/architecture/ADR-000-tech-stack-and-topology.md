# ADR-000: Tech Stack and App Topology

**Status:** Decided — 2026-09-16
**Area:** Cross-cutting (precedes the five ADR areas in `PROJECT_BRIEF.md` §5)

## Context

`PROJECT_BRIEF.md` §4.3 already mandates a custom orchestration loop (not an agent framework) in "TypeScript or Python," and §22 flagged frontend stack and overall app topology as open decisions for the first build session.

Three topologies were considered:

1. **Single Next.js (TypeScript) app.** Frontend, API layer (Route Handlers / Server Actions), and the orchestration loop all live in one codebase and deploy as one unit (e.g. Vercel).
2. **Next.js frontend + separate Python (FastAPI) backend.** TypeScript UI, Python service owns orchestration/tools/domain logic.
3. **Next.js frontend + separate Node (Fastify) backend.** TypeScript throughout, but orchestration lives in its own service instead of Next.js route handlers.

## Decision

**Single Next.js (TypeScript, App Router) app.**

## Rationale

- One language end-to-end reduces context-switching and duplicated type definitions (e.g. the trip-state shape) between frontend and backend.
- The Anthropic TypeScript SDK, the Supabase JS client, and `@supabase/ssr` are all first-class in this environment — no bindings or a second SDK to maintain.
- A single deployable (Vercel + Supabase) is simplest to build, test, and demo for a solo portfolio project. A split-service topology (options 2 and 3) buys a cleaner service boundary and a more "production-like" topology, but that boundary isn't load-bearing for what this project is actually trying to demonstrate — the orchestration loop, guardrails, and state model are the point, not inter-service networking.
- Python's ecosystem advantage (option 2) matters most when relying on Python-only ML/agent tooling; this project deliberately avoids agent frameworks and uses direct Claude tool-use, so that advantage doesn't apply here.

## Consequences

- The orchestrator, deterministic domain services, and tool implementations all live under `src/` in the same repo as the UI (see `PROJECT_BRIEF.md` §15 for the intended layout).
- If a genuine need for a separate service emerges later (e.g. a long-running background worker that doesn't fit request/response), that's a new ADR, not a silent scope creep.
- Testing can use a single toolchain (Vitest recommended) for both domain-logic unit tests and integration tests.
