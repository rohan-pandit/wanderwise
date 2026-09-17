/**
 * Provider-agnostic seam for generating embeddings (CLAUDE.md: "keep model
 * calls behind interfaces; keep provider-specific code isolated") — the same
 * pattern `src/agents/model-client.ts` established for LLM calls, applied to
 * the other kind of external AI call this project makes. Anthropic has no
 * embeddings API, so this is always a second provider regardless of which
 * one is chosen (see BUILD_LOG.md, 2026-09-16 "embedding provider decided").
 */

export type EmbeddingInputType = "query" | "document";

export interface EmbeddingResult {
  embeddings: number[][];
  totalTokens: number;
}

export interface EmbeddingClient {
  readonly model: string;
  readonly dimension: number;
  /**
   * `inputType` matters for retrieval quality on models that support it —
   * "document" for what gets indexed (destinations/activities), "query" for
   * what a user/agent is searching with. Never mix the two silently.
   */
  embed(texts: string[], inputType: EmbeddingInputType): Promise<EmbeddingResult>;
}

/** What an `EmbeddingClient` implementation throws on failure — keeps provider-specific exception types from leaking through the abstraction. The original error is preserved as `cause`. */
export class EmbeddingClientError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "EmbeddingClientError";
  }
}
