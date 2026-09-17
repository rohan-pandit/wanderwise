# ADR-007: Observability — Dashboards, Telemetry Scope, and Retention/Redaction

**Status:** Decided — 2026-09-17 (Phase 8/9)
**Area:** 5 — Observability and Measurement (`PROJECT_BRIEF.md` §5, §13)

## Scope of this ADR

The event taxonomy, trace/correlation IDs, and build-log conventions (`PROJECT_BRIEF.md` §8.5, §13.1, §17.4) are adopted as-is from the brief — no deviation, no separate ADR. This ADR covers three sub-decisions: **where dashboards live and who can see them, what "engineering" vs. "product" observability means here, and the telemetry retention/redaction policy §13.2 requires.**

## Context

§13.3/§13.4 ask for two different kinds of dashboard (engineering: cost/latency/cache/guardrails; product: funnel/completion/abandonment), and §7.8 leaves open whether analytics lives inside the same app or as a separate tool. §13.2 separately requires "redaction and configurable retention" for stored prompts/model output containing sensitive data — a requirement this project didn't act on until Phase 9, once the eval harness's own data volume (Phase 8) made the gap concretely more load-bearing, not just theoretical.

## Decision

### Dashboard placement and access

**One route group in the same Next.js app** (`app/internal/analytics`, `app/internal/product-metrics`), not a second deployable or an external BI tool — per §7.8, this avoids standing up and syncing a second system for a single-operator project. Access is the same bar every other `/app/*` route uses (any signed-in user via `proxy.ts`'s deny-by-default middleware) — not a separate admin role, since this project has no multi-tenant admin concept anywhere else. Both pages read via the service-role client, since every source table (`agent_runs`, `tool_calls`, `guardrail_events`, `workflow_steps`, `eval_runs`, `eval_results`) has RLS enabled with no policy for `anon`/`authenticated`.

### Engineering vs. product dashboards

**Two separate pages, not one.** `/internal/analytics` answers "is the system working and what does it cost" (finalization rate, cost/latency/cache-read by agent, guardrail trigger frequency, workflow failure-state breakdown, eval pass-rate trend). `/internal/product-metrics` answers "are users completing the funnel" (trip-start rate, requirement-completion rate, draft-generation rate, confirmation/revision rate, time-to-first-draft/finalized, abandonment stage), and shows qualitative feedback honestly as "not yet collected" rather than omitting or faking it. Per §13.4's own explicit rule, a high agent-call count must not read as product success — conflating the two into one page would blur exactly that distinction.

### Telemetry retention and redaction

**Redact the one genuinely sensitive field at write time; document retention rather than automate it yet.**

- `tool_calls.arguments`/`.result` store full tool-call JSON from the Intake agent's `record_extraction`/`propose_trip_revision` calls. Of the fields that flow through it (origin, destination, dates, party size, budget, room groups, hotel/flight preferences, `requiredAccessibility`), only `requiredAccessibility` is genuinely sensitive in the §13.2 sense — free-text accessibility needs can reveal a disability or health condition. Everything else is ordinary trip-shape data the dashboards themselves need to display, so redacting it would defeat the dashboards' purpose for no privacy benefit.
- `src/observability/redaction.ts`'s `redactSensitiveTelemetry` deep-walks a tool-call payload and masks the `value` of any `{field|target: "requiredAccessibility", value: ...}` shape before it's persisted. Applied once, in `src/repositories/agent-runs.ts`'s `recordToolCalls` — the single write boundary every caller (`intake-orchestrator.ts`, `activities-step.ts`) already shares — so no call site can forget it.
- **Retention (time-based deletion) is a decided policy, not yet automated code.** For a production deployment, the policy would be: raw `tool_calls.arguments`/`.result` retained 90 days, then either deleted or collapsed to aggregate-only (`agent_runs`' token/cost/latency columns, which have no sensitive content, retained indefinitely for the cost/trend dashboards). This project does not implement that cleanup job now, because every row in the hosted database today is synthetic demo/eval data, not real user data — building a scheduled-deletion job (e.g. a Postgres function + `pg_cron`, if available on the hosted plan) has no actual privacy benefit yet and would be speculative infrastructure for a portfolio project's current scale.

## Rationale

- Matching the access/placement pattern of every other route avoids inventing a second authorization model or a second deployment target purely for internal dashboards.
- Splitting engineering and product dashboards is a direct, low-cost way to honor §13.4's warning against a specific, real failure mode (mistaking agent activity for product success) rather than trusting a single page's readers to make that distinction themselves.
- Field-scoped redaction (rather than redacting entire payloads, or redacting nothing) is the one place on this project's actual data model where §13.2's stated concern — sensitive data in stored prompts/output — is concretely true, so it's the one place a real code change is warranted; blanket redaction would have made the cost/guardrail dashboards themselves harder to debug for no corresponding privacy gain.
- Deferring the automated retention job is a scoping decision under uncertainty, not an oversight: nothing in the current dataset needs it yet, and building it now would mean guessing at operational requirements (a cleanup cadence, an archival format) a real deployment would actually dictate.

## Consequences

- Every `tool_calls` row written from this point forward has any `requiredAccessibility` value masked as `"[redacted]"` in both `arguments` and `result`; rows written before this change (a small number of throwaway Phase 6–8 eval/dev-signin rows, already noted in `BUILD_LOG.md` as synthetic) are not retroactively redacted, since nothing currently reads or displays that historical data.
- If a future extracted field turns out to carry comparably sensitive content (none currently does), it needs to be added to `redaction.ts`'s `SENSITIVE_FIELD_NAMES` set deliberately — this isn't a general PII scrubber, it's a narrow, named allowlist-of-what-to-mask.
- Before this system holds real user data (i.e., before any claim of being production-ready), the documented retention policy above needs to become real code — a scheduled cleanup job, not just a paragraph in this ADR. Tracked in `docs/IMPLEMENTATION_PLAN.md` §5 until that happens.
- The eval-grading decision (ADR-006) and this ADR are linked: every eval run's `eval_runs`/`eval_results` rows flow into `/internal/analytics`'s pass-rate trend, so a change to what the eval suite persists affects this dashboard directly.
