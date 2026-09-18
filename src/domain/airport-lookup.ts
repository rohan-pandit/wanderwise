/**
 * Resolves a free-text city (optionally "City, Country", same shape as the
 * `destination` requirement — see `parseDestinationQuery`) to the real
 * commercial airport(s) that serve it, against the static dataset generated
 * by `scripts/generate-airport-data.ts` (`airport-data.ts`, do not hand-edit
 * that file). Exists because SerpAPI's Google Flights endpoint takes IATA
 * airport codes, not city names — this is the resolution step between a
 * trip's free-text `origin`/`destination` and a real flight search.
 *
 * Many cities have exactly one airport, in which case resolution is
 * unambiguous. Some have several (same city — "New York" -> JFK/LGA; or,
 * more surprisingly, the same city name reused across countries — "London"
 * -> London, UK's three airports *and* London, Ontario's) — callers decide
 * what to do with more than one result (the flight-search integration plan
 * asks the user which airport, via a clarification turn, rather than
 * guessing).
 */
import { parseDestinationQuery } from "./destination-query";
import { AIRPORTS_RAW } from "./airport-data";

export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  /** IANA time zone (e.g. "America/New_York") — needed to turn SerpAPI's bare local "YYYY-MM-DD HH:MM" leg times into a correctly-dated `Flight` row (`src/repositories/providers/serpapi-flight-provider.ts`). */
  tz: string;
}

const ALL_AIRPORTS: Airport[] = AIRPORTS_RAW.map(([iata, name, city, country, tz]) => ({ iata, name, city, country, tz }));

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const airportsByCity = new Map<string, Airport[]>();
for (const airport of ALL_AIRPORTS) {
  const key = normalize(airport.city);
  const list = airportsByCity.get(key);
  if (list) list.push(airport);
  else airportsByCity.set(key, [airport]);
}

const airportsByIata = new Map<string, Airport>();
for (const airport of ALL_AIRPORTS) {
  airportsByIata.set(airport.iata, airport);
}

/**
 * Looks up every scheduled-commercial airport serving the given free-text
 * city (optionally with a country, e.g. "Madrid, Spain" or "London, Canada")
 * — parsed the same way a destination requirement is (`parseDestinationQuery`).
 * When a country is given but doesn't match any airport's country for that
 * city (e.g. "London, France"), this returns `[]` rather than silently
 * falling back to a different country's airports for that city name.
 */
export function findAirportsForCity(raw: string): Airport[] {
  const { city, country } = parseDestinationQuery(raw);
  const candidates = airportsByCity.get(normalize(city)) ?? [];
  if (!country) return candidates;
  const wantedCountry = normalize(country);
  return candidates.filter((airport) => normalize(airport.country) === wantedCountry);
}

/** Looks up a single airport by its IATA code (case-insensitive) — used to resolve a user's disambiguating answer (e.g. "LHR") back to a real airport. */
export function findAirportByIata(iata: string): Airport | undefined {
  return airportsByIata.get(iata.trim().toUpperCase());
}
