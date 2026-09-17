/**
 * Cost estimation from token usage (PROJECT_BRIEF.md §6.7/§13.2: cache read/
 * write tokens must be measured, not assumed, so cost is cache-aware rather
 * than treating all input tokens as full price). Shared by every real
 * caller that persists an `agent_runs.cost_usd` value
 * (`intake-orchestrator.ts`, `activities-step.ts`) and by
 * `evals/runners/run-intake-eval.ts`'s model-comparison cost reporting —
 * originally lived only in that eval runner, generalized here once the
 * engineering dashboard (§13.3 "cost per session"/"cost per agent") needed
 * real, persisted cost data rather than every caller re-deriving its own
 * copy of the same pricing table.
 *
 * $/1M tokens — see the `claude-api` skill's pricing table.
 */
import type { AvailableModel } from "@/src/config/models";

const PRICING_PER_MILLION: Record<AvailableModel, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Best-effort: `model` is a plain `string` at every real call site
 * (`ModelClient.model`), not the narrower `AvailableModel` the pricing
 * table is keyed by — a model added to `AGENT_MODELS` without a matching
 * pricing entry shouldn't fail an agent turn just because cost telemetry
 * couldn't be computed, so this logs and returns `null` (persisted as
 * `agent_runs.cost_usd = null`, distinct from a real $0) rather than
 * throwing.
 */
export function estimateCostUsd(model: string, usage: TokenUsage): number | null {
  const pricing = PRICING_PER_MILLION[model as AvailableModel];
  if (!pricing) {
    console.error(`estimateCostUsd: no pricing entry for model "${model}" — cost_usd will be recorded as null.`);
    return null;
  }
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000) * pricing.input * CACHE_READ_MULTIPLIER;
  const cacheWriteCost = (usage.cacheCreationInputTokens / 1_000_000) * pricing.input * CACHE_WRITE_MULTIPLIER;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}
