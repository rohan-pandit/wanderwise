# Deployment brief — Vercel hosting for peer review

Goal: a `https://` URL anyone can open, sign in to via magic link, and use — with the engineering/product dashboards (`/internal/*`) restricted to one email address. This app is a single Next.js 16 (App Router) codebase with a hosted Supabase backend already in place, so there's no separate service to stand up — just wiring the two together on Vercel.

This isn't confidential data and there's no meaningful cost-abuse concern (per-provider budget caps already exist outside this app), so this brief deliberately does **not** cover signup gating, CAPTCHA, or rate limiting. If that changes, revisit.

Each step below is labeled with who does it.

---

## 0. What's already done (this session, in the repo)

- **`INTERNAL_ACCESS_EMAIL` allowlist** — `proxy.ts` now requires the signed-in user's email to match `process.env.INTERNAL_ACCESS_EMAIL` before allowing `/internal/*` (analytics + product-metrics dashboards). Unset → denies everyone (fails closed). This reverses a documented earlier decision ("any signed-in user is fine" — see the docstring history in [`app/internal/analytics/page.tsx`](../app/internal/analytics/page.tsx)), which was correct for a local-only single-operator setup but not once the app is reachable by peer reviewers.
- **`.env.local.example`** updated with the two vars that were missing from it: `SERPAPI_API_KEY` (already required unconditionally by [`app/app/actions.ts`](../app/app/actions.ts) — no seeded-data fallback, so flight search throws without it) and `INTERNAL_ACCESS_EMAIL`.
- Local `.env.local` already has `INTERNAL_ACCESS_EMAIL=rohan.pandit14@gmail.com` set, so local dev keeps working.
- `npm run eval:ci` (typecheck + lint + 451 tests) and `npm run build` both pass clean with this change.

---

## 1. Custom SMTP for auth emails

**Why:** Supabase's built-in mailer is rate-limited to 2 emails/hour per project (`supabase/config.toml`) — fine for solo local dev, not for multiple reviewers signing in around the same time.

**What you need to do (Supabase dashboard + an SMTP provider — I have no access to either):**
1. Create an account with an SMTP provider (Resend is a reasonable free-tier choice; SendGrid/Postmark work too). Verify a sending domain or use their sandbox/shared domain if you don't want to touch DNS for this.
2. Generate SMTP credentials (host, port, username, password/API key, and the "from" address).
3. In the Supabase dashboard → **Project Settings → Authentication → SMTP Settings**, enable "custom SMTP" and enter those credentials.
4. Send a test magic-link email to yourself from the dashboard's test tool to confirm delivery before relying on it.

**What you need to give me:** nothing — this is entirely a Supabase dashboard setting, not app code or a Vercel env var. I don't need the SMTP credentials for anything in this repo.

---

## 2. Push and import into Vercel

