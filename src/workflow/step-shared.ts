/**
 * Small helpers shared across the stepwise chain's step modules
 * (`flight-step.ts`, `hotel-step.ts`, `activities-step.ts`) and
 * `intake-orchestrator.ts`. Originally lived on `search-orchestrator.ts`/
 * `itinerary-orchestrator.ts` (the one-shot pipeline those steps replace);
 * relocated here when that pipeline was retired (stepwise chain redesign
 * slice 3, `docs/IMPLEMENTATION_PLAN.md`) since these are genuinely
 * reusable, not specific to the pipeline that used to own them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import type { ChainStep } from "@/src/domain/chain";
import type { HardConstraint } from "@/src/domain/constraints";
import {
  maxFlightPriceConstraint,
  maxHotelPriceConstraint,
  minHotelRatingConstraint,
  noRedEyeConstraint,
  refundableConstraint,
  roomAvailabilityConstraint,
  roomCapacityConstraint,
} from "@/src/domain/constraints";
import { findAirportsForCity, type Airport } from "@/src/domain/airport-lookup";
import { parseDestinationQuery } from "@/src/domain/destination-query";
import type { RequirementFieldName } from "@/src/domain/extraction";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import { isUsStateName } from "@/src/domain/region-names";
import type { RoomGroup } from "@/src/domain/rooms";
import {
  AmbiguousDestinationNameError,
  getDestinationByName,
  listDestinationCountries,
  listDestinationsByCountry,
  matchDestinationsByName,
  type Destination,
} from "@/src/repositories/destinations";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  confirmTripDecisionById,
  retireActiveTripDecisionsForField,
  supersedeOtherActiveTripDecisions,
  type TripDecisionRow,
} from "@/src/repositories/trip-decisions";
import type { TripRequirementRow } from "@/src/repositories/trip-requirements";

export function requirementMap(rows: TripRequirementRow[]): Map<RequirementFieldName, unknown> {
  const map = new Map<RequirementFieldName, unknown>();
  for (const row of rows) map.set(row.field as RequirementFieldName, row.value);
  return map;
}

/** A cancelled trip (`state-machine.ts`'s `cancel` event/`cancelled` terminal state) is terminal — no further action should be able to mutate it. Lives here (not `app/app/actions.ts`, a `"use server"` file that can only export async functions) so every Server Action can import and throw it. */
export class TripCancelledError extends Error {
  constructor(tripId: string) {
    super(`Trip ${tripId} has been cancelled — no further changes can be made to it.`);
    this.name = "TripCancelledError";
  }
}

/** A trip's stated `destination` requirement doesn't resolve to any real `destinations` row — inventory we simply don't cover, distinct from "no viable candidates" (docs/IMPLEMENTATION_PLAN.md §5). */
export class UnknownDestinationError extends Error {
  constructor(tripId: string, destinationName: string) {
    super(`Trip ${tripId}'s destination "${destinationName}" doesn't match any known destination.`);
    this.name = "UnknownDestinationError";
  }
}

/**
 * Resolves a trip's free-text `destination` requirement to its real
 * `destinations` row once, at the point a step actually needs it — closes
 * the identifier-space gap `docs/IMPLEMENTATION_PLAN.md` §5 tracked (`flights`/
 * `hotels`/`activities` used to match `destination` by name alone, with no
 * shared key against `destinations.name`, which isn't even guaranteed
 * unique). Deliberately resolved lazily per step call rather than once at
 * intake time and persisted — intake-time resolution would need new
 * deterministic workflow-state plumbing to override the Intake agent's own
 * clarification decision, or exposing the destinations catalog to the model;
 * lazy resolution closes the same gap with far less surface, and still
 * surfaces an unresolvable destination in the same chat turn, since
 * `sendMessage` auto-chains straight into the flight step once
 * `requirements_ready` is reached.
 */
export async function resolveTripDestination(
  supabase: SupabaseClient<Database>,
  reqs: Map<RequirementFieldName, unknown>,
  tripId: string,
): Promise<Destination> {
  const destinationName = reqs.get("destination") as string;
  const { city, country } = parseDestinationQuery(destinationName);
  const destination = await getDestinationByName(supabase, city, CURRENT_INVENTORY_VERSION, country);
  if (!destination) {
    throw new UnknownDestinationError(tripId, destinationName);
  }
  return destination;
}

export interface PendingDestinationClarification {
  /** The free-text the user actually gave for `destination`. */
  cityQuery: string;
  /**
   * Real destination names to confirm/pick from — non-empty means "did you
   * mean X?" (one candidate) or "which did you mean, X or Y?" (several).
   * Empty (with `regionKind` set) means `cityQuery` matched a whole US
   * state or an already-seeded country instead of any specific city.
   */
  candidates: string[];
  /** Set when `cityQuery` matched a recognized US state or an existing seeded country rather than any specific city — a different question ("which city?") than "did you mean X?". */
  regionKind: "state" | "country" | null;
}

