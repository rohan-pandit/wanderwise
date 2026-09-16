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
