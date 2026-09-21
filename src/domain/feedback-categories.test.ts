import { describe, expect, it } from "vitest";
import { FEEDBACK_CATEGORY_OPTIONS, feedbackCategoryLabel } from "./feedback-categories";

describe("feedbackCategoryLabel", () => {
  it("resolves a known category value to its label", () => {
    expect(feedbackCategoryLabel("flights")).toBe("Flights not loading or matching");
  });

  it("resolves every option's own value back to its own label", () => {
    for (const option of FEEDBACK_CATEGORY_OPTIONS) {
      expect(feedbackCategoryLabel(option.value)).toBe(option.label);
    }
  });

  it("falls back to the raw value for an unrecognized category", () => {
    expect(feedbackCategoryLabel("not_a_real_category")).toBe("not_a_real_category");
  });
});
