/**
 * Per-user activity index — one row per signed-up account, linking to a
 * full timeline (`[userId]/page.tsx`). Phase A of per-user observability:
 * built only from tables the app already writes (see
 * `src/observability/user-activity.ts`'s docstring for which).
 *
 * Same access model as the other `/internal` pages: `proxy.ts` gates
 * `/internal/*` to `INTERNAL_ACCESS_EMAIL`, and reads go through the
 * service client because `auth.users` and the telemetry tables aren't
 * readable any other way. Emails and raw chat are shown deliberately —
 * this is a closed beta whose operator decided (2026-09-25) that per-user
 * review needs no separate notice; revisit before any public launch.
 */
import Link from "next/link";
import { connection } from "next/server";
import { createServiceClient } from "@/src/config/supabase/service";
import { selectAllRows } from "@/src/repositories/shared";
import { isDuplicateOfChainFailure, summarizeUsers, type UserSummaryInput } from "@/src/observability/user-activity";
import { CALLBACK_FAILURE_LABELS, summarizeSignInProblems, type CallbackFailureReason } from "@/src/observability/sign-in-telemetry";
import { InternalNav } from "../_components/internal-nav";
import { formatTimestamp } from "./format";

/** `auth.admin.listUsers` pages too (max 1000 per page) — walk until a short page, like `selectAllRows`. */
async function listAllAuthUsers(supabase: ReturnType<typeof createServiceClient>): Promise<UserSummaryInput[]> {
  const users: UserSummaryInput[] = [];
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    users.push(
      ...data.users.map((u) => ({ userId: u.id, email: u.email ?? null, createdAt: u.created_at, lastSignInAt: u.last_sign_in_at ?? null })),
    );
    if (data.users.length < perPage) return users;
  }
}

