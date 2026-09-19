/**
 * Replaces the plain "Thinking…" text `ChatPanel` used to show while
 * `sendMessage` is in flight — an assistant-style bubble (same shape/color
 * as a real assistant message) with three staggered bouncing dots, so it
 * reads as part of the conversation rather than a status line easy to miss.
 * The text itself survives for screen readers via `sr-only` + the
 * container's own `aria-live` (set by the caller, matching where the old
 * text's `aria-live="polite"` lived).
 */
export function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-1.5 rounded-2xl bg-sand-100 px-4 py-3">
        <span className="sr-only">Thinking…</span>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-navy-400 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-navy-400 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-navy-400" />
      </div>
    </div>
  );
}
