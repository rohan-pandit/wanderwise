/**
 * Day-by-day activity scheduler. `assembleCandidateCombinations` (Phase 2)
 * only decides *which* activities fit the budget — nothing assigns them a
 * specific day/time, but `validateItineraryFeasibility` requires exactly
 * that (a fully dated `ScheduledActivity[]`, §9.2). This is the missing
 * seam between the two, surfaced and scoped explicitly while wiring Phase 6
 * continued's slice 2 (`docs/IMPLEMENTATION_PLAN.md`), not part of the
 * original Phase 2 service sketch.
 *
 * Deliberately a naive greedy placer, not an optimizer: walks the trip's
 * date range once per activity (in the order given — callers should pass
 * activities pre-sorted by whatever priority they want honored first, e.g.
 * the Curator's `rankedIds` order), placing each at the first day/time slot
 * that respects `closedDays` and `openingHours`, back-to-back with a fixed
 * gap. Good enough to make `validateItineraryFeasibility` a real, exercised
 * guardrail; still a single deterministic forward pass with no backtracking
 * or lookahead (docs/IMPLEMENTATION_PLAN.md §5) — revisit with something
 * heavier (geographic clustering, a real repair/optimization pass) if a
 * future phase needs it.
 *
 * One lightweight heuristic layered on top of that same first-fit structure,
 * not a step toward an optimizer: an activity can carry `preferredWindows`
 * (e.g. a food activity biased toward lunch/dinner — the caller decides what
 * counts as "preferred," this module stays domain-agnostic). Each window is
 * tried in order, across the whole date range, before falling back to the
 * unconstrained earliest-fit search — still one forward pass per window, not
 * a search over placements.
 */
import { toEpochDay, weekdayOf } from "./dates";

const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_START_MINUTES = 600; // 10:00
const DEFAULT_GAP_MINUTES = 60;
const DEFAULT_DURATION_MINUTES = 60;

/** Weekday name (lowercase) -> "HH:MM-HH:MM". A day with no entry is treated as not open that day (distinct from `closedDays`, which marks a day closed explicitly). */
export type OpeningHours = Record<string, string>;

/** A minute-of-day range an activity should be tried against before falling back to the unconstrained earliest-fit search (e.g. a meal window). */
export interface PreferredWindow {
  startMinutes: number;
  endMinutes: number;
}

export interface SchedulableActivity {
  id: string;
  /** Falls back to a 60-minute default if not known. */
  durationMinutes?: number | null;
  openingHours?: OpeningHours | null;
  closedDays?: string[] | null;
  /** Tried in order, each across the whole date range, before the unconstrained fallback. Omit for no preference. */
  preferredWindows?: PreferredWindow[];
}

export interface ScheduleParams {
  activities: SchedulableActivity[];
  /** Destination-local calendar dates the schedule may use, inclusive of both ends. */
  dateRange: { start: string; end: string };
  /** Minutes after local midnight tried first on a day with nothing scheduled yet. Defaults to 600 (10:00). */
  defaultStartMinutes?: number;
  /** Minutes left between two activities placed on the same day. Defaults to 60. */
  gapMinutes?: number;
  /**
   * Per-date override for the earliest minute-of-day an activity may start on
   * that date (e.g. the arrival day's transfer-buffer boundary —
   * `validateItineraryFeasibility` rejects anything scheduled before it, so
   * this scheduler needs to know about it too, not just the destination's
   * own opening hours). Dates not listed here use `defaultStartMinutes`.
   */
  earliestStartByDate?: Record<string, number>;
  /**
   * Per-date cap on the latest minute-of-day an activity may *end* on that
   * date (e.g. the departure day's transfer-buffer boundary). Dates not
   * listed here may run until local midnight.
   */
  latestEndByDate?: Record<string, number>;
}

