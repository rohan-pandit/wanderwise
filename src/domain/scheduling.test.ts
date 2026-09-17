import { describe, expect, it } from "vitest";
import { scheduleActivities, type ScheduleParams } from "./scheduling";

function baseParams(overrides: Partial<ScheduleParams> = {}): ScheduleParams {
  return {
    activities: [],
    dateRange: { start: "2026-10-06", end: "2026-10-10" },
    ...overrides,
  };
}

describe("scheduleActivities", () => {
  it("places an activity with no constraints on the first day of the range", () => {
    const result = scheduleActivities(baseParams({ activities: [{ id: "a1", durationMinutes: 90 }] }));
    expect(result.scheduled).toEqual([{ id: "a1", date: "2026-10-06", startMinutes: 600, durationMinutes: 90 }]);
    expect(result.unscheduled).toEqual([]);
  });

  it("falls back to a 60-minute default duration when unknown", () => {
    const result = scheduleActivities(baseParams({ activities: [{ id: "a1" }] }));
    expect(result.scheduled[0].durationMinutes).toBe(60);
  });

  it("skips a day the activity is closed on", () => {
    // 2026-10-06 is a Tuesday.
    const result = scheduleActivities(
      baseParams({ activities: [{ id: "a1", durationMinutes: 60, closedDays: ["tuesday"] }] }),
    );
    expect(result.scheduled[0].date).toBe("2026-10-07");
  });

  it("leaves an activity unscheduled when every day in range is closed", () => {
    const result = scheduleActivities(
      baseParams({
        dateRange: { start: "2026-10-06", end: "2026-10-06" }, // just the Tuesday
        activities: [{ id: "a1", durationMinutes: 60, closedDays: ["tuesday"] }],
      }),
    );
    expect(result.scheduled).toEqual([]);
    expect(result.unscheduled).toEqual(["a1"]);
  });

  it("stacks two activities on the same day back-to-back with a gap, in input order", () => {
    const result = scheduleActivities(
      baseParams({
        activities: [
          { id: "first", durationMinutes: 120 },
          { id: "second", durationMinutes: 60 },
        ],
      }),
    );
    expect(result.scheduled).toEqual([
      { id: "first", date: "2026-10-06", startMinutes: 600, durationMinutes: 120 },
      // 600 + 120 + 60 (default gap) = 780
      { id: "second", date: "2026-10-06", startMinutes: 780, durationMinutes: 60 },
    ]);
  });

  it("moves to the next day once the current day is full", () => {
    const result = scheduleActivities(
      baseParams({
        dateRange: { start: "2026-10-06", end: "2026-10-07" },
        activities: [
          { id: "big", durationMinutes: 800 }, // 600 + 800 > 1440? no, fits; pushes cursor near midnight
          { id: "overflow", durationMinutes: 200 },
        ],
      }),
    );
    expect(result.scheduled.find((s) => s.id === "big")?.date).toBe("2026-10-06");
    expect(result.scheduled.find((s) => s.id === "overflow")?.date).toBe("2026-10-07");
  });

  it("jumps forward to an evening-only activity's own opening time rather than skipping the day (the default 10:00 start doesn't fit it)", () => {
    const result = scheduleActivities(
      baseParams({
        activities: [{ id: "a1", durationMinutes: 60, openingHours: { tuesday: "18:00-22:00" } }],
      }),
    );
    // 2026-10-06 is a Tuesday — its only opening window is the evening one,
    // so the activity should be placed there, not left unscheduled just
    // because the default start (10:00) falls outside it.
    expect(result.scheduled).toEqual([{ id: "a1", date: "2026-10-06", startMinutes: 18 * 60, durationMinutes: 60 }]);
  });

  it("leaves an activity unscheduled when no day in range has a matching opening-hours entry at all", () => {
    const result = scheduleActivities(
      baseParams({
        dateRange: { start: "2026-10-07", end: "2026-10-08" }, // Wednesday, Thursday — no "tuesday" entry
        activities: [{ id: "a1", durationMinutes: 60, openingHours: { tuesday: "18:00-22:00" } }],
      }),
    );
    expect(result.unscheduled).toEqual(["a1"]);
  });

  it("places within an opening-hours window that covers the default start time", () => {
    const result = scheduleActivities(
      baseParams({
        activities: [{ id: "a1", durationMinutes: 60, openingHours: { tuesday: "09:00-18:00" } }],
      }),
    );
    expect(result.scheduled).toEqual([{ id: "a1", date: "2026-10-06", startMinutes: 600, durationMinutes: 60 }]);
  });

  it("handles an overnight (wraparound) opening-hours window", () => {
    const result = scheduleActivities(
      baseParams({
        defaultStartMinutes: 22 * 60, // 22:00
        activities: [{ id: "a1", durationMinutes: 120, openingHours: { tuesday: "21:00-02:00" } }],
      }),
    );
    expect(result.scheduled).toEqual([{ id: "a1", date: "2026-10-06", startMinutes: 22 * 60, durationMinutes: 120 }]);
  });

  it("respects a per-date earliest-start override (e.g. an arrival-day transfer buffer)", () => {
    const result = scheduleActivities(
      baseParams({
        dateRange: { start: "2026-10-06", end: "2026-10-06" },
        activities: [{ id: "a1", durationMinutes: 60 }],
        earliestStartByDate: { "2026-10-06": 13 * 60 },
      }),
    );
    expect(result.scheduled).toEqual([{ id: "a1", date: "2026-10-06", startMinutes: 13 * 60, durationMinutes: 60 }]);
  });

  it("respects a per-date latest-end cap (e.g. a departure-day transfer buffer), pushing an activity that doesn't fit to unscheduled", () => {
    const result = scheduleActivities(
      baseParams({
        dateRange: { start: "2026-10-06", end: "2026-10-06" },
        activities: [{ id: "a1", durationMinutes: 120 }],
        latestEndByDate: { "2026-10-06": 630 }, // 10:30 — the default 10:00 start + 120min (12:00) overruns it
      }),
    );
    expect(result.scheduled).toEqual([]);
    expect(result.unscheduled).toEqual(["a1"]);
  });

  it("never spills an activity past midnight", () => {
    const result = scheduleActivities(
      baseParams({
        dateRange: { start: "2026-10-06", end: "2026-10-06" },
        defaultStartMinutes: 23 * 60,
        activities: [{ id: "a1", durationMinutes: 120 }],
      }),
    );
    expect(result.scheduled).toEqual([]);
    expect(result.unscheduled).toEqual(["a1"]);
  });

  describe("preferredWindows", () => {
    const LUNCH = { startMinutes: 11 * 60 + 30, endMinutes: 14 * 60 };
    const DINNER = { startMinutes: 18 * 60, endMinutes: 21 * 60 };

    it("places an all-day-open activity inside its preferred window instead of the default 10:00 start", () => {
      const result = scheduleActivities(
        baseParams({
          activities: [{ id: "lunch-spot", durationMinutes: 60, preferredWindows: [LUNCH] }],
        }),
      );
      expect(result.scheduled).toEqual([{ id: "lunch-spot", date: "2026-10-06", startMinutes: LUNCH.startMinutes, durationMinutes: 60 }]);
    });

    it("tries windows in order — dinner only if lunch doesn't fit anywhere in range", () => {
      const result = scheduleActivities(
        baseParams({
          // Lunch window fully consumed by something else on every day in range.
          dateRange: { start: "2026-10-06", end: "2026-10-06" },
          activities: [
            { id: "blocks-lunch", durationMinutes: 150 }, // 10:00-12:30, eats into the lunch window
            { id: "food", durationMinutes: 60, preferredWindows: [LUNCH, DINNER] },
          ],
        }),
      );
      const food = result.scheduled.find((s) => s.id === "food");
      expect(food?.startMinutes).toBe(DINNER.startMinutes);
    });

    it("falls back to the unconstrained earliest-fit search when no preferred window fits anywhere in range", () => {
      const result = scheduleActivities(
        baseParams({
          dateRange: { start: "2026-10-06", end: "2026-10-06" },
          activities: [{ id: "odd-hours", durationMinutes: 60, openingHours: { tuesday: "06:00-11:00" }, preferredWindows: [LUNCH, DINNER] }],
        }),
      );
      // 2026-10-06 is a Tuesday, open 06:00-11:00 — closes before the lunch
      // window even opens, so neither preferred window fits, but the
      // activity still gets placed via the fallback pass (at the default
      // 10:00 start), not left unscheduled.
      expect(result.scheduled).toEqual([{ id: "odd-hours", date: "2026-10-06", startMinutes: 10 * 60, durationMinutes: 60 }]);
      expect(result.unscheduled).toEqual([]);
    });

    it("still respects closedDays/openingHours and per-date buffers while searching within a preferred window", () => {
      const result = scheduleActivities(
        baseParams({
          dateRange: { start: "2026-10-06", end: "2026-10-06" },
          activities: [{ id: "food", durationMinutes: 60, preferredWindows: [LUNCH] }],
          earliestStartByDate: { "2026-10-06": 13 * 60 }, // arrival-day transfer buffer, later than lunch's own start
        }),
      );
      expect(result.scheduled).toEqual([{ id: "food", date: "2026-10-06", startMinutes: 13 * 60, durationMinutes: 60 }]);
    });
  });
});
