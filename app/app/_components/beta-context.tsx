"use client";

/**
 * Shared state behind every beta callout under `/app` (`beta-callouts.tsx`):
 * whether the banner has been dismissed, the brief "you can always send
 * feedback from here" hint on the Beta chip right after that, and the one
 * `FeedbackDialog` instance all three entry points (chip, banner, header
 * link) open. Mounted once in `app/app/layout.tsx`, so the dialog also
 * works on pages with no trip — `TripWorkspace` registers its own `tripId`
 * via `useRegisterFeedbackTrip` while it's mounted, which is how a report
 * from inside a trip still gets that trip attached.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BETA_BANNER_COOKIE, BETA_BANNER_VERSION } from "@/src/config/beta";
import { FeedbackDialog } from "./feedback-dialog";

const CHIP_HINT_MS = 3500;
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface BetaContextValue {
  bannerDismissed: boolean;
  dismissBanner: () => void;
  chipHintVisible: boolean;
  openFeedback: () => void;
  setFeedbackTripId: (tripId: string | null) => void;
}

const BetaContext = createContext<BetaContextValue | null>(null);

export function BetaProvider({ initialBannerDismissed, children }: { initialBannerDismissed: boolean; children: ReactNode }) {
  const [bannerDismissed, setBannerDismissed] = useState(initialBannerDismissed);
  const [chipHintVisible, setChipHintVisible] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackTripId, setFeedbackTripId] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  const dismissBanner = useCallback(() => {
    // A versioned value, not a plain flag — see `BETA_BANNER_VERSION`.
    document.cookie = `${BETA_BANNER_COOKIE}=${BETA_BANNER_VERSION}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    setBannerDismissed(true);
    // Points at where feedback lives now that the banner's own link is gone.
    setChipHintVisible(true);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setChipHintVisible(false), CHIP_HINT_MS);
  }, []);

  const openFeedback = useCallback(() => {
    setChipHintVisible(false);
    setFeedbackOpen(true);
  }, []);

  const value = useMemo(
    () => ({ bannerDismissed, dismissBanner, chipHintVisible, openFeedback, setFeedbackTripId }),
    [bannerDismissed, dismissBanner, chipHintVisible, openFeedback],
  );

  return (
    <BetaContext.Provider value={value}>
      {children}
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} tripId={feedbackTripId} />
    </BetaContext.Provider>
  );
}

export function useBeta(): BetaContextValue {
  const ctx = useContext(BetaContext);
  if (!ctx) throw new Error("useBeta must be used inside <BetaProvider> (app/app/layout.tsx).");
  return ctx;
}

/** Attaches `tripId` to any feedback sent while the calling component (`TripWorkspace`) is mounted. */
export function useRegisterFeedbackTrip(tripId: string) {
  const { setFeedbackTripId } = useBeta();
  useEffect(() => {
    setFeedbackTripId(tripId);
    return () => setFeedbackTripId(null);
  }, [tripId, setFeedbackTripId]);
}
