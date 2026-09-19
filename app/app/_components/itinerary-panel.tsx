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
import { Drawer } from "@base-ui/react/drawer";
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
  cancelTrip,
  confirmActivitySelection,
  confirmCascadeAndRevise,
  confirmFlightCandidate,
  confirmHotelCandidate,
  finalizeActivities,
  finalizeTrip,
  proposeActivityCandidates,
  proposeFlightCandidates,
  proposeHotelCandidates,
  removeActivitySelection,
  type PendingCascadeConfirmation,
} from "../actions";
import type { FlightStepCandidate } from "@/src/workflow/flight-step";
import type { ActivityCandidate, ProposedScheduledActivity } from "@/src/workflow/activities-step";
import type { LayoutMode } from "./use-layout-mode";

/** A submitted activities preference, forwarded down from `TripWorkspace` once `ChatPanel`'s inline prompt is answered (the preference-collection UI itself lives in chat now, not here — see the module docstring's "ACTIVITIES" note). `requestId` is a fresh value per submission so the effect below can tell a genuinely new answer apart from the same object reference re-rendering. */
export interface ActivityPreferenceSubmission {
  requestId: string;
  categories: string[];
  criteria?: string;
}

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

/**
 * The `"drawer"` layout's shell (mobile and tablet-portrait) — a bottom
 * sheet that's either a short peek bar (collapsed) or an ~82vh sheet over a
 * dimming scrim (open), both `position: fixed` so they sit outside
 * `TripWorkspace`'s normal flex flow entirely (chat gets the full width
 * either way, not a shrinking sibling). `ItineraryPanel` owns *when* this
 * opens/closes (an auto-open effect keyed off whatever currently needs a
 * user decision — see its own comment); this component only renders
 * whatever `open` it's given. Tapping the peek bar, the drag handle, or the
 * scrim are the only ways to toggle it — real swipe-to-dismiss (drag
 * physics) is a deliberately deferred fast-follow, not built here.
 */
/** The peek bar's height and the expanded sheet's height, both expressed as fractions of the viewport height (Base UI's `snapPoints` accept 0-1 as a viewport-height fraction, >1 as a literal pixel value, or a `px`/`rem` string) — fractions track real device height variation better than a fixed pixel peek bar would. */
const DRAWER_PEEK_SNAP = 0.08;
const DRAWER_FULL_SNAP = 0.82;

/**
 * Real drag-to-dismiss/expand physics for the "drawer" layout's bottom
 * sheet, via Base UI's `Drawer` primitive (`@base-ui/react/drawer`) rather
 * than hand-rolled pointer-event tracking — velocity-based snapping,
 * scroll-vs-drag disambiguation against `children`'s own scroll area, and
 * accessibility (focus trap only while actually expanded, escape/outside
 * handling) all come from it instead of being reinvented here. (`vaul`, the
 * more commonly recommended library for this, is openly unmaintained as of
 * this writing — its own README says so — so this codebase uses Base UI's
 * primitive instead, which explicitly supports React 19 and is under active
 * development.)
 *
 * Modeled as two `snapPoints`, not a plain open/closed boolean: the peek bar
 * is real content (a status line), always visible, never actually
 * unmounted, so `open` stays a constant `true` and `ItineraryPanel`'s own
 * `open` prop instead selects which snap point is active. `modal` tracks
 * the same boolean — full focus trap and scroll lock only while genuinely
 * expanded over most of the screen, not while just peeking (where chat
 * underneath should stay completely usable).
 */
