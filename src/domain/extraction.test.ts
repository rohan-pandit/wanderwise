import { describe, expect, it } from "vitest";
import {
  ClarificationRequest,
  ExtractedPreference,
  ExtractedRequirement,
  REQUIRED_FOR_READY,
  RevisionProposal,
  checkRequirementsComplete,
  toPreferenceRecord,
  toRequirementRecord,
  type RequirementRecord,
} from "./extraction";

describe("ExtractedRequirement", () => {
  it("accepts a valid string-field requirement", () => {
    const result = ExtractedRequirement.safeParse({
      field: "destination",
      value: "Lisbon",
      source: "user_explicit",
      confidence: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a value of the wrong type for its field", () => {
    const result = ExtractedRequirement.safeParse({
      field: "partySize",
      value: "two", // should be a number
      source: "user_explicit",
      confidence: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown field", () => {
    const result = ExtractedRequirement.safeParse({
      field: "favoriteColor",
      value: "blue",
      source: "user_explicit",
      confidence: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside [0, 1]", () => {
    const result = ExtractedRequirement.safeParse({
      field: "origin",
      value: "New York",
      source: "user_explicit",
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a provenance a model must never claim", () => {
    const result = ExtractedRequirement.safeParse({
      field: "origin",
      value: "New York",
      source: "deterministic_validation",
      confidence: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed ISO date", () => {
    const result = ExtractedRequirement.safeParse({
      field: "departureDate",
      value: "10/05/2026",
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a calendrically-invalid date that still matches the YYYY-MM-DD shape", () => {
    expect(
      ExtractedRequirement.safeParse({
        field: "departureDate",
        value: "2026-02-30",
        source: "user_explicit",
        confidence: 0.9,
      }).success,
    ).toBe(false);
    expect(
      ExtractedRequirement.safeParse({
        field: "departureDate",
        value: "2026-13-05",
        source: "user_explicit",
        confidence: 0.9,
      }).success,
    ).toBe(false);
  });

  it("accepts a valid leap-day date", () => {
    const result = ExtractedRequirement.safeParse({
      field: "departureDate",
      value: "2028-02-29",
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an excludeClosedOnDays value outside the weekday enum", () => {
    const result = ExtractedRequirement.safeParse({
      field: "excludeClosedOnDays",
      value: ["someday"],
      source: "user_explicit",
      confidence: 0.8,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid maxHotelPriceUsd requirement", () => {
    const result = ExtractedRequirement.safeParse({
      field: "maxHotelPriceUsd",
      value: 150,
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive maxHotelPriceUsd", () => {
    const result = ExtractedRequirement.safeParse({
      field: "maxHotelPriceUsd",
      value: 0,
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid roomGroups requirement", () => {
    const result = ExtractedRequirement.safeParse({
      field: "roomGroups",
      value: [{ occupants: 2, label: "parents" }, { occupants: 2, label: "kids" }],
      source: "user_explicit",
      confidence: 0.95,
    });
    expect(result.success).toBe(true);
  });
});

describe("toRequirementRecord", () => {
  it("stamps id/createdAt/status onto a validated extraction", () => {
    const extracted = ExtractedRequirement.parse({
      field: "budgetTotalUsd",
      value: 3000,
      source: "user_explicit",
      confidence: 1,
    });
    const record = toRequirementRecord(extracted, { id: "req_1", createdAt: "2026-09-16T00:00:00Z" });
    expect(record).toEqual({
      id: "req_1",
      field: "budgetTotalUsd",
      value: 3000,
      source: "user_explicit",
      confidence: 1,
      status: "active",
      createdAt: "2026-09-16T00:00:00Z",
    });
  });
});

describe("checkRequirementsComplete", () => {
  function record(field: RequirementRecord["field"], status: RequirementRecord["status"] = "active"): RequirementRecord {
    return { id: field, field, value: "x", source: "user_explicit", confidence: 1, status, createdAt: "2026-09-16" };
  }

  it("reports not ready with no requirements", () => {
    const result = checkRequirementsComplete([]);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toEqual(REQUIRED_FOR_READY);
  });

  it("reports ready once all required fields are present", () => {
    const result = checkRequirementsComplete(REQUIRED_FOR_READY.map((f) => record(f)));
    expect(result).toEqual({ ready: true, missingFields: [] });
  });

  it("does not count a retracted requirement as present", () => {
    const records = REQUIRED_FOR_READY.map((f) => record(f));
    records[0] = record(REQUIRED_FOR_READY[0], "retracted");
    const result = checkRequirementsComplete(records);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toEqual([REQUIRED_FOR_READY[0]]);
  });

  it("ignores fields outside the required-for-ready set", () => {
    const records = [...REQUIRED_FOR_READY.map((f) => record(f)), record("noRedEye")];
    expect(checkRequirementsComplete(records).ready).toBe(true);
  });
});

describe("ExtractedPreference", () => {
  it("accepts a single string value", () => {
    const result = ExtractedPreference.safeParse({
      field: "travelStyle",
      value: "food",
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a string-array value", () => {
    const result = ExtractedPreference.safeParse({
      field: "travelStyle",
      value: ["food", "culture"],
      source: "user_inferred",
      confidence: 0.6,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown field", () => {
    const result = ExtractedPreference.safeParse({
      field: "shoeSize",
      value: "9",
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.success).toBe(false);
  });
});

describe("toPreferenceRecord", () => {
  it("stamps id/createdAt/status onto a validated extraction", () => {
    const extracted = ExtractedPreference.parse({
      field: "pace",
      value: "relaxed",
      source: "user_explicit",
      confidence: 0.8,
    });
    const record = toPreferenceRecord(extracted, { id: "pref_1", createdAt: "2026-09-16T00:00:00Z" });
    expect(record.status).toBe("active");
    expect(record.field).toBe("pace");
  });
});

describe("ClarificationRequest", () => {
  it("requires at least one missing field", () => {
    const result = ClarificationRequest.safeParse({ missingFields: [], reason: "need more info" });
    expect(result.success).toBe(false);
  });

  it("accepts a valid clarification request", () => {
    const result = ClarificationRequest.safeParse({
      missingFields: ["budgetTotalUsd"],
      reason: "No budget mentioned yet.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a missing field outside the requirement vocabulary", () => {
    const result = ClarificationRequest.safeParse({
      missingFields: ["shoeSize"],
      reason: "need more info",
    });
    expect(result.success).toBe(false);
  });
});

describe("RevisionProposal", () => {
  it("accepts a decision revision with an arbitrary value payload", () => {
    const result = RevisionProposal.safeParse({
      revisionType: "decision",
      target: "hotel",
      value: "hotel_456",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown revisionType", () => {
    const result = RevisionProposal.safeParse({
      revisionType: "wish",
      target: "hotel",
      value: "hotel_456",
    });
    expect(result.success).toBe(false);
  });
});
