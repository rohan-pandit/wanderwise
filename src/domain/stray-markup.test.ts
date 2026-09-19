import { describe, expect, it } from "vitest";
import { stripStrayMarkup } from "./stray-markup";

describe("stripStrayMarkup", () => {
  it("returns plain prose unchanged", () => {
    expect(stripStrayMarkup("A lovely week in Lisbon awaits.")).toBe("A lovely week in Lisbon awaits.");
  });

  it("truncates at a leaked tool-call fragment (the live trip 2c40a36c case)", () => {
    const text =
      'We hope this makes for a memorable trip!</explanation>\n<parameter name="groundedIds">["a1","a2"]';
    expect(stripStrayMarkup(text)).toBe("We hope this makes for a memorable trip!");
  });

  it("truncates at any tag-like fragment, not just </explanation>", () => {
    expect(stripStrayMarkup("Enjoy your trip.<br>Extra junk")).toBe("Enjoy your trip.");
  });

  it("does not mistake a bare less-than sign for a tag", () => {
    expect(stripStrayMarkup("Book at least <3 days ahead for the best rates.")).toBe(
      "Book at least <3 days ahead for the best rates.",
    );
  });

  it("does not mistake a price comparison for a tag", () => {
    expect(stripStrayMarkup("Rooms starting < $50/night.")).toBe("Rooms starting < $50/night.");
  });

  it("falls back to the original text when stripping would leave nothing", () => {
    const text = "<parameter name=\"groundedIds\">[\"a1\"]";
    expect(stripStrayMarkup(text)).toBe(text);
  });
});
