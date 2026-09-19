/**
 * URL-friendly slug generation for a trip's name, so a trip's URL reads as
 * `/app/trips/lisbon-getaway` instead of a raw UUID
 * (`app/app/trips/[identifier]/page.tsx`). Pure and deterministic — the
 * DB-side uniqueness handling that actually resolves a same-name collision
 * lives in `generateUniqueTripSlug` (`src/repositories/trips.ts`), since it
 * needs a database round trip this module deliberately doesn't make.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` looks like a trip's raw `id` rather than a `slug` — `[identifier]/page.tsx` uses this to decide which column to query. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const MAX_SLUG_LENGTH = 60;

/**
 * Lowercases, collapses any run of non-alphanumeric characters to a single
 * hyphen, trims leading/trailing hyphens, and caps the length. Never
 * returns an empty string — a name with no alphanumeric characters at all
 * (e.g. pure emoji/punctuation) falls back to `"trip"` rather than
 * producing a degenerate slug that's just a dash or nothing.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return base || "trip";
}
