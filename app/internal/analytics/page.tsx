/**
 * Engineering dashboard (PROJECT_BRIEF.md §13.3), Phase 8. Reads
 * `agent_runs`/`tool_calls`/`guardrail_events`/`workflow_steps`/`eval_runs`/
 * `eval_results` — every one of them internal/service-role-only (RLS
 * enabled with no policy for `anon`/`authenticated`, per
 * `supabase/migrations/0001_initial_schema.sql`), so this page uses
 * `createServiceClient`, not the RLS-scoped client `app/app/*` pages use.
 * Route-level access control is still real: `proxy.ts`'s deny-by-default
 * middleware already redirects any signed-out request away from
 * `/internal/analytics` before this ever renders, the same bar every other
 * `/app/*` route relies on (`app/app/layout.tsx`'s own docstring — no
 * second in-page auth check, for the same reason). Whether this needs a
 * *stricter* check than "any signed-in user" was `docs/IMPLEMENTATION_PLAN.md`
 * §22's open "Phase 8 decision" — resolved here as no: this is a
 * single-operator portfolio project with no multi-tenant admin concept
 * anywhere else in the app, so inventing one just for this page would be
 * unjustified complexity (CLAUDE.md: "don't design for hypothetical future
 * requirements").
 *
 * This project's data volume is small enough (a portfolio demo, not a
 * production system with real traffic) that fetching full row sets and
 * aggregating in the Server Component is simpler and more transparent than
 * writing SQL views/RPCs for each metric — revisit only if row counts ever
 * make that naive approach slow.
 */
import { createServiceClient } from "@/src/config/supabase/service";
import { formatMoney, money } from "@/src/domain/money";

const FAILURE_STATES = new Set(["failed_recoverable", "failed_terminal", "cancelled"]);

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

