# ADR-003: State and Data Model — Identity, Auth, and RLS Strategy

**Status:** Decided (identity/auth scope only) — 2026-09-16
**Area:** 2 — State Model and Data Architecture (`PROJECT_BRIEF.md` §5, §7)

## Scope of this ADR

The versioned requirements/preferences/decisions model, provenance tracking, append-only event history, and concurrency strategy described in `PROJECT_BRIEF.md` §7.1–§7.7 are adopted as-is from the brief — no deviation, no separate ADR needed for those unless a concrete implementation issue forces one.

This ADR covers the one genuinely open sub-decision from that section: **how users are identified, and what that means for Row Level Security.**

## Context

`PROJECT_BRIEF.md` §3.2 leaves auth optional for v1 ("session-based only... unless you want to showcase Supabase Auth specifically"). Two identity models were considered:

1. **Progressive/anonymous-first.** A persistent anonymous cookie identifies the browser from the first visit; the user can optionally attach an email later (magic link) to make their trip(s) durable and cross-device. Lower friction to start, but requires two identity systems in parallel and a merge flow that reassigns an anonymous session's rows to a newly authenticated `auth.uid()` once claimed.
2. **Mandatory sign-in.** Supabase Auth (magic link only — no passwords) is required before a user can start a trip at all. One identity model for the lifetime of the data; no merge/migration logic ever needed.

A requirement surfaced during planning — users should be able to view a history of previous, completed itineraries — made the durability gap in option 1 more consequential: trip history tied to a single browser's cookies is fragile and undermines the "look at my past trips" demo moment if shown from a different machine or after cookies are cleared.

## Decision

**Mandatory sign-in via Supabase Auth (magic link), required before entering the app.** No anonymous/guest mode, no account-linking flow.

Route structure: a public landing page (`/`) handles the magic-link sign-in; the chat + live itinerary experience, and the trip-history list, live behind auth on a separate route segment (e.g. `/app`). This keeps the auth boundary at the routing layer, not scattered through the product UI.

## Rationale

- Removes an entire class of complexity (dual identity model, session-claim merge logic, edge cases like "what if the claimed email differs from an existing account") that has no bearing on the project's actual demonstration goals.
- `auth.uid()`-keyed Row Level Security is the standard, well-documented Supabase pattern — less bespoke code than hand-rolling an anonymous-id cookie and its own authorization checks.
- Magic-link-only auth is a small increment over building session persistence from scratch — `@supabase/ssr` handles the cookie/session/refresh plumbing that a hand-rolled approach would need anyway.
- Makes the trip-history feature reliably demoable from any device at any time, which matters for a portfolio piece.
- The one-time friction cost (email + click a link before the first interaction) is acceptable given the product isn't optimizing for anonymous drop-in usage.

## Consequences

- Every row that represents user data (`sessions`, `trips`, and everything hanging off `trips`) has a non-nullable owner reference to `auth.users`. There is no "unowned" trip state.
- RLS policies are straightforward `owner = auth.uid()` checks (directly, or via a join to `trips`/`sessions` for child tables). See `supabase/migrations/0001_initial_schema.sql`.
- Internal/telemetry tables (`agent_runs`, `tool_calls`, `guardrail_events`, `workflow_runs`, `workflow_steps`, `eval_runs`, `eval_results`) are not user-owned and are not exposed to the `anon`/`authenticated` roles at all — RLS is enabled with no policies, so only server-side code using the service role can read/write them.
- If a genuinely anonymous "try it without signing in" mode is wanted later, that's a deliberate v2 decision with its own ADR, not a default to fall back into.
