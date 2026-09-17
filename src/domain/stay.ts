/**
 * Derives the hotel stay's check-in/check-out dates from a confirmed
 * outbound+return flight pair. Extracted from
 * `src/workflow/itinerary-orchestrator.ts`'s `buildDraft` (Phase 6 continued)
 * so the stepwise chain redesign's flight->hotel cascade rule
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section) can
 * compare "did the derived dates actually change" without duplicating this
 * logic — a hotel step only needs re-searching if these dates differ from
 * what the previous flight selection produced.
 */
import { localDateInTimeZone } from "./dates";
import type { Flight } from "@/src/repositories/flights";

export interface HotelStayDates {
  /** The destination's time zone (the outbound flight's arrival time zone), used to interpret both dates in local terms. */
  destinationTimeZone: string;
  checkIn: string;
  checkOut: string;
}

/**
 * Check-in is the outbound flight's local arrival date; check-out is the
 * return flight's local departure date — both interpreted in the
 * destination's time zone, since an overnight flight can land a calendar day
 * after `departureDate` was stated.
 */
export function deriveHotelStayDates(outboundFlight: Flight, returnFlight: Flight): HotelStayDates {
  const destinationTimeZone = outboundFlight.arrival_time_zone ?? "UTC";
  return {
    destinationTimeZone,
    checkIn: localDateInTimeZone(outboundFlight.arrival_time, destinationTimeZone),
    checkOut: localDateInTimeZone(returnFlight.departure_time, destinationTimeZone),
  };
}