export default async function UsersPage() {
  await connection();
  const supabase = createServiceClient();

  const [users, tripsRes, messagesRes, agentErrorsRes, chainFailuresRes, appEventsRes] = await Promise.all([
    listAllAuthUsers(supabase),
    selectAllRows((from, to) => supabase.from("trips").select("id, user_id, session_id, status, created_at").order("id").range(from, to)),
    selectAllRows((from, to) => supabase.from("messages").select("session_id, role, created_at").order("id").range(from, to)),
    selectAllRows((from, to) => supabase.from("agent_runs").select("trip_id").eq("status", "error").order("id").range(from, to)),
    selectAllRows((from, to) =>
      supabase
        .from("trip_events")
        .select("trip_id, event_type, payload, created_at")
        .in("event_type", ["chain_propose_failed", "chain_revision_failed"])
        .order("id")
        .range(from, to),
    ),
    // Degrades to empty (with a note below) if migration 0021 isn't applied yet.
    selectAllRows((from, to) => supabase.from("app_events").select("event_type, user_id, email, trip_id, payload, created_at").order("id").range(from, to)),
  ]);

  const errorTripIds = [...(agentErrorsRes.data ?? []), ...(chainFailuresRes.data ?? [])]
    .map((r) => r.trip_id)
    .filter((id): id is string => id !== null);
  const chainFailures = chainFailuresRes.data ?? [];
  const appEvents = (appEventsRes.data ?? []).filter((e) => !isDuplicateOfChainFailure(e, chainFailures));
  const summaries = summarizeUsers(users, tripsRes.data ?? [], messagesRes.data ?? [], errorTripIds, appEvents);
  const signInProblems = summarizeSignInProblems(appEvents);
  const trackingStartedAt = appEvents.map((e) => e.created_at).sort()[0] ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-2xl font-semibold text-navy-900">Users</h1>
          <InternalNav current="/internal/users" />
        </div>
        <p className="mt-1 text-sm text-navy-400">
          Every signed-up account, most recently active first. Open one for the full timeline: chat, selections, errors and the current state of each trip.
        </p>
      </div>

      <section>
        <div className="overflow-x-auto rounded-lg border border-sand-200">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-sand-200 text-navy-400">
              <tr>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Last active</th>
                <th className="px-3 py-2 font-medium">Last sign-in</th>
                <th className="px-3 py-2 font-medium">Sign-ins</th>
                <th className="px-3 py-2 font-medium">Trips</th>
                <th className="px-3 py-2 font-medium">Messages sent</th>
                <th className="px-3 py-2 font-medium">Errors</th>
                <th className="px-3 py-2 font-medium">Signed up</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((u) => (
                <tr key={u.userId} className="border-b border-sand-100 last:border-0">
                  <td className="px-3 py-2">
                    <Link href={`/internal/users/${u.userId}`} className="text-teal-700 underline hover:text-teal-800">
                      {u.email ?? u.userId}
                    </Link>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-navy-700">{u.lastActiveAt ? formatTimestamp(u.lastActiveAt) : "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {u.lastSignInAt ? (
                      <span className="text-navy-700">{formatTimestamp(u.lastSignInAt)}</span>
                    ) : (
                      <span className="text-terracotta-600" title="A magic link was requested but never used to sign in">
                        never — link unused
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-navy-700">{u.signInCount}</td>
                  <td className="px-3 py-2 text-navy-700">
                    {u.tripCount}
                    {u.finalizedCount > 0 ? <span className="text-navy-400"> ({u.finalizedCount} finalized)</span> : null}
                  </td>
                  <td className="px-3 py-2 text-navy-700">{u.userMessageCount}</td>
                  <td className={`px-3 py-2 ${u.errorCount > 0 ? "font-medium text-terracotta-700" : "text-navy-700"}`}>{u.errorCount}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-navy-700">{formatTimestamp(u.createdAt)}</td>
                </tr>
              ))}
              {summaries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-navy-400">
                    No users yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-navy-400">
          Supabase creates the account when a magic link is first requested, so &ldquo;never — link unused&rdquo; means someone asked for a link and
          didn&apos;t complete sign-in. Sign-ins are counted from {trackingStartedAt ? formatTimestamp(trackingStartedAt) : "when migration 0021 is applied"}; earlier
          ones only show as the last sign-in.
          {appEventsRes.error ? <span className="text-terracotta-600"> app_events couldn&apos;t be read ({appEventsRes.error.message}), so sign-ins and action failures are missing.</span> : null}
        </p>
      </section>

      <SignInProblemsSection problems={signInProblems} />
    </div>
  );
}

function SignInProblemsSection({ problems }: { problems: ReturnType<typeof summarizeSignInProblems> }) {
  const empty = problems.callbackFailures.length + problems.linkFailures.length + problems.unusedLinks.length === 0;
  return (
    <section>
      <h2 className="text-sm font-semibold text-navy-900">Sign-in problems</h2>
      <p className="mt-1 text-xs text-navy-400">
        A failed sign-in link usually can&apos;t say who it was (a bad or expired code identifies nobody), so failures are listed by time. Match them
        against the unused link requests next to them.
      </p>
      {empty ? <p className="mt-2 text-sm text-navy-400">None recorded.</p> : null}
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {problems.unusedLinks.length > 0 ? (
          <ProblemList
            title="Link requested, no sign-in after it"
            rows={problems.unusedLinks.map((u) => ({
              at: u.lastRequestedAt,
              text: u.email,
              sub: u.requestCount > 1 ? `${u.requestCount} requests` : null,
            }))}
          />
        ) : null}
        {problems.callbackFailures.length > 0 ? (
          <ProblemList
            title="Sign-in link failed"
            rows={problems.callbackFailures.map((f) => ({
              at: f.at,
              text: CALLBACK_FAILURE_LABELS[f.reason as CallbackFailureReason] ?? f.reason,
              sub: f.detail,
            }))}
          />
        ) : null}
        {problems.linkFailures.length > 0 ? (
          <ProblemList
            title="Couldn't send a link"
            rows={problems.linkFailures.map((f) => ({ at: f.at, text: f.email ?? "unknown", sub: f.message }))}
          />
        ) : null}
      </div>
    </section>
  );
}

function ProblemList({ title, rows }: { title: string; rows: { at: string; text: string; sub: string | null }[] }) {
  return (
    <div className="rounded-lg border border-sand-200 px-4 py-3">
      <h3 className="text-xs font-medium text-navy-400">{title}</h3>
      <ul className="mt-2 flex flex-col gap-2 text-sm">
        {rows.slice(0, 20).map((r, i) => (
          <li key={i}>
            <div className="break-all text-navy-900">{r.text}</div>
            <div className="text-xs text-navy-400">
              {formatTimestamp(r.at)}
              {r.sub ? ` · ${r.sub}` : ""}
            </div>
          </li>
        ))}
      </ul>
      {rows.length > 20 ? <p className="mt-2 text-xs text-navy-400">+{rows.length - 20} older</p> : null}
    </div>
  );
}
