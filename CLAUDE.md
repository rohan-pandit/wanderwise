# CLAUDE.md

Instructions for any coding agent (Claude Code or otherwise) working in this repository.

## What this project is

Wanderwise — a travel-planning and booking-preparation concierge. It's a portfolio project: the travel domain is a vehicle for demonstrating agentic AI product/engineering judgment (multi-agent orchestration, deterministic guardrails, RAG, evals, observability), not an end in itself.

**`PROJECT_BRIEF.md` is the source of truth for scope, architecture, and rationale.** Read it before making any non-trivial change. This file only covers decisions and operating rules — it does not restate the brief.

## Locked architecture decisions

These were decided deliberately and should not be silently revisited:

- **App topology:** a single Next.js (TypeScript, App Router) app. Frontend, API layer (Route Handlers / Server Actions), and the orchestration loop all live in one codebase. See [`docs/architecture/ADR-000-tech-stack-and-topology.md`](docs/architecture/ADR-000-tech-stack-and-topology.md).
- **Orchestration:** a custom-built loop, not an agent framework (no LangGraph, no autonomous multi-agent chat). See `PROJECT_BRIEF.md` §4.3.
- **Data/backend:** Supabase (Postgres + pgvector) for all persistent state, inventory, embeddings, and telemetry.
- **Auth:** Supabase Auth, magic link only (no passwords, no OAuth). Sign-in is **required before entering the app** — there is no anonymous/guest mode. See [`docs/architecture/ADR-003-state-and-data-model.md`](docs/architecture/ADR-003-state-and-data-model.md).
- **Route structure:** a public landing/sign-in page one level above the product; the chat + live itinerary experience (and trip history) sits behind auth on its own route segment.
- **Version control:** git initialized, public GitHub repo at `rohan-pandit/wanderwise`. Commit at the end of each build session — real commit history is part of the portfolio deliverable, alongside `BUILD_LOG.md`.

## General behavior

- Do not silently make major architectural decisions. Before a cross-cutting change, identify which ADR area it affects (`PROJECT_BRIEF.md` §5) and flag it if it's a genuine fork rather than an obvious consequence of something already decided.
- Prefer small, testable increments over large batched changes.
- Write tests before or alongside deterministic domain logic (budget, constraints, feasibility, validation) — that logic must work without an LLM.
- Keep model calls behind interfaces; keep provider-specific code isolated.
- Do not introduce a framework without explaining the benefit.
- Do not add an agent when a deterministic service is sufficient (`PROJECT_BRIEF.md` §6.1–6.2).
- Do not use an LLM for arithmetic, authorization, or state transitions.
- Do not store secrets in source control.
- Do not expose arbitrary database or network access to a model — only the narrow, typed, model-facing tools listed in `PROJECT_BRIEF.md` §12.

## Per-task discipline

For each substantial task: state the intended change → identify impacted modules → identify the relevant ADR area → implement the smallest coherent change → add/update tests → run the relevant checks → update documentation → add a `BUILD_LOG.md` entry → report unresolved risks or assumptions.

## End-of-session report

At the end of each work session, report: what changed; files changed; tests run and results; database migrations added; decisions made; assumptions; known limitations; next recommended task. Log the session in `BUILD_LOG.md` using the format in `PROJECT_BRIEF.md` §17.4, and commit.

## Where things live

- Full spec: `PROJECT_BRIEF.md`
- ADR index: `docs/architecture/ADR-INDEX.md`
- Implementation plan / milestones: `docs/IMPLEMENTATION_PLAN.md`
- Build history: `BUILD_LOG.md`
- Database schema/migrations: `supabase/migrations/`
