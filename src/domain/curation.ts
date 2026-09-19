/**
 * Structured output schemas for the Destination/Activity Curator and Trip
 * Explanation agents (PROJECT_BRIEF.md §6.2 rows B/C). Pure Zod, no model
 * calls — same pattern as `src/domain/extraction.ts`.
 *
 * Both schemas carry the same hallucination guardrail (§9.4 "prevent
 * hallucinated inventory", generalized to retrieval candidates rather than
 * booking inventory): the agent may only reference IDs that were actually in
 * the candidate set it was given, never invent one — checked deterministically
 * by `validateCurationReferences`/`validateExplanationGrounding`, not trusted
 * from the model's own claim.
 */
import { z } from "zod";
import { stripStrayMarkup } from "./stray-markup";

export const CurationOutput = z.object({
  /** Candidate IDs, most-recommended first. Every ID must come from the candidate set the agent was given. */
  rankedIds: z.array(z.string().min(1)).min(1),
  excludedIds: z
    .array(z.object({ id: z.string().min(1), reason: z.string().min(1) }))
    .default([]),
  rationale: z.string().min(1),
});
export type CurationOutput = z.infer<typeof CurationOutput>;

export interface ReferenceCheckResult {
  valid: boolean;
  unresolvedIds: string[];
}

export function validateCurationReferences(
  output: CurationOutput,
  approvedIds: ReadonlySet<string>,
): ReferenceCheckResult {
  const referenced = [...output.rankedIds, ...output.excludedIds.map((e) => e.id)];
  const unresolvedIds = [...new Set(referenced.filter((id) => !approvedIds.has(id)))];
  return { valid: unresolvedIds.length === 0, unresolvedIds };
}

export const ExplanationOutput = z.object({
  explanation: z.string().min(1),
  /** IDs the explanation actually relies on/references — every one must come from the approved candidate/selection set. */
  groundedIds: z.array(z.string().min(1)).default([]),
});
export type ExplanationOutput = z.infer<typeof ExplanationOutput>;

/**
 * Applied by callers right after `ExplanationOutput.safeParse` succeeds —
 * deliberately kept out of the schema itself (no `.transform`) because both
 * agents that use this schema (`itinerary-writer.ts`, `explanation.ts`) also
 * feed it through `z.toJSONSchema` to build the tool definition sent to the
 * model, and a `.transform` isn't representable in JSON Schema (it broke
 * that call outright when tried inline here). See `stray-markup.ts`.
 */
export function sanitizeExplanationOutput(output: ExplanationOutput): ExplanationOutput {
  return { ...output, explanation: stripStrayMarkup(output.explanation) };
}

export function validateExplanationGrounding(
  output: ExplanationOutput,
  approvedIds: ReadonlySet<string>,
): ReferenceCheckResult {
  const unresolvedIds = [...new Set(output.groundedIds.filter((id) => !approvedIds.has(id)))];
  return { valid: unresolvedIds.length === 0, unresolvedIds };
}
