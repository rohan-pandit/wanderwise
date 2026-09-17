import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  ModelClientError,
  type ModelClient,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type ModelToolCall,
} from "../model-client";

/**
 * The only file that imports `@anthropic-ai/sdk` for agent calls — every
 * other agent-facing module goes through `ModelClient` (CLAUDE.md: keep
 * provider-specific code isolated). One non-looping `messages.create` call:
 * the tools this client is used with (`record_extraction`,
 * `request_clarification`, `propose_trip_revision` — src/agents/intake.ts)
 * are output-shaping, not real actions the model needs a tool_result back
 * from, so there's no agentic loop to drive here.
 *
 * Caching structure follows PROJECT_BRIEF.md §6.7: the system prompt and
 * tool definitions are static per agent and cached; the dynamic trip-state
 * slice and user message are passed in `messages` last, after the cache
 * breakpoint, so cache hits don't require them to match.
 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(model: string, client: Anthropic = new Anthropic()) {
    this.model = model;
    this.client = client;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        system: [
          {
            type: "text",
            text: request.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: request.tools.map((tool, index) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          // Cache breakpoint after the last (stable) tool definition.
          ...(index === request.tools.length - 1
            ? { cache_control: { type: "ephemeral" as const } }
            : {}),
        })),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (err) {
      throw new ModelClientError(`Anthropic request failed for model "${this.model}"`, err);
    }

    let text = "";
    const toolCalls: ModelToolCall[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({ toolName: block.name, input: block.input });
      }
    }

    return {
      text,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      model: response.model,
      stopReason: response.stop_reason ?? "unknown",
    };
  }
}
