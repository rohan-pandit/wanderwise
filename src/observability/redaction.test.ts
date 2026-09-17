import { describe, expect, it } from "vitest";
import { redactSensitiveTelemetry } from "./redaction";

describe("redactSensitiveTelemetry", () => {
  it("redacts a requiredAccessibility requirement's value inside a record_extraction payload", () => {
    const input = {
      requirements: [
        { field: "requiredAccessibility", value: ["wheelchair accessible room"], source: "user_explicit", confidence: 0.9 },
        { field: "budgetTotalUsd", value: 4000, source: "user_explicit", confidence: 0.9 },
      ],
      preferences: [],
    };

    const result = redactSensitiveTelemetry(input) as typeof input;

    expect(result.requirements[0]).toMatchObject({
      field: "requiredAccessibility",
      value: "[redacted]",
      source: "user_explicit",
      confidence: 0.9,
    });
    expect(result.requirements[1]).toEqual(input.requirements[1]);
  });

  it("redacts a propose_trip_revision payload targeting requiredAccessibility", () => {
    const input = { revisionType: "requirement", target: "requiredAccessibility", value: ["step-free access"] };

    expect(redactSensitiveTelemetry(input)).toEqual({
      revisionType: "requirement",
      target: "requiredAccessibility",
      value: "[redacted]",
    });
  });

  it("leaves non-sensitive fields and unrelated shapes untouched", () => {
    const input = {
      requirements: [{ field: "destination", value: "Lisbon", source: "user_explicit", confidence: 1 }],
      note: "no field/target here",
      count: 3,
    };

    expect(redactSensitiveTelemetry(input)).toEqual(input);
  });

  it("handles null, primitives, and arrays without a wrapping object", () => {
    expect(redactSensitiveTelemetry(null)).toBeNull();
    expect(redactSensitiveTelemetry(42)).toBe(42);
    expect(redactSensitiveTelemetry("hi")).toBe("hi");
    expect(redactSensitiveTelemetry([{ field: "requiredAccessibility", value: ["x"] }])).toEqual([
      { field: "requiredAccessibility", value: "[redacted]" },
    ]);
  });
});
