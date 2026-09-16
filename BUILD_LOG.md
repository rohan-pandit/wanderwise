# Build Log

Entry format and rationale in `PROJECT_BRIEF.md` §17.4. Updated per work session, not retroactively.

---

## 2026-09-16 — Planning: brief consolidation, repo setup, first architecture decisions

**What I built:**
- Consolidated the original `PROJECT_BRIEF.md` and the superseding `CURATED_TRAVEL_CONCIERGE_BUILD_BRIEF.md` into a single non-redundant `PROJECT_BRIEF.md`, keeping all build-brief content and folding in the original's still-useful table formats, a concrete Supabase SQL sketch, and the `BUILD_LOG.md` entry-format template that had been dropped in the first consolidation pass.
- Renamed the project from `curated_travel_concierge` to `Wanderwise`.
- Initialized git, created a public GitHub repo (`rohan-pandit/wanderwise`), pushed the initial commit.
- Worked through the first-build-session checklist (`PROJECT_BRIEF.md` §23): repo inspection, domain model proposal, schema/migration proposal, deterministic service interface proposals, ADR index, this log.
- Created `CLAUDE.md`, `docs/architecture/ADR-INDEX.md`, `docs/architecture/ADR-000-tech-stack-and-topology.md`, `docs/architecture/ADR-003-state-and-data-model.md`, `docs/IMPLEMENTATION_PLAN.md`, and `supabase/migrations/0001_initial_schema.sql`.

**Why:** The build brief's own kickoff instructions require presenting a plan and domain boundaries before writing application code, and flag several decisions (§22) that shouldn't be picked silently.

**Decisions made:**
1. **App topology:** single Next.js (TypeScript, App Router) app — frontend, API layer, and orchestration loop in one codebase. See ADR-000.
2. **Auth:** Supabase Auth via magic link, required before entering the app — no anonymous/guest mode, no progressive claim flow. Landing page (`/`) handles sign-in; the product lives behind auth on `/app`. See ADR-003.
3. **Version control:** git initialized locally and a public GitHub remote created immediately, with a commit per build session going forward, since the build process itself is a portfolio deliverable.

**What didn't work / dead ends:**
- Initially considered a progressive/anonymous-first auth model (start without signing in, optionally attach an email later). Rejected once a "view previous itineraries" requirement surfaced — that model needs an anonymous-to-authenticated merge flow and dual identity handling for a UX nicety that isn't the point of the project. Mandatory sign-in removes that complexity entirely.
- First attempt to rename the project folder failed (`mv: cannot move ... Device or resource busy`) because the shell's working directory was still inside it; resolved by moving the shell to the parent directory first.

**Next up:** Scaffold the actual Next.js app (Phase 0 remaining items in `docs/IMPLEMENTATION_PLAN.md` §1), wire up local Supabase and apply `0001_initial_schema.sql`, and build the route skeleton (`/`, `/auth/callback`, `/app`, `/app/trips`).

---

## 2026-09-16 — Next.js scaffold, auth flow, route skeleton

