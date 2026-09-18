import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { RequirementFieldName } from "@/src/domain/extraction";

vi.mock("@/src/repositories/destinations");

import { getDestinationByName } from "@/src/repositories/destinations";
import { UnknownAirportError, checkAirportReadiness, resolveFlightAirport } from "./step-shared";

const supabase = {} as SupabaseClient<Database>;
const TRIP_ID = "trip-1";

function reqs(entries: Partial<Record<RequirementFieldName, unknown>>): Map<RequirementFieldName, unknown> {
  return new Map(Object.entries(entries) as [RequirementFieldName, unknown][]);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("resolveFlightAirport", () => {
  it("resolves an unambiguous city silently", () => {
    const result = resolveFlightAirport(TRIP_ID, "Madrid", undefined);
    expect("resolved" in result && result.resolved.iata).toBe("MAD");
  });

  it("returns candidates for an ambiguous city with no stored answer", () => {
    const result = resolveFlightAirport(TRIP_ID, "New York", undefined);
    expect("candidates" in result && result.candidates.map((a) => a.iata).sort()).toEqual(["JFK", "LGA"]);
  });

  it("resolves to the stored airport code once one was recorded", () => {
    const result = resolveFlightAirport(TRIP_ID, "New York", "JFK");
    expect("resolved" in result && result.resolved.iata).toBe("JFK");
  });

  it("is case-insensitive when matching a stored airport code", () => {
    const result = resolveFlightAirport(TRIP_ID, "New York", "jfk");
    expect("resolved" in result && result.resolved.iata).toBe("JFK");
  });

  it("falls back to candidates if the stored code doesn't match any real candidate", () => {
    const result = resolveFlightAirport(TRIP_ID, "New York", "ZZZ");
    expect("candidates" in result).toBe(true);
  });

  it("throws UnknownAirportError for a city with no scheduled-commercial airport", () => {
    expect(() => resolveFlightAirport(TRIP_ID, "Nowheresville", undefined)).toThrow(UnknownAirportError);
  });
});

describe("checkAirportReadiness", () => {
  it("returns no pending disambiguation when origin/destination aren't both present yet", async () => {
    const result = await checkAirportReadiness(supabase, reqs({ origin: "New York" }), TRIP_ID);
    expect(result).toEqual([]);
  });

  it("returns no pending disambiguation when both sides are unambiguous", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue({ id: "d1", name: "Madrid", country: "Spain" } as never);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "Madrid", destination: "Madrid" }), TRIP_ID);
    expect(result).toEqual([]);
  });

  it("flags the origin side when it's ambiguous", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue({ id: "d1", name: "Madrid", country: "Spain" } as never);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "New York", destination: "Madrid" }), TRIP_ID);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("originAirportCode");
    expect(result[0].candidates.map((a) => a.iata).sort()).toEqual(["JFK", "LGA"]);
  });

  it("flags the destination side when it's ambiguous, using the resolved destination's own country", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue({ id: "d1", name: "London", country: "United Kingdom" } as never);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "Madrid", destination: "London" }), TRIP_ID);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("destinationAirportCode");
    expect(result[0].candidates.every((a) => a.country === "United Kingdom")).toBe(true);
  });

  it("resolves the destination side once its stored airport code is present", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue({ id: "d1", name: "London", country: "United Kingdom" } as never);
    const result = await checkAirportReadiness(
      supabase,
      reqs({ origin: "Madrid", destination: "London", destinationAirportCode: "LHR" }),
      TRIP_ID,
    );
    expect(result).toEqual([]);
  });

  it("flags both sides when both are ambiguous", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue({ id: "d1", name: "London", country: "United Kingdom" } as never);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "New York", destination: "London" }), TRIP_ID);
    expect(result.map((p) => p.field).sort()).toEqual(["destinationAirportCode", "originAirportCode"]);
  });

  it("fails soft (no pending disambiguation) when the destination doesn't resolve at all", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue(null);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "Madrid", destination: "Atlantis" }), TRIP_ID);
    expect(result).toEqual([]);
  });

  it("still flags an ambiguous origin even when the destination doesn't resolve", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue(null);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "New York", destination: "Atlantis" }), TRIP_ID);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe("originAirportCode");
  });

  it("fails soft when the destination resolves but has no scheduled-commercial airport", async () => {
    vi.mocked(getDestinationByName).mockResolvedValue({ id: "d1", name: "Nowheresville", country: "Nowhere" } as never);
    const result = await checkAirportReadiness(supabase, reqs({ origin: "Madrid", destination: "Nowheresville" }), TRIP_ID);
    expect(result).toEqual([]);
  });
});
