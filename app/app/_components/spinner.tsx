/**
 * Small inline spinner for a button's pending state — `currentColor` on both
 * strokes (one dim, one bright) so it automatically matches whatever text
 * color the button it's placed in already uses, rather than needing a color
 * prop per call site (a teal outline button, a terracotta filled one, etc.
 * all just work). Pairs with a swapped "-ing" label, not a replacement for
 * one — see `itinerary-panel.tsx`'s pending-button call sites.
 */
export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`h-3.5 w-3.5 flex-shrink-0 animate-spin ${className}`} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M10 2a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
