import type { PostgrestError } from "@supabase/supabase-js";

/** Awaits a PostgREST query result, throwing on error instead of returning it as a tuple. */
export async function unwrapOrThrow<T>(
  result: PromiseLike<{ data: T | null; error: PostgrestError | null }>,
): Promise<T> {
  const { data, error } = await result;
  if (error) throw error;
  // Safe: PostgREST only returns a null `data` alongside a non-null `error`,
  // which we've just checked above — the generic signature can't express
  // that correlation directly.
  return data as T;
}

/** Type-narrowing check for "this optional filter array was actually provided." */
export function hasValues<T>(arr: T[] | undefined): arr is T[] {
  return arr !== undefined && arr.length > 0;
}

export class InvalidEmbeddingError extends Error {
  constructor(reason: string) {
    super(`Invalid query embedding: ${reason}`);
    this.name = "InvalidEmbeddingError";
  }
}

/**
 * A pgvector literal is built by string-joining the array (`[0.1,0.2,...]`)
 * before it ever reaches Postgres, so a malformed vector — empty, or
 * containing `NaN`/`Infinity` from an embedding-provider bug — would
 * otherwise surface as an opaque DB-level cast error instead of a clear one
 * at the call site. Checked once here rather than in every RPC wrapper that
 * takes a query embedding.
 */
export function toVectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new InvalidEmbeddingError("received an empty vector");
  }
  if (!embedding.every((n) => Number.isFinite(n))) {
    throw new InvalidEmbeddingError("contains a non-finite value (NaN/Infinity)");
  }
  return `[${embedding.join(",")}]`;
}
