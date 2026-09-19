/**
 * Observed live (Wanderwise trip `2c40a36c-91f0-4579-a5f5-fb620c467ae2`,
 * 2026-09-19): after finishing its real prose, the Itinerary Writer agent's
 * model occasionally keeps generating into a leaked, tag-like re-statement
 * of its own tool call instead of stopping — e.g. a trailing
 * `</explanation>\n<parameter name="groundedIds">[...]` appended to the
 * `explanation` string itself (inside otherwise-valid tool-call JSON, so
 * nothing upstream rejects it). Rather than trust that can't happen again,
 * truncate at the first sign of raw tag-like markup wherever model prose is
 * trusted or rendered — deterministic, not a model-trust call, consistent
 * with this file's siblings in `src/domain/` never taking a model's output
 * at face value.
 */
const TAG_LIKE_PATTERN = /<\/?[a-zA-Z][^<>]*>/;

/** Strips a tag-like artifact and everything after it; returns `text` unchanged if none is found, or if stripping would leave nothing. */
export function stripStrayMarkup(text: string): string {
  const match = TAG_LIKE_PATTERN.exec(text);
  if (!match) return text;
  const truncated = text.slice(0, match.index).trimEnd();
  return truncated.length > 0 ? truncated : text;
}
