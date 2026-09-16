/**
 * Itinerary feasibility engine (PROJECT_BRIEF.md §9.2). Pure, structured-input
 * validation of a dated draft itinerary — dates, time zones, schedules,
 * conflicts, and basic logistics. This runs *after* `assembleCandidateCombinations`
 * has produced a budget-feasible bundle and the bundle has been laid out
 * against real dates/times; it never touches the DB or an LLM.
 */
import {
  type DateRange,
  isWithinRange,
  localDateInTimeZone,
  localMinutesOfDay,
  toEpochDay,
  WEEKDAYS,
  weekdayOf,
} from "./dates";

export interface FlightLeg {
  id: string;
  /** ISO timestamp, UTC. */
  departureTime: string;
  arrivalTime: string;
  departureTimeZone: string;
  arrivalTimeZone: string;
}

export interface HotelStay {
  id: string;
  /** ISO dates, destination-local calendar days. */
  checkIn: string;
  checkOut: string;
}

/** Weekday name (lowercase, e.g. "monday") -> "HH:MM-HH:MM", present only for open days. Ranges may cross midnight (e.g. "21:00-01:00"). */
export type OpeningHours = Record<string, string>;

export interface ScheduledActivity {
  id: string;
  /** ISO date, the destination-local calendar day this activity is scheduled on. */
  date: string;
  /** Minutes after local midnight the activity starts. */
  startMinutes: number;
  durationMinutes: number;
  openingHours?: OpeningHours | null;
  closedDays?: string[] | null;
}

export interface DraftItinerary {
  destinationTimeZone: string;
  /** Destination-local calendar dates the trip spans, inclusive. */
  tripDateRange: DateRange;
  outboundFlight: FlightLeg;
  returnFlight: FlightLeg;
  hotelStay: HotelStay;
  scheduledActivities: ScheduledActivity[];
  /** Minutes required after landing before any activity may start. Default 180. */
  arrivalBufferMinutes?: number;
  /** Minutes required before departure that no activity may still be running. Default 180. */
  departureBufferMinutes?: number;
}

export interface FeasibilityViolation {
  code: string;
  severity: "error";
  itemId: string;
  message: string;
}

export interface FeasibilityWarning {
  code: string;
  itemId?: string;
  message: string;
}

export interface FeasibilityResult {
  valid: boolean;
  violations: FeasibilityViolation[];
  warnings: FeasibilityWarning[];
}

const DEFAULT_TRANSFER_BUFFER_MINUTES = 180;
const TIGHT_BUFFER_MARGIN_MINUTES = 60;
const EXCESSIVE_DAILY_LOAD_MINUTES = 600;
const MINUTES_PER_DAY = 24 * 60;