export interface ScheduledSlot {
  id: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

export interface ScheduleResult {
  scheduled: ScheduledSlot[];
  /** Activities that didn't fit anywhere in the date range (every day closed, no opening-hours match, or every day already full). */
  unscheduled: string[];
}

function enumerateDates(start: string, end: string): string[] {
  const startDay = toEpochDay(start);
  const endDay = toEpochDay(end);
  const dates: string[] = [];
  for (let day = startDay; day <= endDay; day++) {
    dates.push(new Date(day * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * The earliest minute-of-day this activity could start on `weekday`, given
 * it can't start before `earliestCandidate` (the running cursor for the
 * day, already floored by any `earliestStartByDate` boundary) — or `null`
 * if it can't fit at all. Critically, this *advances* into the activity's
 * own opening window rather than only testing `earliestCandidate` itself:
 * an evening-only activity (e.g. open 19:30-23:00) should still be
 * schedulable on an otherwise-empty day, not skipped just because the
 * day's default/cursor start happens to be 10:00. No entry for `weekday` at
 * all means not open that day — a stricter rule than
 * `validateItineraryFeasibility`'s own check (which also credits a previous
 * day's overnight window), acceptable for a first-fit greedy placer.
 */
function earliestFeasibleStart(
  openingHours: OpeningHours | null | undefined,
  weekday: string,
  earliestCandidate: number,
  duration: number,
  dayCeiling: number,
): number | null {
  if (!openingHours) {
    return earliestCandidate + duration <= dayCeiling ? earliestCandidate : null;
  }
  const today = openingHours[weekday];
  if (!today) return null;
  const [open, close] = today.split("-").map(toMinutes);
  const wraps = close <= open;
  const effectiveClose = wraps ? close + MINUTES_PER_DAY : close;
  const start = Math.max(earliestCandidate, open);
  return start + duration <= effectiveClose && start + duration <= dayCeiling ? start : null;
}

/**
 * Greedily places each activity, in the order given, at the first
 * day/time slot that respects its `closedDays`/`openingHours` and doesn't
 * collide with anything already placed that day. Deterministic for a given
 * input order — callers control priority by pre-sorting `activities`.
 */
export function scheduleActivities(params: ScheduleParams): ScheduleResult {
  const dates = enumerateDates(params.dateRange.start, params.dateRange.end);
  const defaultStart = params.defaultStartMinutes ?? DEFAULT_START_MINUTES;
  const gap = params.gapMinutes ?? DEFAULT_GAP_MINUTES;
  const nextAvailableMinute = new Map<string, number>();

  const scheduled: ScheduledSlot[] = [];
  const unscheduled: string[] = [];

  /**
   * One forward pass over `dates` for a single activity, optionally capped
   * to a preferred window on top of the day's usual boundaries. Returns the
   * slot it placed (and records it) or `null` if nothing in `dates` fit
   * within the window — the caller decides what to try next.
   */
  function tryPlace(activity: SchedulableActivity, duration: number, window?: PreferredWindow): ScheduledSlot | null {
    for (const date of dates) {
      const weekday = weekdayOf(date);
      if ((activity.closedDays ?? []).includes(weekday)) continue;

      const earliestStart = params.earliestStartByDate?.[date] ?? defaultStart;
      let earliestCandidate = Math.max(nextAvailableMinute.get(date) ?? defaultStart, earliestStart);
      let dayCeiling = Math.min(params.latestEndByDate?.[date] ?? MINUTES_PER_DAY, MINUTES_PER_DAY);
      if (window) {
        earliestCandidate = Math.max(earliestCandidate, window.startMinutes);
        dayCeiling = Math.min(dayCeiling, window.endMinutes);
      }

      const start = earliestFeasibleStart(activity.openingHours, weekday, earliestCandidate, duration, dayCeiling);
      if (start === null) continue;

      const slot: ScheduledSlot = { id: activity.id, date, startMinutes: start, durationMinutes: duration };
      scheduled.push(slot);
      nextAvailableMinute.set(date, start + duration + gap);
      return slot;
    }
    return null;
  }

  for (const activity of params.activities) {
    const duration = activity.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    let placed: ScheduledSlot | null = null;

    for (const window of activity.preferredWindows ?? []) {
      placed = tryPlace(activity, duration, window);
      if (placed) break;
    }
    if (!placed) placed = tryPlace(activity, duration);

    if (!placed) unscheduled.push(activity.id);
  }

  return { scheduled, unscheduled };
}
