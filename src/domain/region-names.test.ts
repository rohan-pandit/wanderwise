import { describe, expect, it } from "vitest";
import { isUsStateName } from "./region-names";

describe("isUsStateName", () => {
  it("recognizes a state name", () => {
    expect(isUsStateName("New Hampshire")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUsStateName("new hampshire")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isUsStateName("  Texas  ")).toBe(true);
  });

  it("recognizes a two-word state name", () => {
    expect(isUsStateName("North Carolina")).toBe(true);
  });

  it("recognizes the District of Columbia", () => {
    expect(isUsStateName("District of Columbia")).toBe(true);
  });

  it("does not match a real city, even one that shares a name with a state", () => {
    expect(isUsStateName("New York City")).toBe(false);
  });

  it("does not match a foreign country", () => {
    expect(isUsStateName("Spain")).toBe(false);
  });

  it("does not match an unrelated free-text destination", () => {
    expect(isUsStateName("somewhere warm")).toBe(false);
  });
});
