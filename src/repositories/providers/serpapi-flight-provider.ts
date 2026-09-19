import "server-only";
import { findAirportByIata } from "@/src/domain/airport-lookup";
import type { GeneratedFlightOption } from "@/src/domain/flight-generator";
import { FlightProviderError, type FlightSearchProvider, type FlightSearchProviderQuery } from "../flight-provider";
import { mapSerpApiResponse, type SerpApiFlightsResponse } from "./serpapi-flight-mapper";

const SERPAPI_BASE_URL = "https://serpapi.com/search.json";

/**
 * The real (only, for the live app) flight data source, backing
 * `docs/IMPLEMENTATION_PLAN.md`'s SerpAPI-only-flights integration. Pure
 * HTTP client + auth — the actual response parsing lives in
 * `serpapi-flight-mapper.ts`'s `mapSerpApiResponse` (split out so it's
 * unit-testable without `"server-only"` throwing outside a real
 * React-server-conditions environment, same reason no other provider client
 * in this codebase has unit tests). Caching/rate-limit management (the free
 * tier: 250 searches/month, 50/hour) is the caller's job
 * (`findFlightsFromProvider`, `src/repositories/flights.ts`), not this
 * class's — same shape as `AnthropicModelClient`/`VoyageEmbeddingClient`.
 */
export class SerpApiFlightProvider implements FlightSearchProvider {
  readonly name = "serpapi";
  private readonly apiKey: string;

  constructor(apiKey: string | undefined = process.env.SERPAPI_API_KEY) {
    if (!apiKey) {
      throw new Error("SerpApiFlightProvider: SERPAPI_API_KEY is not set.");
    }
    this.apiKey = apiKey;
  }

  async search(query: FlightSearchProviderQuery): Promise<GeneratedFlightOption[]> {
    const originAirport = findAirportByIata(query.originAirportCode);
    const destinationAirport = findAirportByIata(query.destinationAirportCode);
    if (!originAirport || !destinationAirport) {
      throw new FlightProviderError(
        `SerpApiFlightProvider: unknown airport code (${query.originAirportCode} / ${query.destinationAirportCode})`,
        null,
      );
    }

    const url = new URL(SERPAPI_BASE_URL);
    url.searchParams.set("engine", "google_flights");
    url.searchParams.set("departure_id", query.originAirportCode);
    url.searchParams.set("arrival_id", query.destinationAirportCode);
    url.searchParams.set("outbound_date", query.departureDate);
    url.searchParams.set("type", "2"); // one way — flight-step.ts always searches outbound/return as two separate one-way legs
    url.searchParams.set("currency", "USD");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", this.apiKey);

    let response: Response;
    try {
      response = await fetch(url.toString());
    } catch (err) {
      throw new FlightProviderError("SerpAPI request failed", err);
    }
    if (!response.ok) {
      throw new FlightProviderError(`SerpAPI request failed: ${response.status} ${response.statusText}`, null);
    }

    let json: SerpApiFlightsResponse;
    try {
      json = await response.json();
    } catch (err) {
      throw new FlightProviderError("SerpAPI returned a non-JSON response", err);
    }

    const mapped = mapSerpApiResponse(json, originAirport.tz, destinationAirport.tz);
    // TEMPORARY DIAGNOSTIC (2026-09-18) — three different live routes all
    // returned zero flights today with no thrown provider error, meaning
    // `mapSerpApiResponse` isn't throwing but also isn't producing options.
    // No access to Vercel's server logs from here, so surface the raw
    // response shape through the existing client-visible error path instead.
    // Remove once root-caused.
    if (mapped.length === 0) {
      throw new FlightProviderError(
        `DIAGNOSTIC: zero mapped options. keys=${Object.keys(json).join(",")} status=${json.search_metadata?.status ?? "none"} error=${json.error ?? "none"} bestFlights=${json.best_flights?.length ?? "undefined"} otherFlights=${json.other_flights?.length ?? "undefined"} raw=${JSON.stringify(json).slice(0, 500)}`,
        null,
      );
    }
    return mapped;
  }
}
