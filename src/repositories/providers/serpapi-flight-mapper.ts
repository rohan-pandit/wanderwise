/**
 * Pure response parsing for `serpapi-flight-provider.ts`, split out
 * separately (no `"server-only"` import, unlike that file) so it's
 * unit-testable under plain `vitest run` — every other provider client in
 * this codebase (`AnthropicModelClient`/`VoyageEmbeddingClient`) has no unit
 * tests at all precisely because `"server-only"` throws outside a real
 * React-server-conditions environment, leaving only live scripts/evals to
 * verify them. Splitting the actual HTTP+auth (needs `"server-only"`, no
 * real logic to test) from the mapping (real logic, no server-only
 * capability at risk of leaking into client code) sidesteps that gap here
 * rather than accepting it.
 */
import { zonedTimeToUtc } from "@/src/domain/dates";
import type { GeneratedFlightOption } from "@/src/domain/flight-generator";
import { FlightProviderError } from "../flight-provider";

/** Google's local-time convention for a "red-eye" — mirrors `src/domain/flight-generator.ts`'s own threshold exactly, for consistency between the two flight sources. */
const RED_EYE_START_HOUR = 21;
const RED_EYE_END_HOUR = 5;

export interface SerpApiAirportLeg {
  id?: string;
  time?: string;
}
export interface SerpApiFlightLeg {
  departure_airport?: SerpApiAirportLeg;
  arrival_airport?: SerpApiAirportLeg;
  airline?: string;
  flight_number?: string;
  travel_class?: string;
}
export interface SerpApiFlightItinerary {
  flights?: SerpApiFlightLeg[];
  total_duration?: number;
  price?: number;
}
export interface SerpApiFlightsResponse {
  search_metadata?: { status?: string };
  error?: string;
  best_flights?: SerpApiFlightItinerary[];
  other_flights?: SerpApiFlightItinerary[];
}

/** SerpAPI gives a bare local "YYYY-MM-DD HH:MM" with no offset — this reads just the hour, for the red-eye check, without needing a full timezone conversion first. */
function localHour(localDateTime: string): number {
  const match = /^\d{4}-\d{2}-\d{2} (\d{2}):\d{2}$/.exec(localDateTime);
  if (!match) {
    throw new FlightProviderError(`SerpAPI: unexpected time format "${localDateTime}"`, null);
  }
  return Number(match[1]);
}

/**
 * Maps a raw SerpAPI Google Flights response into this app's
 * `GeneratedFlightOption` shape. Every result is a single "door to door"
 * summary of one itinerary's price/departure/arrival — an itinerary's
 * individual layover segments (`flights[1..]`) aren't modeled separately,
 * matching how `src/domain/flight-generator.ts`'s synthetic flights are
 * also single point-to-point options with no leg structure of their own.
 * `originTz`/`destinationTz` must be the real IANA zones for the airport
 * codes actually searched (`src/domain/airport-lookup.ts`), since SerpAPI's
 * own per-leg times carry no offset at all.
 *
 * Throws `FlightProviderError` for a genuine failure (bad request, account
 * issue) — `json.error`, or a `search_metadata.status` other than
 * "Success". A route that legitimately has nothing that day returns `[]`,
 * not an error — same distinction `src/domain/flight-generator.ts`'s "route
 * doesn't operate on this weekday" already makes for the synthetic path.
 * SerpAPI reports that case two ways: a normal `Success` response with
 * empty flight arrays, or an `error` of exactly `SERPAPI_NO_RESULTS_ERROR`
 * (found live 2026-09-24 — it surfaced to the user as "live flight search
 * is temporarily unavailable" when it really meant "no flights").
 */
export const SERPAPI_NO_RESULTS_ERROR = "Google Flights hasn't returned any results for this query.";

export function mapSerpApiResponse(
  json: SerpApiFlightsResponse,
  originTz: string,
  destinationTz: string,
): GeneratedFlightOption[] {
  if (json.error === SERPAPI_NO_RESULTS_ERROR) {
    return [];
  }
  if (json.error) {
    throw new FlightProviderError(`SerpAPI error: ${json.error}`, null);
  }
  if (json.search_metadata?.status && json.search_metadata.status !== "Success") {
    throw new FlightProviderError(`SerpAPI search did not succeed: ${json.search_metadata.status}`, null);
  }

  const itineraries = [...(json.best_flights ?? []), ...(json.other_flights ?? [])];
  const options: GeneratedFlightOption[] = [];
  for (const itinerary of itineraries) {
    const legs = itinerary.flights ?? [];
    const first = legs[0];
    const last = legs[legs.length - 1];
    if (!first?.departure_airport?.time || !last?.arrival_airport?.time || typeof itinerary.price !== "number") {
      continue; // malformed/incomplete itinerary — skip rather than fail the whole search over one bad entry
    }

    options.push({
      departure_time: zonedTimeToUtc(first.departure_airport.time, originTz),
      arrival_time: zonedTimeToUtc(last.arrival_airport.time, destinationTz),
      departure_time_zone: originTz,
      arrival_time_zone: destinationTz,
      airline: first.airline ?? "Unknown",
      flight_number: first.flight_number ?? "",
      price_usd: itinerary.price,
      taxes_fees_usd: 0,
      cabin: first.travel_class ?? "Economy",
      is_red_eye: (() => {
        const hour = localHour(first.departure_airport.time!);
        return hour >= RED_EYE_START_HOUR || hour < RED_EYE_END_HOUR;
      })(),
      duration_minutes: itinerary.total_duration ?? 0,
      // No refundable/changeable signal exists anywhere in SerpAPI's
      // response — always `false` here, a known, deliberate limitation
      // (not fabricated data) rather than guessed. A trip requiring a
      // refundable flight will correctly find zero SerpAPI candidates.
      refundable: false,
      changeable: false,
    });
  }
  return options;
}
