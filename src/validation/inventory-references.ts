/**
 * Inventory-reference validation (PROJECT_BRIEF.md §9.4). Every itinerary
 * item must resolve to a real inventory record, in the current inventory
 * version, belonging to the trip's destination — never trust that a model
 * only ever mentions IDs it was actually given. `approved` is the candidate
 * set the itinerary is allowed to draw from (typically what survived
 * `filterHardConstraints`/`assembleCandidateCombinations` for this trip), not
 * a live database call — this stays a pure function so it can run as a
 * cheap, deterministic guardrail on model output.
 *
 * Flights get their own check, not the generic single-field one hotels/
 * activities use: `flights` is a one-way table, so a *return* leg's own
 * `.destination` column is the trip's *origin* (see `src/domain/combinations.ts`'s
 * header for the same round-trip note) — a flight belongs to this trip if
 * *either* endpoint matches the trip's destination, not just one fixed field.
 */
import type { Activity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";

/** The only fields checked for hotels/activities — generic so it also accepts Phase 5's `MatchedActivity` retrieval projection (which lacks `embedding`) without an unsafe cast. */
export interface DestinationScopedCandidate {
  id: string;
  inventory_version: number;
  destination: string;
}

export interface ApprovedCandidateSet<A extends DestinationScopedCandidate = Activity> {
  destination: string;
  inventoryVersion: number;
  flights: Flight[];
  hotels: Hotel[];
  activities: A[];
}

export interface ItineraryReferences {
  flightIds: string[];
  hotelIds: string[];
  activityIds: string[];
}

export type ReferenceItemKind = "flight" | "hotel" | "activity";

export interface ReferenceViolation {
  id: string;
  kind: ReferenceItemKind;
  reason: string;
}

export interface InventoryReferenceResult {
  valid: boolean;
  /** IDs that don't match any record in the approved candidate set at all. */
  unresolvedIds: string[];
  /** IDs that matched a record, but the record fails a further check (stale version, wrong destination). */
  violations: ReferenceViolation[];
}

export function validateInventoryReferences<A extends DestinationScopedCandidate = Activity>(
  references: ItineraryReferences,
  approved: ApprovedCandidateSet<A>,
): InventoryReferenceResult {
  const unresolvedIds: string[] = [];
  const violations: ReferenceViolation[] = [];

  checkFlights(references.flightIds, approved.flights, approved, unresolvedIds, violations);
  checkKind(references.hotelIds, approved.hotels, "hotel", approved, unresolvedIds, violations, (h) => h.destination);
  checkKind(references.activityIds, approved.activities, "activity", approved, unresolvedIds, violations, (a) => a.destination);

  return {
    valid: unresolvedIds.length === 0 && violations.length === 0,
    unresolvedIds,
    violations,
  };
}

function checkFlights(
  ids: string[],
  records: Flight[],
  approved: { destination: string; inventoryVersion: number },
  unresolvedIds: string[],
  violations: ReferenceViolation[],
): void {
  for (const id of ids) {
    const record = records.find((r) => r.id === id);
    if (!record) {
      unresolvedIds.push(id);
      continue;
    }
    if (record.inventory_version !== approved.inventoryVersion) {
      violations.push({
        id,
        kind: "flight",
        reason: `Inventory version ${record.inventory_version} does not match the current version ${approved.inventoryVersion}.`,
      });
      continue;
    }
    if (record.destination !== approved.destination && record.origin !== approved.destination) {
      violations.push({
        id,
        kind: "flight",
        reason: `Route ${record.origin} → ${record.destination} doesn't involve the trip's destination "${approved.destination}".`,
      });
    }
  }
}

function checkKind<T extends { id: string; inventory_version: number }>(
  ids: string[],
  records: T[],
  kind: ReferenceItemKind,
  approved: { destination: string; inventoryVersion: number },
  unresolvedIds: string[],
  violations: ReferenceViolation[],
  destinationOf: (record: T) => string,
): void {
  for (const id of ids) {
    const record = records.find((r) => r.id === id);
    if (!record) {
      unresolvedIds.push(id);
      continue;
    }
    if (record.inventory_version !== approved.inventoryVersion) {
      violations.push({
        id,
        kind,
        reason: `Inventory version ${record.inventory_version} does not match the current version ${approved.inventoryVersion}.`,
      });
      continue;
    }
    if (destinationOf(record) !== approved.destination) {
      violations.push({
        id,
        kind,
        reason: `Belongs to destination "${destinationOf(record)}", not the trip's destination "${approved.destination}".`,
      });
    }
  }
}