**What I built:**
- Scaffolded the Next.js app (TypeScript, App Router, Tailwind, ESLint) via `create-next-app`, merged into the existing repo without disturbing `PROJECT_BRIEF.md`/`CLAUDE.md`/`BUILD_LOG.md` (kept ours over the generated `README.md`/`CLAUDE.md`; kept the generated `AGENTS.md` and wired `CLAUDE.md` to import it via `@AGENTS.md`, since it's framework-maintained and auto-regenerated).
- Installed `@supabase/supabase-js`, `@supabase/ssr`, `@anthropic-ai/sdk`, `zod`, and `vitest` (+ `@types/node` bump to satisfy vitest's peer dependency).
- Built the `src/` domain-layer skeleton (`domain/`, `workflow/`, `agents/`, `tools/`, `repositories/`, `validation/`, `observability/`, `config/`) per `PROJECT_BRIEF.md` §15.
- Implemented the full magic-link auth flow end to end: landing page with sign-in form (`app/page.tsx`), Supabase browser/server/service-role clients (`src/config/supabase/`), the auth callback route, and a `proxy.ts` (Next.js 16's renamed `middleware.ts`) that refreshes sessions and redirects signed-out requests away from `/app`.
- Built the route skeleton: `/app` (protected shell + placeholder chat), `/app/trips` (live query against the `trips` table, RLS-scoped), `/app/trips/[tripId]` (placeholder).
- `supabase init` (created `supabase/config.toml`).
- Wired up Vitest (`vitest.config.mts`, one sanity test, `npm test` script) and verified `npm run build`, `npm run lint`, and `npm test` all pass clean.
- Removed the unused, superseded `CURATED_TRAVEL_CONCIERGE_BUILD_BRIEF.md`.

**Why:** Continuing Phase 0 of the build sequence — the architecture decisions from the previous session (single Next.js app, mandatory magic-link auth) needed an actual scaffold to be real rather than just documented.

**Decisions made:**
- Kept Next.js's own `app/` router directory at repo root (not under `src/`), reserving `src/` for domain/business logic per ADR-000 — avoids mixing routing concerns with orchestration/domain code.
- Auth is enforced twice — once in `proxy.ts` (fast, avoids rendering protected pages at all) and once again in `app/app/layout.tsx` (defense in depth, per `PROJECT_BRIEF.md` §6.6) — redundant by design, not an oversight.
- Followed Next.js 16's rename of `middleware.ts` → `proxy.ts` (exported function name must be `proxy`, not `middleware`) rather than leaving the deprecated convention in place.

**What didn't work / dead ends:**
- `create-next-app` refuses a clean non-empty-directory run interactively; scaffolded into a sibling temp directory (`wanderwise-scaffold`) and merged the needed files in by hand instead, discarding its generated `README.md`/`CLAUDE.md` (boilerplate, superseded by ours).
- `vitest.config.ts` warned about future ESM/CommonJS incompatibility (`__dirname` usage) under Vite's native config loader; renamed to `.mts` and switched to `import.meta.dirname`.
- `npx supabase start` failed — Docker Desktop is installed but its daemon isn't running (`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`). Left this blocked rather than trying to launch a GUI app on the user's behalf; local Supabase (and therefore a working `.env.local`) is blocked until Docker Desktop is started manually.
- The `middleware-to-proxy` codemod wanted a clean git tree or `--force`; did the one-file rename by hand instead rather than run an automated codemod with `--force` on a repo with lots of new untracked files.

**Next up:** Start Docker Desktop, run `npx supabase start`, populate `.env.local` from the printed keys, confirm `0001_initial_schema.sql` applies cleanly and the magic-link flow works end to end against local Supabase (Inbucket/Mailpit for catching the email). Then Phase 1 — seed data and inventory repositories.

---

## 2026-09-16 — Docker/local Supabase blocker: root cause, pivot to hosted Supabase

**What I built:**
- Diagnosed the Docker Desktop startup failure from the previous session down to its actual root cause (see "What didn't work" below) — a machine-level Windows problem, not a Docker installation problem.
- Pivoted to a **hosted Supabase project** instead of local Docker-based Supabase for this environment. Created the project, pushed `0001_initial_schema.sql` to it via `supabase db push --db-url` (no CLI login/account-level token needed — just the project's own DB connection string), and populated `.env.local` with the real project URL, anon key, service role key, and `ANTHROPIC_API_KEY`.
- Verified the magic-link sign-in flow end to end against the real hosted project: submitted an email from the running dev server, confirmed `supabase.auth.signInWithOtp` round-tripped cleanly (UI moved to "check your inbox", no console errors).
- Added `.claude/launch.json` so the dev server can be previewed directly.

**Why:** Local Supabase requires Docker, which requires Windows to be able to create Unix domain sockets (AF_UNIX) — and it can't, machine-wide, independent of Docker entirely. That's not fixable by anything Docker-side, so continuing to chase it wasn't worth the time; a hosted project is something we'd need for a live deployment eventually anyway, so switching now isn't a step backward.

**Decisions made:**
- **Use a hosted Supabase project for this environment rather than local Docker-based Supabase**, until/unless the underlying Windows issue gets resolved. `supabase/config.toml` (from `supabase init`) stays in the repo in case local dev becomes viable later, but it's not the working setup right now.
- Migrations get applied via `supabase db push --db-url <connection-string>` using the project's own DB password — deliberately avoided asking for a Supabase account-level Personal Access Token, since that would grant broader account-wide project-management access than this task needed.

**What didn't work / dead ends (the Docker saga):**
- Root cause, found via a chain of elimination: Docker Desktop's "Inference manager" failed to bind a Unix socket (`...\Docker\run\dockerInference`) with "The file cannot be accessed by the system." Deleting the file failed identically through every tool tried — `Remove-Item`, `del`, `rmdir`, `fsutil reparsepoint query` (itself failed with the same error), `takeown`/`icacls` (same error even with forced ownership).
- `wsl --shutdown` and renaming the parent `run` folder (which *did* succeed, unlike deleting the files inside it) didn't help — Docker recreated a fresh `dockerInference` file that was broken again immediately.
- Disabling the specific feature via Docker's local feature-flag override (`features-overrides.json` → `{"InferenceAvailable": false}`) "fixed" that one error — only to immediately reveal the identical failure on a completely different Docker subsystem (the "Secrets Engine," a different socket path entirely). This was the key signal that it wasn't about any one file or feature.
- Wrote a standalone Node.js script that creates a plain AF_UNIX socket with no Docker involvement at all — it failed with the same class of error (`EACCES: permission denied`), proving conclusively this was a **Windows-level problem, not a Docker problem**.
- Tried the two standard fixes for broken Windows socket providers: `netsh winsock reset` (+ reboot) and enabling Developer Mode (+ reboot, since privilege grants apply at logon, not instantly) — neither changed the result of the plain Node.js test.
- Checked and ruled out: third-party antivirus (none installed), Windows Defender Controlled Folder Access (disabled), the `afunix` kernel driver (running normally).
- Reinstalled Docker Desktop entirely, at the user's suggestion — the plain Node.js AF_UNIX test still failed identically with Docker completely out of the picture, confirming again that reinstalling Docker was never going to fix an OS-level issue.
- Left as an open, unresolved mystery: something about this specific Windows machine's socket-provider stack rejects AF_UNIX socket creation with `EACCES`, survives a full Winsock reset, survives Developer Mode + reboot, and survives a Docker reinstall. Worth revisiting later with `sfc /scannow` / `DISM` (system file corruption) or a Process Monitor trace to see exactly what's denying the request, but not worth further time right now given the hosted-Supabase workaround unblocks everything.

**Next up:** Confirm the magic-link email actually completes the flow (click-through → `/auth/callback` → redirected into `/app`, session persists). Then Phase 1 — seed data and inventory repositories.

---

## 2026-09-16 — Phase 1: domain types, inventory repositories, seed data

**What I built:**
- `src/domain/money.ts` and `src/domain/dates.ts` — normalized `Money` (currency-checked arithmetic, throws `CurrencyMismatchError` on mismatch) and `DateRange` (ISO date strings, not `Date` objects) types, each with unit tests (17 tests total, all passing).
- `src/repositories/{destinations,flights,hotels,activities}.ts` — typed query functions over the inventory tables, taking a `SupabaseClient<Database>` and returning typed rows. These are the relational query layer the `search_flights`/`search_hotels`/`retrieve_activities` model-facing tools will wrap in Phase 6, not the tools themselves.
- `src/config/supabase/database.types.ts` — hand-written `Database` type for all three Supabase client factories (browser/server/service), covering the 13 tables actually queried so far. `supabase gen types typescript` needs Docker (spins up a local introspection container), which is still unavailable, so this is maintained by hand for now.
- `supabase/migrations/0002_seed_data.sql` — 6 destinations, 22 flights, 17 hotels, 27 activities, pushed to the hosted project via `supabase db push`.

**Why:** Phase 2 (deterministic services — budget engine, constraint filtering, feasibility engine) needs both a normalized money/date vocabulary and real inventory to filter against; building those without seed data first would mean testing against nothing.

**Decisions made:**
- Seed data lives in `supabase/migrations/0002_seed_data.sql`, not `supabase/seed.sql` as `PROJECT_BRIEF.md` §15 sketches — one file works for both `db push` (hosted, what we actually have) and a future local `db reset`, instead of two copies that could drift. Documented in the migration file's own header.
- Went with 6/22/17/27 (destinations/flights/hotels/activities) rather than the higher end of the ~4-6/~20-25/~15-20/~25-30 target range from the original plan — enough to make search and edge-case testing feel real without over-investing in hand-authored mock data at this phase.
- Deferred all embeddings (`destinations.embedding`, `activities.embedding`) to Phase 5 as originally planned — they're nullable columns, so leaving them null now doesn't block anything.

**What didn't work / dead ends:**
- `supabase gen types typescript --db-url ...` failed — it also requires Docker/Podman on PATH (`docker: command not found (podman also not found)`), same root cause as the local-Supabase blocker from the previous session. Hand-wrote the types instead.
- The hand-written types initially made every `.select(...)` resolve to `never` — postgrest-js's generic inference requires a `Relationships: []` field on every table (even if empty), which `supabase gen types` output always includes but I'd omitted. Traced this by reading postgrest-js's own `GenericTable` type definition in `node_modules` rather than guessing further; adding `Relationships: []` to all 13 tables fixed it, confirmed by a clean `tsc --noEmit`.

**Verification:** `npm test` (17/17 passing), `npx tsc --noEmit` (clean), `npm run build` (clean), `npm run lint` (clean). Also spot-checked the repositories against the live hosted data with a throwaway script (not committed): confirmed inventory-version filtering separates the stale v0 fixtures correctly, red-eye exclusion correctly returns zero results for the one route where every flight is a red-eye, rating and closed-day filters return the expected rows.

**Next up:** Phase 2 — deterministic services (budget engine, hard-constraint engine, candidate combination, itinerary feasibility engine, inventory-reference validation, state-transition validation), all unit-tested, no LLM involved yet.

---

## 2026-09-16 — Post-Phase-1 review and fixes

**What I built:** Nothing new-feature-wise — a full code review of everything built in Phases 0-1 (four review angles: correctness/cross-file, reuse/simplification, efficiency/altitude, CLAUDE.md conventions), then fixed everything it found. This is now a standing step after every phase, not a one-off.

**Why:** Requested explicitly — catch bloat, hacky code, and scalability gaps early, while they're cheap to fix, rather than letting them compound as more phases build on top.

**What the review found and I fixed (10 items):**
1. **`findDestinations`/`findActivities`/`findHotels` didn't filter by `inventory_version`** (only `findFlights` did) — the stale `v0` fixtures seeded specifically to test this were being returned as live data. Added `src/domain/inventory.ts` (`CURRENT_INVENTORY_VERSION`) and defaulted all four repos to it. Also fixed `getDestinationByName`, which — verified live — was an actual crash bug: two same-named Lisbon rows (current + stale) made `.maybeSingle()` throw "multiple rows returned."
2. **Flight date search had a timezone bug**: it compared a UTC day-boundary window against `departure_time`, which is stored/returned in UTC without preserving each flight's local offset. Fixed by widening the DB query ±1 day and filtering precisely by local calendar date (new `localDateInTimeZone` helper in `src/domain/dates.ts`, using `departure_time_zone`). Verified live: the old approach found 1 matching flight for NY→Lisbon on 2026-10-05, the fix correctly finds 2.
3. **Open redirect in the auth callback** — `redirectTo` from the query string was concatenated into the post-login redirect with no validation. Added `isSafeRedirectPath()` (same-origin relative paths only).
4. **Auth gate was an allowlist-by-prefix (`pathname.startsWith("/app")`)**, not deny-by-default — a future route outside `/app` (e.g. an API endpoint) wouldn't be protected unless someone remembered to prefix it. Flipped `proxy.ts` to a `PUBLIC_PATHS` allowlist (`/`, `/auth/callback`) with everything else protected by default.
5. **`dateRange` silently produced `NaN` for unparseable date strings** instead of throwing, because `NaN < NaN` is always `false`. Added `InvalidDateError` and an explicit `Number.isNaN` check in `toEpochDay`.
6. **Trip detail page couldn't distinguish a real DB error from "trip doesn't exist"** — both rendered the same 404. Now checks for PostgREST's `PGRST116` ("no rows") specifically before calling `notFound()`; any other error is rethrown.
7. **Sign-out had no error handling** — `signOut()`'s returned `error` was ignored, so a failure silently skipped the redirect with no feedback. Now checks the error and shows an inline message.
8. **Duplicate auth check per `/app` request** — `proxy.ts` and `AppLayout` both called `getUser()`. Removed the layout's redundant check; `proxy.ts` is now the sole auth gate, RLS remains the data-level defense in depth (the same pattern the trip detail page already used).
9. **No per-request memoization of the Supabase server client** — wrapped `createClient()` in `src/config/supabase/server.ts` with React's `cache()`, the standard Supabase/Next.js SSR pattern, so multiple Server Components in one request share a single client and session lookup.
10. **Filter-building and error-unwrapping logic was copy-pasted across all four repositories** — extracted `src/repositories/shared.ts` (`unwrapOrThrow`, `hasValues`), used by all four.

**Decisions made:** Made this review + fix + retest cycle a standing part of "phase done," not just a one-time cleanup — saved as a standing preference so it happens automatically after every future phase without being asked again.

**What didn't work / dead ends:** After the fixes, the dev server's browser tab showed a stale "Expected ',', got '<eof>'" parse error on `src/config/supabase/server.ts` that persisted through a server restart and a `.next` cache wipe — but `tsc --noEmit`, lint, `next build`, and the actual server logs (real requests returning 200) all confirmed the file was fine. Traced it to a stale WebSocket/HMR artifact in the specific browser tab that had been open during the edit; closing that tab and opening a fresh one cleared it immediately. Not a real bug — noting it in case it recurs, so it's not mistaken for one next time.

**Verification:** `npm test` (19/19 passing, 2 new test cases for the date-validation and timezone fixes), `npx tsc --noEmit` (clean), `npm run build` (clean, and `/app` is now statically optimizable since it no longer does per-request auth work), `npm run lint` (clean). All three DB-touching fixes (inventory-version filtering, `getDestinationByName`, flight timezone) spot-verified against the live hosted data with a throwaway script (not committed).

**Next up:** Phase 2 — deterministic services, unchanged from the prior plan.

---

## 2026-09-16 — Phase 2: deterministic services (budget, constraints, combinations, feasibility, inventory references, state machine)

**What I built:** All six deterministic services from `docs/IMPLEMENTATION_PLAN.md` §1 Phase 2, each pure/no-LLM and no-DB, per `PROJECT_BRIEF.md` §8.6's "deterministic planning baseline before AI optimization":
- `src/domain/constraints.ts` — hard-constraint engine (`filterHardConstraints` + one factory per constraint: no-red-eye, max price, min hotel rating, min room capacity, refundable, required accessibility, excluded closed days).
- `src/domain/budget.ts` — budget engine (`calculateBudget`), itemizing flight/hotel/activity costs into subtotal, taxes/fees, contingency, total estimate, remaining-vs-ceiling, unpriced items, and ceiling violations — the only place a total is ever computed (§9.3).
- `src/domain/combinations.ts` — `assembleCandidateCombinations`, cross-joining flights × hotels and greedily filling in the cheapest activities that still fit the ceiling.
- `src/domain/feasibility.ts` — `validateItineraryFeasibility`, checking a dated draft itinerary for hotel-stay coverage, activity date/hotel-stay bounds, closed days and opening hours (including overnight ranges), arrival/departure transfer buffers, and same-day overlaps/excessive load.
- `src/validation/inventory-references.ts` — `validateInventoryReferences`, rejecting itinerary item IDs that don't resolve to the approved candidate set, are on a stale inventory version, or belong to the wrong destination (§9.4, hallucinated-inventory guardrail).
- `src/workflow/state-machine.ts` — `validateStateTransition`, an explicit table-driven state machine covering the states in §8.1, the revision loop, confirmation (gated on proposal-hash match + guardrails passing), staleness/refresh, and cancellation/error/resume.
- 82 unit tests total across all six services plus new coverage added to `src/domain/dates.test.ts` for helpers relocated there during the review pass below.

**Why:** Per `CLAUDE.md`'s per-task discipline and `PROJECT_BRIEF.md` §8.6, the non-AI planning path (structured requirements → inventory filters → hard-constraint checks → budget → combinations → feasibility → structured draft) needs to exist and be independently correct before any agent/LLM code is layered on top in Phase 4+.

**Decisions made:**
1. Deviated from `docs/IMPLEMENTATION_PLAN.md` §3's proposed signatures in a few places (documented inline there): `BudgetBreakdown` uses the existing `Money` type instead of raw numbers; `filterHardConstraints` takes small self-describing `HardConstraint<T>` objects instead of a constraint union; `validateInventoryReferences` takes a lightweight `{flightIds, hotelIds, activityIds}` struct instead of a full `DraftItinerary`; `TransitionRequest` gained `proposalHashMatches`/`guardrailsPassed`/`resumeState` fields the original sketch didn't have, to actually implement §8.2's "proposal hash matches + guardrails pass" precondition and the §8.4 recovery path.
2. `assembleCandidateCombinations` assumes hotels have already passed a room-capacity hard constraint upstream (documented in its docstring) rather than modeling multi-room bookings itself — keeping it a pure budget-fit function, not a booking-logic engine.
3. `validateStateTransition`'s workflow table models `cancel`/`recoverable_error`/`fatal_error` as wildcard-`from` rows (legal from any non-terminal state) rather than per-state entries, after the initial version's per-state special-casing turned out to hide a dead rule (see review below).

**Post-phase review and fixes (standing practice since the last session):** Ran the `/code-review high` cycle (8 finder angles, 1-vote verify, then applied fixes) against the full diff. Found and fixed 10 issues, the most important being genuine correctness bugs, several confirmed against real seed-data fixtures rather than being purely hypothetical:
1. **Overlap detection only compared adjacent activities** after sorting by start time, missing a shorter activity nested inside a longer one when a third, non-overlapping activity sat between them in sort order. Fixed with a proper sweep-line (running max end time).
2. **Transfer-buffer checks (arrival/departure) only looked at same-calendar-day activities**, so a buffer spilling across midnight (e.g. an early-morning departure) never caught a late-night activity on the previous day. Fixed by comparing absolute "local instants" (epoch-day × 1440 + minutes) instead of date-string equality — this also let the arrival and departure buffer checks share one helper (`checkTransferBuffer`) instead of two duplicated blocks.
3. **Opening-hours parsing broke on overnight ranges** (`close < open`, e.g. "21:00-01:00") — and this isn't hypothetical: the actual seed data has exactly this shape for Reykjavik's "Northern Lights Hunt" (`0002_seed_data.sql`). Any activity legitimately scheduled in that window was being flagged as outside hours. Fixed with wraparound-aware containment plus a same-morning "yesterday's overnight window" fallback.
4. **A duplicated activity ID skipped every downstream check** (dates, hours, overlaps) for its second occurrence instead of just being flagged and continuing — meant a real overlap conflict on the duplicate could go unreported. Fixed by removing the early `continue`.
5. **`refundableConstraint` compared `cancellation_policy` to the literal string `"refundable"`**, but the real column is free text ("Free cancellation up to 48 hours before check-in" / "Non-refundable") — the literal never occurs, so the constraint rejected every real hotel. Fixed to check for a `"non-refundable"` substring instead (fail-closed on a null policy).
6. **`state-machine.ts` special-cased `cancel`/`recoverable_error`/`fatal_error` outside the declarative rules table**, which also made one explicit table row permanently dead code (a `cancel` rule from `failed_recoverable` that the special-case always intercepted first). Restructured as wildcard-`from` rows in the same table, and removed the placeholder `to: "blocked"` value on the `resume` rule (now an omitted `to`, resolved from `resumeState`) so a real workflow state can't be mistaken for unset placeholder data.
7. Reuse cleanup: `budget.ts` had its own copy of `money.ts`'s rounding helper and a USD-only formatter instead of the existing (currency-correct) `formatMoney`; `feasibility.ts` reimplemented local-time and weekday parsing that now live as exported helpers on `dates.ts` (`localMinutesOfDay`, `weekdayOf`, `toEpochDay`) instead of being duplicated.
8. Three test files had independently drifting copies of the same `flight()`/`hotel()`/`activity()` fixture builders (one still used the stale, since-fixed `cancellation_policy: "refundable"` value) — extracted to `src/repositories/fixtures.ts`, test-only, shared by all three.

Efficiency review found nothing worth changing at this project's actual scale (seed data in the 5-30 items per table range) — noted but explicitly not "fixed," since the fix would be over-engineering for now: `combinations.ts` recomputing a full budget breakdown from scratch on every greedy step is correct-by-design (§9.3 requires exactly one function ever compute a total) rather than a performance bug.

**What didn't work / dead ends:** None — this phase had no environment/tooling blockers, unlike the previous three sessions.

**Verification:** `npm test` (82/82 passing — 73 from the initial implementation, 9 more added during the review pass for the bugs above), `npx tsc --noEmit` (clean), `npm run lint` (clean), `npm run build` (clean). No DB or LLM calls in any of this phase's code, so nothing needed live-data spot-checking this time.

**Known limitations / assumptions carried forward:** `validateInventoryReferences` assumes `flights.destination`/`hotels.destination`/`activities.destination` and `destinations.name` share one identifier space (city names) since none of them are foreign keys — noted as a risk if a future data-loading path ever populates one table differently than the others. (The one-room-per-hotel-booking limitation originally noted here was resolved the same day — see the next entry.)

**Next up:** Phase 3 — session/trip repositories, state-versioning writes, event-history writes, and wiring the new `validateStateTransition` state machine into an actual workflow controller.

---

## 2026-09-16 — Multi-room hotel bookings (parties that split across rooms)

**What I built:** Generalized hotel booking from "always one room for the whole party" to one room per **room group** — so a family wanting the kids in a separate room, or a party that includes friends who want their own room, prices and validates correctly instead of silently assuming everyone shares one room.
- `src/domain/rooms.ts` (new) — `RoomGroup` (an occupant count plus an optional, calculation-irrelevant `label` like `"kids"`), `totalOccupants()`, `maxRoomOccupancy()`, and `assertRoomGroupsMatchTravelers()` (throws `RoomConfigurationError` if the groups don't add up to the traveler count).
- `src/domain/constraints.ts` — replaced `minRoomCapacityConstraint(partySize)` with `roomCapacityConstraint(roomGroups)`: since one room is booked per group, the hotel only needs `room_capacity` to cover the *largest* group, not the whole party.
- `src/domain/budget.ts` — `HotelSelection` gained an optional `rooms` field (default 1); both the nightly rate and the taxes/fees are now multiplied by room count.
- `src/domain/combinations.ts` — `CombinationParams` now takes `roomGroups` instead of implicitly assuming one room; validates the room-group/traveler invariant up front; and — closing the exact gap flagged as a known limitation above — skips any hotel whose `room_capacity` can't fit the largest room group itself, rather than only trusting that hard-constraint filtering happened upstream. `CandidateCombination` now reports `rooms` booked.
- 10 new tests across `rooms.test.ts`, `constraints.test.ts`, `budget.test.ts`, and `combinations.test.ts` (92 total, all passing).

**Why:** Asked directly, after discussing the one-room assumption as a known limitation from the Phase 2 build. Deliberately scoped to what the domain model already supports: a room group is an occupant *count*, not named people — there's no traveler-identity concept anywhere else in the schema (`trip_requirements`/`trip_preferences`/`trip_decisions` track fields and decisions, not individual people), so modeling "Alice and Bob in room 2" would be a materially bigger schema change than what was asked for. Flagged that boundary before implementing rather than silently deciding it either way.

**Decisions made:** A hotel booking still books uniform rooms of the same listed room type/rate for every group (the schema has no concept of a hotel offering multiple room types or a rooms-available count) — every room group is assumed to fit in "a room like this one," priced at the same nightly rate. This matches how the `hotels` table already models one row as one bookable room type, so it isn't a new gap introduced here, just an inherited one worth restating now that room count is explicit.

**Verification:** `npm test` (92/92 passing), `npx tsc --noEmit` (clean), `npm run lint` (clean), `npm run build` (clean).

**Next up:** Phase 3, unchanged from the prior entry.

---

## 2026-09-16 — Phase 3: session/trip repositories, versioned state, and the workflow controller

**What I built:**
- `src/repositories/sessions.ts`, `trips.ts` — typed CRUD for `sessions`/`trips`.
- `src/repositories/trip-state.ts` — `appendTripStateVersion` (optimistic concurrency via the existing `unique(trip_id, version)` constraint: a losing writer gets a clean `{status:"conflict"}` instead of a raw Postgres error), `getLatestTripState`, `getTripStateAtVersion`, and `findTripStateVersionByCorrelationId` (idempotency lookup).
- `src/repositories/trip-events.ts`, `workflow-runs.ts` — append-only event log writes and workflow-run/step telemetry (`PROJECT_BRIEF.md` §8.5).
- `src/workflow/controller.ts` — `startTrip` (creates a trip + its genesis `created` state version) and `advanceTrip` (the actual workflow controller: validates a proposed event via Phase 2's `validateStateTransition`, appends the next state version, then writes the `trip_events`/`trips.status`/`workflow_steps` mirrors). Cancellation and error-handling don't need separate code — they're just the `cancel`/`recoverable_error`/`fatal_error` events flowing through the same `advanceTrip` path Phase 2 already modeled as legal from any non-terminal state.
- `supabase/migrations/0003_trip_state_idempotency.sql` — a partial unique index on `trip_state_versions(trip_id, correlation_id)`, closing the race window between an application-level idempotency check and a concurrent duplicate request.
- 105 tests total (up from 100), including a fully-mocked `controller.test.ts` covering the retry/idempotency/rejection/conflict/terminal-completion branches without touching the DB.

**Why:** This is the seam between Phase 2's pure decision logic and real persistence — nothing durably tracks a trip's state yet, and every later phase (agents, orchestration, UI) needs a controller to call instead of writing to `trips`/`trip_state_versions` directly.

**Decisions made:**
1. Followed `PROJECT_BRIEF.md` §7.7 literally: the version-checked append to `trip_state_versions` is the one write required to be strictly consistent (enforced by the DB constraint, not application logic); `trip_events`, `trips.status`, and `workflow_runs`/`workflow_steps` are best-effort mirrors written afterward, not wrapped in a Postgres transaction/RPC. This is a real architectural choice (Area 3, workflow orchestration) made without a stop-and-ask, since it's reversible at the implementation level and §7.7 doesn't itself require the mirrors to be transactional — but see the review finding below, which is exactly why a choice like this needs to be gotten right rather than just documented.
2. `correlationId` (the idempotency key on every `advanceTrip` call) must be a UUID — the `correlation_id` columns are typed `uuid` in the schema. Caught by the live spot-check (see below), not by unit tests, since the mocked repositories in `controller.test.ts` don't know about column types. Added `InvalidCorrelationIdError` with a regex check at the top of `advanceTrip`.
3. `startTrip` (trip creation) is deliberately *not* idempotency-keyed — `trips` has no correlation-id column, and building that felt like scope creep for "state and workflow foundation." A caller that wants duplicate-request protection on creation should dedupe before calling it; noted as a known gap, not silently assumed away (the module docstring originally overclaimed this — see review finding below).

**Post-phase review and fixes:** Ran `/code-review high --fix`, scoped to just this phase's uncommitted diff (not the already-reviewed Phase 2/multi-room commits sitting ahead of `origin/main`). Found and fixed the most significant bug of any phase so far, plus several smaller ones:
1. **The idempotency replay path permanently dropped mirror writes after a partial failure** — flagged independently by three of the five review angles. `advanceTrip` returned `{status:"replayed"}` as soon as it found a `trip_state_versions` row for the correlation ID, without ever re-attempting `trip_events`/`trips.status`/`workflow_steps`/`workflow_runs.completed_at` writes that might have failed after the state append itself succeeded. A crash between the state append and the mirror writes meant those mirrors were gone forever — no retry could ever complete them, since every retry hit the same short-circuit. This directly contradicted the module's own documented retry-safety claim. **Fixed** by restructuring `advanceTrip`/`startTrip` around a shared `recordTransitionMirrors` helper: every mirror write is individually guarded by its own correlation-ID lookup (or, for `completeWorkflowRun`, an `is("completed_at", null)` filter), so a resumed call only performs whatever didn't happen yet, whether this is the first attempt or the fifth retry. Recovering the transition's `fromState` on a replay (needed to write a correct `trip_events` payload) reads the state at `version - 1`, since versions are sequential and each row is the state *after* its operation.
2. **A reused correlationId across two different logical operations could silently return the wrong state as a success** — the Postgres `23505` conflict code can't distinguish "you're retrying yourself" from "you collided with someone else's write." **Fixed** by checking the replayed row's stored `operation_type` against the currently-requested event and throwing `CorrelationIdReusedError` on a mismatch, rather than silently returning an unrelated transition's result.
3. **`updateTripStatus`/`completeWorkflowRun` discarded their update's result, so a zero-row match (stale ID, RLS mismatch) succeeded silently.** **Fixed** for `updateTripStatus` (now throws `TripNotFoundError` if nothing matched — zero rows is never legitimate there) but deliberately *not* for `completeWorkflowRun`, where zero rows is now the expected, correct outcome of an idempotent replay.
4. **`resume` allowed a no-op `failed_recoverable → failed_recoverable` transition** (Phase 2 code, surfaced by this phase's testing) — a state-machine precondition gap that would let a "recovery" write telemetry showing progress that didn't happen. **Fixed** with one more precondition check.
5. **An unchecked cast let malformed `trip_state_versions.state` JSON skip all validation on the replay path specifically** (the normal path at least gets indirectly checked by `validateStateTransition` failing to find a matching rule). **Fixed** with a runtime check in `toTripStateVersion`, throwing `InvalidTripStateSnapshotError` on an unrecognized `workflowState` value.
6. Reuse/simplification/efficiency: extracted the duplicated `startTrip`/`advanceTrip` mirror-write sequence into the one `recordTransitionMirrors` helper (also what made fix #1 tractable), and parallelized independent reads/writes (`Promise.all` for the idempotency-key lookup + current-state read, and for the independent event/status/workflow-run mirror writes) that were previously sequential for no reason.
7. **Not fixed, documented instead:** `getOrCreateActiveWorkflowRun`'s select-then-insert has no DB constraint behind it, so two genuinely concurrent `advanceTrip` calls for the same trip could both create an "active" `workflow_runs` row. Closing this needs a partial unique index (another migration) for a race that has no real caller yet (nothing calls the controller concurrently as of Phase 3) — left as a documented known gap rather than pushing a second migration in the same pass.

**Verification:** `npm test` (105/105 passing), `npx tsc --noEmit` (clean), `npm run lint` (clean), `npm run build` (clean). Live-spot-checked twice against the hosted Supabase project with throwaway scripts (not committed, each creating and deleting its own auth user): first confirmed the raw insert/update paths, the `unique(trip_id, version)` optimistic-concurrency rejection, and the new idempotency partial-unique-index rejection all behave as designed (and caught the `correlation_id`-must-be-a-UUID bug in the process); second round re-confirmed the review-fix assumptions specifically (a zero-row `.update()` really does return `[]` with no thrown error; the idempotent `completeWorkflowRun` filter really does make a second call a harmless no-op).

**Known limitations carried forward:** `getOrCreateActiveWorkflowRun`'s TOCTOU race (above — resolved same day, see next entry). The identifier-space assumption in `validateInventoryReferences` from Phase 2 is unrelated to this phase and still stands.

**Next up:** Phase 4 — structured output schemas for requirement/preference/decision extraction, and the Intake and Revision Interpreter agent (the first place an LLM enters the system).

---

## 2026-09-16 — Closed the workflow_runs concurrent-insert race

**What I built:** Closed the race documented in the previous entry rather than leaving it deferred to Phase 6 — asked directly whether "no concurrent caller yet" actually held up (a double-click or client retry hits `advanceTrip` twice today, no orchestrator required), and it didn't.
- `supabase/migrations/0004_workflow_runs_single_active.sql` — a partial unique index, `workflow_runs(trip_id) where status='running' and completed_at is null`, making the database itself enforce "at most one active run per trip."
- `src/repositories/workflow-runs.ts` — `getOrCreateActiveWorkflowRun` now catches the `23505` a losing concurrent insert produces and re-fetches the winner's row instead of erroring, mirroring the same catch-and-recover pattern already used for `trip_state_versions`' optimistic concurrency.

**Why:** Asked directly, after initially deferring this with the reasoning "no real concurrent caller exists as of Phase 3" — that reasoning didn't hold up to being questioned (double-submission is a today problem, not a Phase-6 problem), and the fix was cheap enough (one migration, one small code change) that deferring it further wasn't worth the tracking overhead.

**Decisions made:** Also restructured how deferred items get tracked going forward — `docs/IMPLEMENTATION_PLAN.md` §5 is now the single place every deferred bug/gap/constraint lives as an explicit checklist item (checked off, not deleted, when resolved, so the history stays visible), rather than prose scattered across `BUILD_LOG.md` entries that's easy to skim past. Audited every prior entry and added the two other still-open gaps that hadn't made it into a tracked list yet (`validateInventoryReferences`' destination identifier-space assumption from Phase 2; `startTrip` not being idempotency-keyed from this phase), plus the hotel room-type/availability assumption and the unreachable `"blocked"` state as lower-priority notes. **Standing instruction going forward: when a deferred issue or open item comes up (in a review, while building, or anywhere else), ask whether to address it now or later — don't silently decide to defer it.**

**Verification:** `npm test` (105/105 passing, no test changes needed — the fix is internal to `getOrCreateActiveWorkflowRun`), `npx tsc --noEmit` (clean), `npm run lint` (clean), `npm run build` (clean). Live-verified against the hosted Supabase project with a throwaway script (not committed): two concurrent inserts for the same trip, confirmed exactly one succeeds and the other fails with `23505`; confirmed the loser's re-fetch finds the winner's row; confirmed a new active run can still be created after the first one completes (the fix doesn't permanently lock a trip out of new runs).

**Next up:** Phase 4, unchanged from the prior entry.
