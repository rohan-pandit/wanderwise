/**
 * Chat entry point — the core product experience (PROJECT_BRIEF.md §14).
 * No trip exists yet, so this renders just the chat half; once the first
 * message creates a trip, `ChatPanel` redirects to `/app/trips/[tripId]`,
 * which renders the chat alongside the live itinerary panel.
 */
import { ChatPanel } from "./_components/chat-panel";

export default function AppHome() {
  return (
    <div className="flex flex-1">
      <ChatPanel initialMessages={[]} />
    </div>
  );
}
