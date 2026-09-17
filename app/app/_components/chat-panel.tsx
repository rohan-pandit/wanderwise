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
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sendMessage } from "../actions";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export function ChatPanel({
  tripId: initialTripId,
  initialMessages,
}: {
  tripId?: string;
  initialMessages: ChatMessage[];
}) {
  const router = useRouter();
  const [tripId, setTripId] = useState(initialTripId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || pending) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setPending(true);
    setError(null);

    try {
      const result = await sendMessage({ tripId, message: trimmed });
      setMessages((prev) => [...prev, { role: "assistant", content: result.assistantMessage }]);
      if (!tripId) {
        setTripId(result.tripId);
        router.push(`/app/trips/${result.tripId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
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
                      ? "bg-black text-white dark:bg-zinc-50 dark:text-black"
                      : "bg-zinc-100 text-black dark:bg-zinc-800 dark:text-zinc-50"
                  }`}
                >
                  {message.content}
                </div>
              </li>
            ))}
          </ul>
        )}
        {pending ? (
          <p className="mt-3 text-xs text-zinc-400 dark:text-zinc-600" aria-live="polite">
            Thinking…
          </p>
        ) : null}
        {error ? <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={pending}
          placeholder="Message Wanderwise…"
          className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm text-black outline-none focus:border-zinc-500 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50"
        />
        <button
          type="submit"
          disabled={pending || !input.trim()}
          className="rounded-lg bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-50 dark:text-black"
        >
          Send
        </button>
      </form>
    </section>
  );
}
