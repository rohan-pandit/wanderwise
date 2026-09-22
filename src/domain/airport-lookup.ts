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
 *
 * A city with *zero* direct matches isn't necessarily a dead end either —
 * `findNearestAirportForCity` below geocodes it (real coordinates, a
 * separate dataset) and falls back to the closest real scheduled-commercial
 * airport, the same thing an actual traveler to a small town does. Found
 * necessary live 2026-09-22: a real trip to "Sintra, Portugal" (a real,
 * correctly-resolved seeded destination — Sintra genuinely has no airport
 * of its own, nearest is Lisbon, ~30km away) had no fallback at all and
 * could only ever throw `UnknownAirportError`.
 */
import { parseDestinationQuery } from "./destination-query";
import { findCityCoordinates } from "./geocoding";
import { AIRPORTS_RAW } from "./airport-data";

export interface Airport {
  iata: string;
  name: string;
  city: string;
  country: string;
  /** IANA time zone (e.g. "America/New_York") — needed to turn SerpAPI's bare local "YYYY-MM-DD HH:MM" leg times into a correctly-dated `Flight` row (`src/repositories/providers/serpapi-flight-provider.ts`). */
  tz: string;
  lat: number;
  lon: number;
}

const ALL_AIRPORTS: Airport[] = AIRPORTS_RAW.map(([iata, name, city, country, tz, lat, lon]) => ({
  iata,
  name,
  city,
  country,
  tz,
  lat,
  lon,
}));

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

/** Every real country name present in the dataset, for telling an actual "City, Country" suffix apart from something that merely sits in the same position — see `findAirportsForCity`'s docstring. */
const KNOWN_COUNTRIES = new Set(ALL_AIRPORTS.map((a) => normalize(a.country)));

/**
 * Looks up every scheduled-commercial airport serving the given free-text
 * city (optionally with a country, e.g. "Madrid, Spain" or "London, Canada")
 * — parsed the same way a destination requirement is (`parseDestinationQuery`).
 * When a country is given but doesn't match any airport's country for that
 * city (e.g. "London, France"), this returns `[]` rather than silently
 * falling back to a different country's airports for that city name.
 *
 * That "returns `[]`" rule only applies when the given "country" is a real
 * one, though — `origin` (unlike `destination`) is a free-text home city
 * that a US traveler will often state as "City, State" (e.g. "Newark, New
 * Jersey"), which `parseDestinationQuery` parses identically to "City,
 * Country" since it has no way to tell the two apart from shape alone. If
 * the parsed "country" isn't a real country anywhere in the dataset (found
 * live 2026-09-18: "Newark, New Jersey" wrongly resolved to zero airports —
 * "New Jersey" filtered out Newark's real, single, unambiguous airport
 * because no airport's `country` is literally "New Jersey"), this falls
 * back to the unfiltered city match instead of rejecting a real city over a
 * state name it was never meant to disambiguate against.
 */
export function findAirportsForCity(raw: string): Airport[] {
  const { city, country } = parseDestinationQuery(raw);
  const candidates = airportsByCity.get(normalize(city)) ?? [];
  if (!country) return candidates;
  const wantedCountry = normalize(country);
  if (!KNOWN_COUNTRIES.has(wantedCountry)) return candidates;
  return candidates.filter((airport) => normalize(airport.country) === wantedCountry);
}

/** Looks up a single airport by its IATA code (case-insensitive) — used to resolve a user's disambiguating answer (e.g. "LHR") back to a real airport. */
export function findAirportByIata(iata: string): Airport | undefined {
  return airportsByIata.get(iata.trim().toUpperCase());
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance between two lat/long points, in kilometers (haversine formula) — accurate enough for "which of ~3900 airports is closest," not aviation-grade. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The closest scheduled-commercial airport to a coordinate, by straight-line
 * distance — always returns one, since `ALL_AIRPORTS` is never empty. Used
 * as the fallback of last resort once a city's own name doesn't match any
 * airport directly (`findNearestAirportForCity` below): "nearest real
 * airport" is what an actual traveler to a small town without one does
 * anyway (fly into the nearby hub, then a train/car), not something a
 * clarifying question could improve on.
 */
export function findNearestAirport(lat: number, lon: number): Airport {
  let closest = ALL_AIRPORTS[0];
  let closestKm = haversineKm(lat, lon, closest.lat, closest.lon);
  for (const airport of ALL_AIRPORTS) {
    const km = haversineKm(lat, lon, airport.lat, airport.lon);
    if (km < closestKm) {
      closest = airport;
      closestKm = km;
    }
  }
  return closest;
}

/**
 * The full fallback chain for a city with no scheduled-commercial airport of
 * its own: geocode it (`findCityCoordinates`, `src/domain/geocoding.ts` —
 * the same broad, real, public-domain dataset regardless of whether this is
 * a seeded `destination` or an arbitrary user-typed `origin`), then find the
 * nearest real airport to those coordinates. Returns `null` when the city
 * doesn't geocode at all, or (a real, live-found danger — see
 * `findCityCoordinates`'s own docstring) when it only geocodes against a
 * *different* country than the one actually meant — genuinely not a place
 * this app can safely resolve, not something narrowable by asking "which
 * airport?"
 *
 * `preferredCountry` is used only when `raw` itself carries no country (no
 * "City, Country" comma) — this app's `origin` is scoped to the US only for
 * now (`checkOriginReadiness`'s own docstring), and a bare origin city
 * ("Sedona") never states that itself, so `flight-step.ts`/
 * `checkAirportReadiness` pass "United States" here rather than letting an
 * uncorroborated bare name fall through to whatever same-named place
 * happens to have the highest recorded population worldwide — exactly the
 * Calgary/Tuscany case `findCityCoordinates` guards against, just for a
 * query that never had a country to begin with. `destination` never needs
 * this: by the time it reaches here it's always `"City, Country"` already
 * (`flight-step.ts` builds it from the resolved `destinations` row).
 *
 * `resolveFlightAirport` (`src/workflow/step-shared.ts`) calls this only
 * after `findAirportsForCity` itself already found zero direct matches.
 */
export function findNearestAirportForCity(raw: string, preferredCountry?: string): Airport | null {
  const { city, country } = parseDestinationQuery(raw);
  const coords = findCityCoordinates(city, country ?? preferredCountry);
  if (!coords) return null;
  return findNearestAirport(coords.lat, coords.lon);
}
