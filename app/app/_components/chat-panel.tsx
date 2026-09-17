"use client";

/**
 * The chat half of the core product experience (PROJECT_BRIEF.md §14,
 * Phase 7). Calls `sendMessage` (`app/app/actions.ts`) for every turn —
 * that action itself decides what happens next (stay in intake, kick off
 * search/assembly, or apply a decision revision) and auto-chains into it
 * via `after()`, so this component only ever needs to call the one action
 * and otherwise just render whatever comes back. The live itinerary panel
 * (`itinerary-panel.tsx`) picks up everything that happens after this
 * response returns via its own Supabase Realtime subscription.
 *
 * Slice 4 (stepwise chain redesign): if `sendMessage` signals
 * `pendingCascadeConfirmation` (a chat-requested revision that risks
 * invalidating already-confirmed downstream work), this reports it up via
 * `onPendingCascade` instead of silently proceeding — `TripWorkspace` owns
 * that state and `ItineraryPanel` renders the actual warning banner, since
 * either this panel (chat) or that one (a direct "Change" click) can
 * trigger it.
 */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { sendMessage, type PendingCascadeConfirmation } from "../actions";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function ChatPanel({
  tripId: initialTripId,
  initialMessages,
  onPendingCascade,
}: {
  tripId?: string;
  initialMessages: ChatMessage[];
  onPendingCascade?: (pending: PendingCascadeConfirmation) => void;
}) {
  const router = useRouter();
  const [tripId, setTripId] = useState(initialTripId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable across every send attempt until a trip exists — a lost response
  // followed by a retry (double-click, network-level resend) reuses this
  // same key, so `startTrip` (src/workflow/controller.ts) resolves it to
  // the same trip instead of creating a second, orphaned one. Generated
  // lazily rather than eagerly on mount, since most sessions resume an
  // existing trip and never need one.
  const startCorrelationIdRef = useRef<string | null>(null);
  function startCorrelationId(): string {
    if (!startCorrelationIdRef.current) startCorrelationIdRef.current = crypto.randomUUID();
    return startCorrelationIdRef.current;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || pending) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setPending(true);
    setError(null);

    try {
      const result = await sendMessage({
        tripId,
        message: trimmed,
        startCorrelationId: tripId ? undefined : startCorrelationId(),
        turnCorrelationId: crypto.randomUUID(),
      });
      setMessages((prev) => [...prev, { role: "assistant", content: result.assistantMessage }]);
      if (!tripId) {
        setTripId(result.tripId);
        router.push(`/app/trips/${result.tripId}`);
      }
      if (result.pendingCascadeConfirmation) {
        onPendingCascade?.(result.pendingCascadeConfirmation);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 ? (
          <p className="text-sm text-navy-400">
            Tell me about the trip you&apos;re planning — where from, where to, when, how many people, and your budget.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((message, i) => (
              <li
                key={i}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                    message.role === "user"
                      ? "bg-navy-900 text-sand-50"
                      : "bg-sand-100 text-navy-900"
                  }`}
                >
                  {message.content}
                </div>
              </li>
            ))}
          </ul>
        )}
        {pending ? (
          <p className="mt-3 text-xs text-navy-400" aria-live="polite">
            Thinking…
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-sand-200 px-6 py-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={pending}
          placeholder="Message Wanderwise…"
          className="flex-1 rounded-lg border border-sand-300 bg-transparent px-3 py-2 text-sm text-navy-900 outline-none focus:border-navy-400 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-sand-50 transition-colors hover:bg-teal-800 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </section>
  );
}
