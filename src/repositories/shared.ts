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
