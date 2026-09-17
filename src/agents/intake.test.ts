import { describe, expect, it } from "vitest";
import { runIntakeAgent, type IntakeAgentInput } from "./intake";
import type {
  ModelClient,
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelToolCall,
} from "./model-client";

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

/** No real API call — a scripted stand-in so these tests cover the agent's parsing/validation logic only. */
class FakeModelClient implements ModelClient {
  readonly model = "fake-model";
  public lastRequest: ModelCompletionRequest | null = null;

  constructor(
    private readonly response: { text?: string; toolCalls?: ModelToolCall[] },
  ) {}

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

const baseInput: IntakeAgentInput = {
  userMessage: "I want to go to Lisbon from New York, October 5-12, budget $3000, party of 2.",
  currentRequirements: [],
  currentPreferences: [],
};

describe("runIntakeAgent", () => {
  it("passes the system prompt and all three tools to the model client", async () => {
    const client = new FakeModelClient({});
    await runIntakeAgent(client, baseInput);
    expect(client.lastRequest?.tools.map((t) => t.name)).toEqual([
      "record_extraction",
      "request_clarification",
      "propose_trip_revision",
    ]);
    expect(client.lastRequest?.messages[0].content).toContain(baseInput.userMessage);
  });

  it("aggregates a valid record_extraction call into requirements/preferences", async () => {
    const client = new FakeModelClient({
      text: "Got it — Lisbon in October, budget $3000.",
      toolCalls: [
        {
          toolName: "record_extraction",
          input: {
            requirements: [
              { field: "destination", value: "Lisbon", source: "user_explicit", confidence: 1 },
              { field: "budgetTotalUsd", value: 3000, source: "user_explicit", confidence: 1 },
            ],
            preferences: [],
          },
        },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.requirements).toHaveLength(2);
    expect(result.preferences).toHaveLength(0);
    expect(result.toolCallLog).toEqual([
      {
        toolName: "record_extraction",
        input: expect.any(Object),
        status: "success",
        result: { requirementsExtracted: 2, preferencesExtracted: 0 },
        error: undefined,
      },
    ]);
    expect(result.assistantMessage).toBe("Got it — Lisbon in October, budget $3000.");
  });

  it("handles a request_clarification call", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "request_clarification",
          input: { missingFields: ["partySize"], reason: "How many travelers?" },
        },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.clarification).toEqual({ missingFields: ["partySize"], reason: "How many travelers?" });
    expect(result.toolCallLog.every((c) => c.status === "success")).toBe(true);
  });

  it("handles a propose_trip_revision call", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "propose_trip_revision", input: { revisionType: "decision", target: "hotel", value: "hotel_456" } },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.revisionProposal).toEqual({ revisionType: "decision", target: "hotel", value: "hotel_456" });
  });

  it("aggregates multiple tool calls made in the same turn", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "record_extraction",
          input: {
            requirements: [{ field: "origin", value: "New York", source: "user_explicit", confidence: 1 }],
            preferences: [],
          },
        },
        {
          toolName: "request_clarification",
          input: { missingFields: ["budgetTotalUsd"], reason: "No budget yet." },
        },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.requirements).toHaveLength(1);
    expect(result.clarification).not.toBeNull();
  });

  it("records a malformed record_extraction call instead of throwing", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "record_extraction",
          input: {
            requirements: [{ field: "partySize", value: "two", source: "user_explicit", confidence: 1 }],
            preferences: [],
          },
        },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.requirements).toHaveLength(0);
    expect(result.toolCallLog).toHaveLength(1);
    expect(result.toolCallLog[0]).toMatchObject({ toolName: "record_extraction", status: "error" });
  });

  it("keeps valid items from a record_extraction call that also contains one malformed item", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "record_extraction",
          input: {
            requirements: [
              { field: "destination", value: "Lisbon", source: "user_explicit", confidence: 1 },
              { field: "budgetTotalUsd", value: 3000, source: "user_explicit", confidence: 1 },
            ],
            preferences: [
              { field: "travelStyle", value: "", source: "user_explicit", confidence: 0.5 }, // empty string fails min(1)
            ],
          },
        },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.requirements).toHaveLength(2);
    expect(result.preferences).toHaveLength(0);
    expect(result.toolCallLog).toHaveLength(1);
    expect(result.toolCallLog[0].status).toBe("error");
    expect(result.toolCallLog[0].error).toContain("preference:");
  });

  it("accumulates requirements across two record_extraction calls in one turn", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "record_extraction",
          input: {
            requirements: [{ field: "origin", value: "New York", source: "user_explicit", confidence: 1 }],
            preferences: [],
          },
        },
        {
          toolName: "record_extraction",
          input: {
            requirements: [{ field: "destination", value: "Lisbon", source: "user_explicit", confidence: 1 }],
            preferences: [],
          },
        },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements.map((r) => r.field)).toEqual(["origin", "destination"]);
  });

  it("surfaces the model's stop reason", async () => {
    class TruncatedModelClient extends FakeModelClient {
      async complete(request: Parameters<FakeModelClient["complete"]>[0]) {
        const base = await super.complete(request);
        return { ...base, stopReason: "max_tokens" };
      }
    }
    const client = new TruncatedModelClient({ text: "partial repl" });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.stopReason).toBe("max_tokens");
  });

  it("records an unknown tool call rather than crashing", async () => {
    const client = new FakeModelClient({
      toolCalls: [{ toolName: "book_flight", input: { flightId: "f_1" } }],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.toolCallLog).toEqual([
      { toolName: "book_flight", input: { flightId: "f_1" }, status: "error", error: "unknown tool" },
    ]);
  });

  it("flags a duplicate request_clarification call in one turn", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "request_clarification", input: { missingFields: ["origin"], reason: "a" } },
        { toolName: "request_clarification", input: { missingFields: ["destination"], reason: "b" } },
      ],
    });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.clarification).toEqual({ missingFields: ["origin"], reason: "a" });
    const errors = result.toolCallLog.filter((c) => c.status === "error");
    expect(errors).toEqual([
      {
        toolName: "request_clarification",
        input: { missingFields: ["destination"], reason: "b" },
        status: "error",
        error: "duplicate request_clarification call in one turn",
      },
    ]);
  });

  it("returns an empty result when the model only replies with text", async () => {
    const client = new FakeModelClient({ text: "Sounds great, tell me more!" });
    const result = await runIntakeAgent(client, baseInput);
    expect(result.requirements).toHaveLength(0);
    expect(result.clarification).toBeNull();
    expect(result.revisionProposal).toBeNull();
    expect(result.assistantMessage).toBe("Sounds great, tell me more!");
  });

  it("serializes currentDecisions into the request when present (revision framing)", async () => {
    const client = new FakeModelClient({});
    const input: IntakeAgentInput = {
      ...baseInput,
      currentDecisions: [{ field: "hotel", value: "hotel_123" }],
    };
    await runIntakeAgent(client, input);
    expect(client.lastRequest?.messages[0].content).toContain("hotel_123");
  });
});
