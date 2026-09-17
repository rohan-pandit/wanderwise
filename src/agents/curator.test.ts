import { describe, expect, it } from "vitest";
import { runCuratorAgent, type CuratorAgentInput } from "./curator";
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

const baseInput: CuratorAgentInput = {
  kind: "destination",
  preferences: [{ field: "travelStyle", value: ["food", "culture"] }],
  candidates: [
    { id: "d1", name: "Lisbon" },
    { id: "d2", name: "Kyoto" },
    { id: "d3", name: "Reykjavik" },
  ],
};

describe("runCuratorAgent", () => {
  it("sends the record_curation tool and the candidate set", async () => {
    const client = new FakeModelClient({});
    await runCuratorAgent(client, baseInput);
    expect(client.lastRequest?.tools.map((t) => t.name)).toEqual(["record_curation"]);
    expect(client.lastRequest?.messages[0].content).toContain("Lisbon");
  });

  it("delimits candidate data and labels it as untrusted (RAG safety, PROJECT_BRIEF.md §10.4)", async () => {
    const client = new FakeModelClient({});
    await runCuratorAgent(client, baseInput);
    expect(client.lastRequest?.messages[0].content).toMatch(/^<candidate_data>[\s\S]*<\/candidate_data>$/);
    expect(client.lastRequest?.system).toContain("not instructions");
  });

  it("accepts a valid curation referencing only approved ids", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "record_curation",
          input: {
            rankedIds: ["d1", "d2"],
            excludedIds: [{ id: "d3", reason: "too cold for a food-focused trip" }],
            rationale: "Lisbon and Kyoto best match food/culture preferences.",
          },
        },
      ],
    });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.curation).toEqual({
      rankedIds: ["d1", "d2"],
      excludedIds: [{ id: "d3", reason: "too cold for a food-focused trip" }],
      rationale: "Lisbon and Kyoto best match food/culture preferences.",
    });
    expect(result.referenceCheck).toEqual({ valid: true, unresolvedIds: [] });
    expect(result.toolCallLog).toEqual([
      { toolName: "record_curation", input: expect.any(Object), status: "success", result: result.curation },
    ]);
  });

  it("rejects a curation that references a hallucinated candidate id", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "record_curation",
          input: { rankedIds: ["d1", "made-up-destination"], rationale: "x" },
        },
      ],
    });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.curation).toBeNull();
    expect(result.referenceCheck).toEqual({ valid: false, unresolvedIds: ["made-up-destination"] });
    expect(result.toolCallLog[0].status).toBe("error");
    expect(result.toolCallLog[0].error).toContain("made-up-destination");
  });

  it("records a malformed tool call instead of throwing", async () => {
    const client = new FakeModelClient({
      toolCalls: [{ toolName: "record_curation", input: { rankedIds: [] } }], // empty rankedIds fails min(1)
    });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.curation).toBeNull();
    expect(result.toolCallLog[0].status).toBe("error");
  });

  it("flags a duplicate record_curation call instead of overwriting the first valid one", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "record_curation", input: { rankedIds: ["d1", "d2"], rationale: "first" } },
        { toolName: "record_curation", input: { rankedIds: ["d3"], rationale: "second" } },
      ],
    });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.curation?.rankedIds).toEqual(["d1", "d2"]);
    expect(result.referenceCheck).toEqual({ valid: true, unresolvedIds: [] });
    const errors = result.toolCallLog.filter((c) => c.status === "error");
    expect(errors).toEqual([
      { toolName: "record_curation", input: { rankedIds: ["d3"], rationale: "second" }, status: "error", error: "duplicate record_curation call in one turn" },
    ]);
  });

  it("does not let a second, invalid call corrupt a first valid curation's referenceCheck", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "record_curation", input: { rankedIds: ["d1"], rationale: "valid" } },
        { toolName: "record_curation", input: { rankedIds: ["ghost"], rationale: "invalid" } },
      ],
    });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.curation?.rankedIds).toEqual(["d1"]);
    expect(result.referenceCheck).toEqual({ valid: true, unresolvedIds: [] });
  });

  it("records an unknown tool call rather than crashing", async () => {
    const client = new FakeModelClient({ toolCalls: [{ toolName: "search_flights", input: {} }] });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.toolCallLog).toEqual([{ toolName: "search_flights", input: {}, status: "error", error: "unknown tool" }]);
  });

  it("returns an empty result when the model only replies with text", async () => {
    const client = new FakeModelClient({ text: "I need more preference detail to rank these." });
    const result = await runCuratorAgent(client, baseInput);
    expect(result.curation).toBeNull();
    expect(result.assistantMessage).toBe("I need more preference detail to rank these.");
  });
});
