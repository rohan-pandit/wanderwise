/**
 * Per-user activity view for `/internal/users` (Phase A of the per-user
 * observability work — see BUILD_LOG.md, 2026-09-25). Pure functions only:
 * the pages fetch rows with the service client and hand them here, so the
 * "what happened, in what order, and how do we label it" logic is testable
 * without Supabase.
 *
 * Built entirely from tables the app already writes — `messages` (both
 * sides of the chat), `trip_events` (trip creation, every selection, every
 * workflow transition mirror, chain failures), `agent_runs` (model-call
 * errors), `guardrail_events` (blocked input/output) and `feedback`. Nothing
 * here is a new capture; gaps that need new capture (sign-in history,
 * failed sign-ins, server-action failures) are Phase B.
 */
import type { ChainDecision } from "@/src/domain/chain";
import { getCurrentChainStep } from "@/src/domain/chain";

export type TimelineTone = "milestone" | "user" | "agent" | "selection" | "workflow" | "warning" | "error" | "feedback";

export interface TimelineItem {
  at: string;
  tone: TimelineTone;
  title: string;
  detail: string | null;
  /** `null` for account-level items (e.g. feedback sent from outside any trip). */
  tripId: string | null;
}

export interface TripRow {
  id: string;
  name: string | null;
  status: string;
  session_id: string;
  created_at: string;
}

