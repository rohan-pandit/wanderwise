import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { EmbeddingClient, EmbeddingResult } from "./embedding-client";
import { RetrievalQueryError } from "./errors";

vi.mock("@/src/repositories/destinations");

import { matchDestinations } from "@/src/repositories/destinations";
import { retrieveDestinations } from "./destinations-retrieval";

const supabase = {} as SupabaseClient<Database>;

class FakeEmbeddingClient implements EmbeddingClient {
  readonly model = "fake-embedding-model";
  readonly dimension = 3;
  public lastCall: { texts: string[]; inputType: string } | null = null;

  async embed(texts: string[], inputType: "query" | "document"): Promise<EmbeddingResult> {
    this.lastCall = { texts, inputType };
    return { embeddings: texts.map(() => [0.1, 0.2, 0.3]), totalTokens: texts.length * 2 };
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(matchDestinations).mockResolvedValue([]);
});

describe("retrieveDestinations", () => {
  it("throws RetrievalQueryError when neither query nor vibeTags is given", async () => {
    const client = new FakeEmbeddingClient();
    await expect(retrieveDestinations(supabase, client, { topK: 5 })).rejects.toThrow(RetrievalQueryError);
    expect(matchDestinations).not.toHaveBeenCalled();
  });

  it("embeds the explicit query as inputType 'query'", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveDestinations(supabase, client, { query: "relaxing beach town", topK: 5 });
    expect(client.lastCall).toEqual({ texts: ["relaxing beach town"], inputType: "query" });
  });

  it("derives the query text from vibeTags when query is omitted", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveDestinations(supabase, client, { vibeTags: ["food", "culture"], topK: 5 });
    expect(client.lastCall?.texts).toEqual(["food, culture"]);
  });

  it("passes the embedded vector and filters through to matchDestinations", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveDestinations(supabase, client, {
      query: "beach town",
      maxDailyCostUsd: 200,
      vibeTags: ["beach"],
      topK: 5,
      inventoryVersion: 2,
    });
    expect(matchDestinations).toHaveBeenCalledWith(supabase, {
      queryEmbedding: [0.1, 0.2, 0.3],
      matchCount: 5,
      inventoryVersion: 2,
      maxDailyCostUsd: 200,
      vibeTags: ["beach"],
    });
  });
});
