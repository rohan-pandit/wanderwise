import { describe, expect, it } from "vitest";
import { parseDestinationQuery } from "./destination-query";

describe("parseDestinationQuery", () => {
  it("splits 'City, Country' into both parts, trimmed", () => {
    expect(parseDestinationQuery("Madrid, Spain")).toEqual({ city: "Madrid", country: "Spain" });
  });

  it("tolerates extra whitespace around the comma", () => {
    expect(parseDestinationQuery("  Madrid  ,  Spain  ")).toEqual({ city: "Madrid", country: "Spain" });
  });

  it("returns a null country when there's no comma", () => {
    expect(parseDestinationQuery("Madrid")).toEqual({ city: "Madrid", country: null });
  });

  it("trims a bare city with surrounding whitespace", () => {
    expect(parseDestinationQuery("  Madrid  ")).toEqual({ city: "Madrid", country: null });
  });

  it("returns a null country for a trailing comma with nothing after it", () => {
    expect(parseDestinationQuery("Madrid,")).toEqual({ city: "Madrid", country: null });
  });

  it("splits on the first comma only, leaving the rest as the country part", () => {
    expect(parseDestinationQuery("Washington, D.C., USA")).toEqual({ city: "Washington", country: "D.C., USA" });
  });
});