function ItineraryDrawerShell({
  open,
  onExpand,
  onCollapse,
  statusLine,
  children,
}: {
  open: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  statusLine: string;
  children: ReactNode;
}) {
  return (
    <Drawer.Root
      open
      modal={open}
      swipeDirection="down"
      snapPoints={[DRAWER_PEEK_SNAP, DRAWER_FULL_SNAP]}
      snapPoint={open ? DRAWER_FULL_SNAP : DRAWER_PEEK_SNAP}
      onSnapPointChange={(snapPoint) => {
        if (snapPoint === DRAWER_FULL_SNAP) onExpand();
        else onCollapse();
      }}
      // `open` above is always `true` (this sheet never unmounts), but Base
      // UI's own gesture/dismissal logic doesn't know that — a strong-enough
      // downward swipe still crosses its internal dismiss threshold and
      // requests a real close via `onOpenChange`, same as ESC/outside-press
      // would. With no handler, that request lands on nothing (a fixed
      // `open` prop can't become false) but Base UI still runs its "closing"
      // transition — the source of the reported "swipe down is broken/not
      // smooth" (swipe up never hits this path, since `swipeDirection` only
      // treats down as a dismiss direction, matching the docs' own note that
      // an uncanceled dismiss request also force-resets the active snap
      // point out from under `onSnapPointChange`). Canceling it and routing
      // to `onCollapse` ourselves — the documented pattern for "this drawer
      // must not actually close" (see the Drawer docs' "Close confirmation"
      // example) — makes a hard downward swipe just settle at the peek snap
      // point instead of fighting an unhandled close animation.
      onOpenChange={(_nextOpen, eventDetails) => {
        eventDetails.cancel();
        onCollapse();
      }}
    >
      <Drawer.Portal>
        {/* Always mounted (like `Popup` below), not `{open ? <Backdrop/> :
            null}` — a freshly-mounted element has no prior style to
            transition *from*, so the old conditional-render version popped
            in at full darkness instantly the moment the sheet expanded,
            part of what read as "a glitch" rather than an entrance. Driving
            its opacity from `open` with a real `transition` lets the same
            element fade in/out instead. `pointer-events-none` while
            collapsed for the same reason `Viewport` needs it below — an
            always-mounted `fixed inset-0` element must not swallow clicks
            when it's not supposed to be visually present. */}
        <Drawer.Backdrop
          className={`fixed inset-0 z-30 bg-navy-900/40 transition-opacity duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${open ? "opacity-100" : "pointer-events-none opacity-0"}`}
        />
        {/* `Viewport` is a `fixed inset-0` positioning box that stays mounted
            even at the peek snap point (see above) — without
            `pointer-events-none` here, it silently intercepts every tap
            across the *entire* screen, including the chat input below it,
            because its hit-testing area is the full box regardless of how
            little of it the peek bar actually fills (found live on a real
            phone: the chat box was unclickable the instant the drawer
            existed, focused or not). `pointer-events-auto` on `Popup` opts
            the actually-visible sheet back in — the same split the Drawer
            docs' own "Non-modal" example uses for exactly this reason. */}
        <Drawer.Viewport className="pointer-events-none fixed inset-0 z-40 flex items-end">
          {/* `touch-none` on `Popup` + `touch-auto overscroll-contain` on
              `Content` is the exact split Base UI's own bottom-sheet/snap-point
              demos use — without it, a touch-drag anywhere in `Popup`
              (including inside a long scrollable list) is ambiguous between
              "resize the sheet" and "scroll the content." That alone wasn't
              enough on a real phone (the activities list still dragged the
              sheet instead of scrolling): the docs separately call out that
              swipe-dismiss recognition on touch can capture a descendant
              regardless of its own `touch-action`, and `data-base-ui-swipe-ignore`
              (below, on `Content`) is the documented way to opt an element out
              of that for every input type, not just tell the browser how to
              handle native panning. `transition-[height,transform]` on `Popup`
              itself is the other half of "looked like a glitch" — the
              snap-point transform (and the height swap between the peek
              button and the full `Content`) had no transition at all, so it
              snapped instantly instead of sliding. */}
          <Drawer.Popup className="pointer-events-auto touch-none flex w-full flex-col rounded-t-2xl border-t border-sand-200 bg-sand-50 shadow-[0_-8px_24px_rgba(22,35,58,0.16)] outline-none transition-[height,transform] duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)] [height:var(--drawer-height)] [transform:translateY(calc(var(--drawer-snap-point-offset)_+_var(--drawer-swipe-movement-y)))]">
            <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-sand-300" />
            {open ? (
              <Drawer.Content
                data-base-ui-swipe-ignore
                className="min-h-0 flex-1 touch-auto overflow-y-auto overscroll-contain px-6 pb-6"
              >
                {children}
              </Drawer.Content>
            ) : (
              <button type="button" onClick={onExpand} className="flex w-full flex-1 items-center gap-2 px-6">
                <span className="text-sm font-medium text-navy-900">Itinerary</span>
                <span className="text-xs text-navy-400">{statusLine}</span>
                <span className="ml-auto text-navy-400">&#9650;</span>
              </button>
            )}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/**
 * The `"split"` layout's shell (tablet-landscape) — a flexible-width
 * (not the desktop `w-96` fixed one) collapsible side panel, manual toggle
 * only. Unlike the drawer, this never auto-opens: the extra landscape width
 * this mode targets is enough to leave it open by default alongside chat,
 * the way the desktop sidebar already behaves.
 */
function ItineraryCollapsibleSplit({
  collapsed,
  onToggle,
  children,
}: {
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Show itinerary"
        className="fixed top-1/2 right-0 z-30 -translate-y-1/2 rounded-l-lg bg-navy-900 px-2 py-3 text-xs font-semibold tracking-wide text-sand-50 [writing-mode:vertical-rl]"
      >
        Show itinerary
      </button>
    );
  }
  return (
    <aside className="relative flex w-[380px] flex-shrink-0 flex-col overflow-y-auto border-l border-sand-200 px-6 py-6">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Hide itinerary"
        className="absolute top-1/2 -left-3 flex h-11 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-sand-300 bg-sand-50 text-navy-400"
      >
        &#10095;
      </button>
      {children}
    </aside>
  );
}

export function ItineraryPanel({
  tripId,
  initialTripStatus,
  requirementsReady,
  pendingCascade,
  onPendingCascade,
  onActivitiesPreferenceNeeded,
  activityPreferenceSubmission,
  layoutMode,
}: {
  tripId: string;
  initialTripStatus: string;
  /** Whether the trip's `REQUIRED_FOR_READY` fields are all present yet (`app/app/trips/[tripId]/page.tsx` computes the initial value server-side; `ChatPanel`'s `onRequirementsReady` flips it once a turn's completeness check passes). Gates the flight auto-propose effect below — searching before this is true throws `RequirementsNotReadyError` (found live 2026-09-18: an under-specified first message redirected here and the effect fired immediately with an empty decisions list, before the user had finished answering the intake agent's clarifying questions). */
  requirementsReady: boolean;
  pendingCascade: PendingCascadeConfirmation | null;
  onPendingCascade: (pending: PendingCascadeConfirmation | null) => void;
  /** Tells `TripWorkspace` it's time for `ChatPanel` to show its inline activities-preference prompt — fired once the activities step becomes active with no preference given yet (a fresh trip whose hotel just confirmed), and again from "Change preferences". The preference-collection UI itself lives in chat now, not here. */
  onActivitiesPreferenceNeeded: () => void;
  /** The chat prompt's answer, forwarded down once submitted — `null` until then. */
  activityPreferenceSubmission: ActivityPreferenceSubmission | null;
  /** Which of the three chat+itinerary layouts to render (`use-layout-mode.ts`) — "sidebar" renders exactly as before; "drawer"/"split" wrap the same content in `ItineraryDrawerShell`/`ItineraryCollapsibleSplit` instead. */
  layoutMode: LayoutMode;
}) {
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [initialLoad, setInitialLoad] = useState(true);
  const [needsAttention, setNeedsAttention] = useState<string | null>(null);

  const [flightCandidates, setFlightCandidates] = useState<FlightStepCandidate[] | null>(null);
  const [hotelCandidates, setHotelCandidates] = useState<Hotel[] | null>(null);

  // Activities: chat prompt -> candidate pick-list -> finalize (see the
  // module docstring's "ACTIVITIES" note and `ActivityPreferenceSubmission`
  // above). `activityCandidates === null` means "waiting on the chat
  // prompt"; once set (the prompt was answered, or a reload auto-hydrated it
  // — see the effect below), the candidate/pick-list view shows instead.
  // `addedActivities` is a client-side name-ful mirror of the confirmed
  // `"activity"` decision rows (which only carry an id) — seeded from a
  // propose call's `alreadySelected` and kept in sync by
  // `handleAddActivity`/`handleRemoveActivity`'s own results, so the "in
  // your itinerary" list never has to show a bare id.
  const [activityCandidates, setActivityCandidates] = useState<ActivityCandidate[] | null>(null);
  const [addedActivities, setAddedActivities] = useState<Map<string, ActivityCandidate>>(new Map());
  const [pendingActivityId, setPendingActivityId] = useState<string | null>(null);

  const [revisingFlightCandidates, setRevisingFlightCandidates] = useState<FlightStepCandidate[] | null>(null);
  const [revisingHotelCandidates, setRevisingHotelCandidates] = useState<Hotel[] | null>(null);

  const [confirmedFlightSummary, setConfirmedFlightSummary] = useState<{ outboundFlight: Flight; returnFlight: Flight } | null>(null);
  const [confirmedHotelSummary, setConfirmedHotelSummary] = useState<Hotel | null>(null);

  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [finalized, setFinalized] = useState(initialTripStatus === "finalized");
  const [cancelled, setCancelled] = useState(initialTripStatus === "cancelled");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [budgetOverrideViolations, setBudgetOverrideViolations] = useState<{ message: string }[] | null>(null);

  const flightSigRef = useRef<string | null>(null);
  const hotelSigRef = useRef<string | null>(null);
  /** True while this component's own `proposeFlightCandidates`/`proposeHotelCandidates` call (below) is in flight — closes a real infinite-loop bug found live 2026-09-18 (a trip kept re-proposing flights every ~0.7s for minutes, well after already confirming). `propose*Step` writes as two separate steps (retire the old "proposed" rows, then insert the new ones), so Realtime can deliver a transient state with none visible in between; recomputing `sig` from `decisions` during that gap doesn't match what triggered the call, which used to look identical to a genuine external change (e.g. a chat-driven revision) and refire the effect — which retires+inserts again, reproducing the same gap forever. Checked here in addition to the signature so this component's own in-flight write is never mistaken for one. */
  const flightProposingRef = useRef(false);
  const hotelProposingRef = useRef(false);
  /** Hard circuit breaker: a call this effect makes counts against its step's budget, and once it's exhausted, the effect stops retrying automatically and surfaces an error instead — a safety net against *any* runaway-retry shape here (known or not yet found), not just the specific gap `flightProposingRef` closes. Found necessary live 2026-09-18: the signature/in-flight-guard fix above still didn't fully stop a real recurrence (a fresh trip re-proposed flights for ~48s, through and past a live confirm, corrupting an in-progress hotel selection) — root cause not fully pinned down (a stale browser tab running pre-fix JS is the leading theory, but unconfirmed), so this bounds the damage regardless: at most a handful of calls, then a loud failure instead of a silent multi-minute hammering of the DB/SerpAPI. */
  const MAX_AUTO_PROPOSE_ATTEMPTS = 5;
  const flightProposeAttemptsRef = useRef(0);
  const hotelProposeAttemptsRef = useRef(0);
  const activitiesLoadedRef = useRef(false);
  /** Guards the mount/reload effect's own `onActivitiesPreferenceNeeded` call below so it asks chat once per activation, not on every `decisions` change while still waiting — separate from `activitiesLoadedRef`, which guards the unrelated auto-hydrate-on-reload call. `handleConfirmHotel` pre-arms this synchronously for the same reason it pre-arms `hotelSigRef`: closing the race where this effect's own reaction to that confirm's `decisions` update could ask chat a second, redundant time. */
  const activitiesPromptRequestedRef = useRef(false);
  /** Guards the submission-effect below so a re-render with the same `activityPreferenceSubmission` object (or `TripWorkspace` re-passing the same `requestId`) doesn't re-run `proposeActivityCandidates`. */
  const lastActivitySubmissionIdRef = useRef<string | null>(null);

  // `"drawer"` layout mode only (mobile/tablet-portrait) — `null` means "no
  // manual override, let `actionableSignature` decide" (the automatic
  // open/close behavior); "open"/"closed" means the user explicitly
  // toggled it for the *current* pending decision. Reset back to `null`
  // whenever `actionableSignature` actually changes (see the render-time
  // adjustment right before `content` below) — React's documented way to
  // reset state in response to a changing value without an effect
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders),
  // which also sidesteps the `set-state-in-effect` an effect-based version
  // of this hit here first.
  const [manualDrawerState, setManualDrawerState] = useState<"open" | "closed" | null>(null);
  const [lastActionableSignature, setLastActionableSignature] = useState("");
  // `"split"` layout mode only (tablet-landscape) — manual toggle, no
  // auto-open (see `ItineraryCollapsibleSplit`'s own docstring for why).
  const [splitCollapsed, setSplitCollapsed] = useState(false);

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
      if (cancelled) return;
      const rows = (data as DecisionRow[] | null) ?? [];
      setDecisions(rows);
      setInitialLoad(false);

      // `confirmedFlightSummary`/`confirmedHotelSummary` are otherwise only
      // ever populated by `handleConfirmFlight`/`handleConfirmHotel`'s own
      // already-known result — a reload of a trip that was confirmed in an
      // *earlier* session never goes through those handlers, so without
      // this, the confirmed-step display falls back to its raw-id text
      // (`Confirmed ({flightOutboundId} / {flightReturnId})`) permanently,
      // not just transiently (found live 2026-09-18, reported as "the
      // flight name is now a UUID" after a reload — real, reproducible on
      // any reload of an already-confirmed trip, not specific to that
      // session's other issue). `flights`/`hotels` are world-readable seed
      // inventory, so a direct client-side read is fine here, same as the
      // `trip_decisions` fetch just above.
      const outboundId = confirmedValue(rows, "outboundFlight");
      const returnId = confirmedValue(rows, "returnFlight");
      if (outboundId && returnId) {
        const { data: flightRows, error: flightError } = await supabase.from("flights").select("*").in("id", [outboundId, returnId]);
        if (flightError) console.error("confirmed-flight hydrate failed:", flightError);
        const outboundFlight = flightRows?.find((f) => f.id === outboundId) as Flight | undefined;
        const returnFlight = flightRows?.find((f) => f.id === returnId) as Flight | undefined;
        if (!cancelled && outboundFlight && returnFlight) setConfirmedFlightSummary({ outboundFlight, returnFlight });
      }
      const confirmedHotelId = confirmedValue(rows, "hotel");
      if (confirmedHotelId) {
        const { data: hotelRow, error: hotelError } = await supabase.from("hotels").select("*").eq("id", confirmedHotelId).maybeSingle();
        if (hotelError) console.error("confirmed-hotel hydrate failed:", hotelError);
        if (!cancelled && hotelRow) setConfirmedHotelSummary(hotelRow as Hotel);
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
    // `activeStep` reads as "flight" from an empty decisions list whether
    // the trip's requirements are actually complete or the user hasn't
    // finished answering the intake agent's clarifying questions yet — only
    // `requirementsReady` (not decisions/activeStep alone) can tell those
    // apart. Hotel/activities don't need this same guard: `getCurrentChainStep`
    // can't return either one until the flight step is confirmed, which
    // itself can't happen before requirements are ready.
    if (activeStep === "flight" && !requirementsReady) return;
    if (activeStep === "flight") {
      const sig = proposedSignature("flight", decisions);
      // TEMPORARY diagnostic logging (2026-09-18) — pinning down a
      // still-unexplained repeat-propose loop. Remove once root-caused.
      console.debug("[flight-propose-debug] effect check", {
        sig,
        prevSig: flightSigRef.current,
        inFlight: flightProposingRef.current,
        attempts: flightProposeAttemptsRef.current,
        proposedCount: decisions.filter((d) => (d.field === "outboundFlight" || d.field === "returnFlight") && d.status === "proposed").length,
      });
      if (flightSigRef.current === sig || flightProposingRef.current) return;
      if (flightProposeAttemptsRef.current >= MAX_AUTO_PROPOSE_ATTEMPTS) {
        setActionError("Flight search keeps re-running unexpectedly — please reload the page.");
        return;
      }
      flightProposeAttemptsRef.current += 1;
      flightProposingRef.current = true;
      console.debug("[flight-propose-debug] CALLING proposeFlightCandidates", { attempt: flightProposeAttemptsRef.current });
      void (async () => {
        try {
          const result = await proposeFlightCandidates({ tripId });
          if ("error" in result) {
            setActionError(result.error);
            return;
          }
          setFlightCandidates(result.candidates);
          // Derived from the call's own result, not a fresh `decisions`
          // read — see `flightProposingRef`'s docstring above for why that
          // distinction is what actually closes the loop.
          flightSigRef.current = result.candidates
            .flatMap((c) => [c.outboundFlight.id, c.returnFlight.id])
            .sort()
            .join(",");
          console.debug("[flight-propose-debug] result", {
            newSig: flightSigRef.current,
            candidateCount: result.candidates.length,
            ids: result.candidates.map((c) => ({ out: c.outboundFlight.id, ret: c.returnFlight.id })),
          });
        } catch (err) {
          console.error("proposeFlightCandidates failed:", err);
        } finally {
          flightProposingRef.current = false;
        }
      })();
    } else if (activeStep === "hotel") {
      const sig = proposedSignature("hotel", decisions);
      if (hotelSigRef.current === sig || hotelProposingRef.current) return;
      if (hotelProposeAttemptsRef.current >= MAX_AUTO_PROPOSE_ATTEMPTS) {
        setActionError("Hotel search keeps re-running unexpectedly — please reload the page.");
        return;
      }
      hotelProposeAttemptsRef.current += 1;
      hotelProposingRef.current = true;
      void (async () => {
        try {
          const result = await proposeHotelCandidates({ tripId });
          if ("error" in result) {
            setActionError(result.error);
            return;
          }
          setHotelCandidates(result.candidates);
          hotelSigRef.current = result.candidates.map((h) => h.id).sort().join(",");
        } catch (err) {
          console.error("proposeHotelCandidates failed:", err);
        } finally {
          hotelProposingRef.current = false;
        }
      })();
    } else if (activeStep === "activities") {
      // Only auto-hydrates on a genuine reload of a trip that already
      // engaged with activities before (a proposed `activityCandidate` or
      // confirmed `activity` row already exists) — a brand-new trip whose
      // hotel just confirmed asks in chat instead (`onActivitiesPreferenceNeeded`,
      // answered via the submission effect below), since there's no
      // preference to search with yet.
      const hasEngagedBefore = decisions.some((d) => d.field === "activityCandidate" || d.field === "activity");
      if (!hasEngagedBefore) {
        if (!activitiesPromptRequestedRef.current) {
          activitiesPromptRequestedRef.current = true;
          onActivitiesPreferenceNeeded();
        }
        return;
      }
      if (activitiesLoadedRef.current) return;
      activitiesLoadedRef.current = true;
      void (async () => {
        try {
          const result = await proposeActivityCandidates({ tripId });
          if ("error" in result) {
            setActionError(result.error);
            return;
          }
          setActivityCandidates(result.candidates);
          setAddedActivities(new Map(result.alreadySelected.map((a) => [a.id, a])));
        } catch (err) {
          console.error("proposeActivityCandidates failed:", err);
        }
      })();
    }
  }, [activeStep, decisions, initialLoad, requirementsReady, tripId, onActivitiesPreferenceNeeded]);

  // Runs the real propose call once the chat prompt is answered
  // (`activityPreferenceSubmission`, set by `TripWorkspace`) — the
  // counterpart to the auto-hydrate branch above, just sourced from a
  // real user-submitted preference instead of a prior one.
  useEffect(() => {
    if (!activityPreferenceSubmission) return;
    if (lastActivitySubmissionIdRef.current === activityPreferenceSubmission.requestId) return;
    lastActivitySubmissionIdRef.current = activityPreferenceSubmission.requestId;
    activitiesLoadedRef.current = true;
    void (async () => {
      setActionPending(true);
      setActionError(null);
      try {
        const result = await proposeActivityCandidates({
          tripId,
          categories: activityPreferenceSubmission.categories,
          criteria: activityPreferenceSubmission.criteria,
        });
        if ("error" in result) {
          setActionError(result.error);
          return;
        }
        setActivityCandidates(result.candidates);
        setAddedActivities((prev) => {
          const merged = new Map(prev);
          for (const a of result.alreadySelected) merged.set(a.id, a);
          return merged;
        });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Couldn't load activities — try again.");
      } finally {
        setActionPending(false);
      }
    })();
  }, [activityPreferenceSubmission, tripId]);

  async function handleAddActivity(activityId: string) {
    setPendingActivityId(activityId);
    setActionError(null);
    try {
      const result = await confirmActivitySelection({ tripId, activityId });
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      setAddedActivities((prev) => new Map(prev).set(result.activity.id, result.activity));
      setActivityCandidates((prev) => (prev ? prev.filter((c) => c.id !== activityId) : prev));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't add that activity — try again.");
    } finally {
      setPendingActivityId(null);
    }
  }

  async function handleRemoveActivity(activityId: string) {
    setPendingActivityId(activityId);
    setActionError(null);
    try {
      const result = await removeActivitySelection({ tripId, activityId });
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      setAddedActivities((prev) => {
        const next = new Map(prev);
        next.delete(activityId);
        return next;
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't remove that activity — try again.");
    } finally {
      setPendingActivityId(null);
    }
  }

  function handleChangeActivityPreferences() {
    setActivityCandidates(null);
    onActivitiesPreferenceNeeded();
  }

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
      }
      // No `else if (next.step === "activities")` branch: `next.step` can
      // only be "hotel" or "complete" from a flight confirm (hotel always
      // comes between flight and activities) — the chat prompt is asked
      // from `handleConfirmHotel` instead, once activities can actually
      // become the active step.
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't confirm that flight — try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleConfirmHotel(hotelId: string) {
    setActionPending(true);
    setActionError(null);
    try {
      const result = await confirmHotelCandidate({ tripId, hotelId });
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      const { confirmed } = result;
      setConfirmedHotelSummary(confirmed.hotel);
      setDecisions((prev) => optimisticConfirm(prev, "hotel", confirmed.hotel.id));
      setHotelCandidates(null);
      setRevisingHotelCandidates(null);
      // Once hotel confirms, activities becomes the active step — ask for a
      // preference in chat rather than auto-proposing (activities needs a
      // real user-submitted preference first). Pre-arms the guard ref
      // synchronously, same reasoning as `hotelSigRef` above: closes the
      // race where the mount effect's own reaction to this same confirm's
      // `decisions` update could otherwise ask chat a second, redundant time.
      activitiesPromptRequestedRef.current = true;
      onActivitiesPreferenceNeeded();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't confirm that hotel — try again.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleFinalizeActivities() {
    setActionPending(true);
    setActionError(null);
    try {
      const result = await finalizeActivities({ tripId });
      if ("error" in result) {
        setActionError(result.error);
        return;
      }
      const confirmed = result;
      setDecisions((prev) => {
        let next = optimisticConfirm(prev, "activities", confirmed.scheduledActivities);
        next = optimisticConfirm(next, "budget", confirmed.budget);
        if (confirmed.itineraryText) next = optimisticConfirm(next, "itineraryText", confirmed.itineraryText);
        return next;
      });
      if (confirmed.unscheduledActivityIds.length > 0) {
        setNeedsAttention(
          `${confirmed.unscheduledActivityIds.length} selected activity/activities didn't fit into the schedule and were left out.`,
        );
      }
      setActivityCandidates(null);
      setAddedActivities(new Map());
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't finalize activities — try again.");
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

  async function handleCancel() {
    setConfirmingCancel(false);
    setActionPending(true);
    setActionError(null);
    try {
      await cancelTrip({ tripId });
      setCancelled(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't cancel this trip — try again.");
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

  // What (if anything) currently needs a user decision inside the
  // itinerary — the single signal the "drawer" layout's auto-open effect
  // below reacts to, rather than driving the sheet off individual events
  // ("flight confirmed -> close", "hotel proposed -> open"). That
  // event-driven shape would fight the real flow: flight and hotel can be
  // picked back to back (hotel's candidates are already loaded by the time
  // flight confirms — `handleConfirmFlight` sets them directly from its own
  // result), so closing on every confirm and reopening for the next pick
  // would flicker shut between two picks the user makes in one breath.
  // Keying off this signal instead means the sheet only actually closes
  // once nothing is left pending, and reopens the instant something new is.
  const needsFlightPick = Boolean(revisingFlightCandidates ?? flightCandidates);
  const needsHotelPick = Boolean(revisingHotelCandidates ?? hotelCandidates);
  const needsActivityPick = activityCandidates !== null && !confirmedActivities;
  const actionableSignature: string = pendingCascade
    ? "cascade"
    : budgetOverrideViolations
      ? "budget-override"
      : needsFlightPick
        ? "flight"
        : needsHotelPick
          ? "hotel"
          : needsActivityPick
            ? "activities"
            : "";

  const drawerStatusLine =
    actionableSignature === "cascade"
      ? "Confirm your change"
      : actionableSignature === "budget-override"
        ? "Budget needs a look"
        : actionableSignature === "flight"
          ? "Pick a flight"
          : actionableSignature === "hotel"
            ? "Pick a hotel"
            : actionableSignature === "activities"
              ? "Pick your activities"
              : finalized
                ? "Trip finalized"
                : [flightConfirmed && "Flight ✓", hotelConfirmed && "Hotel ✓", confirmedActivities && "Activities ✓"]
                    .filter(Boolean)
                    .join(" · ") || "Planning your trip";

  // Whenever the pending decision itself changes (including to/from
  // nothing pending), any manual override the user set for the *previous*
  // one no longer applies — hand control back to the automatic behavior for
  // whatever's pending now. Adjusting state directly during render like
  // this (rather than in a `useEffect`) is React's documented way to reset
  // state in response to a changing value; it re-renders once immediately,
  // before paint, instead of the extra commit-then-effect round trip an
  // effect-based version of this would cost.
  if (actionableSignature !== lastActionableSignature) {
    setLastActionableSignature(actionableSignature);
    setManualDrawerState(null);
  }

  // Purely derived: automatic (open whenever something's pending) unless
  // the user explicitly overrode it for this exact pending decision. Never
  // true outside `"drawer"` mode — `"split"` never auto-opens
  // (`ItineraryCollapsibleSplit`'s own docstring) and `"sidebar"` has no
  // drawer at all.
  const drawerOpen =
    layoutMode === "drawer" && (manualDrawerState !== null ? manualDrawerState === "open" : Boolean(actionableSignature));

  function handleDrawerExpand() {
    setManualDrawerState("open");
  }
  function handleDrawerCollapse() {
    setManualDrawerState("closed");
  }

  const content = (
    <>
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-lg font-semibold text-navy-900">Your itinerary</h2>
        {!finalized && !cancelled ? (
          <button
            type="button"
            disabled={actionPending}
            onClick={() => setConfirmingCancel(true)}
            className="text-xs text-navy-400 underline decoration-dotted hover:text-terracotta-600 disabled:opacity-50"
          >
            Cancel trip
          </button>
        ) : null}
      </div>

      {confirmingCancel ? (
        <div className="mt-4 rounded-lg border border-terracotta-200 bg-terracotta-50 px-3 py-3 text-xs text-terracotta-700">
          <p>Cancel this trip? Nothing is booked yet, but this can&apos;t be undone — you&apos;ll need to start a new trip to keep planning.</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={actionPending}
              onClick={() => void handleCancel()}
              className="rounded-md bg-terracotta-600 px-3 py-1 text-sand-50 disabled:opacity-50"
            >
              Cancel trip
            </button>
            <button
              type="button"
              disabled={actionPending}
              onClick={() => setConfirmingCancel(false)}
              className="rounded-md border border-terracotta-200 px-3 py-1 text-terracotta-700 disabled:opacity-50"
            >
              Keep planning
            </button>
          </div>
        </div>
      ) : null}

      {cancelled ? (
        <p className="mt-4 rounded-lg bg-sand-200 px-3 py-2 text-center text-sm font-medium text-navy-700">
          Trip cancelled
        </p>
      ) : null}

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
            ) : requirementsReady ? (
              <p className="mt-2 text-xs text-navy-400">Finding flights…</p>
            ) : (
              <p className="mt-2 text-xs text-navy-400">Answer the chat&apos;s questions to start planning.</p>
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

          {/* Activities step — chat prompt -> candidate pick-list -> finalize (see the module docstring's "ACTIVITIES" note). The preference prompt itself renders in `ChatPanel`, not here. */}
          {hotelConfirmed || confirmedActivities ? (
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-navy-400">Activities</h3>
              {confirmedActivities ? (
                itineraryText ? null : (
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {[...confirmedActivities]
                      .sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1))
                      .map((a) => (
                        <li key={a.id}>
                          <span className="font-medium text-navy-900">{a.name}</span>
                          <span className="text-navy-400"> — {a.date} · {formatTime(a.startMinutes)}</span>
                        </li>
                      ))}
                  </ul>
                )
              ) : activityCandidates === null ? (
                <p className="mt-2 text-xs text-navy-400">Answer the chat&apos;s question to choose your activities.</p>
              ) : (
                <div className="mt-2 flex flex-col gap-3">
                  {addedActivities.size > 0 ? (
                    <div>
                      <p className="font-medium text-navy-700">In your itinerary ({addedActivities.size})</p>
                      <ul className="mt-1 flex flex-col gap-1">
                        {[...addedActivities.values()].map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg border border-sand-200 px-2 py-1">
                            <span className="text-navy-900">
                              {a.name} — {formatMoney({ amount: a.priceUsd, currency: "USD" })}
                            </span>
                            <button
                              type="button"
                              disabled={pendingActivityId === a.id}
                              onClick={() => void handleRemoveActivity(a.id)}
                              className="shrink-0 text-terracotta-600 underline hover:text-terracotta-700 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {activityCandidates.length > 0 ? (
                    <div>
                      <p className="font-medium text-navy-700">Suggestions</p>
                      <ul className="mt-1 flex flex-col gap-2">
                        {activityCandidates.map((c) => (
                          <li key={c.id} className="rounded-lg border border-sand-200 px-2 py-2">
                            <p className="font-medium text-navy-900">
                              {c.name} — {formatMoney({ amount: c.priceUsd, currency: "USD" })}
                            </p>
                            <p className="mt-0.5 text-navy-400">
                              {c.category ?? "activity"}
                              {c.durationMinutes ? ` · ${c.durationMinutes} min` : ""}
                              {c.location ? ` · ${c.location}` : ""}
                            </p>
                            {c.description ? <p className="mt-0.5 text-navy-400">{c.description}</p> : null}
                            <button
                              type="button"
                              disabled={pendingActivityId === c.id}
                              onClick={() => void handleAddActivity(c.id)}
                              className="mt-1 rounded-md border border-teal-600 px-2 py-1 text-teal-700 hover:bg-teal-50 disabled:opacity-50"
                            >
                              Add to itinerary
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-navy-400">No more activities match that — try different preferences.</p>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={handleChangeActivityPreferences}
                      className="font-medium text-teal-700 underline hover:text-teal-800"
                    >
                      Change preferences
                    </button>
                    <button
                      type="button"
                      disabled={actionPending}
                      onClick={() => void handleFinalizeActivities()}
                      className="rounded-md bg-terracotta-600 px-3 py-1 text-sand-50 transition-colors hover:bg-terracotta-700 disabled:opacity-50"
                    >
                      {addedActivities.size > 0 ? `Finalize itinerary (${addedActivities.size} added)` : "Finalize with no activities"}
                    </button>
                  </div>
                </div>
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
    </>
  );

  if (layoutMode === "drawer") {
    return (
      <ItineraryDrawerShell
        open={drawerOpen}
        onExpand={handleDrawerExpand}
        onCollapse={handleDrawerCollapse}
        statusLine={drawerStatusLine}
      >
        {content}
      </ItineraryDrawerShell>
    );
  }
  if (layoutMode === "split") {
    return (
      <ItineraryCollapsibleSplit collapsed={splitCollapsed} onToggle={() => setSplitCollapsed((c) => !c)}>
        {content}
      </ItineraryCollapsibleSplit>
    );
  }
  return (
    <aside className="flex w-96 flex-shrink-0 flex-col overflow-y-auto border-l border-sand-200 px-6 py-6">
      {content}
    </aside>
  );
}
