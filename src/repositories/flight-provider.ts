/**
 * Swappable seam for where a flight leg's real candidates actually come
 * from — the SerpAPI-only-flights integration
 * (`docs/IMPLEMENTATION_PLAN.md`). Mirrors `src/retrieval/embedding-client.ts`'s
 * shape exactly (interface + provider-specific error class, real
 * implementation isolated under `providers/`): `ModelClient`/`EmbeddingClient`
 * already establish this pattern for this codebase, and CLAUDE.md's "keep
 * provider-specific code isolated" applies just as much here.
 *
 * Deliberately airport-code-based, not city-name-based — unlike the
 * seed-backed path (`findFlights`, `src/repositories/flights.ts`, still used
 * unchanged by evals), a real flight search needs a real IATA pair. Airport
 * resolution/disambiguation (`src/workflow/step-shared.ts`'s
 * `resolveFlightAirport`/`checkAirportReadiness`) happens *before* a
 * provider is ever called — by the time `search()` runs, both codes are
 * already unambiguous.
 */
import type { GeneratedFlightOption } from "@/src/domain/flight-generator";

export interface FlightSearchProviderQuery {
  originAirportCode: string;
  destinationAirportCode: string;
  /** ISO date (YYYY-MM-DD) — the departure calendar date in the origin airport's own local time, same convention `findFlights`'s `departureDate` already uses. */
  departureDate: string;
}

export interface FlightSearchProvider {
  readonly name: string;
  search(query: FlightSearchProviderQuery): Promise<GeneratedFlightOption[]>;
}

/** What a `FlightSearchProvider` implementation throws on failure (a real HTTP/timeout/malformed-response failure, not "no flights found" — an empty array is the correct, honest result for a route that genuinely has nothing, not an error). The original error is preserved as `cause`. */
export class FlightProviderError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "FlightProviderError";
  }
}