**What you need to do:**
1. Push the current `main` branch (with today's changes) to GitHub.
2. In the Vercel dashboard, **Add New → Project**, import `rohan-pandit/wanderwise`. Vercel auto-detects Next.js — no build command changes needed (confirmed clean `npm run build` locally).

**What you need to give me:** nothing — I can prep the repo (already done in step 0), but the actual Vercel account login and import click-through has to be you.

---

## 3. Set environment variables in Vercel

**What you need to do:** In the Vercel project → **Settings → Environment Variables**, add each of these for both **Production** and **Preview**:

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your `.env.local` (same hosted Supabase project dev already uses) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same |
| `SUPABASE_SERVICE_ROLE_KEY` | Same — server-only, never expose client-side |
| `ANTHROPIC_API_KEY` | Same |
| `VOYAGE_API_KEY` | Same |
| `SERPAPI_API_KEY` | Same |
| `INTERNAL_ACCESS_EMAIL` | `rohan.pandit14@gmail.com` |

**What you need to give me:** nothing — these are values you already hold in your local `.env.local`; there's no reason for me to see or transcribe API keys. Copy them directly from `.env.local` into the Vercel dashboard yourself.

**What I need to do:** nothing further here — the repo doesn't need a `vercel.json` or any build-time env wiring beyond what Next.js does automatically.

---

## 4. Update Supabase Auth URL configuration

**Why:** magic links redirect through `${window.location.origin}/auth/callback` ([`app/page.tsx`](../app/page.tsx)), which is already environment-agnostic — but Supabase only allows redirects to URLs it's been told about.

**What you need to do:** In the Supabase dashboard → **Authentication → URL Configuration**:
1. Set **Site URL** to your production Vercel URL (e.g. `https://wanderwise.vercel.app` or your custom domain once you have one).
2. Add to **Redirect URLs**:
   - The same production URL, e.g. `https://wanderwise.vercel.app/**`
   - If you want Vercel *preview* deployments (per-PR URLs) to also support sign-in: `https://wanderwise-*-<your-vercel-team>.vercel.app/**`

**What you need to give me:** nothing — this is a Supabase dashboard setting with no corresponding repo file.

---

## 5. HTTPS

Nothing to do. Any `*.vercel.app` deployment gets a valid TLS cert automatically. If you later want a custom domain, add it in Vercel's **Domains** tab — SSL is auto-provisioned the same way (Let's Encrypt), typically within minutes of DNS propagating.

---

## 6. Confirm the database is ready

**What you need to do:** nothing extra — this app already points at your one hosted Supabase project, and `supabase/migrations/*.sql` are already applied there (same project local dev uses). No new migration step for this deployment.

**Deliberate decision (2026-09-18): one shared Supabase project, not separate dev/prod databases.** Local dev and the deployed Vercel app (production + any preview deployments) all point at the same `NEXT_PUBLIC_SUPABASE_URL`/keys — there is no environment-level database isolation. Consequences accepted knowingly, not overlooked:
- Peer reviewers' trip data and your local dev/testing activity land in the same tables and the same `/internal/analytics` dashboard.
- A future schema migration is applied once, against that one project, and is immediately live everywhere — there's nothing to "promote" between environments.

This is fine for a portfolio project with no real user data at stake; revisit only if that stops being true.

**Migrations remain a manual step, not a Vercel/GitHub-triggered one.** Pushing code to `main` only redeploys the Next.js app (`next build`) — it does not run `supabase db push` or anything else against the database (confirmed: no such step exists in `.github/workflows/ci.yml` or anywhere else in the repo). A schema change still needs, in order: write the `.sql` migration → apply it manually via `supabase db push --db-url <connection-string>` or the Supabase SQL editor → hand-edit `database.types.ts` to match (it's hand-maintained, not generated — see `BUILD_LOG.md`) → commit and push both files so Vercel's deployed code matches the new schema.

---

## 7. Verify and share

**What you need to do:**
1. Open the deployed URL, sign in with your own email via magic link, confirm it arrives (this exercises step 1).
2. Visit `/internal/analytics` signed in as `rohan.pandit14@gmail.com` — should load. If you ever sign in with a different email, it should bounce to `/app` (this exercises step 0).
3. Run through the main flow once (plan a trip end to end) to confirm Anthropic/Voyage/SerpAPI calls succeed from Vercel's network (not just your machine).
4. Share the URL with peer reviewers.

**What you need to give me:** nothing further — if something breaks in Vercel's build/runtime logs at this stage, paste me the error and I'll debug it from here.

---

## Summary: who holds what

- **Me (already done):** `INTERNAL_ACCESS_EMAIL` allowlist code in `proxy.ts`, updated docstrings, `.env.local.example` fixes, `npm run eval:ci` + `npm run build` verified clean.
- **You, with no input from me:** SMTP provider account + Supabase SMTP config; GitHub push; Vercel project import; copying your existing `.env.local` values into Vercel's dashboard; Supabase Auth URL config; final click-through testing.
- **Nothing requires you to hand me credentials** — every remaining step is either a dashboard setting (Supabase, Vercel) or a copy-paste of values you already have locally into a dashboard, not into this repo or into me.
