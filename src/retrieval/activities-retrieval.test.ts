import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { EmbeddingClient, EmbeddingResult } from "./embedding-client";
import { RetrievalQueryError } from "./errors";

vi.mock("@/src/repositories/activities");

import { matchActivities, type MatchedActivity } from "@/src/repositories/activities";
import { MAX_MATCH_COUNT, retrieveActivities } from "./activities-retrieval";

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
    destination_id: "destination-lisbon",
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
    await retrieveActivities(supabase, client, { destination: "Lisbon", destinationId: "destination-lisbon", topK: 5 });
    expect(client.lastCall).toEqual({ texts: ["Lisbon"], inputType: "query" });
  });

  it("throws RetrievalQueryError when destination is empty and nothing else is given", async () => {
    const client = new FakeEmbeddingClient();
    await expect(
      retrieveActivities(supabase, client, { destination: "", destinationId: "destination-lisbon", topK: 5 }),
    ).rejects.toThrow(RetrievalQueryError);
    expect(matchActivities).not.toHaveBeenCalled();
  });

  it("requests exactly topK candidates when no closed-day filter is given", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveActivities(supabase, client, { destination: "Lisbon", destinationId: "destination-lisbon", topK: 5 });
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
      destinationId: "destination-lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 5,
    });

    expect(matchActivities).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ matchCount: 10 }), // 5 * OVERFETCH_FACTOR
    );
    expect(result.map((a) => a.id)).toEqual(["open", "open-2"]);
  });

  it("widens and retries when the first (exactly-full) batch under-fills topK, since more could exist further down the ranking", async () => {
    const pool = [
      ...Array.from({ length: 10 }, (_, i) => activity({ id: `closed-${i}`, closed_days: ["monday"] })),
      ...Array.from({ length: 10 }, (_, i) => activity({ id: `open-${i}`, closed_days: [] })),
    ];
    vi.mocked(matchActivities).mockImplementation(async (_s, filter) => pool.slice(0, filter.matchCount));
    const client = new FakeEmbeddingClient();

    const result = await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      destinationId: "destination-lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 5,
    });

    // First call (matchCount 10) hits all 10 closed activities and nothing
    // else — 0 passing, but Postgres returned exactly as many rows as asked
    // for, so a bigger fetch might surface the open ones further down the
    // ranking. Second call (matchCount 20) reaches them.
    expect(matchActivities).toHaveBeenCalledTimes(2);
    expect(vi.mocked(matchActivities).mock.calls[0][1]).toMatchObject({ matchCount: 10 });
    expect(vi.mocked(matchActivities).mock.calls[1][1]).toMatchObject({ matchCount: 20 });
    expect(result.map((a) => a.id)).toEqual(["open-0", "open-1", "open-2", "open-3", "open-4"]);
  });

  it("does not retry when the first batch already came back short of matchCount (every matching activity has been seen)", async () => {
    vi.mocked(matchActivities).mockResolvedValue([activity({ id: "only-one", closed_days: [] })]);
    const client = new FakeEmbeddingClient();

    const result = await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      destinationId: "destination-lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 5,
    });

    expect(matchActivities).toHaveBeenCalledTimes(1);
    expect(result.map((a) => a.id)).toEqual(["only-one"]);
  });

  it("stops widening at MAX_MATCH_COUNT rather than retrying forever against a pathological all-closed result set", async () => {
    vi.mocked(matchActivities).mockImplementation(async (_s, filter) =>
      Array.from({ length: filter.matchCount }, (_, i) => activity({ id: `closed-${i}`, closed_days: ["monday"] })),
    );
    const client = new FakeEmbeddingClient();

    const result = await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      destinationId: "destination-lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 5,
    });

    expect(result).toEqual([]);
    const requestedCounts = vi.mocked(matchActivities).mock.calls.map((call) => call[1].matchCount);
    expect(Math.max(...requestedCounts)).toBe(MAX_MATCH_COUNT);
    expect(requestedCounts.every((c) => c <= MAX_MATCH_COUNT)).toBe(true);
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
      destinationId: "destination-lisbon",
      excludeClosedOnDays: ["monday"],
      topK: 2,
    });

    expect(result).toHaveLength(2);
  });

  it("passes price/accessibility/vibeTags filters through to matchActivities", async () => {
    const client = new FakeEmbeddingClient();
    await retrieveActivities(supabase, client, {
      destination: "Lisbon",
      destinationId: "destination-lisbon",
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
      destinationId: "destination-lisbon",
      inventoryVersion: 2,
      minPriceUsd: 10,
      maxPriceUsd: 100,
      requiredAccessibility: ["wheelchair_accessible"],
      vibeTags: ["nightlife"],
    });
  });
});
