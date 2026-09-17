/**
 * End-to-end scenario eval runner (PROJECT_BRIEF.md §9.6/§19; cases in
 * `evals/cases/scenarios.ts`). Drives the real stepwise chain against a
 * real Supabase trip and the real Anthropic/Voyage APIs — costs real money
 * and takes real wall-clock time (several full flight->hotel->activities
 * chains, each with an intake call plus a Curator and Itinerary Writer
 * call), so run deliberately, not from CI (PROJECT_BRIEF.md §22 defers CI
 * evaluation wiring to Phase 8; §9.6 itself recommends CI stick to
 * deterministic-only checks — see `npm run eval:ci` / the GitHub Actions
 * workflow instead).
 *
 * Persists one `eval_runs` row plus one `eval_results` row per scenario
 * (`src/repositories/eval-runs.ts`) so pass-rate trend over commits is a
 * real, queryable history (§9.8), not just this run's console output.
 *
 * Usage: `npm run eval:scenarios`. Reads `.env.local` via Node's
 * `--env-file` flag and needs `--conditions=react-server` for the same
 * `server-only` reason `run-intake-eval.ts` documents. Also needs
 * `SUPABASE_SERVICE_ROLE_KEY` to have `auth.admin` access (it already does
 * — that's the same key `createServiceClient` uses everywhere else).
 */
import type { Json } from "../../src/config/supabase/database.types";
import { createEvalRun, recordEvalResult } from "../../src/repositories/eval-runs";
import { createScenarioHarness } from "../lib/scenario-harness";
import { SCENARIO_CASES, type ScenarioAssertion } from "../cases/scenarios";

interface ScenarioOutcome {
  name: string;
  knownGap?: string;
  pass: boolean;
  assertions: ScenarioAssertion[];
  error?: string;
  durationMs: number;
}

async function main() {
  const harness = createScenarioHarness();
  const outcomes: ScenarioOutcome[] = [];

  try {
    for (const scenario of SCENARIO_CASES) {
      console.log(`\nRunning "${scenario.name}"...`);
      const start = Date.now();
      try {
        const assertions = await scenario.run(harness);
        const pass = assertions.every((a) => a.pass);
        outcomes.push({ name: scenario.name, knownGap: scenario.knownGap, pass, assertions, durationMs: Date.now() - start });
      } catch (err) {
        outcomes.push({
          name: scenario.name,
          knownGap: scenario.knownGap,
          pass: false,
          assertions: [],
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      }
    }
  } finally {
    await harness.cleanup();
  }

  for (const o of outcomes) {
    const status = o.pass ? "PASS" : o.knownGap ? "FAIL (known gap)" : "FAIL";
    console.log(`  [${status}] ${o.name} (${o.durationMs}ms)`);
    if (o.error) console.log(`         error: ${o.error}`);
    for (const a of o.assertions) {
      console.log(`         ${a.pass ? "✓" : "✗"} ${a.detail}`);
    }
    if (!o.pass && o.knownGap) console.log(`         known gap: ${o.knownGap}`);
  }

  const realFailures = outcomes.filter((o) => !o.pass && !o.knownGap);
  const knownGapFailures = outcomes.filter((o) => !o.pass && o.knownGap);
  console.log(
    `\n--- Summary --- ${outcomes.length - realFailures.length - knownGapFailures.length}/${outcomes.length} passed` +
      (knownGapFailures.length > 0 ? `, ${knownGapFailures.length} failing on already-tracked known gaps` : "") +
      (realFailures.length > 0 ? `, ${realFailures.length} REGRESSION(S)` : ""),
  );

  const supabase = harness.supabase;
  const run = await createEvalRun(supabase, "scenario-eval");
  for (const o of outcomes) {
    await recordEvalResult(supabase, {
      evalRunId: run.id,
      testCaseName: o.name,
      passed: o.pass,
      details: { assertions: o.assertions, error: o.error ?? null, knownGap: o.knownGap ?? null, durationMs: o.durationMs } as unknown as Json,
    });
  }
  console.log(`\nPersisted as eval_runs.id = ${run.id}`);

  if (realFailures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
