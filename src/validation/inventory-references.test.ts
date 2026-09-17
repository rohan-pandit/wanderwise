import { describe, expect, it } from "vitest";
import { activity, flight, hotel } from "@/src/repositories/fixtures";
import {
  validateInventoryReferences,
  type ApprovedCandidateSet,
} from "./inventory-references";

function approvedSet(overrides: Partial<ApprovedCandidateSet> = {}): ApprovedCandidateSet {
  return {
    destination: "Lisbon",
    inventoryVersion: 1,
    flights: [flight()],
    hotels: [hotel()],
    activities: [activity()],
    ...overrides,
  };
}

describe("validateInventoryReferences", () => {
  it("is valid when every referenced ID resolves within the approved set", () => {
    const result = validateInventoryReferences(
      { flightIds: ["flight-1"], hotelIds: ["hotel-1"], activityIds: ["activity-1"] },
      approvedSet(),
    );
    expect(result).toEqual({ valid: true, unresolvedIds: [], violations: [] });
  });

  it("reports an ID with no matching record as unresolved (hallucinated inventory)", () => {
    const result = validateInventoryReferences(
      { flightIds: ["made-up-flight"], hotelIds: [], activityIds: [] },
      approvedSet(),
    );
    expect(result.valid).toBe(false);
    expect(result.unresolvedIds).toEqual(["made-up-flight"]);
  });

  it("flags a record whose inventory version is stale", () => {
    const result = validateInventoryReferences(
      { flightIds: [], hotelIds: ["hotel-1"], activityIds: [] },
      approvedSet({ hotels: [hotel({ inventory_version: 0 })] }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      { id: "hotel-1", kind: "hotel", reason: expect.stringContaining("does not match the current version") },
    ]);
  });

  it("flags a record that belongs to a different destination", () => {
    const result = validateInventoryReferences(
      { flightIds: [], hotelIds: [], activityIds: ["activity-1"] },
      approvedSet({ activities: [activity({ destination: "Kyoto" })] }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      { id: "activity-1", kind: "activity", reason: expect.stringContaining('Belongs to destination "Kyoto"') },
    ]);
  });

  it("accepts a return-leg flight, whose own .destination column is the trip's origin", () => {
    // A return flight for a Lisbon trip flies Lisbon -> New York: its
    // `destination` column is "New York", not "Lisbon".
    const result = validateInventoryReferences(
      { flightIds: ["return-flight"], hotelIds: [], activityIds: [] },
      approvedSet({ flights: [flight({ id: "return-flight", origin: "Lisbon", destination: "New York" })] }),
    );
    expect(result).toEqual({ valid: true, unresolvedIds: [], violations: [] });
  });

  it("flags a flight whose route touches neither endpoint of the trip's destination", () => {
    const result = validateInventoryReferences(
      { flightIds: ["unrelated-flight"], hotelIds: [], activityIds: [] },
      approvedSet({ flights: [flight({ id: "unrelated-flight", origin: "Tokyo", destination: "Kyoto" })] }),
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      { id: "unrelated-flight", kind: "flight", reason: expect.stringContaining("doesn't involve the trip's destination") },
    ]);
  });

  it("validates all three item kinds independently in one call", () => {
    const result = validateInventoryReferences(
      { flightIds: ["flight-1", "ghost"], hotelIds: ["hotel-1"], activityIds: ["activity-1"] },
      approvedSet(),
    );
    expect(result.unresolvedIds).toEqual(["ghost"]);
    expect(result.violations).toEqual([]);
  });
});
