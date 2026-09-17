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
 * guardrail; revisit with something smarter (time-of-day preferences,
 * geographic clustering, meal-time awareness) once the Itinerary Writer
 * (Phase 7) needs a more natural-feeling schedule.
 */
import { toEpochDay, weekdayOf } from "./dates";

const MINUTES_PER_DAY = 24 * 60;
const DEFAULT_START_MINUTES = 600; // 10:00
const DEFAULT_GAP_MINUTES = 60;
const DEFAULT_DURATION_MINUTES = 60;

/** Weekday name (lowercase) -> "HH:MM-HH:MM". A day with no entry is treated as not open that day (distinct from `closedDays`, which marks a day closed explicitly). */
export type OpeningHours = Record<string, string>;

export interface SchedulableActivity {
  id: string;
  /** Falls back to a 60-minute default if not known. */
  durationMinutes?: number | null;
  openingHours?: OpeningHours | null;
  closedDays?: string[] | null;
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

  for (const activity of params.activities) {
    const duration = activity.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    let placed = false;

    for (const date of dates) {
      const weekday = weekdayOf(date);
      if ((activity.closedDays ?? []).includes(weekday)) continue;

      const earliestStart = params.earliestStartByDate?.[date] ?? defaultStart;
      const earliestCandidate = Math.max(nextAvailableMinute.get(date) ?? defaultStart, earliestStart);
      const dayCeiling = Math.min(params.latestEndByDate?.[date] ?? MINUTES_PER_DAY, MINUTES_PER_DAY);
      const start = earliestFeasibleStart(activity.openingHours, weekday, earliestCandidate, duration, dayCeiling);
      if (start === null) continue;

      scheduled.push({ id: activity.id, date, startMinutes: start, durationMinutes: duration });
      nextAvailableMinute.set(date, start + duration + gap);
      placed = true;
      break;
    }

    if (!placed) unscheduled.push(activity.id);
  }

  return { scheduled, unscheduled };
}
