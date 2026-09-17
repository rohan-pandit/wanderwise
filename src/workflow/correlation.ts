/**
 * Derives a stable, valid-format UUID from a base correlation ID plus a step
 * label, so a single logical operation that needs more than one workflow
 * transition (e.g. `clarification_resolved` immediately followed by
 * `requirements_complete`, or `begin_search` followed by `search_completed`)
 * gets a distinct, retry-stable correlation ID per step — a retry of the
 * whole operation with the same base ID reproduces the same per-step IDs,
 * preserving `advanceTrip`'s idempotency guarantee across the chain, not
 * just within one call. Shared by every orchestrator that drives more than
 * one transition per logical turn (`intake-orchestrator.ts`,
 * `search-orchestrator.ts`).
 */
import { createHash } from "node:crypto";

export function deriveCorrelationId(base: string, label: string): string {
  const hex = createHash("sha256").update(`${base}:${label}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
