import { describe, expect, it } from "vitest";
import {
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_KIND_OPTIONS,
  feedbackCategoryLabel,
  feedbackKindLabel,
  isFeedbackKind,
  sanitizeFeedbackRoute,
} from "./feedback-categories";

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

describe("feedback kinds", () => {
  it("accepts exactly the values migration 0020's check constraint allows", () => {
    expect(FEEDBACK_KIND_OPTIONS.map((opt) => opt.value)).toEqual(["bug", "idea", "other"]);
    for (const option of FEEDBACK_KIND_OPTIONS) expect(isFeedbackKind(option.value)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isFeedbackKind("praise")).toBe(false);
    expect(isFeedbackKind(undefined)).toBe(false);
    expect(isFeedbackKind(1)).toBe(false);
  });

  it("labels a known kind and falls back to the raw value otherwise", () => {
    expect(feedbackKindLabel("idea")).toBe("Idea");
    expect(feedbackKindLabel("mystery")).toBe("mystery");
  });
});

describe("sanitizeFeedbackRoute", () => {
  it("keeps this app's own /app paths", () => {
    expect(sanitizeFeedbackRoute("/app")).toBe("/app");
    expect(sanitizeFeedbackRoute("/app/trips")).toBe("/app/trips");
    expect(sanitizeFeedbackRoute("/app/trips/lisbon-getaway")).toBe("/app/trips/lisbon-getaway");
  });

  it("drops anything outside /app, or carrying a query string or fragment", () => {
    expect(sanitizeFeedbackRoute("/internal/analytics")).toBeNull();
    expect(sanitizeFeedbackRoute("https://example.com/app")).toBeNull();
    expect(sanitizeFeedbackRoute("/app/trips?token=abc")).toBeNull();
    expect(sanitizeFeedbackRoute("/app#x")).toBeNull();
    expect(sanitizeFeedbackRoute("/application")).toBeNull();
  });

  it("drops non-strings and overlong paths", () => {
    expect(sanitizeFeedbackRoute(undefined)).toBeNull();
    expect(sanitizeFeedbackRoute(42)).toBeNull();
    expect(sanitizeFeedbackRoute(`/app/${"a".repeat(300)}`)).toBeNull();
  });
});
