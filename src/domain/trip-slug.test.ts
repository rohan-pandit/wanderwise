import { describe, expect, it } from "vitest";
import { isUuid, slugify } from "./trip-slug";

describe("slugify", () => {
  it("lowercases and hyphenates a normal name", () => {
    expect(slugify("Lisbon Getaway")).toBe("lisbon-getaway");
  });

  it("collapses punctuation and multiple spaces into single hyphens", () => {
    expect(slugify("Mom & Dad's 50th Anniversary!!  Trip")).toBe("mom-dad-s-50th-anniversary-trip");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  -- Lisbon --  ")).toBe("lisbon");
  });

  it("caps length and doesn't leave a trailing hyphen from truncation", () => {
    const longName = "a ".repeat(40).trim();
    const result = slugify(longName);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith("-")).toBe(false);
  });

  it("falls back to 'trip' for a name with no alphanumeric characters", () => {
    expect(slugify("🎉🎉🎉")).toBe("trip");
  });

  it("falls back to 'trip' for an all-punctuation name", () => {
    expect(slugify("!!!")).toBe("trip");
  });
});

describe("isUuid", () => {
  it("recognizes a real trip id as a uuid", () => {
    expect(isUuid("2c40a36c-91f0-4579-a5f5-fb620c467ae2")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isUuid("2C40A36C-91F0-4579-A5F5-FB620C467AE2")).toBe(true);
  });

  it("rejects a plain slug", () => {
    expect(isUuid("lisbon-getaway")).toBe(false);
  });

  it("rejects a malformed uuid-shaped string", () => {
    expect(isUuid("2c40a36c-91f0-4579-a5f5-fb620c467ae")).toBe(false);
  });
});
