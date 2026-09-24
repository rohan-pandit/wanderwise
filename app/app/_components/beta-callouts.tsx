"use client";

/**
 * The beta-testing callouts in `/app`'s header (`app/app/layout.tsx`),
 * reviewed as mockups before building:
 *
 * - `BetaBanner` — the loud announcement above the header, until dismissed
 *   (remembered per `BETA_BANNER_VERSION`). Never shown inside a trip at
 *   `"drawer"` layout-mode widths (`use-layout-mode.ts`): chat there is
 *   already tight, so the chip is the only entry point on a phone mid-trip.
 * - `BetaChip` — the permanent, quiet entry point next to the wordmark: a
 *   popover explaining the beta, with "Send feedback".
 * - `HeaderFeedbackLink` — a plain "Feedback" link, shown only once the
 *   banner is gone (so there are never two feedback links in the same
 *   strip) and only from `sm:` up (no room at phone width, where the chip
 *   carries an icon instead so it reads as tappable).
 *
 * All of them open the one `FeedbackDialog` owned by `BetaProvider`, and
 * all render nothing once `BETA_ENABLED` is switched off.
 */
import { useState } from "react";
import { usePathname } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import { BETA_ENABLED } from "@/src/config/beta";
import { useBeta } from "./beta-context";

/** Matches `/app/trips/<identifier>` — the trip workspace — but not the `/app/trips` list itself. */
const TRIP_WORKSPACE_PATH = /^\/app\/trips\/[^/]+/;

function MessageIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.9-.9L3 20.5l1.5-4.5A8.1 8.1 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
    </svg>
  );
}

export function BetaBanner() {
  const { bannerDismissed, dismissBanner, openFeedback } = useBeta();
  const pathname = usePathname();
  if (!BETA_ENABLED || bannerDismissed) return null;

  // CSS rather than `useLayoutMode()`: that hook only learns the real width
  // after mount, so the banner would flash in first on every phone-width
  // trip page load. `max-[839px]` is `DRAWER_MAX_WIDTH` (`use-layout-mode.ts`).
  const inTrip = TRIP_WORKSPACE_PATH.test(pathname);

  return (
    <div
      role="region"
      aria-label="Beta notice"
      className={`flex items-center gap-3 border-b border-terracotta-200 bg-terracotta-50 px-4 py-2 text-sm text-navy-700 sm:px-6 ${inTrip ? "max-[839px]:hidden" : ""}`}
    >
      <p className="min-w-0">
        <span className="sm:hidden">In beta ·</span>
        <span className="hidden sm:inline">
          <span className="font-semibold text-navy-900">Wanderwise is in beta.</span> Things may break, and nothing is actually booked.
        </span>{" "}
        <button type="button" onClick={openFeedback} className="font-semibold text-terracotta-600 underline hover:text-terracotta-700">
          Share feedback
        </button>
      </p>
      <button
        type="button"
        onClick={dismissBanner}
        aria-label="Dismiss beta notice"
        className="ml-auto flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-lg leading-none text-navy-400 hover:bg-terracotta-100 hover:text-navy-900"
      >
        &times;
      </button>
    </div>
  );
}

export function BetaChip() {
  const { chipHintVisible, openFeedback } = useBeta();
  const [open, setOpen] = useState(false);
  if (!BETA_ENABLED) return null;

  return (
    <div className="relative flex items-center">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          aria-label="Beta — about this beta and sending feedback"
          className={`inline-flex items-center gap-1 rounded-full border border-terracotta-200 bg-terracotta-50 px-2 py-0.5 font-sans text-[11px] font-semibold tracking-[0.12em] text-terracotta-600 uppercase transition-shadow hover:border-terracotta-500 ${
            chipHintVisible ? "ring-4 ring-terracotta-200" : ""
          }`}
        >
          <span className="sm:hidden">
            <MessageIcon size={12} />
          </span>
          Beta
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={10} align="start" collisionPadding={16} className="z-30">
            <Popover.Popup className="w-[min(260px,calc(100vw-32px))] rounded-xl border border-sand-300 bg-sand-50 p-4 shadow-[0_12px_28px_rgba(22,35,58,0.16)] outline-none transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0">
              <Popover.Title className="font-serif text-base font-semibold text-navy-900">You&apos;re trying an early version</Popover.Title>
              <Popover.Description className="mt-1 text-sm leading-relaxed text-navy-700">
                Things may break while we test. Plan freely, since nothing is actually booked.
              </Popover.Description>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  openFeedback();
                }}
                className="mt-3 rounded-lg bg-terracotta-600 px-4 py-2 text-sm font-semibold text-sand-50 transition-colors hover:bg-terracotta-700"
              >
                Send feedback
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {chipHintVisible ? (
        <div
          role="status"
          className="absolute top-[calc(100%+10px)] left-1/2 z-30 w-max max-w-[220px] -translate-x-1/2 rounded-lg bg-navy-900 px-3 py-2 font-sans text-xs font-normal text-sand-50 shadow-[0_8px_20px_rgba(22,35,58,0.2)] sm:left-0 sm:translate-x-0"
        >
          You can always send feedback from here.
        </div>
      ) : null}
    </div>
  );
}

export function HeaderFeedbackLink() {
  const { bannerDismissed, openFeedback } = useBeta();
  if (!BETA_ENABLED || !bannerDismissed) return null;

  return (
    <button
      type="button"
      onClick={openFeedback}
      className="hidden items-center gap-1.5 text-sm font-medium text-teal-700 hover:text-teal-800 sm:inline-flex sm:text-base"
    >
      <MessageIcon size={16} />
      Feedback
    </button>
  );
}
