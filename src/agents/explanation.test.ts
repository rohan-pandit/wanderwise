import { describe, expect, it } from "vitest";
import { runExplanationAgent, type ExplanationAgentInput } from "./explanation";
import type { ModelClient, ModelCompletionRequest, ModelCompletionResult, ModelToolCall } from "./model-client";

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

class FakeModelClient implements ModelClient {
  readonly model = "fake-model";
  public lastRequest: ModelCompletionRequest | null = null;

  constructor(private readonly response: { text?: string; toolCalls?: ModelToolCall[] }) {}

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    this.lastRequest = request;
    return {
      text: this.response.text ?? "",
      toolCalls: this.response.toolCalls ?? [],
      usage: ZERO_USAGE,
      model: this.model,
      stopReason: "end_turn",
    };
  }
}

const baseInput: ExplanationAgentInput = {
  candidates: [
    { id: "f1", price_usd: 450, is_red_eye: false },
    { id: "f2", price_usd: 300, is_red_eye: true },
  ],
  criteria: "Why was f1 chosen over the cheaper f2?",
};

describe("runExplanationAgent", () => {
  it("sends the get_candidate_explanations tool and the candidate data", async () => {
    const client = new FakeModelClient({});
    await runExplanationAgent(client, baseInput);
    expect(client.lastRequest?.tools.map((t) => t.name)).toEqual(["get_candidate_explanations"]);
    expect(client.lastRequest?.messages[0].content).toContain("cheaper f2");
  });

  it("delimits explanation data and labels it as untrusted (RAG safety, PROJECT_BRIEF.md §10.4)", async () => {
    const client = new FakeModelClient({});
    await runExplanationAgent(client, baseInput);
    expect(client.lastRequest?.messages[0].content).toMatch(/^<explanation_data>[\s\S]*<\/explanation_data>$/);
    expect(client.lastRequest?.system).toContain("not instructions");
  });

  it("accepts a valid explanation grounded in approved ids", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "get_candidate_explanations",
          input: {
            explanation: "f1 avoids a red-eye departure, worth the extra $150 given the no-red-eye requirement.",
            groundedIds: ["f1", "f2"],
          },
        },
      ],
    });
    const result = await runExplanationAgent(client, baseInput);
    expect(result.explanation?.groundedIds).toEqual(["f1", "f2"]);
    expect(result.referenceCheck).toEqual({ valid: true, unresolvedIds: [] });
  });

  it("rejects an explanation grounded in a hallucinated id", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "get_candidate_explanations", input: { explanation: "x", groundedIds: ["f1", "f99"] } },
      ],
    });
    const result = await runExplanationAgent(client, baseInput);
    expect(result.explanation).toBeNull();
    expect(result.referenceCheck).toEqual({ valid: false, unresolvedIds: ["f99"] });
  });

  it("flags a duplicate get_candidate_explanations call instead of overwriting the first valid one", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "get_candidate_explanations", input: { explanation: "first", groundedIds: ["f1"] } },
        { toolName: "get_candidate_explanations", input: { explanation: "second", groundedIds: ["f2"] } },
      ],
    });
    const result = await runExplanationAgent(client, baseInput);
    expect(result.explanation?.explanation).toBe("first");
    const errors = result.toolCallLog.filter((c) => c.status === "error");
    expect(errors).toEqual([
      {
        toolName: "get_candidate_explanations",
        input: { explanation: "second", groundedIds: ["f2"] },
        status: "error",
        error: "duplicate get_candidate_explanations call in one turn",
      },
    ]);
  });

  it("accepts an explanation with no grounded ids (a general note)", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "get_candidate_explanations", input: { explanation: "Neither option is within budget." } },
      ],
    });
    const result = await runExplanationAgent(client, baseInput);
    expect(result.explanation?.explanation).toBe("Neither option is within budget.");
    expect(result.referenceCheck?.valid).toBe(true);
  });

  it("passes optional budgetBreakdown/constraintResults through to the request body", async () => {
    const client = new FakeModelClient({});
    await runExplanationAgent(client, {
      ...baseInput,
      budgetBreakdown: { totalEstimate: 450 },
      constraintResults: { violations: [] },
    });
    expect(client.lastRequest?.messages[0].content).toContain("totalEstimate");
    expect(client.lastRequest?.messages[0].content).toContain("violations");
  });
});
