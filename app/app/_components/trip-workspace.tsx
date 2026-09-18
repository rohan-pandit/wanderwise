"use client";

/**
 * Wraps `ChatPanel` + `ItineraryPanel` side by side and owns the one piece
 * of state either can trigger: `pendingCascadeConfirmation` (stepwise chain
 * redesign slice 4's warn-before-cascade UX). A chat-requested revision
 * (`ChatPanel`) and a direct "Change" click on an already-confirmed step
 * (`ItineraryPanel`) both need to be able to show the same warning banner,
 * so the state lives here rather than inside either panel.
 */
import { useState } from "react";
import { ChatPanel, type ChatMessage } from "./chat-panel";
import { ItineraryPanel } from "./itinerary-panel";
import type { PendingCascadeConfirmation } from "../actions";

export function TripWorkspace({
  tripId,
  initialMessages,
  initialTripStatus,
  initialRequirementsReady,
}: {
  tripId: string;
  initialMessages: ChatMessage[];
  initialTripStatus: string;
  initialRequirementsReady: boolean;
}) {
  const [pendingCascade, setPendingCascade] = useState<PendingCascadeConfirmation | null>(null);
  const [requirementsReady, setRequirementsReady] = useState(initialRequirementsReady);

  return (
    <div className="flex min-h-0 flex-1">
      <ChatPanel
        tripId={tripId}
        initialMessages={initialMessages}
        onPendingCascade={setPendingCascade}
        onRequirementsReady={() => setRequirementsReady(true)}
      />
      <ItineraryPanel
        tripId={tripId}
        initialTripStatus={initialTripStatus}
        requirementsReady={requirementsReady}
        pendingCascade={pendingCascade}
        onPendingCascade={setPendingCascade}
      />
    </div>
  );
}
