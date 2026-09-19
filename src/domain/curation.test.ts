import { describe, expect, it } from "vitest";
import {
  CurationOutput,
  ExplanationOutput,
  sanitizeExplanationOutput,
  validateCurationReferences,
  validateExplanationGrounding,
} from "./curation";

describe("CurationOutput", () => {
  it("accepts a valid curation", () => {
    const result = CurationOutput.safeParse({
      rankedIds: ["d1", "d2"],
      excludedIds: [{ id: "d3", reason: "too expensive" }],
      rationale: "d1 and d2 best match the requested vibe.",
    });
    expect(result.success).toBe(true);
  });

  it("requires at least one ranked id", () => {
    const result = CurationOutput.safeParse({ rankedIds: [], rationale: "x" });
    expect(result.success).toBe(false);
  });

  it("defaults excludedIds to an empty array", () => {
    const result = CurationOutput.parse({ rankedIds: ["d1"], rationale: "x" });
    expect(result.excludedIds).toEqual([]);
  });
});

describe("validateCurationReferences", () => {
  const approved = new Set(["d1", "d2", "d3"]);

  it("passes when every referenced id is approved", () => {
    const output = CurationOutput.parse({
      rankedIds: ["d1", "d2"],
      excludedIds: [{ id: "d3", reason: "too pricey" }],
      rationale: "x",
    });
    expect(validateCurationReferences(output, approved)).toEqual({ valid: true, unresolvedIds: [] });
  });

  it("flags a hallucinated ranked id", () => {
    const output = CurationOutput.parse({ rankedIds: ["d1", "made-up-id"], rationale: "x" });
    const result = validateCurationReferences(output, approved);
    expect(result.valid).toBe(false);
    expect(result.unresolvedIds).toEqual(["made-up-id"]);
  });

  it("flags a hallucinated excluded id", () => {
    const output = CurationOutput.parse({
      rankedIds: ["d1"],
      excludedIds: [{ id: "not-real", reason: "x" }],
      rationale: "x",
    });
    const result = validateCurationReferences(output, approved);
    expect(result.valid).toBe(false);
    expect(result.unresolvedIds).toEqual(["not-real"]);
  });

  it("deduplicates repeated unresolved ids", () => {
    const output = CurationOutput.parse({ rankedIds: ["ghost", "ghost"], rationale: "x" });
    expect(validateCurationReferences(output, approved).unresolvedIds).toEqual(["ghost"]);
  });

  it("rejects everything when the approved set is empty", () => {
    const output = CurationOutput.parse({ rankedIds: ["d1"], rationale: "x" });
    expect(validateCurationReferences(output, new Set())).toEqual({ valid: false, unresolvedIds: ["d1"] });
  });

  it("is case-sensitive — a differently-cased id is not a match", () => {
    const output = CurationOutput.parse({ rankedIds: ["D1"], rationale: "x" });
    expect(validateCurationReferences(output, approved)).toEqual({ valid: false, unresolvedIds: ["D1"] });
  });

  it("does not treat one id as matching another it's merely a prefix of", () => {
    const output = CurationOutput.parse({ rankedIds: ["d10"], rationale: "x" });
    expect(validateCurationReferences(output, approved)).toEqual({ valid: false, unresolvedIds: ["d10"] });
  });
});

describe("ExplanationOutput", () => {
  it("accepts an explanation with grounded ids", () => {
    const result = ExplanationOutput.safeParse({ explanation: "Chosen for X.", groundedIds: ["a1"] });
    expect(result.success).toBe(true);
  });

  it("defaults groundedIds to an empty array", () => {
    expect(ExplanationOutput.parse({ explanation: "x" }).groundedIds).toEqual([]);
  });

  it("requires non-empty explanation text", () => {
    expect(ExplanationOutput.safeParse({ explanation: "" }).success).toBe(false);
  });
});

describe("sanitizeExplanationOutput", () => {
  it("strips a leaked tool-call artifact off the end of the explanation (the live trip 2c40a36c case)", () => {
    const parsed = ExplanationOutput.parse({
      explanation: 'Enjoy your trip!</explanation>\n<parameter name="groundedIds">["a1"]',
      groundedIds: ["a1"],
    });
    expect(sanitizeExplanationOutput(parsed).explanation).toBe("Enjoy your trip!");
  });

  it("leaves clean explanation text and groundedIds untouched", () => {
    const parsed = ExplanationOutput.parse({ explanation: "Chosen for X.", groundedIds: ["a1"] });
    expect(sanitizeExplanationOutput(parsed)).toEqual({ explanation: "Chosen for X.", groundedIds: ["a1"] });
  });
});

describe("validateExplanationGrounding", () => {
  const approved = new Set(["a1", "a2"]);

  it("passes when grounded ids are all approved", () => {
    const output = ExplanationOutput.parse({ explanation: "x", groundedIds: ["a1"] });
    expect(validateExplanationGrounding(output, approved)).toEqual({ valid: true, unresolvedIds: [] });
  });

  it("flags a hallucinated grounded id", () => {
    const output = ExplanationOutput.parse({ explanation: "x", groundedIds: ["a1", "fake"] });
    const result = validateExplanationGrounding(output, approved);
    expect(result.valid).toBe(false);
    expect(result.unresolvedIds).toEqual(["fake"]);
  });

  it("passes trivially when no ids are grounded", () => {
    const output = ExplanationOutput.parse({ explanation: "General note, no specific candidates." });
    expect(validateExplanationGrounding(output, approved)).toEqual({ valid: true, unresolvedIds: [] });
  });
});
