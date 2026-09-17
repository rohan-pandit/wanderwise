/**
 * Per-agent model selection (ADR-INDEX Area 1 "Model selection", resolved
 * 2026-09-16: keep the model-client interface provider/model-agnostic —
 * `ModelClient` (src/agents/model-client.ts) — and wire Sonnet 5 as the
 * working default, with Haiku 4.5 measured as a cheaper alternative through
 * the Phase 4 component evals (`evals/runners/run-intake-eval.ts`) before
 * anything is locked in. An env var override lets the eval runner (and any
 * future caller) compare models without touching this file.
 */
export const AVAILABLE_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"] as const;
export type AvailableModel = (typeof AVAILABLE_MODELS)[number];

function resolveModel(envVar: string, fallback: AvailableModel): AvailableModel {
  const value = process.env[envVar];
  if (value && (AVAILABLE_MODELS as readonly string[]).includes(value)) {
    return value as AvailableModel;
  }
  return fallback;
}

export const AGENT_MODELS = {
  intake: resolveModel("INTAKE_AGENT_MODEL", "claude-sonnet-5"),
  curator: resolveModel("CURATOR_AGENT_MODEL", "claude-sonnet-5"),
} as const;
