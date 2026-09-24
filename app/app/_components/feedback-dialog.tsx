"use client";

/**
 * Beta feedback form — one instance, owned by `BetaProvider`
 * (`beta-context.tsx`) and opened from any of the header's beta callouts
 * (`beta-callouts.tsx`), so it's reachable from every `/app` page rather
 * than only from inside a trip (the old floating "Report an issue" button
 * this replaces lived in `TripWorkspace` alone, and its fixed positioning
 * kept colliding with chat/drawer controls on mobile). Submits via
 * `submitFeedback` (`app/app/actions.ts`), which attaches the trip (when
 * `tripId` is set) and a server-computed "where the user was" itself — this
 * component only sends what the user actually chose/typed, plus the current
 * path as untrusted triage context.
 */
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { submitFeedback } from "../actions";
import {
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_KIND_OPTIONS,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  type FeedbackKind,
} from "@/src/domain/feedback-categories";

const MESSAGE_PLACEHOLDER: Record<FeedbackKind, string> = {
  bug: "What happened? The more detail, the better.",
  idea: "What would make Wanderwise better for you?",
  other: "What's on your mind?",
};

export function FeedbackDialog({
  open,
  onOpenChange,
  tripId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tripId: string | null;
}) {
  const pathname = usePathname();
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The trip-specific breakdown only describes a bug hit while planning a
  // trip — meaningless for an idea, or from a page with no trip at all.
  const showCategories = kind === "bug" && tripId !== null;

  function toggleCategory(value: string) {
    setError(null);
    setSelectedCategories((prev) => (prev.includes(value) ? prev.filter((c) => c !== value) : [...prev, value]));
  }

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Resetting here means a later re-open starts fresh instead of showing
      // the previous report's already-submitted confirmation.
      setKind("bug");
      setSelectedCategories([]);
      setMessage("");
      setSent(false);
      setError(null);
    }
  }

  async function handleSubmit() {
    const categories = showCategories ? selectedCategories : [];
    const trimmed = message.trim();
    // Mirrors `submitFeedback`'s own checks, so the common case gets a
    // friendly inline message instead of a round trip.
    if (!trimmed && categories.length === 0) {
      setError("Add a few words so we know what to look at.");
      return;
    }
    if (trimmed.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
      setError(`Keep it under ${FEEDBACK_MESSAGE_MAX_LENGTH} characters.`);
      return;
    }

    setPending(true);
    setError(null);
    try {
      await submitFeedback({
        tripId: tripId ?? undefined,
        kind,
        categories,
        message: trimmed || undefined,
        route: pathname,
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-navy-900/35 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        {/* A bottom sheet below `sm:` (thumb-reachable, and clear of the
            on-screen keyboard pushing a centered dialog around), a centered
            dialog from `sm:` up — as reviewed in the beta mockups. */}
        <Dialog.Popup className="fixed inset-x-0 bottom-0 z-50 max-h-[90dvh] overflow-y-auto rounded-t-2xl border border-sand-200 bg-sand-50 p-6 shadow-[0_20px_40px_rgba(22,35,58,0.2)] outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[min(440px,calc(100vw-32px))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-7">
          {sent ? (
            <div className="flex flex-col items-start gap-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-lg text-teal-700">✓</div>
              <Dialog.Title className="font-serif text-lg font-semibold text-navy-900">Thanks — we&apos;ve got it.</Dialog.Title>
              <Dialog.Description className="text-sm leading-relaxed text-navy-400">
                We&apos;ll take a look. You can send more anytime from the Beta badge in the header.
              </Dialog.Description>
              <Dialog.Close className="mt-1 text-sm font-medium text-teal-700 underline hover:text-teal-800">Close</Dialog.Close>
            </div>
          ) : (
            <div>
              <Dialog.Title className="font-serif text-xl font-semibold text-navy-900">Send feedback</Dialog.Title>
              <Dialog.Description className="mt-1.5 text-sm leading-relaxed text-navy-400">
                Wanderwise is in beta. This goes straight to our review queue, not a live support agent.
              </Dialog.Description>

              <div className="mt-5 text-xs font-semibold tracking-wide text-navy-400 uppercase">What kind?</div>
              <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Feedback kind">
                {FEEDBACK_KIND_OPTIONS.map((opt) => {
                  const selected = kind === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => {
                        setKind(opt.value);
                        setError(null);
                      }}
                      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                        selected ? "border-teal-600 bg-teal-50 text-teal-800" : "border-sand-300 text-navy-700 hover:border-teal-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>

              {showCategories ? (
                <>
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
                          aria-pressed={selected}
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
                </>
              ) : null}

              <label htmlFor="feedback-message" className="mt-5 block text-xs font-semibold tracking-wide text-navy-400 uppercase">
                Tell us more
              </label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setError(null);
                }}
                placeholder={MESSAGE_PLACEHOLDER[kind]}
                rows={4}
                maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
                className="mt-2 w-full resize-y rounded-lg border border-sand-300 bg-transparent px-3 py-2 text-base text-navy-900 outline-none placeholder:text-navy-400 focus:border-navy-400"
              />
              <p className="mt-2 text-xs text-navy-400 italic">
                {tripId
                  ? "We'll automatically attach this trip and where you are in it — no need to explain that part."
                  : "We'll automatically attach which page you're on."}
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