/**
 * The destination-matching equivalent of `checkAirportReadiness` below —
 * same shape, same "fails soft, never blocks on something it can't itself
 * resolve" philosophy — gating a "which destination did you mean?"
 * clarification turn instead of "which airport?". Added 2026-09-19,
 * debugging two real stuck trips live: `matchDestinationsByName`
 * (`destinations.ts`) already knows how to fuzzy-resolve a shorthand like
 * "New York" -> "New York City" on its own, but doing that *silently* means
 * the user never finds out their exact wording didn't match anything —
 * this gate catches the non-exact case BEFORE `requirements_ready`, asks
 * for explicit confirmation instead, and only once the user confirms does
 * the `destination` requirement itself get rewritten to the exact resolved
 * name (the Intake agent does this via the ordinary `record_extraction`
 * path — see `intake.ts`'s system prompt) — so by the time any step
 * actually calls `resolveTripDestination`, it's always an exact match, and
 * `getDestinationByName`'s own silent-fuzzy-fallback is only ever a
 * defensive backstop, not the primary resolution path anymore.
 *
 * Checked in this order — deliberately not "exact -> fuzzy -> state/country",
 * see the two comments inline below for why: exact match (nothing to ask)
 * -> an already-seeded country matched exactly (ask which city, listing
 * real options) -> a fuzzy city match (ask "did you mean X?") -> a
 * recognized US state with no fuzzy match of its own (ask which city, no
 * real options to list) -> nothing recognized at all (not a clarification
 * case — left for the flight step's own `UnknownDestinationError`
 * handling, same as `checkAirportReadiness` leaves a genuinely
 * airport-less city for the flight step to report).
 */
export async function checkDestinationReadiness(
  supabase: SupabaseClient<Database>,
  reqs: Map<RequirementFieldName, unknown>,
  tripId: string,
): Promise<PendingDestinationClarification[]> {
  void tripId; // kept for signature symmetry with checkAirportReadiness; nothing here needs it (never throws).
  const destination = reqs.get("destination");
  if (typeof destination !== "string") {
    return [];
  }

  const { city, country } = parseDestinationQuery(destination);
  const match = await matchDestinationsByName(supabase, city, CURRENT_INVENTORY_VERSION, country);
  if (match.exact) {
    return [];
  }

  // Checked BEFORE the fuzzy candidates below, deliberately: an exact
  // country match is a precise hit on a real structured column, whereas
  // the fuzzy search is a plain substring scan that can coincidentally
  // false-positive on an unrelated place (found live testing this exact
  // function: "Spain" fuzzy-matches the seeded "Port of Spain" — Trinidad
  // and Tobago's capital, nothing to do with Spain — which would otherwise
  // wrongly ask "did you mean Port of Spain?" instead of the far more
  // useful "which city in Spain?").
  const countriesInCatalog = await listDestinationCountries(supabase, CURRENT_INVENTORY_VERSION);
  const matchedCountry = countriesInCatalog.find((c) => c.toLowerCase() === city.toLowerCase());
  if (matchedCountry) {
    const citiesInCountry = await listDestinationsByCountry(supabase, matchedCountry, CURRENT_INVENTORY_VERSION);
    return [{ cityQuery: destination, candidates: citiesInCountry.map((d) => d.name), regionKind: "country" }];
  }

  if (match.fuzzyCandidates.length > 0) {
    return [{ cityQuery: destination, candidates: match.fuzzyCandidates.map((d) => d.name), regionKind: null }];
  }

  // Checked AFTER the fuzzy candidates, unlike country above — deliberately
  // the opposite order, and for the opposite reason: "New York" the US
  // state and "New York City" the seeded destination share a real,
  // meaningful prefix relationship (not a coincidental substring match
  // like Spain/Port of Spain), and the concrete real case this was built
  // for (a user typing "New York" and clearly meaning the city) needs the
  // fuzzy "did you mean New York City?" to win over "which city in New
  // York?". A state whose name has no such overlap with any real
  // destination (the common case) reaches this branch regardless, since
  // fuzzyCandidates was empty.
  if (isUsStateName(city)) {
    return [{ cityQuery: destination, candidates: [], regionKind: "state" }];
  }

  return [];
}

