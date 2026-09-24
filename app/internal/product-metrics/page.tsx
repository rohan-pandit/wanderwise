/**
 * Product metrics view (PROJECT_BRIEF.md §13.4), Phase 8 — deliberately a
 * separate page from `/internal/analytics` (the engineering dashboard),
 * per §13.4's own rule: "keep product outcomes separate from engineering
 * metrics — do not interpret a high number of agent calls as product
 * success." Sharing a page would make that boundary a caption, not a fact.
 *
 * Reads `trips`/`trip_state_versions`/`trip_requirements`/`trip_decisions`
 * via the service-role client — same reasoning as `/internal/analytics`
 * for `trips` (it's RLS-scoped to the *querying* user; an aggregate product
 * view needs every user's trips) and for the others (RLS-locked-out
 * internal tables). Route access is `proxy.ts`'s deny-by-default
 * middleware, plus (as of docs/DEPLOYMENT.md) the same `INTERNAL_ACCESS_EMAIL`
 * allowlist check `/internal/analytics` uses — see that page's docstring for
 * the full history of that decision.
 *
 * Qualitative feedback (beta feedback, `app/app/_components/feedback-dialog.tsx`,
 * sent from any /app page via the header's beta callouts) is read here too,
 * joined — for reports sent from inside a trip — with a lightweight
 * trip-context reconstruction: the
 * requirements the user entered and the full chat transcript, exactly the
 * same `messages`/`trip_requirements` tables the rest of this app already
 * writes to, not a separate copy captured at report time (see
 * `feedback.ts`'s docstring for why not).
 */
