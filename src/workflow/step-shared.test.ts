import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { RequirementFieldName } from "@/src/domain/extraction";

vi.mock("@/src/repositories/destinations");

import {
  getDestinationByName,
  listDestinationCountries,
  listDestinationsByCountry,
  matchDestinationsByName,
} from "@/src/repositories/destinations";
import {
  UnknownAirportError,
  checkAirportReadiness,
  checkDestinationReadiness,
  checkOriginReadiness,
  resolveFlightAirport,
} from "./step-shared";

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

  it("falls back to the nearest real airport for a city with none of its own (the live Sintra, Portugal case)", () => {
    const result = resolveFlightAirport(TRIP_ID, "Sintra, Portugal", undefined);
    expect("resolved" in result && result.resolved.iata).toBe("CAT");
  });

  it("only throws UnknownAirportError once the nearest-airport fallback also comes back empty", () => {
    expect(() => resolveFlightAirport(TRIP_ID, "Nowheresville", undefined)).toThrow(UnknownAirportError);
  });

  it("throws rather than falling back to a same-named place in the wrong country (the Tuscany regression)", () => {
    expect(() => resolveFlightAirport(TRIP_ID, "Tuscany, Italy", undefined)).toThrow(UnknownAirportError);
  });
});

describe("checkDestinationReadiness", () => {
  it("returns no pending clarification when destination isn't present yet", async () => {
    const result = await checkDestinationReadiness(supabase, reqs({ origin: "Boston" }), TRIP_ID);
    expect(result).toEqual([]);
    expect(matchDestinationsByName).not.toHaveBeenCalled();
  });

  it("returns no pending clarification when the destination resolves exactly", async () => {
    vi.mocked(matchDestinationsByName).mockResolvedValue({
      exact: { id: "d1", name: "Madrid", country: "Spain" } as never,
      fuzzyCandidates: [],
    });
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Madrid" }), TRIP_ID);
    expect(result).toEqual([]);
  });

  it("asks to confirm a single fuzzy match (the New York -> New York City case), even though New York is also a US state name", async () => {
    // listDestinationCountries is checked before the fuzzy candidates (see
    // the function's own comment on why) but finds nothing here — "New
    // York" isn't a country — so this falls through to the fuzzy match,
    // which correctly wins over the state check for this exact real case.
    vi.mocked(listDestinationCountries).mockResolvedValue(["Portugal", "Spain"]);
    vi.mocked(matchDestinationsByName).mockResolvedValue({
      exact: null,
      fuzzyCandidates: [{ id: "d1", name: "New York City", country: "United States" } as never],
    });
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "New York" }), TRIP_ID);
    expect(result).toEqual([{ cityQuery: "New York", candidates: ["New York City"], regionKind: null }]);
  });

  it("asks which one for multiple fuzzy matches", async () => {
    vi.mocked(listDestinationCountries).mockResolvedValue([]);
    vi.mocked(matchDestinationsByName).mockResolvedValue({
      exact: null,
      fuzzyCandidates: [
        { id: "d1", name: "Springfield" } as never,
        { id: "d2", name: "New Springfield" } as never,
      ],
    });
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Springfield" }), TRIP_ID);
    expect(result[0].candidates).toEqual(["Springfield", "New Springfield"]);
    expect(result[0].regionKind).toBeNull();
  });

  it("asks for a specific city when the destination is a recognized US state with no fuzzy match of its own (the New Hampshire case)", async () => {
    vi.mocked(listDestinationCountries).mockResolvedValue(["Portugal", "Spain"]);
    vi.mocked(matchDestinationsByName).mockResolvedValue({ exact: null, fuzzyCandidates: [] });
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "New Hampshire" }), TRIP_ID);
    expect(result).toEqual([{ cityQuery: "New Hampshire", candidates: [], regionKind: "state" }]);
  });

  it("prefers a country match over a coincidental fuzzy substring collision (Spain vs. the seeded Port of Spain)", async () => {
    vi.mocked(listDestinationCountries).mockResolvedValue(["Spain", "Trinidad and Tobago"]);
    vi.mocked(listDestinationsByCountry).mockResolvedValue([
      { id: "d1", name: "Madrid", country: "Spain" } as never,
      { id: "d2", name: "Barcelona", country: "Spain" } as never,
    ]);
    vi.mocked(matchDestinationsByName).mockResolvedValue({
      exact: null,
      fuzzyCandidates: [{ id: "d3", name: "Port of Spain", country: "Trinidad and Tobago" } as never],
    });
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Spain" }), TRIP_ID);
    expect(result).toEqual([{ cityQuery: "Spain", candidates: ["Madrid", "Barcelona"], regionKind: "country" }]);
  });

  it("asks for a specific city, listing real options, when the destination is a whole seeded country", async () => {
    vi.mocked(matchDestinationsByName).mockResolvedValue({ exact: null, fuzzyCandidates: [] });
    vi.mocked(listDestinationCountries).mockResolvedValue(["Spain", "France"]);
    vi.mocked(listDestinationsByCountry).mockResolvedValue([
      { id: "d1", name: "Madrid", country: "Spain" } as never,
      { id: "d2", name: "Barcelona", country: "Spain" } as never,
    ]);
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Spain" }), TRIP_ID);
    expect(result).toEqual([{ cityQuery: "Spain", candidates: ["Madrid", "Barcelona"], regionKind: "country" }]);
  });

  it("is case-insensitive when matching a seeded country", async () => {
    vi.mocked(matchDestinationsByName).mockResolvedValue({ exact: null, fuzzyCandidates: [] });
    vi.mocked(listDestinationCountries).mockResolvedValue(["Spain"]);
    vi.mocked(listDestinationsByCountry).mockResolvedValue([{ id: "d1", name: "Madrid", country: "Spain" } as never]);
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "spain" }), TRIP_ID);
    expect(result[0].regionKind).toBe("country");
  });

  it("returns no pending clarification for a genuinely unknown destination (not a state/country either)", async () => {
    vi.mocked(matchDestinationsByName).mockResolvedValue({ exact: null, fuzzyCandidates: [] });
    vi.mocked(listDestinationCountries).mockResolvedValue(["Spain", "France"]);
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Nowheresville" }), TRIP_ID);
    expect(result).toEqual([]);
  });

  it("asks which one, state or country, for a name that's both a real US state and a real seeded country (the Georgia collision)", async () => {
    vi.mocked(matchDestinationsByName).mockResolvedValue({ exact: null, fuzzyCandidates: [] });
    vi.mocked(listDestinationCountries).mockResolvedValue(["Spain", "Georgia"]);
    vi.mocked(listDestinationsByCountry).mockResolvedValue([
      { id: "d1", name: "Tbilisi", country: "Georgia" } as never,
      { id: "d2", name: "Batumi", country: "Georgia" } as never,
    ]);
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Georgia" }), TRIP_ID);
    expect(result).toEqual([{ cityQuery: "Georgia", candidates: ["Tbilisi", "Batumi"], regionKind: "state_or_country" }]);
  });

  it("still asks the plain country question for a seeded country with no US-state name collision", async () => {
    vi.mocked(matchDestinationsByName).mockResolvedValue({ exact: null, fuzzyCandidates: [] });
    vi.mocked(listDestinationCountries).mockResolvedValue(["Japan"]);
    vi.mocked(listDestinationsByCountry).mockResolvedValue([{ id: "d1", name: "Tokyo", country: "Japan" } as never]);
    const result = await checkDestinationReadiness(supabase, reqs({ destination: "Japan" }), TRIP_ID);
    expect(result).toEqual([{ cityQuery: "Japan", candidates: ["Tokyo"], regionKind: "country" }]);
  });
});

describe("checkOriginReadiness", () => {
  it("returns no pending clarification when origin isn't present yet", () => {
    expect(checkOriginReadiness(reqs({ destination: "Lisbon" }))).toEqual([]);
  });

  it("asks for a specific city when origin is a bare US state name (the Texas case)", () => {
    const result = checkOriginReadiness(reqs({ origin: "Texas" }));
    expect(result).toEqual([{ cityQuery: "Texas" }]);
  });

  it("is case-insensitive", () => {
    const result = checkOriginReadiness(reqs({ origin: "texas" }));
    expect(result).toEqual([{ cityQuery: "texas" }]);
  });

  it("does flag 'New York' too, even though it's usually meant as the city — unlike destination, origin has no fuzzy city catalog to resolve the ambiguity against, so this deliberately asks rather than guessing", () => {
    expect(checkOriginReadiness(reqs({ origin: "New York" }))).toEqual([{ cityQuery: "New York" }]);
  });

  it("does not flag a non-US country or vague region — out of scope for this deterministic check (left to the model's own judgment)", () => {
    expect(checkOriginReadiness(reqs({ origin: "Canada" }))).toEqual([]);
    expect(checkOriginReadiness(reqs({ origin: "the Midwest" }))).toEqual([]);
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