/** A trip's origin or destination city has no scheduled-commercial airport in `src/domain/airport-lookup.ts`'s dataset — a genuine gap (no clarifying question can fix it), distinct from `AirportAmbiguousError` below. Only ever thrown by the SerpAPI-backed flight search; the seed-backed path (evals) has no airport concept at all. */
export class UnknownAirportError extends Error {
  constructor(tripId: string, cityQuery: string) {
    super(`Trip ${tripId}: no scheduled-commercial airport found for "${cityQuery}".`);
    this.name = "UnknownAirportError";
  }
}

/**
 * Resolves a free-text city (`origin`, or `destination`/`country` already
 * resolved via `resolveTripDestination`) to a single commercial airport for
 * the SerpAPI flight search. Three outcomes, in order:
 * 1. Exactly one airport serves the city — resolved silently. The
 *    overwhelmingly common case; most cities never touch the other two.
 * 2. More than one airport matches, but `airportCodeValue` (the trip's
 *    already-recorded `originAirportCode`/`destinationAirportCode`
 *    requirement, if the user already answered a disambiguation question)
 *    names one of them — resolved to that one.
 * 3. More than one airport matches and nothing disambiguates it yet — the
 *    caller gets `candidates` back instead of `resolved`, to turn into a
 *    clarification (`checkAirportReadiness` below does this for the
 *    orchestrator; a caller inside the flight step itself that somehow still
 *    sees unresolved candidates at search time — meaning readiness was
 *    checked with a different requirements snapshot than the one search
 *    actually runs against — should treat that as a real bug, not something
 *    to silently guess through).
 * Throws `UnknownAirportError` for zero candidates — see that class's
 * docstring for why that's not a clarification case.
 */
export function resolveFlightAirport(
  tripId: string,
  cityQuery: string,
  airportCodeValue: unknown,
): { resolved: Airport } | { candidates: Airport[] } {
  const candidates = findAirportsForCity(cityQuery);
  if (candidates.length === 0) {
    throw new UnknownAirportError(tripId, cityQuery);
  }
  if (candidates.length === 1) {
    return { resolved: candidates[0] };
  }
  if (typeof airportCodeValue === "string") {
    const chosen = candidates.find((a) => a.iata === airportCodeValue.toUpperCase());
    if (chosen) return { resolved: chosen };
  }
  return { candidates };
}

/** Thrown only as a bug signal, never reachable through normal use: the orchestrator's `checkAirportReadiness` gate (which runs before `requirements_ready` can ever be reached) already guarantees an unambiguous airport by the time a real search runs. Seeing this means readiness was checked against a different requirements snapshot than the one the search actually ran against. */
export class AirportAmbiguousError extends Error {
  constructor(tripId: string, cityQuery: string) {
    super(`Trip ${tripId}: "${cityQuery}" is still ambiguous at search time — this should have been resolved before requirements_ready.`);
    this.name = "AirportAmbiguousError";
  }
}

/** `resolveFlightAirport` for a caller that needs a single definite answer right now (the actual flight search), not a value it can turn into a clarification — see `AirportAmbiguousError`. */
export function resolveFlightAirportOrThrow(tripId: string, cityQuery: string, airportCodeValue: unknown): Airport {
  const result = resolveFlightAirport(tripId, cityQuery, airportCodeValue);
  if ("resolved" in result) return result.resolved;
  throw new AirportAmbiguousError(tripId, cityQuery);
}

export interface PendingAirportDisambiguation {
  field: "originAirportCode" | "destinationAirportCode";
  cityQuery: string;
  candidates: Airport[];
}

/**
 * The deterministic gate behind the SerpAPI flight search's "which airport"
 * clarification turn — the airport-search equivalent of
 * `checkRequirementsComplete` (`src/domain/extraction.ts`), but this one
 * needs a real lookup (and, for the destination side, a real DB call via
 * `resolveTripDestination`) so it can't live in that pure module. Only ever
 * meaningful once the trip's basic required fields are already complete
 * (callers should check `checkRequirementsComplete` first — this assumes
 * `origin`/`destination` are both present).
 *
 * Deliberately fails soft: if the destination doesn't resolve at all
 * (`UnknownDestinationError`/`AmbiguousDestinationNameError`) this returns
 * no pending disambiguation rather than throwing — that's a different,
 * already-handled problem (the flight step's own error path surfaces it
 * once it actually tries to search), and this gate has no business blocking
 * the turn over it. Same reasoning for a genuinely airport-less city
 * (`UnknownAirportError`): not something a clarifying question can resolve,
 * so it's left for the flight step's own error handling too.
 */
