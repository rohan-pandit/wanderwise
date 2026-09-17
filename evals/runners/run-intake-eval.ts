/**
 * Component eval runner for the Intake and Revision Interpreter agent.
 * Calls the real Anthropic API — this costs real money, run deliberately,
 * not from CI or on every save (PROJECT_BRIEF.md §22 defers CI evaluation
 * wiring to Phase 8). Exists specifically to inform the still-open Phase 4
 * model choice: run both candidate models over the same cases and compare
 * pass rate against cost (docs/IMPLEMENTATION_PLAN.md Phase 4, "model
 * selection").
 *
 * Usage: `npm run eval:intake` (all models in AVAILABLE_MODELS) or
 * `npm run eval:intake -- claude-sonnet-5` (one model only). Reads
 * `.env.local` via Node's built-in `--env-file` flag (wired in package.json)
 * rather than a `dotenv` dependency. Also passes `--conditions=react-server`
 * so the `server-only` guard in `anthropic-model-client.ts` (which otherwise
 * only resolves correctly under Next.js's own bundler) treats this script as
 * the trusted server-side context it is.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelClient } from "../../src/agents/providers/anthropic-model-client";
import { runIntakeAgent } from "../../src/agents/intake";
import { AVAILABLE_MODELS, type AvailableModel } from "../../src/config/models";
import { INTAKE_EVAL_CASES } from "../cases/intake";

// $/1M tokens (input, output) — see the `claude-api` skill's pricing table.
// Cache reads run ~0.1x the input rate, cache writes ~1.25x — PROJECT_BRIEF.md
// §6.7 requires cache read/write tokens to be measured, not assumed, so cost
// here is cache-aware rather than treating all input tokens as full price.
const PRICING_PER_MILLION: Record<AvailableModel, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

function estimateCostUsd(
  model: AvailableModel,
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number },
): number {
  const pricing = PRICING_PER_MILLION[model];
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000) * pricing.input * CACHE_READ_MULTIPLIER;
  const cacheWriteCost = (usage.cacheCreationInputTokens / 1_000_000) * pricing.input * CACHE_WRITE_MULTIPLIER;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

interface CaseOutcome {
  model: AvailableModel;
  caseName: string;
  pass: boolean;
  failedAssertions: string[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
}

async function runCaseForModel(model: AvailableModel, client: Anthropic): Promise<CaseOutcome[]> {
  const modelClient = new AnthropicModelClient(model, client);
  const outcomes: CaseOutcome[] = [];

  for (const evalCase of INTAKE_EVAL_CASES) {
    const start = Date.now();
    const result = await runIntakeAgent(modelClient, evalCase.input);
    const latencyMs = Date.now() - start;
    const assertions = evalCase.assert(result);
    const failedAssertions = assertions.filter((a) => !a.pass).map((a) => a.detail);

    outcomes.push({
      model,
      caseName: evalCase.name,
      pass: failedAssertions.length === 0,
      failedAssertions,
      latencyMs,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadInputTokens: result.usage.cacheReadInputTokens,
      cacheCreationInputTokens: result.usage.cacheCreationInputTokens,
      costUsd: estimateCostUsd(model, result.usage),
    });
  }

  return outcomes;
}

async function main() {
  const requestedModel = process.argv[2];
  const models: AvailableModel[] = requestedModel
    ? [requestedModel as AvailableModel]
    : [...AVAILABLE_MODELS];

  for (const m of models) {
    if (!(AVAILABLE_MODELS as readonly string[]).includes(m)) {
      console.error(`Unknown model "${m}". Available: ${AVAILABLE_MODELS.join(", ")}`);
      process.exit(1);
    }
  }

  const client = new Anthropic();
  const allOutcomes: CaseOutcome[] = [];

  for (const model of models) {
    console.log(`\nRunning ${INTAKE_EVAL_CASES.length} cases against ${model}...`);
    const outcomes = await runCaseForModel(model, client);
    allOutcomes.push(...outcomes);
    for (const o of outcomes) {
      const status = o.pass ? "PASS" : "FAIL";
      console.log(
        `  [${status}] ${o.caseName} (${o.latencyMs}ms, $${o.costUsd.toFixed(4)}, cache_read=${o.cacheReadInputTokens} cache_write=${o.cacheCreationInputTokens})`,
      );
      for (const detail of o.failedAssertions) {
        console.log(`         - ${detail}`);
      }
    }
  }

  console.log("\n--- Summary ---");
  for (const model of models) {
    const modelOutcomes = allOutcomes.filter((o) => o.model === model);
    const passed = modelOutcomes.filter((o) => o.pass).length;
    const totalCost = modelOutcomes.reduce((sum, o) => sum + o.costUsd, 0);
    const avgLatency = modelOutcomes.reduce((sum, o) => sum + o.latencyMs, 0) / modelOutcomes.length;
    const totalCacheRead = modelOutcomes.reduce((sum, o) => sum + o.cacheReadInputTokens, 0);
    console.log(
      `${model}: ${passed}/${modelOutcomes.length} passed, $${totalCost.toFixed(4)} total, ${avgLatency.toFixed(0)}ms avg latency, ${totalCacheRead} cache-read tokens (system prompt + tools reused after the first call)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
