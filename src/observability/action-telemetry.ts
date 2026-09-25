/**
 * Records server-action failures to `app_events` (Phase B of per-user
 * observability, ADR-007). The actions in `app/app/actions.ts` fail in two
 * ways, and until now neither was stored:
 * - they **throw** (auth, ownership, unexpected bugs), which the user sees
 *   as a generic error;
 * - they **return `{ error }`**, a friendly message the UI shows inline.
 *
 * `trackAction` records both and changes nothing about what the caller
 * gets back. Dependencies are injected so this is testable without
 * Supabase or Next.
 */
import type { NewAppEvent } from "@/src/repositories/app-events";
import { truncateMessage } from "@/src/repositories/app-events";

export interface ActionTelemetryDeps {
  record: (event: NewAppEvent) => Promise<void>;
  /** Only called when something failed, so successful actions pay nothing extra. */
  currentUser: () => Promise<{ id: string; email: string | null } | null>;
}

function returnedError(result: unknown): string | null {
  if (result !== null && typeof result === "object" && "error" in result) {
    const error = (result as { error: unknown }).error;
    if (typeof error === "string") return error;
  }
  return null;
}

/**
 * Next implements redirect()/notFound() as thrown errors with a `NEXT_`
 * digest. Those are control flow, not failures.
 */
function isNextControlFlow(err: unknown): boolean {
  const digest = err !== null && typeof err === "object" && "digest" in err ? (err as { digest: unknown }).digest : null;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

export async function trackAction<T>(
  action: string,
  tripId: string | null,
  run: () => Promise<T>,
  deps: ActionTelemetryDeps,
): Promise<T> {
  const recordFailure = async (kind: "thrown" | "returned", message: string) => {
    // Telemetry must never replace the action's own outcome, so a failure
    // to identify the user or write the row is swallowed here.
    try {
      const user = await deps.currentUser().catch(() => null);
      await deps.record({
        eventType: "action_failed",
        userId: user?.id ?? null,
        email: user?.email ?? null,
        tripId,
        payload: { action, kind, message: truncateMessage(message) },
      });
    } catch {
      /* best-effort */
    }
  };

  let result: T;
  try {
    result = await run();
  } catch (err) {
    if (!isNextControlFlow(err)) {
      await recordFailure("thrown", err instanceof Error ? err.message : String(err));
    }
    throw err;
  }

  const error = returnedError(result);
  if (error !== null) await recordFailure("returned", error);
  return result;
}