export async function checkAirportReadiness(
  supabase: SupabaseClient<Database>,
  reqs: Map<RequirementFieldName, unknown>,
  tripId: string,
): Promise<PendingAirportDisambiguation[]> {
  const origin = reqs.get("origin");
  const destination = reqs.get("destination");
  if (typeof origin !== "string" || typeof destination !== "string") {
    return [];
  }

  const pending: PendingAirportDisambiguation[] = [];
  try {
    const originResolution = resolveFlightAirport(tripId, origin, reqs.get("originAirportCode"));
    if ("candidates" in originResolution) {
      pending.push({ field: "originAirportCode", cityQuery: origin, candidates: originResolution.candidates });
    }
  } catch (err) {
    if (!(err instanceof UnknownAirportError)) throw err;
  }

  try {
    const destinationRow = await resolveTripDestination(supabase, reqs, tripId);
    const destinationQuery = `${destinationRow.name}, ${destinationRow.country}`;
    const destinationResolution = resolveFlightAirport(tripId, destinationQuery, reqs.get("destinationAirportCode"));
    if ("candidates" in destinationResolution) {
      pending.push({ field: "destinationAirportCode", cityQuery: destinationQuery, candidates: destinationResolution.candidates });
    }
  } catch (err) {
    if (!(err instanceof UnknownDestinationError) && !(err instanceof AmbiguousDestinationNameError) && !(err instanceof UnknownAirportError)) {
      throw err;
    }
  }

  return pending;
}

export function flightHardConstraints(reqs: Map<RequirementFieldName, unknown>): HardConstraint<Flight>[] {
  const constraints: HardConstraint<Flight>[] = [];
  if (reqs.get("noRedEye") === true) constraints.push(noRedEyeConstraint());
  const maxFlightPriceUsd = reqs.get("maxFlightPriceUsd");
  if (typeof maxFlightPriceUsd === "number") constraints.push(maxFlightPriceConstraint(maxFlightPriceUsd));
  return constraints;
}

export function hotelHardConstraints(reqs: Map<RequirementFieldName, unknown>, roomGroups: RoomGroup[]): HardConstraint<Hotel>[] {
  const constraints: HardConstraint<Hotel>[] = [roomCapacityConstraint(roomGroups), roomAvailabilityConstraint(roomGroups)];
  const minHotelRating = reqs.get("minHotelRating");
  if (typeof minHotelRating === "number") constraints.push(minHotelRatingConstraint(minHotelRating));
  const maxHotelPriceUsd = reqs.get("maxHotelPriceUsd");
  if (typeof maxHotelPriceUsd === "number") constraints.push(maxHotelPriceConstraint(maxHotelPriceUsd));
  if (reqs.get("refundableHotel") === true) constraints.push(refundableConstraint());
  return constraints;
}

/**
 * Persists a confirmed value for a decision field, promoting a matching
 * `"proposed"` candidate in place when one exists (stepwise chain redesign
 * slice 4 — `propose*Step` now persists its candidate list as `"proposed"`
 * rows) rather than always retiring-and-reinserting. `supersedeOtherActiveTripDecisions`
 * clears both sibling proposed candidates and any prior `"confirmed"` row
 * for the field, so this is correct both for a first-ever confirm (nothing
 * else to supersede) and for revising an already-confirmed step (a fresh
 * proposed list coexists with the still-confirmed old pick until one of the
 * new candidates is promoted here). Falls back to the original
 * retire-then-insert-as-confirmed behavior when no matching proposed row is
 * found (e.g. a direct `confirm*Step` call with no prior `propose*Step`
 * call, which every existing test that doesn't call `propose*Step` first
 * still does).
 */
export async function confirmDecisionField(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: string,
  value: Json,
  activeDecisions: TripDecisionRow[],
): Promise<void> {
  const proposedMatch = activeDecisions.find((d) => d.field === field && d.status === "proposed" && d.value === value);
  if (proposedMatch) {
    await supersedeOtherActiveTripDecisions(supabase, tripId, field, proposedMatch.id);
    await confirmTripDecisionById(supabase, tripId, proposedMatch.id);
    return;
  }
  await retireActiveTripDecisionsForField(supabase, tripId, field);
  await appendTripDecision(supabase, { tripId, field, value, source: "user_explicit", status: "confirmed" });
}

/**
 * Chain steps (`src/domain/chain.ts`'s `ChainStep`) `propose_trip_revision`
 * can target for a `revisionType: "decision"` revision (stepwise chain
 * redesign slice 4 — replaces the old flat `outboundFlight`/`returnFlight`/
 * `hotel` field-name vocabulary now that a decision revision routes through
 * `src/workflow/step-router.ts`'s per-step `reviseChainStep`, not a specific
 * `trip_decisions` field). "activities" stays excluded — which specific
 * activity to swap needs more than a step name to resolve, a carried-forward
 * scope limit, not a new gap.
 */
export const REVISABLE_CHAIN_STEPS: readonly ChainStep[] = ["flight", "hotel"];
