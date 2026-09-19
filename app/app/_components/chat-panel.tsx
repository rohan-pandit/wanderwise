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
import { useEffect, useRef, useState } from "react";
import { sendMessage, type PendingCascadeConfirmation } from "../actions";
import type { LayoutMode } from "./use-layout-mode";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Real `activities.category` values (`scripts/data/inventory-templates.ts`'s `ActivityCategory`) as user-facing chip labels for the inline activities-preference prompt below. Free text covers anything a chip doesn't (a pure vibe word like "relaxing", "nothing too touristy"). */
const ACTIVITY_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "food", label: "Food & Dining" },
  { value: "cultural", label: "Museums & Culture" },
  { value: "tour", label: "Guided Tours" },
  { value: "spa", label: "Spa & Relaxation" },
  { value: "concert", label: "Concerts" },
  { value: "show", label: "Shows & Theater" },
  { value: "movie", label: "Movies" },
  { value: "sporting_event", label: "Sporting Events" },
  { value: "outdoor", label: "Outdoors & Nature" },
  { value: "nightlife", label: "Nightlife" },
];

export function ChatPanel({
  tripId: initialTripId,
  initialMessages,
  onPendingCascade,
  onRequirementsReady,
  activitiesPreferencePrompt,
  onSubmitActivityPreferences,
  layoutMode,
}: {
  tripId?: string;
  initialMessages: ChatMessage[];
  onPendingCascade?: (pending: PendingCascadeConfirmation) => void;
  /** Fired once a turn's completeness check (`result.ready`) first reports the trip's requirements are complete — `ItineraryPanel` uses this to know it's safe to search, rather than guessing from an empty decisions list (see its own docstring). Never fired with `false`: going from ready back to not-ready isn't a real transition once `requirements_ready` is reached (`checkRequirementsComplete` only ever gates the one-way `collecting_requirements`/`awaiting_clarification` -> `requirements_ready` hop). */
  onRequirementsReady?: () => void;
  /** Set by `TripWorkspace` (via `ItineraryPanel`'s `onActivitiesPreferenceNeeded`) once the activities step needs a preference — renders the pill+free-text prompt inline in the transcript instead of in the itinerary panel, per the activities redesign's UI having moved into chat. `ItineraryPanel` still owns the actual `proposeActivityCandidates` call and the resulting suggestions/add/remove/finalize UI, unchanged. */
  activitiesPreferencePrompt?: boolean;
  /** Fired once the inline prompt is submitted (pills and/or free text). */
  onSubmitActivityPreferences?: (categories: string[], criteria: string | undefined) => void;
  /** In `"drawer"` mode (`use-layout-mode.ts`), `ItineraryPanel` renders as a `position: fixed` bottom sheet that's always at least a 64px peek bar — without this, that bar sits on top of the message input whenever the sheet is collapsed. Unused in `"split"`/`"sidebar"` mode, where the itinerary is a normal flex sibling instead. */
  layoutMode?: LayoutMode;
}) {
  const router = useRouter();
  const [tripId, setTripId] = useState(initialTripId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activitySelectedCategories, setActivitySelectedCategories] = useState<string[]>([]);
  const [activityNotesInput, setActivityNotesInput] = useState("");

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

  // Announces the inline activities prompt once per activation (a rising
  // edge of `activitiesPreferencePrompt`) as a normal assistant message, so
  // it reads as part of the conversation rather than a UI element that
  // appeared unexplained — then resets on the falling edge (submitted, or
  // not yet needed) so a later "Change preferences" re-activation announces
  // again instead of staying silent.
  const activitiesPromptAnnouncedRef = useRef(false);
  useEffect(() => {
    if (activitiesPreferencePrompt) {
      if (!activitiesPromptAnnouncedRef.current) {
        activitiesPromptAnnouncedRef.current = true;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "What would you like to do during your trip? Pick anything that fits below, or just tell me in your own words." },
        ]);
      }
    } else {
      activitiesPromptAnnouncedRef.current = false;
    }
  }, [activitiesPreferencePrompt]);

  function handleSubmitActivityPreferences() {
    const categories = activitySelectedCategories;
    const criteria = activityNotesInput.trim() || undefined;
    const labels = categories.map((c) => ACTIVITY_CATEGORY_OPTIONS.find((opt) => opt.value === c)?.label ?? c);
    const summary = [labels.join(", "), criteria].filter(Boolean).join(labels.length && criteria ? " — " : "") || "Surprise me — no particular preferences.";
    setMessages((prev) => [...prev, { role: "user", content: summary }]);
    setActivitySelectedCategories([]);
    setActivityNotesInput("");
    onSubmitActivityPreferences?.(categories, criteria);
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
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", content: result.assistantMessage }]);
      if (!tripId) {
        setTripId(result.tripId);
        router.push(`/app/trips/${result.tripId}`);
      }
      if (result.pendingCascadeConfirmation) {
        onPendingCascade?.(result.pendingCascadeConfirmation);
      }
      if (result.ready) {
        onRequirementsReady?.();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* `mx-auto max-w-2xl` on the content, not the scroll container itself
          — without a width cap here, message bubbles and the input row
          stretched edge-to-edge on a wide desktop screen (measured at
          1440px: the section/form were literally `width: 1440` with
          `max-width: none`), reading as very sparse rather than like a chat
          interface. Capping just the inner content keeps the outer
          scroll/border bar full-width (so the border-top still spans the
          whole panel) while the actual conversation stays a readable
          column, the same split every mainstream chat UI uses. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto w-full max-w-2xl">
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
          {activitiesPreferencePrompt ? (
            <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-sand-200 bg-sand-50 px-4 py-3 text-sm">
              <div className="flex flex-wrap gap-1">
                {ACTIVITY_CATEGORY_OPTIONS.map((opt) => {
                  const selected = activitySelectedCategories.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() =>
                        setActivitySelectedCategories((prev) =>
                          selected ? prev.filter((c) => c !== opt.value) : [...prev, opt.value],
                        )
                      }
                      className={`rounded-full border px-2 py-1 text-xs transition-colors ${
                        selected ? "border-teal-600 bg-teal-50 text-teal-800" : "border-sand-300 text-navy-700 hover:border-teal-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <textarea
                value={activityNotesInput}
                onChange={(e) => setActivityNotesInput(e.target.value)}
                placeholder="e.g. “I want a relaxing trip” or “nothing too touristy” (optional)"
                rows={2}
                // `text-base`, not `text-xs` — see the message input below for why.
                className="rounded-md border border-sand-300 bg-transparent px-2 py-1 text-base text-navy-900 placeholder:text-navy-400"
              />
              <button
                type="button"
                onClick={handleSubmitActivityPreferences}
                className="self-start rounded-md bg-terracotta-600 px-3 py-1 text-xs font-medium text-sand-50 transition-colors hover:bg-terracotta-700"
              >
                Show me activities
              </button>
            </div>
          ) : null}
          {pending ? (
            <p className="mt-3 text-xs text-navy-400" aria-live="polite">
              Thinking…
            </p>
          ) : null}
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className={`border-t border-sand-200 px-6 py-4 ${layoutMode === "drawer" ? "pb-[calc(1rem+4rem)]" : ""}`}
      >
        <div className="mx-auto flex w-full max-w-2xl gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={pending}
            placeholder="Message Wanderwise…"
            // Not an address/name/contact field, so no autofill suggestions
            // apply — `autoComplete="off"` keeps iOS from showing one anyway.
            // `enterKeyHint="send"` labels the keyboard's return key correctly
            // for a chat input instead of the generic default.
            autoComplete="off"
            enterKeyHint="send"
            // `text-base` (16px), not `text-sm` — iOS Safari auto-zooms the
            // whole page on focus for any input under 16px. Found live on a
            // phone: with the keyboard open, the zoomed page was clipping the
            // header nav and the initial chat bubble's right edge — neither
            // is actually broken, the whole page was just zoomed in.
            className="flex-1 rounded-lg border border-sand-300 bg-transparent px-3 py-2 text-base text-navy-900 outline-none focus:border-navy-400 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={pending || !input.trim()}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-medium text-sand-50 transition-colors hover:bg-teal-800 disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
