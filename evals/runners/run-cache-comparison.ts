/**
 * Cache-hit / cost comparison (PROJECT_BRIEF.md §6.7: "prompt caching is an
 * experiment, not an assumption" — measure it, don't assume it). Runs the
 * same sequence of real Intake-agent calls (`evals/cases/intake.ts`'s
 * `INTAKE_EVAL_CASES` — the Intake agent's system prompt + tool defs never
 * change across a session, only the dynamic trip-state slice and user
 * message in `messages`, which is exactly the shape prompt caching is
 * built for) twice against the real Anthropic API: once with caching on
 * (the real, always-on production behavior), once with it forced off via
 * `AnthropicModelClient`'s `cachingEnabled` flag (which exists solely for
 * this comparison — every real call site leaves it at its default `true`).
 * Same model, same inputs, same call order — the only variable is the
 * `cache_control` breakpoints, so the delta is attributable to caching
 * alone rather than run-to-run variance.
 *
 * Calls the real Anthropic API twice over — costs real money, run
 * deliberately, not from CI (same reasoning as every other real-model
 * runner in this directory).
 *
 * Usage: `npm run eval:cache-comparison` (defaults to `claude-sonnet-5`) or
 * `npm run eval:cache-comparison -- claude-haiku-4-5`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelClient } from "../../src/agents/providers/anthropic-model-client";
import { runIntakeAgent } from "../../src/agents/intake";
import { AVAILABLE_MODELS, type AvailableModel } from "../../src/config/models";
import { estimateCostUsd } from "../../src/observability/pricing";
import { INTAKE_EVAL_CASES } from "../cases/intake";

interface CallResult {
  caseName: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

async function runSequence(model: AvailableModel, client: Anthropic, cachingEnabled: boolean): Promise<CallResult[]> {
  const modelClient = new AnthropicModelClient(model, client, cachingEnabled);
  const results: CallResult[] = [];
  for (const evalCase of INTAKE_EVAL_CASES) {
    const start = Date.now();
    const result = await runIntakeAgent(modelClient, evalCase.input);
    results.push({
      caseName: evalCase.name,
      latencyMs: Date.now() - start,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      costUsd: estimateCostUsd(model, result.usage) ?? 0,
    });
  }
  return results;
}

function summarize(label: string, results: CallResult[]) {
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const totalLatency = results.reduce((s, r) => s + r.latencyMs, 0);
  const totalCacheRead = results.reduce((s, r) => s + r.cacheReadInputTokens, 0);
  const totalCacheWrite = results.reduce((s, r) => s + r.cacheCreationInputTokens, 0);
  console.log(`\n--- ${label} ---`);
  for (const r of results) {
    console.log(`  ${r.caseName}: ${r.latencyMs}ms, $${r.costUsd.toFixed(5)}, cache_read=${r.cacheReadInputTokens} cache_write=${r.cacheCreationInputTokens}`);
  }
  console.log(`  TOTAL: $${totalCost.toFixed(5)}, ${totalLatency}ms, cache_read=${totalCacheRead}, cache_write=${totalCacheWrite}`);
  return { totalCost, totalLatency, totalCacheRead, totalCacheWrite };
}

async function main() {
  const requestedModel = process.argv[2] as AvailableModel | undefined;
  const model: AvailableModel = requestedModel && (AVAILABLE_MODELS as readonly string[]).includes(requestedModel) ? requestedModel : "claude-sonnet-5";

  console.log(`Running ${INTAKE_EVAL_CASES.length} real Intake-agent calls twice against ${model}: once with caching on, once forced off.`);

  const client = new Anthropic();
  // Caching off first — a fresh client/run has nothing to hit anyway, and
  // running it first means the "on" run's warm cache can't leak into it.
  const off = await runSequence(model, client, false);
  const on = await runSequence(model, client, true);

  const offSummary = summarize("Caching OFF (baseline)", off);
  const onSummary = summarize("Caching ON", on);

  const costSavingsUsd = offSummary.totalCost - onSummary.totalCost;
  const costSavingsPct = offSummary.totalCost > 0 ? (costSavingsUsd / offSummary.totalCost) * 100 : 0;
  const latencySavingsMs = offSummary.totalLatency - onSummary.totalLatency;

  console.log("\n--- Summary ---");
  console.log(`Cost:    OFF $${offSummary.totalCost.toFixed(5)} -> ON $${onSummary.totalCost.toFixed(5)} (saved $${costSavingsUsd.toFixed(5)}, ${costSavingsPct.toFixed(1)}%)`);
  console.log(`Latency: OFF ${offSummary.totalLatency}ms -> ON ${onSummary.totalLatency}ms (${latencySavingsMs >= 0 ? "saved" : "cost"} ${Math.abs(latencySavingsMs)}ms)`);
  console.log(`Cache reads: OFF ${offSummary.totalCacheRead} tokens (expected 0 — caching forced off) -> ON ${onSummary.totalCacheRead} tokens`);
  console.log(`Cache writes: OFF ${offSummary.totalCacheWrite} tokens (expected 0) -> ON ${onSummary.totalCacheWrite} tokens (the first ON call's cache-miss write; every call after it should read, not rewrite)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