export interface MessageRow {
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface TripEventRow {
  trip_id: string;
  event_type: string;
  payload: unknown;
  created_at: string;
}

export interface AgentErrorRow {
  trip_id: string | null;
  agent_name: string;
  error_message: string | null;
  created_at: string;
}

export interface GuardrailBlockRow {
  trip_id: string | null;
  guardrail_name: string;
  layer: string;
  detail: string | null;
  created_at: string;
}

export interface FeedbackRow {
  trip_id: string | null;
  kind: string;
  categories: string[];
  message: string | null;
  created_at: string;
}

/** Inventory id → human label (e.g. "TAP TP202 · JFK→LIS"), resolved by the page from `flights`/`hotels`/`activities`. */
export type InventoryNames = ReadonlyMap<string, string>;

const FAILED_STATES = new Set(["failed_recoverable", "failed_terminal"]);

function asRecord(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function nameOf(names: InventoryNames, id: unknown): string {
  if (typeof id !== "string") return "unknown";
  return names.get(id) ?? `${id.slice(0, 8)}…`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Every inventory id a set of trip events references — so the page can fetch exactly those names and nothing else. */
export function collectInventoryIds(events: TripEventRow[]): { flightIds: string[]; hotelIds: string[]; activityIds: string[] } {
  const flights = new Set<string>();
  const hotels = new Set<string>();
  const activities = new Set<string>();
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === "string") set.add(value);
  };
  for (const e of events) {
    const p = asRecord(e.payload);
    add(flights, p.outboundFlightId);
    add(flights, p.returnFlightId);
    add(hotels, p.hotelId);
    add(activities, p.activityId);
    if (Array.isArray(p.candidates)) {
      for (const c of p.candidates) {
        const cand = asRecord(c);
        add(flights, cand.outboundFlightId);
        add(flights, cand.returnFlightId);
        add(hotels, cand.hotelId);
      }
    }
    for (const key of ["candidateActivityIds", "scheduledActivityIds", "unscheduledActivityIds"]) {
      if (Array.isArray(p[key])) (p[key] as unknown[]).forEach((id) => add(activities, id));
    }
  }
  return { flightIds: [...flights], hotelIds: [...hotels], activityIds: [...activities] };
}

/**
 * Labels one `trip_events` row. Event types without a dedicated case are
 * the workflow-transition mirrors `controller.ts` writes (payload
 * `{fromState, toState}`), shown as low-emphasis "workflow" items — or as an
 * error when the transition lands in a failed state. Anything else unknown
 * still renders (by its raw type) rather than being silently dropped, so a
 * new event type shows up here before anyone remembers to label it.
 */
export function describeTripEvent(event: TripEventRow, names: InventoryNames): Omit<TimelineItem, "at" | "tripId"> {
  const p = asRecord(event.payload);
  switch (event.event_type) {
    case "trip_created":
      return { tone: "milestone", title: "Started a new trip", detail: null };
    case "flight_step_proposed": {
      const n = Array.isArray(p.candidates) ? p.candidates.length : 0;
      return { tone: "agent", title: `Shown ${plural(n, "flight option")}`, detail: null };
    }
    case "flight_step_confirmed":
      return {
        tone: "selection",
        title: "Selected flights",
        detail: `Outbound: ${nameOf(names, p.outboundFlightId)}\nReturn: ${nameOf(names, p.returnFlightId)}`,
      };
    case "hotel_step_proposed": {
      const n = Array.isArray(p.candidates) ? p.candidates.length : 0;
      const dates = typeof p.checkIn === "string" && typeof p.checkOut === "string" ? `${p.checkIn} → ${p.checkOut}` : null;
      return { tone: "agent", title: `Shown ${plural(n, "hotel option")}`, detail: dates };
    }
    case "hotel_step_confirmed":
      return { tone: "selection", title: "Selected hotel", detail: nameOf(names, p.hotelId) };
    case "activities_step_proposed": {
      const n = Array.isArray(p.candidateActivityIds) ? p.candidateActivityIds.length : 0;
      const categories = Array.isArray(p.categories) && p.categories.length > 0 ? `Interests: ${p.categories.join(", ")}` : null;
      const criteria = typeof p.criteria === "string" && p.criteria ? `Notes: ${p.criteria}` : null;
      return { tone: "agent", title: `Shown ${plural(n, "activity option")}`, detail: [categories, criteria].filter(Boolean).join("\n") || null };
    }
    case "activity_selected":
      return { tone: "selection", title: "Added activity", detail: nameOf(names, p.activityId) };
    case "activity_deselected":
      return { tone: "selection", title: "Removed activity", detail: nameOf(names, p.activityId) };
    case "activities_step_confirmed": {
      const scheduled = Array.isArray(p.scheduledActivityIds) ? p.scheduledActivityIds.length : 0;
      const unscheduled = Array.isArray(p.unscheduledActivityIds) ? p.unscheduledActivityIds.length : 0;
      return {
        tone: "selection",
        title: "Confirmed activities",
        detail: `${plural(scheduled, "activity")} scheduled${unscheduled > 0 ? `, ${unscheduled} couldn't fit` : ""}`,
      };
    }
    case "hotel_step_invalidated":
    case "activities_step_invalidated": {
      const step = event.event_type.replace("_step_invalidated", "");
      return { tone: "warning", title: `${step === "hotel" ? "Hotel" : "Activities"} step reset by an earlier change`, detail: typeof p.reason === "string" ? p.reason : null };
    }
    case "chain_propose_failed":
    case "chain_revision_failed":
      return {
        tone: "error",
        title: `${event.event_type === "chain_propose_failed" ? "Couldn't load" : "Couldn't revise"} ${typeof p.step === "string" ? p.step : "step"} options`,
        detail: typeof p.message === "string" ? p.message : null,
      };
  }
  if (typeof p.toState === "string") {
    const from = typeof p.fromState === "string" ? p.fromState : "—";
    const tone: TimelineTone = FAILED_STATES.has(p.toState) ? "error" : p.toState === "finalized" || p.toState === "cancelled" ? "milestone" : "workflow";
    const title =
      p.toState === "finalized" ? "Finalized the trip" : p.toState === "cancelled" ? "Cancelled the trip" : `Workflow: ${event.event_type}`;
    return { tone, title, detail: `${from} → ${p.toState}` };
  }
  return { tone: "workflow", title: event.event_type, detail: null };
}

/**
 * `messages` are keyed by session, not trip. Almost every session has one
 * trip; for the rare session with several, a message belongs to the most
 * recent trip created at or before it (or the session's first trip, for a
 * message that predates all of them).
 */
export function tripIdForMessage(message: MessageRow, tripsBySession: ReadonlyMap<string, TripRow[]>): string | null {
  const trips = tripsBySession.get(message.session_id);
  if (!trips || trips.length === 0) return null;
  const sorted = [...trips].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let owner = sorted[0];
  for (const t of sorted) {
    if (t.created_at <= message.created_at) owner = t;
  }
  return owner.id;
}

export interface UserTimelineInput {
  trips: TripRow[];
  messages: MessageRow[];
  tripEvents: TripEventRow[];
  agentErrors: AgentErrorRow[];
  guardrailBlocks: GuardrailBlockRow[];
  feedback: FeedbackRow[];
  names: InventoryNames;
}

/** Merges every source into one chronological stream (oldest first; ties keep source order, so a user message stays ahead of the agent reply written in the same instant). */
export function buildUserTimeline(input: UserTimelineInput): TimelineItem[] {
  const tripsBySession = new Map<string, TripRow[]>();
  for (const t of input.trips) {
    const list = tripsBySession.get(t.session_id) ?? [];
    list.push(t);
    tripsBySession.set(t.session_id, list);
  }

  const items: TimelineItem[] = [];

  for (const m of input.messages) {
    const tripId = tripIdForMessage(m, tripsBySession);
    if (m.role === "user") items.push({ at: m.created_at, tone: "user", title: "User", detail: m.content, tripId });
    else if (m.role === "assistant") items.push({ at: m.created_at, tone: "agent", title: "Agent", detail: m.content, tripId });
    else items.push({ at: m.created_at, tone: "workflow", title: "System message", detail: m.content, tripId });
  }

  for (const e of input.tripEvents) {
    items.push({ at: e.created_at, tripId: e.trip_id, ...describeTripEvent(e, input.names) });
  }

  for (const r of input.agentErrors) {
    items.push({ at: r.created_at, tone: "error", title: `Agent error (${r.agent_name})`, detail: r.error_message, tripId: r.trip_id });
  }

  for (const g of input.guardrailBlocks) {
    items.push({
      at: g.created_at,
      tone: "warning",
      title: `Guardrail triggered: ${g.guardrail_name}`,
      detail: [g.layer, g.detail].filter(Boolean).join(" — ") || null,
      tripId: g.trip_id,
    });
  }

  for (const f of input.feedback) {
    const categories = f.categories.length > 0 ? `[${f.categories.join(", ")}] ` : "";
    items.push({ at: f.created_at, tone: "feedback", title: `Sent feedback (${f.kind})`, detail: `${categories}${f.message ?? ""}`.trim() || null, tripId: f.trip_id });
  }

  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index)
    .map(({ item }) => item);
  return collapseRepeats(sorted);
}