export function validateItineraryFeasibility(itinerary: DraftItinerary): FeasibilityResult {
  const violations: FeasibilityViolation[] = [];
  const warnings: FeasibilityWarning[] = [];

  const { hotelStay, tripDateRange, scheduledActivities } = itinerary;

  if (hotelStay.checkIn > tripDateRange.start || hotelStay.checkOut < tripDateRange.end) {
    violations.push({
      code: "HOTEL_DOES_NOT_COVER_TRIP",
      severity: "error",
      itemId: hotelStay.id,
      message: `Hotel stay (${hotelStay.checkIn} to ${hotelStay.checkOut}) does not cover the full trip (${tripDateRange.start} to ${tripDateRange.end}).`,
    });
  }

  // Expressed as absolute "local instants" (epoch day * 1440 + minutes-of-day)
  // rather than a same-calendar-day comparison, so a buffer that spills
  // across midnight (e.g. a late arrival or an early departure) still
  // correctly reaches into the adjacent day's activities.
  const arrivalBuffer = itinerary.arrivalBufferMinutes ?? DEFAULT_TRANSFER_BUFFER_MINUTES;
  const departureBuffer = itinerary.departureBufferMinutes ?? DEFAULT_TRANSFER_BUFFER_MINUTES;
  const earliestActivityInstant =
    localInstant(
      localDateInTimeZone(itinerary.outboundFlight.arrivalTime, itinerary.destinationTimeZone),
      localMinutesOfDay(itinerary.outboundFlight.arrivalTime, itinerary.destinationTimeZone),
    ) + arrivalBuffer;
  const latestActivityInstant =
    localInstant(
      localDateInTimeZone(itinerary.returnFlight.departureTime, itinerary.destinationTimeZone),
      localMinutesOfDay(itinerary.returnFlight.departureTime, itinerary.destinationTimeZone),
    ) - departureBuffer;

  const seenIds = new Set<string>();
  const byDate = new Map<string, { id: string; start: number; end: number }[]>();

  for (const activity of scheduledActivities) {
    if (seenIds.has(activity.id)) {
      violations.push({
        code: "DUPLICATE_ACTIVITY",
        severity: "error",
        itemId: activity.id,
        message: `Activity ${activity.id} is scheduled more than once.`,
      });
    }
    seenIds.add(activity.id);

    if (!isWithinRange(activity.date, tripDateRange)) {
      violations.push({
        code: "ACTIVITY_OUTSIDE_TRIP_DATES",
        severity: "error",
        itemId: activity.id,
        message: `Activity is scheduled on ${activity.date}, outside the trip dates (${tripDateRange.start} to ${tripDateRange.end}).`,
      });
    }

    if (activity.date < hotelStay.checkIn || activity.date > hotelStay.checkOut) {
      violations.push({
        code: "ACTIVITY_OUTSIDE_HOTEL_STAY",
        severity: "error",
        itemId: activity.id,
        message: `Activity is scheduled on ${activity.date}, outside the hotel stay (${hotelStay.checkIn} to ${hotelStay.checkOut}).`,
      });
    }

    const weekday = weekdayOf(activity.date);
    const closedToday = (activity.closedDays ?? []).includes(weekday);
    if (closedToday) {
      violations.push({
        code: "ACTIVITY_CLOSED",
        severity: "error",
        itemId: activity.id,
        message: `Activity is closed on ${weekday}.`,
      });
    } else if (activity.openingHours) {
      const hoursMessage = openingHoursViolation(activity, weekday, activity.openingHours);
      if (hoursMessage) {
        violations.push({
          code: "ACTIVITY_OUTSIDE_OPENING_HOURS",
          severity: "error",
          itemId: activity.id,
          message: hoursMessage,
        });
      }
    }

    const activityStart = localInstant(activity.date, activity.startMinutes);
    const activityEnd = activityStart + activity.durationMinutes;

    checkTransferBuffer({
      itemId: activity.id,
      itemStart: activityStart,
      itemEnd: activityEnd,
      boundary: earliestActivityInstant,
      direction: "after",
      violationCode: "ACTIVITY_BEFORE_ARRIVAL",
      violationMessage: `Activity starts before the ${arrivalBuffer}-minute transfer buffer after landing.`,
      warningMessage: "The proposed schedule leaves little recovery time after arrival.",
      violations,
      warnings,
    });
    checkTransferBuffer({
      itemId: activity.id,
      itemStart: activityStart,
      itemEnd: activityEnd,
      boundary: latestActivityInstant,
      direction: "before",
      violationCode: "ACTIVITY_AFTER_DEPARTURE",
      violationMessage: `Activity ends inside the ${departureBuffer}-minute transfer buffer before departure.`,
      warningMessage: "The proposed schedule leaves little recovery time before departure.",
      violations,
      warnings,
    });

    const dayEntries = byDate.get(activity.date) ?? [];
    dayEntries.push({
      id: activity.id,
      start: activity.startMinutes,
      end: activity.startMinutes + activity.durationMinutes,
    });
    byDate.set(activity.date, dayEntries);
  }

  for (const [date, entries] of byDate) {
    const sorted = [...entries].sort((a, b) => a.start - b.start || a.end - b.end);
    let runningMaxEnd = -Infinity;
    let runningMaxOwner: string | null = null;
    for (const entry of sorted) {
      if (entry.start < runningMaxEnd) {
        violations.push({
          code: "OVERLAPPING_ACTIVITIES",
          severity: "error",
          itemId: entry.id,
          message: `Activity ${entry.id} overlaps with ${runningMaxOwner} on ${date}.`,
        });
      }
      if (entry.end > runningMaxEnd) {
        runningMaxEnd = entry.end;
        runningMaxOwner = entry.id;
      }
    }

    const totalMinutes = entries.reduce((sum, e) => sum + (e.end - e.start), 0);
    if (totalMinutes > EXCESSIVE_DAILY_LOAD_MINUTES) {
      warnings.push({
        code: "EXCESSIVE_DAILY_LOAD",
        message: `${date} schedules ${totalMinutes} minutes of activities, an unusually full day.`,
      });
    }
  }

  return { valid: violations.length === 0, violations, warnings };
}