export default async function AnalyticsPage() {
  const supabase = createServiceClient();

  const [tripsRes, agentRunsRes, toolCallsRes, guardrailEventsRes, workflowStepsRes, evalResultsRes] = await Promise.all([
    supabase.from("trips").select("id, status"),
    supabase.from("agent_runs").select("agent_name, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, cost_usd, status, trip_id"),
    supabase.from("tool_calls").select("status"),
    supabase.from("guardrail_events").select("guardrail_name, layer, triggered"),
    supabase.from("workflow_steps").select("to_state"),
    supabase
      .from("eval_results")
      .select("test_case_name, passed, eval_run_id, eval_runs(run_label, created_at)")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const trips = tripsRes.data ?? [];
  const agentRuns = agentRunsRes.data ?? [];
  const toolCalls = toolCallsRes.data ?? [];
  const guardrailEvents = guardrailEventsRes.data ?? [];
  const workflowSteps = workflowStepsRes.data ?? [];
  const evalResultRows = evalResultsRes.data ?? [];

  // --- Workflow success rate ---
  const finalizedTrips = trips.filter((t) => t.status === "finalized").length;

  // --- Cost / latency / cache, overall and by agent ---
  const totalCostUsd = agentRuns.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const costByTrip = new Map<string, number>();
  for (const r of agentRuns) {
    if (!r.trip_id) continue;
    costByTrip.set(r.trip_id, (costByTrip.get(r.trip_id) ?? 0) + (r.cost_usd ?? 0));
  }
  const costPerFinalizedTrip = finalizedTrips > 0 ? totalCostUsd / finalizedTrips : null;

  const byAgent = new Map<
    string,
    { runs: number; errors: number; costUsd: number; latencyMsTotal: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  >();
  for (const r of agentRuns) {
    const entry = byAgent.get(r.agent_name) ?? { runs: 0, errors: 0, costUsd: 0, latencyMsTotal: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    entry.runs += 1;
    if (r.status === "error") entry.errors += 1;
    entry.costUsd += r.cost_usd ?? 0;
    entry.latencyMsTotal += r.latency_ms ?? 0;
    entry.inputTokens += r.input_tokens ?? 0;
    entry.outputTokens += r.output_tokens ?? 0;
    entry.cacheReadTokens += r.cache_read_tokens ?? 0;
    entry.cacheWriteTokens += r.cache_write_tokens ?? 0;
    byAgent.set(r.agent_name, entry);
  }

  const totalCacheReadTokens = agentRuns.reduce((sum, r) => sum + (r.cache_read_tokens ?? 0), 0);
  const totalCacheWriteTokens = agentRuns.reduce((sum, r) => sum + (r.cache_write_tokens ?? 0), 0);
  const totalInputTokens = agentRuns.reduce((sum, r) => sum + (r.input_tokens ?? 0), 0);
  const cacheHitRate = pct(totalCacheReadTokens, totalCacheReadTokens + totalInputTokens);
  // A cache read costs ~0.1x its model's input rate (src/observability/pricing.ts) — the
  // other ~0.9x is what a cache hit actually saved versus paying full input price for the
  // same tokens. Blended across models actually used, not a single hardcoded rate.
  const cacheSavingsUsd = agentRuns.reduce((sum, r) => {
    if (!r.cache_read_tokens) return sum;
    const pricePerMillion = r.model === "claude-haiku-4-5" ? 1 : 2; // matches PRICING_PER_MILLION in src/observability/pricing.ts
    return sum + (r.cache_read_tokens / 1_000_000) * pricePerMillion * 0.9;
  }, 0);

  // --- Tool error rate ---
  const toolErrorCount = toolCalls.filter((c) => c.status === "error").length;

  // --- Guardrails ---
  const guardrailByName = new Map<string, { triggered: number; total: number; layer: string }>();
  for (const g of guardrailEvents) {
    const entry = guardrailByName.get(g.guardrail_name) ?? { triggered: 0, total: 0, layer: g.layer };
    entry.total += 1;
    if (g.triggered) entry.triggered += 1;
    guardrailByName.set(g.guardrail_name, entry);
  }
  const guardrailRows = [...guardrailByName.entries()].sort((a, b) => b[1].triggered - a[1].triggered);

  // --- Failure rate by category (workflow_steps landing in a failure state) ---
  const failuresByState = new Map<string, number>();
  for (const s of workflowSteps) {
    if (s.to_state && FAILURE_STATES.has(s.to_state)) {
      failuresByState.set(s.to_state, (failuresByState.get(s.to_state) ?? 0) + 1);
    }
  }
  const totalFailures = [...failuresByState.values()].reduce((a, b) => a + b, 0);

  // --- Eval pass rate over time (most recent runs first) ---
  const runsById = new Map<string, { label: string; createdAt: string; passed: number; total: number }>();
  for (const row of evalResultRows) {
    const runMeta = row.eval_runs as unknown as { run_label: string | null; created_at: string } | null;
    const entry = runsById.get(row.eval_run_id) ?? { label: runMeta?.run_label ?? "eval run", createdAt: runMeta?.created_at ?? "", passed: 0, total: 0 };
    entry.total += 1;
    if (row.passed) entry.passed += 1;
    runsById.set(row.eval_run_id, entry);
  }
  const evalRuns = [...runsById.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 10);

  return (
    <div className="mx-auto flex max-w-5xl flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold text-black dark:text-zinc-50">Engineering dashboard</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          PROJECT_BRIEF.md §13.3 — workflow health, cost, latency, cache, and guardrail activity across every trip.
        </p>
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Trips finalized" value={pct(finalizedTrips, trips.length)} sub={`${finalizedTrips} / ${trips.length}`} />
        <StatCard label="Total agent cost" value={formatMoney(money(totalCostUsd))} sub={costPerFinalizedTrip !== null ? `${formatMoney(money(costPerFinalizedTrip))} / finalized trip` : "no finalized trips yet"} />
        <StatCard label="Cache hit rate" value={cacheHitRate} sub={`~${formatMoney(money(cacheSavingsUsd))} saved`} />
        <StatCard label="Tool error rate" value={pct(toolErrorCount, toolCalls.length)} sub={`${toolErrorCount} / ${toolCalls.length} calls`} />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Cost &amp; latency by agent</h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Runs</th>
                <th className="px-3 py-2 font-medium">Error rate</th>
                <th className="px-3 py-2 font-medium">Avg latency</th>
                <th className="px-3 py-2 font-medium">Total cost</th>
                <th className="px-3 py-2 font-medium">Cache read tokens</th>
              </tr>
            </thead>
            <tbody>
              {[...byAgent.entries()].map(([agentName, a]) => (
                <tr key={agentName} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-3 py-2 text-black dark:text-zinc-50">{agentName}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{a.runs}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{pct(a.errors, a.runs)}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{ms(a.latencyMsTotal / a.runs)}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{formatMoney(money(a.costUsd))}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{a.cacheReadTokens.toLocaleString()}</td>
                </tr>
              ))}
              {byAgent.size === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400">
                    No agent runs recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">Total cache-write tokens: {totalCacheWriteTokens.toLocaleString()}.</p>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Guardrail trigger frequency</h2>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">Which guardrail fires most tells you where the model struggles (PROJECT_BRIEF.md §13.3).</p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Guardrail</th>
                <th className="px-3 py-2 font-medium">Layer</th>
                <th className="px-3 py-2 font-medium">Triggered</th>
                <th className="px-3 py-2 font-medium">Trigger rate</th>
              </tr>
            </thead>
            <tbody>
              {guardrailRows.map(([name, g]) => (
                <tr key={name} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-3 py-2 text-black dark:text-zinc-50">{name}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{g.layer}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">
                    {g.triggered} / {g.total}
                  </td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{pct(g.triggered, g.total)}</td>
                </tr>
              ))}
              {guardrailRows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400">
                    No guardrail events recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Workflow failures by category</h2>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Count</th>
                <th className="px-3 py-2 font-medium">Share of transitions</th>
              </tr>
            </thead>
            <tbody>
              {[...failuresByState.entries()].map(([state, count]) => (
                <tr key={state} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-3 py-2 text-black dark:text-zinc-50">{state}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{count}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{pct(count, workflowSteps.length)}</td>
                </tr>
              ))}
              {totalFailures === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400">
                    No failure transitions recorded ({workflowSteps.length} total transitions).
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Eval pass rate over time</h2>
        <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">Most recent {evalRuns.length} run(s) (`npm run eval:scenarios` / `npm run eval:intake` / `npm run eval:retrieval`).</p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2 font-medium">Run</th>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {evalRuns.map((run, i) => (
                <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-3 py-2 text-black dark:text-zinc-50">{run.label}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">{run.createdAt ? new Date(run.createdAt).toLocaleString() : "—"}</td>
                  <td className="px-3 py-2 text-zinc-600 dark:text-zinc-300">
                    {run.passed} / {run.total} ({pct(run.passed, run.total)})
                  </td>
                </tr>
              ))}
              {evalRuns.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-zinc-500 dark:text-zinc-400">
                    No eval runs recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-black dark:text-zinc-50">{value}</div>
      <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">{sub}</div>
    </div>
  );
}
