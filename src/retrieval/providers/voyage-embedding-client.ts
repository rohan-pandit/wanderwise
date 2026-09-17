import "server-only";
import { VoyageAIClient } from "voyageai";
import {
  EmbeddingClientError,
  type EmbeddingClient,
  type EmbeddingInputType,
  type EmbeddingResult,
} from "../embedding-client";

/** Voyage's documented per-request limit on the `input` array (see docs.voyageai.com/docs/embeddings). */
const MAX_BATCH_SIZE = 128;

/**
 * The only file that imports the `voyageai` SDK — every other retrieval
 * module goes through `EmbeddingClient`. `voyage-4-lite` is the default:
 * cheapest tier ($0.02/1M tokens, 200M tokens free per account), and this
 * project's short travel-copy embeddings don't need `voyage-4`/`voyage-4-large`'s
 * extra quality. `outputDimension` is fixed at construction, matching
 * whatever the `destinations`/`activities.embedding` columns were migrated
 * to (`supabase/migrations/0005_retrieval.sql` — currently 1024) — the two
 * must never drift independently.
 */
export class VoyageEmbeddingClient implements EmbeddingClient {
  private readonly client: VoyageAIClient;
  readonly model: string;
  readonly dimension: number;

  constructor(model = "voyage-4-lite", dimension = 1024, client?: VoyageAIClient) {
    this.model = model;
    this.dimension = dimension;
    this.client = client ?? new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY });
  }

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<EmbeddingResult> {
    if (texts.length === 0) return { embeddings: [], totalTokens: 0 };

    const embeddings: number[][] = [];
    let totalTokens = 0;

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      let response;
      try {
        response = await this.client.embed({
          input: batch,
          model: this.model,
          inputType,
          outputDimension: this.dimension,
        });
      } catch (err) {
        throw new EmbeddingClientError(`Voyage embedding request failed for model "${this.model}"`, err);
      }

      const data = response.data ?? [];
      if (data.length !== batch.length) {
        throw new EmbeddingClientError(
          `Voyage returned ${data.length} embeddings for a batch of ${batch.length} inputs`,
          response,
        );
      }
      for (const item of data) {
        if (!item.embedding) {
          throw new EmbeddingClientError("Voyage response item is missing its embedding vector", item);
        }
        embeddings.push(item.embedding);
      }
      totalTokens += response.usage?.totalTokens ?? 0;
    }

    return { embeddings, totalTokens };
  }
}
