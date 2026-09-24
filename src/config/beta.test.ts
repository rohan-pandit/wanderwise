import { describe, expect, it } from "vitest";
import { isBetaBannerDismissed } from "./beta";

describe("isBetaBannerDismissed", () => {
  it("is dismissed only when the stored version matches the current one", () => {
    expect(isBetaBannerDismissed("v1", "v1")).toBe(true);
  });

  it("shows the banner again after a version bump", () => {
    expect(isBetaBannerDismissed("v1", "v2")).toBe(false);
  });

  it("shows the banner when nothing was ever dismissed", () => {
    expect(isBetaBannerDismissed(undefined, "v1")).toBe(false);
    expect(isBetaBannerDismissed("", "v1")).toBe(false);
  });
});
