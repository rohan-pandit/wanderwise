/**
 * Shimmer placeholders for a list of cards that's about to arrive (flight/
 * hotel candidates, activity suggestions) — sized to roughly match the real
 * card each one stands in for, so there's no layout jump once real content
 * replaces it. `padCls` is threaded in from the caller's own desktop/mobile
 * size variables (`cardPadCls` in `itinerary-panel.tsx`) rather than fixed
 * here, so a skeleton in sidebar mode is exactly as roomy as the card it
 * precedes.
 */
export function SkeletonCandidateCard({ padCls }: { padCls: string }) {
  return (
    <div className={`rounded-lg border border-sand-200 ${padCls}`}>
      <div className="h-4 w-3/5 animate-pulse rounded bg-sand-200" />
      <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-sand-200" />
    </div>
  );
}

export function SkeletonActivityCard({ padCls }: { padCls: string }) {
  return (
    <div className={`rounded-xl bg-white shadow-[0_1px_2px_rgba(22,35,58,0.06),0_4px_12px_rgba(22,35,58,0.08)] ${padCls}`}>
      <div className="h-4 w-2/3 animate-pulse rounded bg-sand-200" />
      <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-sand-200" />
      <div className="mt-2 h-3 w-full animate-pulse rounded bg-sand-200" />
      <div className="mt-3 h-7 w-28 animate-pulse rounded-md bg-sand-200" />
    </div>
  );
}
