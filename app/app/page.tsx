/**
 * Chat + live itinerary panel — the core product experience
 * (PROJECT_BRIEF.md §14). Placeholder until Phase 6/7 wire the
 * orchestrator and agents in.
 */
export default function AppHome() {
  return (
    <div className="flex flex-1">
      <section className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Chat interface — coming in Phase 6/7 (PROJECT_BRIEF.md §16).
        </p>
        <p className="text-xs text-zinc-400 dark:text-zinc-600">
          The live itinerary panel will sit alongside this once the
          orchestrator and agents are wired in.
        </p>
      </section>
    </div>
  );
}
