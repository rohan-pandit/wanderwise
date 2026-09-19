"use client";

/**
 * The finalized trip review page's "View chat history" button + slide-over
 * panel (PROJECT_BRIEF.md §14 UX rework, 2026-09-19) — read-only, purely
 * archival: a finalized trip's chat can no longer drive a revision (see
 * `trip-review.tsx`'s docstring), so this only ever displays the transcript,
 * never sends. Built on Base UI's `Dialog` (accessible focus trap/ESC-to-close
 * for free) rather than the `Drawer` `ItineraryPanel` uses for the mobile
 * bottom sheet — that one's snap-point/swipe machinery is built specifically
 * for a bottom sheet, and this is a simpler top-to-bottom side panel with no
 * swipe gesture of its own.
 */
import { Dialog } from "@base-ui/react/dialog";
import type { ChatMessage } from "./chat-panel";

export function ChatHistoryPanel({ messages }: { messages: ChatMessage[] }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg border border-teal-600 px-4 py-2.5 text-sm font-medium text-teal-700 transition-colors hover:bg-teal-50">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v7A1.5 1.5 0 0 1 15.5 13H8l-3.5 3.5V13h-1A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3 4.5Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        View chat history
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-navy-900/35 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-0 right-0 bottom-0 z-50 flex w-full max-w-[420px] flex-col border-l border-sand-200 bg-sand-50 shadow-[-12px_0_32px_rgba(22,35,58,0.18)] outline-none transition-transform duration-200 data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full">
          <div className="flex flex-shrink-0 items-center justify-between border-b border-sand-200 px-6 py-5">
            <Dialog.Title className="text-base font-semibold text-navy-900">Chat history</Dialog.Title>
            <Dialog.Close
              aria-label="Close chat history"
              className="flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none text-navy-400 hover:bg-sand-200 hover:text-navy-700"
            >
              ×
            </Dialog.Close>
          </div>

          {/* `min-h-0` on the flex-1 scroll container is what actually makes
              a long transcript scroll instead of overflowing the popup —
              without it, a flex child's default `min-height: auto` lets it
              grow past its parent instead of clipping+scrolling. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {messages.length === 0 ? (
              <p className="text-sm text-navy-400">No messages.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {messages.map((message, i) => (
                  <li key={i} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                        message.role === "user" ? "bg-navy-900 text-sand-50" : "bg-sand-100 text-navy-900"
                      }`}
                    >
                      {message.content}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-center text-xs text-navy-400">This trip is finalized — history is read-only.</p>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
