/**
 * Pure display-formatting helpers shared between `ItineraryPanel`
 * (`app/app/_components/itinerary-panel.tsx`, the live in-progress view) and
 * the finalized trip review page (`app/app/_components/trip-review.tsx`, a
 * server component) — extracted here so a server component can use them
 * without importing a `"use client"` module.
 */

export function formatMoney(m?: { amount: number; currency: string }): string | null {
  if (!m) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(m.amount);
}

export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

export function formatFlightTime(iso: string, timeZone: string | null): string {
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
