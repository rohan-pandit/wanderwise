const FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Sep 25, 13:20 UTC" — pinned to UTC so a server-rendered page reads the same wherever it's rendered. */
export function formatTimestamp(iso: string): string {
  return `${FORMATTER.format(new Date(iso))} UTC`;
}
