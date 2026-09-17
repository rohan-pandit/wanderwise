import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { redactSensitiveTelemetry } from "@/src/observability/redaction";
import { unwrapOrThrow } from "./shared";

export type AgentRun = Database["public"]["Tables"]["agent_runs"]["Row"];
export type ToolCallRow = Database["public"]["Tables"]["tool_calls"]["Row"];

/** Per-agent-call telemetry (PROJECT_BRIEF.md §13.2/§6.7) — tokens, cache stats, latency, cost, all in one place so the engineering dashboard (§13.3) can compute cache hit rate and cost per session without joining across tables. */
export interface NewAgentRun {
  sessionId?: string | null;
  tripId?: string | null;
  workflowRunId?: string | null;
  agentName: string;
  model?: string | null;
  inputStateVersion?: number | null;
  outputStateVersion?: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  latencyMs: number;
  costUsd?: number | null;
  status: "success" | "error" | "guardrail_blocked";
  errorMessage?: string | null;
  correlationId?: string | null;
}

export async function recordAgentRun(
  supabase: SupabaseClient<Database>,
  run: NewAgentRun,
): Promise<AgentRun> {
  return unwrapOrThrow(
    supabase
      .from("agent_runs")
      .insert({
        session_id: run.sessionId ?? null,
        trip_id: run.tripId ?? null,
        workflow_run_id: run.workflowRunId ?? null,
        agent_name: run.agentName,
        model: run.model ?? null,
        input_state_version: run.inputStateVersion ?? null,
        output_state_version: run.outputStateVersion ?? null,
        input_tokens: run.usage.inputTokens,
        output_tokens: run.usage.outputTokens,
        cache_read_tokens: run.usage.cacheReadInputTokens,
        cache_write_tokens: run.usage.cacheCreationInputTokens,
        latency_ms: run.latencyMs,
        cost_usd: run.costUsd ?? null,
        status: run.status,
        error_message: run.errorMessage ?? null,
        correlation_id: run.correlationId ?? null,
      })
      .select()
      .single(),
  );
}

/**
 * One row per tool call the model made this turn (PROJECT_BRIEF.md §6.4:
 * "log tool call name, args, and result, not just raw text"). Persisted
 * `arguments`/`result` are redacted (§13.2, `redactSensitiveTelemetry`) —
 * applied here, the one write boundary every caller (intake-orchestrator,
 * activities-step) shares, so no call site can forget it.
 */
export interface NewToolCall {
  toolName: string;
  arguments: Json;
  result?: Json | null;
  durationMs?: number | null;
  status: "success" | "error";
}

export async function recordToolCalls(
  supabase: SupabaseClient<Database>,
  agentRunId: string,
  calls: NewToolCall[],
): Promise<ToolCallRow[]> {
  if (calls.length === 0) return [];
  return unwrapOrThrow(
    supabase
      .from("tool_calls")
      .insert(
        calls.map((call) => ({
          agent_run_id: agentRunId,
          tool_name: call.toolName,
          arguments: redactSensitiveTelemetry(call.arguments),
          result: call.result != null ? redactSensitiveTelemetry(call.result) : null,
          duration_ms: call.durationMs ?? null,
          status: call.status,
        })),
      )
      .select(),
  );
}
