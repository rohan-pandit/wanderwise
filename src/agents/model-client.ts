/**
 * Provider-agnostic seam for calling a model (CLAUDE.md: "keep model calls
 * behind interfaces; keep provider-specific code isolated"). An agent
 * function takes a `ModelClient`, never an SDK client directly — this is
 * what lets `src/agents/intake.test.ts` cover the agent's parsing/validation
 * logic with a fake, no real API call, and what lets Phase 4's model-choice
 * question (Sonnet 5 vs. Haiku 4.5, decided by component evals rather than
 * up front) be a matter of constructing a different `ModelClient`, not a
 * different agent implementation.
 */

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

/** A tool definition in provider-neutral form — `inputSchema` is plain JSON Schema. */
export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One tool call the model made. `input` is raw and unvalidated — the caller validates it against its own Zod schema before trusting it (PROJECT_BRIEF.md §6.1: the model's output is never trusted directly). */
export interface ModelToolCall {
  toolName: string;
  input: unknown;
}

export interface ModelCompletionRequest {
  system: string;
  tools: ModelTool[];
  messages: ModelMessage[];
  maxTokens: number;
}

export interface ModelCompletionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ModelCompletionResult {
  /** Concatenated text content blocks, "" if the model only called tools. */
  text: string;
  toolCalls: ModelToolCall[];
  usage: ModelCompletionUsage;
  model: string;
  stopReason: string;
}

export interface ModelClient {
  readonly model: string;
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult>;
}

/**
 * One entry per physical tool call a model made — the full audit trail an
 * orchestrator persists as `tool_calls` rows (PROJECT_BRIEF.md §6.4: "log
 * tool call name, args, and result, not just raw text") and uses to detect
 * Layer 2 guardrail triggers (§9.1: malformed/invalid tool output). Shared
 * across every agent that validates its own tool calls against a Zod schema
 * (originally introduced for the Intake agent, Phase 4; reused by the
 * Curator/Explanation agents, Phase 5) rather than each agent defining its
 * own copy of the same shape.
 */
export interface ToolCallLogEntry {
  toolName: string;
  input: unknown;
  status: "success" | "error";
  /** The validated/parsed output for a successful call. */
  result?: unknown;
  error?: string;
}

/** What a `ModelClient` implementation throws on failure — keeps provider-specific exception types (e.g. `Anthropic.APIError`) from leaking through the abstraction. The original error is preserved as `cause`. */
export class ModelClientError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ModelClientError";
  }
}
