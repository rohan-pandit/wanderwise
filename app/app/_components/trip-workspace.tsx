"use client";

/**
 * Wraps `ChatPanel` + `ItineraryPanel` side by side and owns the one piece
 * of state either can trigger: `pendingCascadeConfirmation` (stepwise chain
 * redesign slice 4's warn-before-cascade UX). A chat-requested revision
 * (`ChatPanel`) and a direct "Change" click on an already-confirmed step
 * (`ItineraryPanel`) both need to be able to show the same warning banner,
 * so the state lives here rather than inside either panel.
 */
import { useCallback, useState } from "react";
import { ChatPanel, type ChatMessage } from "./chat-panel";
import { FeedbackWidget } from "./feedback-widget";
import { ItineraryPanel, type ActivityPreferenceSubmission } from "./itinerary-panel";
import { useLayoutMode } from "./use-layout-mode";
import type { PendingCascadeConfirmation } from "../actions";

export function TripWorkspace({
  tripId,
  tripName,
  initialMessages,
  initialTripStatus,
  initialRequirementsReady,
}: {
  tripId: string;
  tripName: string | null;
  initialMessages: ChatMessage[];
  initialTripStatus: string;
  initialRequirementsReady: boolean;
}) {
  const [pendingCascade, setPendingCascade] = useState<PendingCascadeConfirmation | null>(null);
  const [requirementsReady, setRequirementsReady] = useState(initialRequirementsReady);
  const layoutMode = useLayoutMode();

  // Bridges the activities preference prompt across panels — `ItineraryPanel`
  // detects when it's needed (from its own Realtime-derived `decisions`
  // state) but the prompt itself renders inside `ChatPanel` (see both
  // components' own docstrings for why). `showActivitiesPrompt` flows one
  // way (ItineraryPanel -> ChatPanel); a submission flows back the other way
  // (ChatPanel -> ItineraryPanel) tagged with a fresh `requestId` each time
  // so a repeat "Change preferences" round trip is never mistaken for the
  // same answer twice.
  const [showActivitiesPrompt, setShowActivitiesPrompt] = useState(false);
  const [activityPreferenceSubmission, setActivityPreferenceSubmission] = useState<ActivityPreferenceSubmission | null>(null);

  // Stable identity: passed into `ItineraryPanel`'s own effect dependency
  // array, so a fresh function reference on every `TripWorkspace` render
  // (e.g. `pendingCascade` changing) doesn't needlessly re-run it.
  const handleActivitiesPreferenceNeeded = useCallback(() => setShowActivitiesPrompt(true), []);

  function handleSubmitActivityPreferences(categories: string[], criteria: string | undefined) {
    setShowActivitiesPrompt(false);
    setActivityPreferenceSubmission({ requestId: crypto.randomUUID(), categories, criteria });
  }

  return (
    <div className="flex min-h-0 flex-1">
      <ChatPanel
        tripId={tripId}
        initialMessages={initialMessages}
        onPendingCascade={setPendingCascade}
        onRequirementsReady={() => setRequirementsReady(true)}
        activitiesPreferencePrompt={showActivitiesPrompt}
        onSubmitActivityPreferences={handleSubmitActivityPreferences}
        layoutMode={layoutMode}
      />
      <ItineraryPanel
        tripId={tripId}
        tripName={tripName}
        initialTripStatus={initialTripStatus}
        requirementsReady={requirementsReady}
        pendingCascade={pendingCascade}
        onPendingCascade={setPendingCascade}
        onActivitiesPreferenceNeeded={handleActivitiesPreferenceNeeded}
        activityPreferenceSubmission={activityPreferenceSubmission}
        layoutMode={layoutMode}
      />
      <FeedbackWidget tripId={tripId} layoutMode={layoutMode} />
    </div>
  );
}
