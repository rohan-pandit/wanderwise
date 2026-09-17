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
}: {
  tripId: string;
  initialMessages: ChatMessage[];
  initialTripStatus: string;
}) {
  const [pendingCascade, setPendingCascade] = useState<PendingCascadeConfirmation | null>(null);

  return (
    <div className="flex min-h-0 flex-1">
      <ChatPanel tripId={tripId} initialMessages={initialMessages} onPendingCascade={setPendingCascade} />
      <ItineraryPanel
        tripId={tripId}
        initialTripStatus={initialTripStatus}
        pendingCascade={pendingCascade}
        onPendingCascade={setPendingCascade}
      />
    </div>
  );
}
