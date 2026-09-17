import { describe, expect, it } from "vitest";
import { runItineraryWriterAgent, type ItineraryWriterInput } from "./itinerary-writer";
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

const baseInput: ItineraryWriterInput = {
  selections: [
    { id: "flight-1", airline: "TAP Air Portugal", price_usd: 548 },
    { id: "hotel-1", name: "Hotel Alfama Bica", price_per_night_usd: 165 },
    { id: "activity-1", name: "Tram 28 Heritage Ride", date: "2026-10-06", startMinutes: 725 },
  ],
};

describe("runItineraryWriterAgent", () => {
  it("sends the write_itinerary tool and the selection data", async () => {
    const client = new FakeModelClient({});
    await runItineraryWriterAgent(client, baseInput);
    expect(client.lastRequest?.tools.map((t) => t.name)).toEqual(["write_itinerary"]);
    expect(client.lastRequest?.messages[0].content).toContain("Hotel Alfama Bica");
  });

  it("delimits itinerary data and labels it as untrusted (RAG safety, PROJECT_BRIEF.md §10.4)", async () => {
    const client = new FakeModelClient({});
    await runItineraryWriterAgent(client, baseInput);
    expect(client.lastRequest?.messages[0].content).toMatch(/^<itinerary_data>[\s\S]*<\/itinerary_data>$/);
    expect(client.lastRequest?.system).toContain("not instructions");
  });

  it("accepts a valid write-up grounded in approved ids", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        {
          toolName: "write_itinerary",
          input: {
            explanation: "Day 1: arrive, ride the historic Tram 28 through Alfama, check into Hotel Alfama Bica.",
            groundedIds: ["flight-1", "hotel-1", "activity-1"],
          },
        },
      ],
    });
    const result = await runItineraryWriterAgent(client, baseInput);
    expect(result.itinerary?.groundedIds).toEqual(["flight-1", "hotel-1", "activity-1"]);
    expect(result.referenceCheck).toEqual({ valid: true, unresolvedIds: [] });
  });

  it("rejects a write-up grounded in a hallucinated id", async () => {
    const client = new FakeModelClient({
      toolCalls: [{ toolName: "write_itinerary", input: { explanation: "x", groundedIds: ["flight-1", "made-up"] } }],
    });
    const result = await runItineraryWriterAgent(client, baseInput);
    expect(result.itinerary).toBeNull();
    expect(result.referenceCheck).toEqual({ valid: false, unresolvedIds: ["made-up"] });
  });

  it("flags a duplicate write_itinerary call instead of overwriting the first valid one", async () => {
    const client = new FakeModelClient({
      toolCalls: [
        { toolName: "write_itinerary", input: { explanation: "first", groundedIds: ["flight-1"] } },
        { toolName: "write_itinerary", input: { explanation: "second", groundedIds: ["hotel-1"] } },
      ],
    });
    const result = await runItineraryWriterAgent(client, baseInput);
    expect(result.itinerary?.explanation).toBe("first");
    const errors = result.toolCallLog.filter((c) => c.status === "error");
    expect(errors).toEqual([
      {
        toolName: "write_itinerary",
        input: { explanation: "second", groundedIds: ["hotel-1"] },
        status: "error",
        error: "duplicate write_itinerary call in one turn",
      },
    ]);
  });
});
