/**
 * Inventory-reference validation (PROJECT_BRIEF.md §9.4). Every itinerary
 * item must resolve to a real inventory record, in the current inventory
 * version, belonging to the trip's destination — never trust that a model
 * only ever mentions IDs it was actually given. `approved` is the candidate
 * set the itinerary is allowed to draw from (typically what survived
 * `filterHardConstraints`/`assembleCandidateCombinations` for this trip), not
 * a live database call — this stays a pure function so it can run as a
 * cheap, deterministic guardrail on model output.
 */
import type { Activity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";

export interface ApprovedCandidateSet {
  destination: string;
  inventoryVersion: number;
  flights: Flight[];
  hotels: Hotel[];
  activities: Activity[];
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

export function validateInventoryReferences(
  references: ItineraryReferences,
  approved: ApprovedCandidateSet,
): InventoryReferenceResult {
  const unresolvedIds: string[] = [];
  const violations: ReferenceViolation[] = [];

  checkKind(references.flightIds, approved.flights, "flight", approved, unresolvedIds, violations, (f) => f.destination);
  checkKind(references.hotelIds, approved.hotels, "hotel", approved, unresolvedIds, violations, (h) => h.destination);
  checkKind(references.activityIds, approved.activities, "activity", approved, unresolvedIds, violations, (a) => a.destination);

  return {
    valid: unresolvedIds.length === 0 && violations.length === 0,
    unresolvedIds,
    violations,
  };
}

function checkKind<T extends { id: string; inventory_version: number }>(
  ids: string[],
  records: T[],
  kind: ReferenceItemKind,
  approved: ApprovedCandidateSet,
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
