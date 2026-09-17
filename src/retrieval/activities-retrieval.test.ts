import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { EmbeddingClient, EmbeddingResult } from "./embedding-client";
import { RetrievalQueryError } from "./errors";

vi.mock("@/src/repositories/activities");

import { matchActivities, type MatchedActivity } from "@/src/repositories/activities";
import { retrieveActivities } from "./activities-retrieval";

const supabase = {} as SupabaseClient<Database>;

class FakeEmbeddingClient implements EmbeddingClient {
  readonly model = "fake-embedding-model";
  readonly dimension = 3;
  public lastCall: { texts: string[]; inputType: string } | null = null;

  async embed(texts: string[], inputType: "query" | "document"): Promise<EmbeddingResult> {
    this.lastCall = { texts, inputType };
    return { embeddings: texts.map(() => [0.4, 0.5, 0.6]), totalTokens: texts.length * 2 };
  }
}

function activity(overrides: Partial<MatchedActivity> = {}): MatchedActivity {
  return {
    id: "a1",
    destination: "Lisbon",
    name: "Fado Night",
    description: null,
    category: null,
    vibe_tags: null,
    price_usd: 30,
    duration_minutes: 90,
    opening_hours: null,
    closed_days: null,
    location: null,
    accessibility_attributes: null,
    reservation_required: false,
    inventory_version: 1,
    similarity: 0.9,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(matchActivities).mockResolvedValue([]);
});

describe("retrieveActivities", () => {
  it("falls back to the destination name as the query text when query and vibeTags are omitted", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveActivities(supabase, client, { destination: "Lisbon", topK: 5 });
    expect(client.lastCall).toEqual({ texts: ["Lisbon"], inputType: "query" });
  });

  it("throws RetrievalQueryError when destination is empty and nothing else is given", async () => {
    const client = new FakeEmbeddingClient();
    await expect(retrieveActivities(supabase, client, { destination: "", topK: 5 })).rejects.toThrow(
      RetrievalQueryError,
    );
    expect(matchActivities).not.toHaveBeenCalled();
  });

  it("requests exactly topK candidates when no closed-day filter is given", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveActivities(supabase, client, { destination: "Lisbon", topK: 5 });
    expect(matchActivities).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ matchCount: 5 }),
    );
  });

  it("overfetches when a closed-day filter is given, then filters and slices back to topK", async () => {
    vi.mocked(matchActivities).mockResolvedValue([
      activity({ id: "open", closed_days: [] }),
      activity({ id: "closed-monday", closed_days: ["monday"] }),
      activity({ id: "open-2", closed_days: ["tuesday"] }),
    ]);
    const client = new FakeEmbeddingClient();

    const result = await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 5,
    });

    expect(matchActivities).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ matchCount: 10 }), // 5 * OVERFETCH_FACTOR
    );
    expect(result.map((a) => a.id)).toEqual(["open", "open-2"]);
  });

  it("slices closed-day-filtered results down to topK even if more survive", async () => {
    vi.mocked(matchActivities).mockResolvedValue([
      activity({ id: "a", closed_days: [] }),
      activity({ id: "b", closed_days: [] }),
      activity({ id: "c", closed_days: [] }),
    ]);
    const client = new FakeEmbeddingClient();

    const result = await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 2,
    });

    expect(result).toHaveLength(2);
  });

  it("passes price/accessibility/vibeTags filters through to matchActivities", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      minPriceUsd: 10,
      maxPriceUsd: 100,
      accessibilityNeeds: ["wheelchair_accessible"],
      vibeTags: ["nightlife"],
      topK: 5,
      inventoryVersion: 2,
    });
    expect(matchActivities).toHaveBeenCalledWith(supabase, {
      queryEmbedding: [0.4, 0.5, 0.6],
      matchCount: 5,
      destination: "Lisbon",
      inventoryVersion: 2,
      minPriceUsd: 10,
      maxPriceUsd: 100,
      requiredAccessibility: ["wheelchair_accessible"],
      vibeTags: ["nightlife"],
    });
  });
});
