/**
 * The finalized trip review page (PROJECT_BRIEF.md §14 UX rework,
 * 2026-09-19) — replaces `TripWorkspace` once `trips.status === "finalized"`
 * (see `app/app/trips/[identifier]/page.tsx`'s branch). A finalized trip is
 * immutable: flight/hotel/activities are locked (no more "Change" —
 * `ItineraryPanel`'s own `finalized` branch, unchanged) and chat can no
 * longer drive a revision (`ChatHistoryPanel` is read-only, no input at
 * all), so unlike `ItineraryPanel` this needs no client state, no Realtime
 * subscription, and no interactivity beyond the one chat-history toggle —
 * a plain server component fetches once and renders.
 */
import Link from "next/link";
import type { ChatMessage } from "./chat-panel";
import { ChatHistoryPanel } from "./chat-history-panel";
import { ItineraryText } from "./itinerary-text";
import { formatFlightTime, formatMoney, formatTime } from "@/src/domain/itinerary-format";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";
import type { ProposedScheduledActivity } from "@/src/workflow/activities-step";

export interface TripReviewProps {
  tripName: string | null;
  summaryLine: string | null;
  flight: { outboundFlight: Flight; returnFlight: Flight } | null;
  hotel: Hotel | null;
  activities: ProposedScheduledActivity[] | null;
  itineraryText: string | null;
  totalEstimate: { amount: number; currency: string } | undefined;
  messages: ChatMessage[];
}

export function TripReview({
  tripName,
  summaryLine,
  flight,
  hotel,
  activities,
  itineraryText,
  totalEstimate,
  messages,
}: TripReviewProps) {
  const sortedActivities = activities
    ? [...activities].sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1))
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-4 border-b border-sand-200 px-6 py-6 sm:px-10">
        <div className="flex items-center gap-3">
          <h1 className="font-serif text-2xl font-semibold text-navy-900 sm:text-3xl">
            {tripName ?? "Untitled trip"}
          </h1>
          <span className="inline-flex flex-shrink-0 items-center rounded-full bg-teal-700 px-3 py-1 text-xs font-semibold text-sand-50">
            Finalized
          </span>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/app/new" className="text-sm font-medium text-teal-700 hover:text-teal-800">
            New trip
          </Link>
          <ChatHistoryPanel messages={messages} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-10 sm:px-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-9">
          {summaryLine ? <p className="text-base text-navy-400">{summaryLine}</p> : null}

          <div className="flex flex-col gap-8">
            {flight ? (
              <section>
                <h3 className="text-sm font-semibold tracking-wide text-navy-400 uppercase">Flight</h3>
                <div className="mt-3 rounded-2xl border border-teal-200 bg-teal-50 px-6 py-5">
                  <div className="flex items-start gap-2.5">
                    <CheckIcon />
                    <div>
                      <p className="text-lg text-navy-700">
                        {flight.outboundFlight.airline ?? "Flight"} —{" "}
                        {formatMoney({
                          amount: flight.outboundFlight.price_usd + flight.returnFlight.price_usd,
                          currency: "USD",
                        })}{" "}
                        round trip
                      </p>
                      <p className="mt-1.5 text-sm text-teal-700">
                        {formatFlightTime(flight.outboundFlight.departure_time, flight.outboundFlight.departure_time_zone)} →{" "}
                        {formatFlightTime(flight.outboundFlight.arrival_time, flight.outboundFlight.arrival_time_zone)} · returning{" "}
                        {flight.returnFlight.airline ?? "flight"},{" "}
                        {formatFlightTime(flight.returnFlight.departure_time, flight.returnFlight.departure_time_zone)} →{" "}
                        {formatFlightTime(flight.returnFlight.arrival_time, flight.returnFlight.arrival_time_zone)}
                      </p>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {hotel ? (
              <section>
                <h3 className="text-sm font-semibold tracking-wide text-navy-400 uppercase">Hotel</h3>
                <div className="mt-3 rounded-2xl border border-teal-200 bg-teal-50 px-6 py-5">
                  <div className="flex items-start gap-2.5">
                    <CheckIcon />
                    <div>
                      <p className="text-lg text-navy-700">
                        {hotel.name} — {formatMoney({ amount: hotel.price_per_night_usd, currency: "USD" })}/night
                      </p>
                      <p className="mt-1.5 text-sm text-teal-700">
                        {hotel.neighborhood ?? hotel.destination}
                        {hotel.rating ? ` · ${hotel.rating}★` : ""}
                      </p>
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {sortedActivities && sortedActivities.length > 0 ? (
              <section>
                <h3 className="text-sm font-semibold tracking-wide text-navy-400 uppercase">Activities</h3>
                <ul className="mt-3 flex flex-col gap-2.5">
                  {sortedActivities.map((a) => (
                    <li key={a.id} className="text-base">
                      <span className="font-medium text-navy-900">{a.name}</span>
                      <span className="text-navy-400">
                        {" "}
                        — {a.date} · {formatTime(a.startMinutes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          {itineraryText ? (
            <>
              <hr className="border-t border-sand-200" />
              <div>
                <h2 className="mb-4 font-serif text-xl font-semibold text-navy-900 sm:text-2xl">Your itinerary</h2>
                <ItineraryText text={itineraryText} />
              </div>
            </>
          ) : null}

          {totalEstimate ? (
            <p className="text-base text-navy-700">
              Estimated total: <span className="font-semibold text-navy-900">{formatMoney(totalEstimate)}</span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" className="mt-0.5 flex-shrink-0" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="#0e4f53" />
      <path d="M6 10.5l2.5 2.5L14 7" stroke="#e7f0ef" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