/**
 * Folds back-to-back identical non-chat items (same trip, tone, title and
 * detail) into one "(×N)" row, keeping the first timestamp — the same
 * options re-proposed on every revisit of a step otherwise bury the
 * actual choices (hosted data: 821 `flight_step_proposed` across 44 trips).
 * Chat is never folded: a user repeating themselves is signal.
 */
function collapseRepeats(items: TimelineItem[]): TimelineItem[] {
  const out: { item: TimelineItem; count: number }[] = [];
  for (const item of items) {
    const prev = out.at(-1);
    const isChat = item.tone === "user" || (item.tone === "agent" && item.title === "Agent");
    if (
      prev &&
      !isChat &&
      prev.item.tripId === item.tripId &&
      prev.item.tone === item.tone &&
      prev.item.title === item.title &&
      prev.item.detail === item.detail
    ) {
      prev.count += 1;
      continue;
    }
    out.push({ item, count: 1 });
  }
  return out.map(({ item, count }) => (count > 1 ? { ...item, title: `${item.title} (×${count})` } : item));
}

export function countErrors(items: TimelineItem[]): number {
  return items.filter((i) => i.tone === "error").length;
}

/** A one-line "what the user entered" summary — reads whatever's present rather than requiring completeness, since a trip can be abandoned mid-intake. */
export function summarizeRequirements(rows: { field: string; value: unknown }[]): string | null {
  const byField = new Map(rows.map((r) => [r.field, r.value]));
  const destination = byField.get("destination");
  const origin = byField.get("origin");
  const departureDate = byField.get("departureDate");
  const returnDate = byField.get("returnDate");
  const partySize = byField.get("partySize");
  const budget = byField.get("budgetTotalUsd");

  const parts = [
    destination ? String(destination) : null,
    origin ? `from ${origin}` : null,
    departureDate && returnDate ? `${departureDate} → ${returnDate}` : null,
    typeof partySize === "number" ? `${partySize} traveler${partySize === 1 ? "" : "s"}` : null,
    typeof budget === "number" ? `$${budget.toLocaleString()} budget` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface TripSnapshot {
  requirements: string | null;
  /** "Chain step: hotel" / "Complete" — `getCurrentChainStep` over the trip's live decisions. */
  chainStep: string;
  outboundFlight: string | null;
  returnFlight: string | null;
  hotel: string | null;
  activities: string[];
}

/**
 * Current selections for one trip, from its non-superseded `trip_decisions`.
 * A confirmed row wins over a proposed one for the same single-valued field;
 * per-pick `activity` rows are a set.
 */
export function buildTripSnapshot(
  requirements: { field: string; value: unknown }[],
  decisions: { field: string; status: string; value: unknown }[],
  names: InventoryNames,
): TripSnapshot {
  const live = decisions.filter((d) => d.status !== "superseded");
  const pick = (field: string): string | null => {
    const rows = live.filter((d) => d.field === field);
    const chosen = rows.find((d) => d.status === "confirmed") ?? rows[rows.length - 1];
    return chosen ? nameOf(names, chosen.value) : null;
  };
  const chain = getCurrentChainStep(live as ChainDecision[]);
  return {
    requirements: summarizeRequirements(requirements),
    chainStep: chain === "complete" ? "Complete" : `Chain step: ${chain}`,
    outboundFlight: pick("outboundFlight"),
    returnFlight: pick("returnFlight"),
    hotel: pick("hotel"),
    activities: [...new Set(live.filter((d) => d.field === "activity").map((d) => nameOf(names, d.value)))],
  };
}

/** The ids `buildTripSnapshot` will need names for — decision values are bare inventory ids. */
export function collectDecisionInventoryIds(decisions: { field: string; status: string; value: unknown }[]): {
  flightIds: string[];
  hotelIds: string[];
  activityIds: string[];
} {
  const live = decisions.filter((d) => d.status !== "superseded" && typeof d.value === "string");
  const ids = (fields: string[]) => [...new Set(live.filter((d) => fields.includes(d.field)).map((d) => d.value as string))];
  return { flightIds: ids(["outboundFlight", "returnFlight"]), hotelIds: ids(["hotel"]), activityIds: ids(["activity"]) };
}

export interface UserSummaryInput {
  userId: string;
  email: string | null;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface UserSummary extends UserSummaryInput {
  tripCount: number;
  finalizedCount: number;
  userMessageCount: number;
  errorCount: number;
  /** Latest of last sign-in, any trip creation, or any message — `null` for a user who never did anything. */
  lastActiveAt: string | null;
}

/** One row per user for the `/internal/users` list, most recently active first. */
export function summarizeUsers(
  users: UserSummaryInput[],
  trips: { user_id: string; session_id: string; status: string; created_at: string; id: string }[],
  messages: { session_id: string; role: string; created_at: string }[],
  errorTripIds: string[],
): UserSummary[] {
  const tripsByUser = new Map<string, typeof trips>();
  const userBySession = new Map<string, string>();
  const userByTrip = new Map<string, string>();
  for (const t of trips) {
    const list = tripsByUser.get(t.user_id) ?? [];
    list.push(t);
    tripsByUser.set(t.user_id, list);
    userBySession.set(t.session_id, t.user_id);
    userByTrip.set(t.id, t.user_id);
  }

  const messageCount = new Map<string, number>();
  const lastMessageAt = new Map<string, string>();
  for (const m of messages) {
    const userId = userBySession.get(m.session_id);
    if (!userId) continue;
    if (m.role === "user") messageCount.set(userId, (messageCount.get(userId) ?? 0) + 1);
    const prev = lastMessageAt.get(userId);
    if (!prev || m.created_at > prev) lastMessageAt.set(userId, m.created_at);
  }

  const errors = new Map<string, number>();
  for (const tripId of errorTripIds) {
    const userId = userByTrip.get(tripId);
    if (userId) errors.set(userId, (errors.get(userId) ?? 0) + 1);
  }

  const latest = (values: (string | null | undefined)[]): string | null =>
    values.filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;

  return users
    .map((u) => {
      const userTrips = tripsByUser.get(u.userId) ?? [];
      return {
        ...u,
        tripCount: userTrips.length,
        finalizedCount: userTrips.filter((t) => t.status === "finalized").length,
        userMessageCount: messageCount.get(u.userId) ?? 0,
        errorCount: errors.get(u.userId) ?? 0,
        lastActiveAt: latest([u.lastSignInAt, lastMessageAt.get(u.userId), ...userTrips.map((t) => t.created_at)]),
      };
    })
    .sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
}
