"use client";

/**
 * "Report an issue" — a quiet floating entry point mounted once per trip
 * workspace (`trip-workspace.tsx`), not tucked into either panel's own
 * header, so it stays reachable regardless of layout mode (sidebar / split
 * / drawer) or how the itinerary drawer happens to be positioned. Submits
 * via `submitFeedback` (`app/app/actions.ts`), which attaches the trip and
 * a server-computed "where the user was" itself — this component only ever
 * sends the category/message the user actually typed.
 */
import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { submitFeedback } from "../actions";
import type { LayoutMode } from "./use-layout-mode";
import { FEEDBACK_CATEGORY_OPTIONS } from "@/src/domain/feedback-categories";

export function FeedbackWidget({ tripId, layoutMode }: { tripId: string; layoutMode: LayoutMode }) {
  const [open, setOpen] = useState(false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleCategory(value: string) {
    setSelectedCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // The panel unmounts its content on close either way — resetting here
      // just means a later re-open starts fresh instead of showing the
      // previous report's already-submitted confirmation.
      setSelectedCategories([]);
      setMessage("");
      setSent(false);
      setError(null);
    }
  }

  async function handleSubmit() {
    setPending(true);
    setError(null);
    try {
      await submitFeedback({ tripId, categories: selectedCategories, message: message.trim() || undefined });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger
        className="fixed right-4 z-20 inline-flex items-center gap-2 rounded-full border border-sand-300 bg-sand-100 px-4 py-2.5 text-sm font-semibold text-navy-700 shadow-[0_6px_16px_rgba(22,35,58,0.14)] transition-colors hover:border-teal-600 hover:text-teal-800 sm:right-6"
        style={
          layoutMode === "drawer"
            ? // Bottom-right collides with the chat's Send button and the
              // itinerary drawer's always-mounted peek bar on mobile (also
              // dragged around unpredictably by the on-screen keyboard
              // resizing the viewport from the bottom) — top-right instead,
              // clear of the global header (app/app/layout.tsx) at every
              // width "drawer" mode covers, including its own sm: breakpoint
              // size step.
              { top: "88px" }
            : { bottom: "24px" }
        }
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="4" />
        </svg>
        Report an issue
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-navy-900/35 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-sand-200 bg-sand-50 p-7 shadow-[0_20px_40px_rgba(22,35,58,0.2)] outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
          {sent ? (
            <div className="flex flex-col items-start gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-lg text-teal-700">✓</div>
              <Dialog.Title className="font-serif text-lg font-semibold text-navy-900">Thanks — we&apos;ve got it.</Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-navy-400">
                We&apos;ll take a look. Feel free to send another report if something else comes up.
              </Dialog.Description>
              <Dialog.Close className="mt-1 text-sm font-medium text-teal-700 underline hover:text-teal-800">Close</Dialog.Close>
            </div>
          ) : (
            <div>
              <Dialog.Title className="font-serif text-xl font-semibold text-navy-900">Report an issue</Dialog.Title>
              <Dialog.Description className="mt-1.5 text-sm leading-relaxed text-navy-400">
                Something feel broken or off? This goes straight to our internal review queue, not a live support agent.
              </Dialog.Description>

              <div className="mt-5 text-xs font-semibold tracking-wide text-navy-400 uppercase">
                What&apos;s going on? <span className="font-normal normal-case tracking-normal">(optional, pick any that fit)</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {FEEDBACK_CATEGORY_OPTIONS.map((opt) => {
                  const selected = selectedCategories.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleCategory(opt.value)}
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        selected ? "border-teal-600 bg-teal-50 text-teal-800" : "border-sand-300 text-navy-700 hover:border-teal-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              <label htmlFor="feedback-message" className="mt-5 block text-xs font-semibold tracking-wide text-navy-400 uppercase">
                Tell us more
              </label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What happened? The more detail, the better."
                rows={4}
                className="mt-2 w-full resize-y rounded-lg border border-sand-300 bg-transparent px-3 py-2 text-base text-navy-900 outline-none placeholder:text-navy-400 focus:border-navy-400"
              />
              <p className="mt-2 text-xs text-navy-400 italic">
                We&apos;ll automatically attach this trip and where you are in it — no need to explain that part.
              </p>

              {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

              <div className="mt-6 flex items-center justify-end gap-5">
                <Dialog.Close className="text-sm text-navy-400 hover:text-terracotta-600">Cancel</Dialog.Close>
                <button
                  type="button"
                  disabled={pending}
                  onClick={handleSubmit}
                  className="rounded-lg bg-terracotta-600 px-5 py-2.5 text-sm font-semibold text-sand-50 transition-colors hover:bg-terracotta-700 disabled:opacity-50"
                >
                  {pending ? "Sending…" : "Send feedback"}
                </button>
              </div>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
