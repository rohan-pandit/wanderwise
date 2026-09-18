/**
 * Parses a trip's free-text `destination` requirement (e.g. "Madrid, Spain",
 * "Madrid") into a city and an optional country, for country-aware matching
 * against `destinations` (`src/repositories/destinations.ts`'s
 * `getDestinationByName`). The Intake agent isn't instructed to normalize
 * this itself (`SYSTEM_PROMPT`, `src/agents/intake.ts`) — it just reports
 * whatever the user said, verbatim — so the matching side has to be the one
 * that's format-tolerant. Found live 2026-09-18: "Madrid, Spain" failed to
 * resolve against a seeded destination named exactly "Madrid" even though
 * that destination has real inventory, because the old lookup was a bare
 * case-sensitive exact match with no comma-splitting.
 *
 * Deliberately splits on the *first* comma only — "City, Country" is the
 * only format this needs to handle (nothing upstream ever asks for or
 * produces a more specific "City, Region, Country" shape), and splitting on
 * the first comma degrades gracefully for that case anyway (city correct,
 * country too specific to match — falls through to the existing
 * `UnknownDestinationError`/`AmbiguousDestinationNameError` handling rather
 * than silently guessing).
 */
export interface ParsedDestinationQuery {
  city: string;
  country: string | null;
}

export function parseDestinationQuery(raw: string): ParsedDestinationQuery {
  const trimmed = raw.trim();
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex === -1) {
    return { city: trimmed, country: null };
  }
  const city = trimmed.slice(0, commaIndex).trim();
  const country = trimmed.slice(commaIndex + 1).trim();
  return { city, country: country.length > 0 ? country : null };
}
