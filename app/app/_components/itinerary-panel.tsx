"use client";

/**
 * The live itinerary panel (PROJECT_BRIEF.md §14, Phase 7) — the other half
 * of the core product experience alongside `chat-panel.tsx`. Renders
 * `trip_decisions` as they're written, live, via a Supabase Realtime
 * subscription (`postgres_changes` INSERT+UPDATE on `trip_decisions`,
 * INSERT on `trip_events`, filtered to this trip). Both tables already have
 * owner-scoped RLS (`supabase/migrations/0001_initial_schema.sql`), so the
 * anon-key browser client only ever receives this user's own rows.
 *
 * Slice 4 (stepwise chain redesign) rework — the hybrid interaction model:
 * the current chain step's candidates render as clickable cards that call
 * Server Actions directly (`app/app/actions.ts`'s `propose*Candidates`/
 * `confirm*Candidate`), no LLM round trip for the common pick/confirm path.
 * An already-confirmed step gets a "Change" button; revising a step with
 * confirmed work downstream shows a warning banner (`pendingCascade` prop,
 * owned by `TripWorkspace`) before anything is retired. Once every step is
 * confirmed, a "Finalize trip" button appears.
 *
 * Candidate-loading design note (why this isn't a naive "whenever
 * `decisions` changes, re-propose" effect): `propose*Step` re-persists a
 * fresh candidate list every time it's called, so a reactive effect keyed
 * on the full `decisions` array would refire on its own writes. Flight/
 * hotel proposals are cheap deterministic queries, so a one-time harmless
 * double-fetch on first load is fine (see the signature-keyed refs below).
 * Activities is not cheap — `proposeActivitiesStep` makes a real Curator LLM
 * call — so it's guarded by a plain once-per-step-transition ref instead,
 * and the confirm-hotel handler sets that ref *synchronously, before*
 * awaiting the confirm action, closing the race where a Realtime-delivered
 * "activities proposed" event (from this same confirm's own server-side
 * `advanceOrRefreshChain` call) could otherwise trigger a second, redundant
 * Curator call before the handler's own response comes back.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/src/config/supabase/client";
import {
  STEP_DECISION_FIELDS,
  getCurrentChainStep,
  revisionRisksConfirmedWork,
  type ChainDecision,
  type ChainStep,
} from "@/src/domain/chain";
import { parseMarkdownLite, type InlineSegment } from "@/src/domain/markdown-lite";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";
import {
  confirmActivitiesCandidate,
  confirmCascadeAndRevise,
  confirmFlightCandidate,
  confirmHotelCandidate,
  finalizeTrip,
  proposeActivitiesCandidate,
  proposeFlightCandidates,
  proposeHotelCandidates,
  type PendingCascadeConfirmation,
} from "../actions";
import type { FlightStepCandidate } from "@/src/workflow/flight-step";
import type { ProposeActivitiesStepResult, ProposedScheduledActivity } from "@/src/workflow/activities-step";

interface DecisionRow {
  id: string;
  field: string;
  value: unknown;
  status: string;
}

interface BudgetDecision {
  totalEstimate?: { amount: number; currency: string };
  remaining?: { amount: number; currency: string };
  violations?: { message: string }[];
}

const STEP_LABELS: Record<ChainStep, string> = { flight: "Flight", hotel: "Hotel", activities: "Activities" };
const DOWNSTREAM_LABEL: Record<ChainStep, string> = { flight: "hotel and activities", hotel: "activities", activities: "" };

function formatMoney(m?: { amount: number; currency: string }): string | null {
  if (!m) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(m.amount);
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatFlightTime(iso: string, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timeZone ?? "UTC",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function renderInline(segments: InlineSegment[], keyPrefix: string): ReactNode[] {
  return segments.map((segment, i) => {
    const key = `${keyPrefix}-${i}`;
    if (segment.type === "bold") return <strong key={key}>{segment.text}</strong>;
    if (segment.type === "italic") return <em key={key}>{segment.text}</em>;
    return segment.text;
  });
}

/** Renders the Itinerary Writer agent's free-text output (`src/domain/markdown-lite.ts` — a narrow Markdown subset, not a general renderer). */
function ItineraryText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm text-navy-700">
      {parseMarkdownLite(text).map((block, i) => {
        const key = `md-${i}`;
        if (block.type === "heading") {
          const className = "font-serif font-semibold text-navy-900";
          if (block.level === 1) return <h3 key={key} className={`${className} text-base`}>{renderInline(block.inline, key)}</h3>;
          if (block.level === 2) return <h4 key={key} className={`${className} text-sm`}>{renderInline(block.inline, key)}</h4>;
          return <h5 key={key} className={`${className} text-sm`}>{renderInline(block.inline, key)}</h5>;
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={key} className={block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>
              {block.items.map((item, j) => (
                <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={key}>{renderInline(block.inline, key)}</p>;
      })}
    </div>
  );
}

const OPTIMISTIC_ID_PREFIX = "optimistic:";

/**
 * Inserting/updating by row `id` alone isn't enough once optimistic rows
 * exist (see `optimisticConfirm` below) — a genuine Realtime-delivered row
 * for the same field has a different (real) id, so it would otherwise sit
 * alongside the optimistic one instead of replacing it. Drop any leftover
 * optimistic row for the same field whenever a real one for that field
 * arrives, in addition to the normal upsert-by-id.
 */
function upsertById(rows: DecisionRow[], row: DecisionRow): DecisionRow[] {
  const withoutStaleOptimistic = row.id.startsWith(OPTIMISTIC_ID_PREFIX)
    ? rows
    : rows.filter((r) => !(r.field === row.field && r.id.startsWith(OPTIMISTIC_ID_PREFIX)));
  const idx = withoutStaleOptimistic.findIndex((r) => r.id === row.id);
  if (idx === -1) return [...withoutStaleOptimistic, row];
  const next = [...withoutStaleOptimistic];
  next[idx] = row;
  return next;
}

/**
 * Merges a just-confirmed field's value into `decisions` immediately,
 * rather than waiting for Supabase Realtime to deliver the same row —
 * `flightConfirmed`/`activeStep`/`confirmedActivities`/etc. below all
 * derive from `decisions`, and confirming shouldn't visibly stall on
 * Realtime's own latency when the confirm action itself already returned
 * the authoritative result. A stable per-field id (not a random one) means
 * confirming the same field twice in a row (a revision) replaces the prior
 * optimistic row instead of accumulating stale ones.
 */
function optimisticConfirm(rows: DecisionRow[], field: string, value: unknown): DecisionRow[] {
  const withoutPriorForField = rows.filter((r) => r.field !== field);
  return [...withoutPriorForField, { id: `${OPTIMISTIC_ID_PREFIX}${field}`, field, value, status: "confirmed" }];
}

function confirmedValue(decisions: DecisionRow[], field: string): string | undefined {
  return decisions.find((d) => d.field === field && d.status === "confirmed")?.value as string | undefined;
}

function proposedSignature(step: ChainStep, decisions: DecisionRow[]): string {
  return STEP_DECISION_FIELDS[step]
    .flatMap((field) => decisions.filter((d) => d.field === field && d.status === "proposed").map((d) => String(d.value)))
    .sort()
    .join(",");
}

export function ItineraryPanel({
  tripId,
  initialTripStatus,
  pendingCascade,
  onPendingCascade,
}: {
  tripId: string;
  initialTripStatus: string;
  pendingCascade: PendingCascadeConfirmation | null;
  onPendingCascade: (pending: PendingCascadeConfirmation | null) => void;
}) {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [initialLoad, setInitialLoad] = useState(true);
  const [needsAttention, setNeedsAttention] = useState<string | null>(null);

  const [flightCandidates, setFlightCandidates] = useState<FlightStepCandidate[] | null>(null);
  const [hotelCandidates, setHotelCandidates] = useState<Hotel[] | null>(null);
  const [activitiesProposal, setActivitiesProposal] = useState<ProposeActivitiesStepResult | null>(null);

  const [revisingFlightCandidates, setRevisingFlightCandidates] = useState<FlightStepCandidate[] | null>(null);
  const [revisingHotelCandidates, setRevisingHotelCandidates] = useState<Hotel[] | null>(null);

  const [confirmedFlightSummary, setConfirmedFlightSummary] = useState<{ outboundFlight: Flight; returnFlight: Flight } | null>(null);
  const [confirmedHotelSummary, setConfirmedHotelSummary] = useState<Hotel | null>(null);

  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [finalized, setFinalized] = useState(initialTripStatus === "finalized");
  const [budgetOverrideViolations, setBudgetOverrideViolations] = useState<{ message: string }[] | null>(null);

  const flightSigRef = useRef<string | null>(null);
  const hotelSigRef = useRef<string | null>(null);
  const activitiesLoadedRef = useRef(false);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      await supabase.auth.getSession();
      if (cancelled) return;

      const { data, error } = await supabase
        .from("trip_decisions")
        .select("id, field, value, status")
        .eq("trip_id", tripId)
        .neq("status", "superseded");
      if (error) console.error("initial trip_decisions fetch failed:", error);
      if (!cancelled) {
        if (data) setDecisions(data as DecisionRow[]);
        setInitialLoad(false);
      }
    })();

    const channel = supabase
      .channel(`trip-${tripId}-decisions`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trip_decisions", filter: `trip_id=eq.${tripId}` },
        (payload) => setDecisions((prev) => upsertById(prev, payload.new as DecisionRow)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "trip_decisions", filter: `trip_id=eq.${tripId}` },
        (payload) => setDecisions((prev) => upsertById(prev, payload.new as DecisionRow)),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trip_events", filter: `trip_id=eq.${tripId}` },
        (payload) => {
          const row = payload.new as { event_type: string; payload?: { message?: string } };
          if (row.event_type === "recoverable_error" || row.event_type === "itinerary_invalid") {
            setNeedsAttention(
              row.event_type === "recoverable_error"
                ? "No matching flights/hotels were found for this trip — try adjusting the dates or budget."
                : "That combination didn't work out — trying again with different options.",
            );
          } else if (row.event_type === "chain_revision_failed" || row.event_type === "chain_propose_failed") {
            // Both are chat-triggered fire-and-forget paths (`sendMessage`'s
            // `after()` calls to `reviseChainStep`/`proposeCurrentChainStep`
            // in `app/app/actions.ts`) with no direct caller to return a
            // `{error}` result to, so each logs its own trip_event instead —
            // this is the only place either failure reaches the user.
            setNeedsAttention(row.payload?.message ?? "That didn't go through — try again or adjust your requirements.");
          } else {
            setNeedsAttention(null);
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [tripId]);

  const confirmedDecisions: ChainDecision[] = decisions
    .filter((d) => d.status === "confirmed")
    .map((d) => ({ field: d.field, status: d.status }));
  const activeStep = getCurrentChainStep(confirmedDecisions);

  // Loads candidates for whichever step is currently active. Flight/hotel
  // are cheap and keyed by a signature of their live "proposed" ids, so a
  // chat-triggered re-propose of the still-active step is picked up
  // automatically. Activities is gated by a plain once-per-transition flag
  // instead (see the module docstring) — chat can never revise activities
  // (`REVISABLE_CHAIN_STEPS` excludes it), so the only way this ref is reset
  // is a genuine step transition, and `handleConfirmHotel` below sets it
  // pre-emptively to avoid a redundant Curator call of its own.
  useEffect(() => {
    if (initialLoad) return;
    if (activeStep === "flight") {
      const sig = proposedSignature("flight", decisions);
      if (flightSigRef.current === sig) return;
      flightSigRef.current = sig;
      void (async () => {
        try {
          const result = await proposeFlightCandidates({ tripId });
          if ("error" in result) setActionError(result.error);
          else setFlightCandidates(result.candidates);
        } catch (err) {
          console.error("proposeFlightCandidates failed:", err);
        }
      })();
    } else if (activeStep === "hotel") {
      const sig = proposedSignature("hotel", decisions);
      if (hotelSigRef.current === sig) return;
      hotelSigRef.current = sig;
      void (async () => {
        try {
          const result = await proposeHotelCandidates({ tripId });
          if ("error" in result) setActionError(result.error);
          else setHotelCandidates(result.candidates);
        } catch (err) {
          console.error("proposeHotelCandidates failed:", err);
        }
      })();
    } else if (activeStep === "activities") {
      if (activitiesLoadedRef.current) return;
      activitiesLoadedRef.current = true;
      void (async () => {
        try {
          const result = await proposeActivitiesCandidate({ tripId });
          setActivitiesProposal(result);
        } catch (err) {
          console.error("proposeActivitiesCandidate failed:", err);
        }
      })();
    }
  }, [activeStep, decisions, initialLoad, tripId]);

  async function handleConfirmFlight(outboundFlightId: string, returnFlightId: string) {
    setActionPending(true);
    setActionError(null);
    try {
      const result = await confirmFlightCandidate({ tripId, outboundFlightId, returnFlightId });
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      const { confirmed, next } = result;
      setConfirmedFlightSummary({ outboundFlight: confirmed.outboundFlight, returnFlight: confirmed.returnFlight });
      setDecisions((prev) => {
        const withOutbound = optimisticConfirm(prev, "outboundFlight", confirmed.outboundFlight.id);
        return optimisticConfirm(withOutbound, "returnFlight", confirmed.returnFlight.id);
      });
      setFlightCandidates(null);
      setRevisingFlightCandidates(null);
      if (next.step === "hotel") {
        hotelSigRef.current = proposedSignature("hotel", decisions);
        setHotelCandidates(next.result.candidates);
      } else if (next.step === "activities") {
        activitiesLoadedRef.current = true;
        setActivitiesProposal(next.result);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't confirm that flight — try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleConfirmHotel(hotelId: string) {
    // Set *before* awaiting — see the module docstring on why this closes
    // the double-Curator-call race for the hotel -> activities transition.
    activitiesLoadedRef.current = true;
    setActionPending(true);
    setActionError(null);
    try {
      const result = await confirmHotelCandidate({ tripId, hotelId });
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      const { confirmed, next } = result;
      setConfirmedHotelSummary(confirmed.hotel);
      setDecisions((prev) => optimisticConfirm(prev, "hotel", confirmed.hotel.id));
      setHotelCandidates(null);
      setRevisingHotelCandidates(null);
      if (next.step === "activities") {
        setActivitiesProposal(next.result);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't confirm that hotel — try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleConfirmActivities(scheduledActivities: ProposedScheduledActivity[]) {
    setActionPending(true);
    setActionError(null);
    try {
      const confirmed = await confirmActivitiesCandidate({ tripId, scheduledActivities });
      setDecisions((prev) => {
        let next = optimisticConfirm(prev, "activities", confirmed.scheduledActivities);
        next = optimisticConfirm(next, "budget", confirmed.budget);
        if (confirmed.itineraryText) next = optimisticConfirm(next, "itineraryText", confirmed.itineraryText);
        return next;
      });
      setActivitiesProposal(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't confirm that schedule — try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function reviseStep(step: "flight" | "hotel") {
    setActionPending(true);
    setActionError(null);
    try {
      const revised = await confirmCascadeAndRevise({ tripId, step });
      if ("error" in revised) {
        setActionError(revised.error);
        return;
      }
      if (revised.step === "flight") setRevisingFlightCandidates(revised.result.candidates);
      else if (revised.step === "hotel") setRevisingHotelCandidates(revised.result.candidates);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't load new options — try again.");
    } finally {
      setActionPending(false);
    }
  }

  function handleChangeClick(step: "flight" | "hotel") {
    if (revisionRisksConfirmedWork(step, confirmedDecisions)) {
      onPendingCascade({ kind: "decision", step, field: step });
      return;
    }
    void reviseStep(step);
  }

  async function handleConfirmCascade() {
    if (!pendingCascade) return;
    const step = pendingCascade.step;
    onPendingCascade(null);
    if (step === "flight" || step === "hotel") {
      await reviseStep(step);
    }
  }

  async function handleFinalize(overrideBudgetCeiling = false) {
    setActionPending(true);
    setActionError(null);
    try {
      const result = await finalizeTrip({ tripId, overrideBudgetCeiling });
      if ("requiresBudgetOverride" in result) {
        setBudgetOverrideViolations(result.violations);
        return;
      }
      setBudgetOverrideViolations(null);
      setFinalized(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't finalize this trip — try again.");
    } finally {
      setActionPending(false);
    }
  }

  const itineraryText = (decisions.find((d) => d.field === "itineraryText" && d.status === "confirmed")?.value as string | undefined) ?? null;
  const budget = decisions.find((d) => d.field === "budget" && d.status === "confirmed")?.value as BudgetDecision | undefined;
  const totalEstimate = formatMoney(budget?.totalEstimate);
  const confirmedActivities = decisions.find((d) => d.field === "activities" && d.status === "confirmed")?.value as
    | ProposedScheduledActivity[]
    | undefined;

  const flightOutboundId = confirmedValue(decisions, "outboundFlight");
  const flightReturnId = confirmedValue(decisions, "returnFlight");
  const flightConfirmed = Boolean(flightOutboundId && flightReturnId);
  const hotelId = confirmedValue(decisions, "hotel");
  const hotelConfirmed = Boolean(hotelId);

  return (
    <aside className="flex w-96 flex-shrink-0 flex-col overflow-y-auto border-l border-sand-200 px-6 py-6">
      <h2 className="font-serif text-lg font-semibold text-navy-900">Your itinerary</h2>

      {needsAttention ? (
        <p className="mt-4 rounded-lg bg-terracotta-50 px-3 py-2 text-xs text-terracotta-600">
          {needsAttention}
        </p>
      ) : null}

      {pendingCascade ? (
        <div className="mt-4 rounded-lg border border-terracotta-200 bg-terracotta-50 px-3 py-3 text-xs text-terracotta-700">
          <p>
            Changing your {STEP_LABELS[pendingCascade.step]} may also change your {DOWNSTREAM_LABEL[pendingCascade.step]}. Continue?
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={actionPending}
              onClick={() => void handleConfirmCascade()}
              className="rounded-md bg-terracotta-600 px-3 py-1 text-sand-50 disabled:opacity-50"
            >
              Continue
            </button>
            <button
              type="button"
              disabled={actionPending}
              onClick={() => onPendingCascade(null)}
              className="rounded-md border border-terracotta-200 px-3 py-1 text-terracotta-700 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {actionError ? <p className="mt-4 text-xs text-red-600">{actionError}</p> : null}

      {initialLoad ? (
        <p className="mt-4 text-sm text-navy-400">Loading your itinerary…</p>
      ) : (
        <div className="mt-4 flex flex-col gap-5">
          {/* Flight step */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Flight</h3>
            {flightConfirmed && !revisingFlightCandidates ? (
              <div className="mt-2 rounded-lg border border-sand-200 px-3 py-2 text-xs">
                {confirmedFlightSummary ? (
                  <p className="text-navy-700">
                    {confirmedFlightSummary.outboundFlight.airline ?? "Flight"} · {formatFlightTime(confirmedFlightSummary.outboundFlight.departure_time, confirmedFlightSummary.outboundFlight.departure_time_zone)}
                    {" -> "}
                    {formatFlightTime(confirmedFlightSummary.returnFlight.arrival_time, confirmedFlightSummary.returnFlight.arrival_time_zone)}
                  </p>
                ) : (
                  <p className="text-navy-400">Confirmed ({flightOutboundId} / {flightReturnId})</p>
                )}
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() => handleChangeClick("flight")}
                  className="mt-1 text-xs font-medium text-teal-700 underline hover:text-teal-800 disabled:opacity-50"
                >
                  Change
                </button>
              </div>
            ) : (revisingFlightCandidates ?? flightCandidates) ? (
              <ul className="mt-2 flex flex-col gap-2">
                {(revisingFlightCandidates ?? flightCandidates ?? []).map((c) => (
                  <li key={`${c.outboundFlight.id}-${c.returnFlight.id}`}>
                    <button
                      type="button"
                      disabled={actionPending}
                      onClick={() => void handleConfirmFlight(c.outboundFlight.id, c.returnFlight.id)}
                      className="w-full rounded-lg border border-sand-200 px-3 py-2 text-left text-xs hover:border-teal-600 disabled:opacity-50"
                    >
                      <p className="font-medium text-navy-900">
                        {c.outboundFlight.airline ?? "Flight"} — {formatMoney({ amount: c.totalPriceUsd, currency: "USD" })}
                      </p>
                      <p className="mt-0.5 text-navy-400">
                        {formatFlightTime(c.outboundFlight.departure_time, c.outboundFlight.departure_time_zone)} → {formatFlightTime(c.returnFlight.arrival_time, c.returnFlight.arrival_time_zone)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-navy-400">Finding flights…</p>
            )}
          </section>

          {/* Hotel step */}
          {flightConfirmed || hotelConfirmed ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Hotel</h3>
              {hotelConfirmed && !revisingHotelCandidates ? (
                <div className="mt-2 rounded-lg border border-sand-200 px-3 py-2 text-xs">
                  {confirmedHotelSummary ? (
                    <p className="text-navy-700">
                      {confirmedHotelSummary.name} · {formatMoney({ amount: confirmedHotelSummary.price_per_night_usd, currency: "USD" })}/night
                    </p>
                  ) : (
                    <p className="text-navy-400">Confirmed ({hotelId})</p>
                  )}
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => handleChangeClick("hotel")}
                    className="mt-1 text-xs font-medium text-teal-700 underline hover:text-teal-800 disabled:opacity-50"
                  >
                    Change
                  </button>
                </div>
              ) : (revisingHotelCandidates ?? hotelCandidates) ? (
                <ul className="mt-2 flex flex-col gap-2">
                  {(revisingHotelCandidates ?? hotelCandidates ?? []).map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        disabled={actionPending}
                        onClick={() => void handleConfirmHotel(h.id)}
                        className="w-full rounded-lg border border-sand-200 px-3 py-2 text-left text-xs hover:border-teal-600 disabled:opacity-50"
                      >
                        <p className="font-medium text-navy-900">
                          {h.name} — {formatMoney({ amount: h.price_per_night_usd, currency: "USD" })}/night
                        </p>
                        <p className="mt-0.5 text-navy-400">
                          {h.neighborhood ?? h.destination}
                          {h.rating ? ` · ${h.rating}★` : ""}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-navy-400">Finding hotels…</p>
              )}
            </section>
          ) : null}

          {/* Activities step */}
          {hotelConfirmed || confirmedActivities ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Activities</h3>
              {confirmedActivities ? (
                itineraryText ? null : (
                  <ul className="mt-2 flex flex-col gap-1 text-xs text-navy-400">
                    {[...confirmedActivities]
                      .sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1))
                      .map((a) => (
                        <li key={a.id}>
                          {a.date} · {formatTime(a.startMinutes)}
                        </li>
                      ))}
                  </ul>
                )
              ) : activitiesProposal ? (
                <div className="mt-2 rounded-lg border border-sand-200 px-3 py-2 text-xs">
                  {activitiesProposal.scheduledActivities.length === 0 ? (
                    <p className="text-navy-400">No activities could be scheduled for this trip.</p>
                  ) : (
                    <ul className="flex flex-col gap-1 text-navy-700">
                      {[...activitiesProposal.scheduledActivities]
                        .sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1))
                        .map((a) => (
                          <li key={a.id}>
                            {a.date} · {formatTime(a.startMinutes)}
                          </li>
                        ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    disabled={actionPending}
                    onClick={() => void handleConfirmActivities(activitiesProposal.scheduledActivities)}
                    className="mt-2 rounded-md bg-terracotta-600 px-3 py-1 text-sand-50 transition-colors hover:bg-terracotta-700 disabled:opacity-50"
                  >
                    Confirm this schedule
                  </button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-navy-400">Planning activities…</p>
              )}
            </section>
          ) : null}

          {totalEstimate ? (
            <p className="text-sm text-navy-700">
              Estimated total: <span className="font-medium text-navy-900">{totalEstimate}</span>
            </p>
          ) : null}

          {itineraryText ? <ItineraryText text={itineraryText} /> : null}

          {budgetOverrideViolations ? (
            <div className="rounded-lg border border-terracotta-200 bg-terracotta-50 px-3 py-3 text-xs text-terracotta-700">
              {budgetOverrideViolations.map((v, i) => (
                <p key={i}>{v.message}</p>
              ))}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() => void handleFinalize(true)}
                  className="rounded-md bg-terracotta-600 px-3 py-1 text-sand-50 disabled:opacity-50"
                >
                  Finalize anyway
                </button>
                <button
                  type="button"
                  disabled={actionPending}
                  onClick={() => setBudgetOverrideViolations(null)}
                  className="rounded-md border border-terracotta-200 px-3 py-1 text-terracotta-700 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {activeStep === "complete" && !budgetOverrideViolations ? (
            finalized ? (
              <p className="rounded-lg bg-teal-700 px-3 py-2 text-center text-sm font-medium text-sand-50">
                Trip finalized
              </p>
            ) : (
              <button
                type="button"
                disabled={actionPending}
                onClick={() => void handleFinalize()}
                className="rounded-lg bg-terracotta-600 px-3 py-2 text-sm font-medium text-sand-50 transition-colors hover:bg-terracotta-700 disabled:opacity-50"
              >
                Finalize trip
              </button>
            )
          ) : null}
        </div>
      )}
    </aside>
  );
}
