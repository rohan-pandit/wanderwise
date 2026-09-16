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
