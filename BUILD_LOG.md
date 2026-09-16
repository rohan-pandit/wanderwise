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