/** Epoch-day-relative minutes, so instants on different calendar dates compare directly. */
function localInstant(isoDate: string, minutesOfDay: number): number {
  return toEpochDay(isoDate) * MINUTES_PER_DAY + minutesOfDay;
}

interface TransferBufferCheck {
  itemId: string;
  itemStart: number;
  itemEnd: number;
  boundary: number;
  /** "after": the item must start at or after `boundary` (arrival). "before": the item must end at or before `boundary` (departure). */
  direction: "after" | "before";
  violationCode: string;
  violationMessage: string;
  warningMessage: string;
  violations: FeasibilityViolation[];
  warnings: FeasibilityWarning[];
}

function checkTransferBuffer(check: TransferBufferCheck): void {
  const { itemId, itemStart, itemEnd, boundary, direction, violations, warnings } = check;
  const violates = direction === "after" ? itemStart < boundary : itemEnd > boundary;
  if (violates) {
    violations.push({
      code: check.violationCode,
      severity: "error",
      itemId,
      message: check.violationMessage,
    });
    return;
  }
  const margin = direction === "after" ? itemStart - boundary : boundary - itemEnd;
  if (margin < TIGHT_BUFFER_MARGIN_MINUTES) {
    warnings.push({ code: "TIGHT_TRANSFER_BUFFER", itemId, message: check.warningMessage });
  }
}

/** Returns a violation message if the activity falls outside its listed opening hours, else null. */
function openingHoursViolation(
  activity: ScheduledActivity,
  weekday: string,
  openingHours: OpeningHours,
): string | null {
  const end = activity.startMinutes + activity.durationMinutes;

  const today = openingHours[weekday];
  if (today) {
    const [open, close] = parseHoursRange(today);
    const wrapsPastMidnight = close <= open;
    const effectiveClose = wrapsPastMidnight ? close + MINUTES_PER_DAY : close;
    if (activity.startMinutes >= open && end <= effectiveClose) return null;
  }

  // An overnight window from the *previous* day (e.g. "21:00-01:00") can
  // still cover an activity scheduled early this morning, even though
  // today's own opening-hours entry (if any) doesn't start until later.
  const weekdayIndex = (WEEKDAYS as readonly string[]).indexOf(weekday);
  const previousWeekday = WEEKDAYS[(weekdayIndex + 6) % 7];
  const yesterday = openingHours[previousWeekday];
  if (yesterday) {
    const [open, close] = parseHoursRange(yesterday);
    if (close <= open && activity.startMinutes < close && end <= close) return null;
  }

  return today
    ? `Activity (${formatMinutes(activity.startMinutes)}-${formatMinutes(end)}) falls outside opening hours on ${weekday} (${today}).`
    : `Activity has no listed opening hours on ${weekday}.`;
}

function parseHoursRange(range: string): [number, number] {
  const [open, close] = range.split("-");
  return [toMinutes(open), toMinutes(close)];
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