import { connection } from "next/server";
import { createServiceClient } from "@/src/config/supabase/service";
import { selectAllRows } from "@/src/repositories/shared";
import { checkRequirementsComplete } from "@/src/domain/extraction";
import type { RequirementRecord, RequirementFieldName } from "@/src/domain/extraction";
import { getCurrentChainStep, type ChainDecision } from "@/src/domain/chain";
import type { WorkflowState } from "@/src/workflow/state-machine";
import { FeedbackList, type FeedbackEntryView } from "./feedback-list";

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/** A one-line "what the user entered" summary for a feedback report's trip context — reads whatever's present rather than requiring completeness, since a report can happen mid-intake before every field is filled in. */
function summarizeRequirements(rows: { field: string; value: unknown }[]): string | null {
  const byField = new Map(rows.map((r) => [r.field, r.value]));
  const destination = byField.get("destination");
  const origin = byField.get("origin");
  const departureDate = byField.get("departureDate");
  const returnDate = byField.get("returnDate");
  const partySize = byField.get("partySize");
  const budget = byField.get("budgetTotalUsd");

  const parts = [
    destination ? String(destination) : null,
    origin ? `from ${origin}` : null,
    departureDate && returnDate ? `${departureDate} → ${returnDate}` : null,
    typeof partySize === "number" ? `${partySize} traveler${partySize === 1 ? "" : "s"}` : null,
    typeof budget === "number" ? `$${budget.toLocaleString()} budget` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : null;
}

const STAGE_LABELS: Record<WorkflowState, string> = {
  created: "Just started",
  collecting_requirements: "Collecting requirements",
  awaiting_clarification: "Awaiting clarification",
  requirements_ready: "Requirements ready (chain not complete)",
  searching_inventory: "Searching inventory (legacy one-shot state)",
  validating_candidates: "Validating candidates (legacy one-shot state)",
  assembling_options: "Assembling options (legacy one-shot state)",
  validating_itinerary: "Validating itinerary (legacy one-shot state)",
  presenting_draft: "Draft presented, not yet confirmed",
  awaiting_confirmation: "Awaiting confirmation",
  awaiting_user_revision: "Awaiting user revision",
  applying_revision: "Applying revision",
  stale: "Stale (inventory changed)",
  finalized: "Finalized",
  cancelled: "Cancelled",
  failed_recoverable: "Failed (recoverable)",
  failed_terminal: "Failed (terminal)",
};

export default async function ProductMetricsPage() {
  // Nothing here reads `cookies()`/`headers()`, so without this Next
  // prerendered the whole page at *build* time — production showed a
  // snapshot from the last deploy, and new beta feedback never appeared
  // until the next one (found 2026-09-24: `next build` listed this route as
  // `○ (Static)`). Render per request instead.
  await connection();
  const supabase = createServiceClient();

  // Every whole-table read pages through `selectAllRows`: PostgREST silently
  // truncates a plain select at 1000 rows, which had already cut
  // `trip_decisions` (2119 rows) roughly in half — a 1200% "confirmation
  // rate" (12 finalized / 1 drafted) was the visible symptom. `id` is the
  // final order-by tiebreaker so pages never overlap or skip rows.
  const [tripsRes, stateVersionsRes, requirementsRes, decisionsRes, feedbackRes] = await Promise.all([
    selectAllRows((from, to) => supabase.from("trips").select("id, name, session_id, status, created_at").order("id").range(from, to)),
    selectAllRows((from, to) =>
      supabase.from("trip_state_versions").select("trip_id, version, state, created_at").order("version", { ascending: true }).order("id").range(from, to),
    ),
    selectAllRows((from, to) => supabase.from("trip_requirements").select("trip_id, field, status").order("id").range(from, to)),
    selectAllRows((from, to) => supabase.from("trip_decisions").select("trip_id, field, status").order("id").range(from, to)),
    // Not `listAllFeedback`-style `unwrapOrThrow` — every query here degrades
    // to `?? []` instead, so a briefly unreachable Supabase costs one empty
    // section rather than the whole page.
    selectAllRows((from, to) => supabase.from("feedback").select("*").order("created_at", { ascending: false }).order("id").range(from, to)),
  ]);

  const trips = tripsRes.data ?? [];
  const stateVersions = stateVersionsRes.data ?? [];
  const requirementRows = requirementsRes.data ?? [];
  const decisionRows = decisionsRes.data ?? [];
  const feedbackRows = feedbackRes.data ?? [];

  const totalTrips = trips.length;
  const totalSessions = new Set(trips.map((t) => t.session_id)).size;

  // --- Requirement completion, using the same deterministic check the real intake flow uses ---
  const requirementsByTrip = new Map<string, { field: RequirementFieldName; status: RequirementRecord["status"] }[]>();
  for (const r of requirementRows) {
    const list = requirementsByTrip.get(r.trip_id) ?? [];
    list.push({ field: r.field as RequirementFieldName, status: r.status as RequirementRecord["status"] });
    requirementsByTrip.set(r.trip_id, list);
  }
  const tripsWithCompleteRequirements = trips.filter((t) => {
    const records = (requirementsByTrip.get(t.id) ?? []) as RequirementRecord[];
    return checkRequirementsComplete(records).ready;
  }).length;

  // --- Decisions per trip: draft generation, revision, finalization signals ---
  const decisionsByTrip = new Map<string, { field: string; status: string }[]>();
  for (const d of decisionRows) {
    const list = decisionsByTrip.get(d.trip_id) ?? [];
    list.push({ field: d.field, status: d.status });
    decisionsByTrip.set(d.trip_id, list);
  }
  const tripsWithDraft = trips.filter((t) => (decisionsByTrip.get(t.id) ?? []).some((d) => d.field === "itineraryText" && d.status === "confirmed")).length;
  const tripsWithAnyRevision = trips.filter((t) => (decisionsByTrip.get(t.id) ?? []).some((d) => d.status === "superseded")).length;
  const finalizedTrips = trips.filter((t) => t.status === "finalized").length;

  // --- State-version timing: time to first draft, time to finalized, current stage per trip ---
  const versionsByTrip = new Map<string, { workflowState: WorkflowState; createdAt: string }[]>();
  for (const v of stateVersions) {
    const state = v.state as { workflowState: WorkflowState };
    const list = versionsByTrip.get(v.trip_id) ?? [];
    list.push({ workflowState: state.workflowState, createdAt: v.created_at });
    versionsByTrip.set(v.trip_id, list);
  }

  const timesToFirstDraftMs: number[] = [];
  const timesToFinalizedMs: number[] = [];
  const currentStageByTrip = new Map<string, WorkflowState>();
  for (const [tripId, versions] of versionsByTrip) {
    const genesis = versions[0];
    if (!genesis) continue;
    const genesisMs = new Date(genesis.createdAt).getTime();
    const firstDraft = versions.find((v) => v.workflowState === "presenting_draft");
    if (firstDraft) timesToFirstDraftMs.push(new Date(firstDraft.createdAt).getTime() - genesisMs);
    const finalized = versions.find((v) => v.workflowState === "finalized");
    if (finalized) timesToFinalizedMs.push(new Date(finalized.createdAt).getTime() - genesisMs);
    currentStageByTrip.set(tripId, versions[versions.length - 1].workflowState);
  }
  const avg = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const avgTimeToFirstDraft = avg(timesToFirstDraftMs);
  const avgTimeToFinalized = avg(timesToFinalizedMs);

  // --- Abandonment stage: for non-finalized trips, where did they stop? Prefer the chain step (more granular than raw workflowState once the stepwise chain is active) over the raw state, falling back to the raw state for trips that never got requirements-ready. ---
  const abandonedTrips = trips.filter((t) => t.status !== "finalized");
  const abandonmentCounts = new Map<string, number>();
  for (const t of abandonedTrips) {
    const decisions = (decisionsByTrip.get(t.id) ?? []) as ChainDecision[];
    const chainStep = getCurrentChainStep(decisions);
    const rawState = currentStageByTrip.get(t.id) ?? "created";
    const label = rawState === "requirements_ready" || rawState === "created" || rawState === "collecting_requirements" || rawState === "awaiting_clarification"
      ? STAGE_LABELS[rawState]
      : chainStep !== "complete"
        ? `Chain step: ${chainStep}`
        : STAGE_LABELS[rawState];
    abandonmentCounts.set(label, (abandonmentCounts.get(label) ?? 0) + 1);
  }
  const abandonmentRows = [...abandonmentCounts.entries()].sort((a, b) => b[1] - a[1]);

  // --- Qualitative feedback: join each report back to the trip data the
  // user entered and the agent's own responses, rather than duplicating
  // either — `feedback.ts`'s own docstring explains why not. ---
  const tripsById = new Map(trips.map((t) => [t.id, t]));
  const feedbackTripIds = [...new Set(feedbackRows.map((f) => f.trip_id).filter((id): id is string => id !== null))];
  const feedbackSessionIds = [
    ...new Set(
      feedbackTripIds
        .map((id) => tripsById.get(id)?.session_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const [feedbackRequirementsRes, feedbackMessagesRes] = await Promise.all([
    feedbackTripIds.length > 0
      ? selectAllRows((from, to) =>
          supabase.from("trip_requirements").select("trip_id, field, value").in("trip_id", feedbackTripIds).neq("status", "retracted").order("id").range(from, to),
        )
      : Promise.resolve({ data: [] as { trip_id: string; field: string; value: unknown }[] }),
    feedbackSessionIds.length > 0
      ? selectAllRows((from, to) =>
          supabase.from("messages").select("session_id, role, content").in("session_id", feedbackSessionIds).order("created_at", { ascending: true }).order("id").range(from, to),
        )
      : Promise.resolve({ data: [] as { session_id: string; role: string; content: string }[] }),
  ]);

  const requirementsByTripForFeedback = new Map<string, { field: string; value: unknown }[]>();
  for (const r of feedbackRequirementsRes.data ?? []) {
    const list = requirementsByTripForFeedback.get(r.trip_id) ?? [];
    list.push({ field: r.field, value: r.value });
    requirementsByTripForFeedback.set(r.trip_id, list);
  }

  const messagesBySession = new Map<string, { role: string; content: string }[]>();
  for (const m of feedbackMessagesRes.data ?? []) {
    const list = messagesBySession.get(m.session_id) ?? [];
    list.push({ role: m.role, content: m.content });
    messagesBySession.set(m.session_id, list);
  }

  const feedbackEntries: FeedbackEntryView[] = feedbackRows.map((f) => {
    const trip = f.trip_id ? tripsById.get(f.trip_id) : undefined;
    return {
      id: f.id,
      kind: f.kind,
      categories: f.categories,
      message: f.message,
      context: f.context,
      route: f.route,
      createdAt: f.created_at,
      hasTrip: f.trip_id !== null,
      tripName: trip?.name ?? null,
      requirementsSummary: f.trip_id ? summarizeRequirements(requirementsByTripForFeedback.get(f.trip_id) ?? []) : null,
      messages: trip?.session_id ? (messagesBySession.get(trip.session_id) ?? []) : [],
    };
  });
  const weekAgoMs = new Date().getTime() - 7 * 24 * 60 * 60 * 1000;
  const feedbackThisWeekCount = feedbackEntries.filter((e) => new Date(e.createdAt).getTime() >= weekAgoMs).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <div className="flex items-center justify-between">
          <h1 className="font-serif text-2xl font-semibold text-navy-900">Product metrics</h1>
          <a href="/internal/analytics" className="text-sm text-teal-700 underline hover:text-teal-800">
            ← Engineering dashboard
          </a>
        </div>
        <p className="mt-1 text-sm text-navy-400">
          PROJECT_BRIEF.md §13.4 — product outcomes, kept separate from the engineering dashboard so a high agent-call count is never mistaken for product success.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Trip-start rate" value={pct(totalTrips, totalSessions)} sub={`${totalTrips} trips / ${totalSessions} sessions`} />
        <StatCard label="Requirement completion" value={pct(tripsWithCompleteRequirements, totalTrips)} sub={`${tripsWithCompleteRequirements} / ${totalTrips} trips`} />
        <StatCard label="Draft-generation rate" value={pct(tripsWithDraft, totalTrips)} sub={`${tripsWithDraft} / ${totalTrips} trips`} />
        <StatCard label="Confirmation rate" value={pct(finalizedTrips, tripsWithDraft)} sub={`${finalizedTrips} finalized / ${tripsWithDraft} drafted`} />
      </section>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Revision rate" value={pct(tripsWithAnyRevision, totalTrips)} sub={`${tripsWithAnyRevision} / ${totalTrips} trips had a decision revised`} />
        <StatCard label="Time to first draft" value={avgTimeToFirstDraft !== null ? duration(avgTimeToFirstDraft) : "—"} sub={`avg over ${timesToFirstDraftMs.length} trip(s)`} />
        <StatCard label="Time to finalized" value={avgTimeToFinalized !== null ? duration(avgTimeToFinalized) : "—"} sub={`avg over ${timesToFinalizedMs.length} trip(s)`} />
        <StatCard label="Overall completion" value={pct(finalizedTrips, totalTrips)} sub={`${finalizedTrips} / ${totalTrips} trips ever finalized`} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-navy-900">Abandonment stage</h2>
        <p className="mt-1 text-xs text-navy-400">Where non-finalized trips currently sit.</p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-sand-200">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-sand-200 text-navy-400">
              <tr>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Trips</th>
                <th className="px-3 py-2 font-medium">Share of non-finalized</th>
              </tr>
            </thead>
            <tbody>
              {abandonmentRows.map(([label, count]) => (
                <tr key={label} className="border-b border-sand-100 last:border-0">
                  <td className="px-3 py-2 text-navy-900">{label}</td>
                  <td className="px-3 py-2 text-navy-700">{count}</td>
                  <td className="px-3 py-2 text-navy-700">{pct(count, abandonedTrips.length)}</td>
                </tr>
              ))}
              {abandonedTrips.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-navy-400">
                    Every trip either just started or is finalized.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-navy-900">Qualitative feedback</h2>
        <p className="mt-1 text-xs text-navy-400">Beta feedback — bugs, ideas, and everything else — newest first. Reports sent from inside a trip expand to that trip&apos;s own requirements and full chat transcript.</p>
        {feedbackEntries.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-sand-300 px-4 py-3 text-sm text-navy-400">
            No feedback yet — nothing submitted through the header&apos;s Beta badge, banner, or Feedback link so far.
          </p>
        ) : (
          <FeedbackList entries={feedbackEntries} thisWeekCount={feedbackThisWeekCount} />
        )}
      </section>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-sand-200 px-4 py-3">
      <div className="text-xs text-navy-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-navy-900">{value}</div>
      <div className="mt-0.5 text-xs text-navy-400">{sub}</div>
    </div>
  );
}
