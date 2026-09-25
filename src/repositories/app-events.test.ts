import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { recordAppEvent } from "./app-events";

/** A fake client whose `insert` answers with the given errors, one per call. */
function fakeClient(errors: ({ code: string } | null)[]) {
  const insert = vi.fn<(row: unknown) => Promise<{ error: { code: string } | null }>>(async () => ({ error: errors.shift() ?? null }));
  const client = { from: () => ({ insert }) } as unknown as SupabaseClient<Database>;
  return { client, insert };
}

const event = { eventType: "action_failed" as const, userId: "user-1", tripId: "missing-trip", payload: { action: "x" } };

describe("recordAppEvent", () => {
  it("writes the row once when it's accepted", async () => {
    const { client, insert } = fakeClient([null]);
    await recordAppEvent(client, event);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({ user_id: "user-1", trip_id: "missing-trip" });
  });

  it("keeps the user but moves an unknown trip id into the payload on a foreign-key violation", async () => {
    const { client, insert } = fakeClient([{ code: "23503" }, null]);
    await recordAppEvent(client, event);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert.mock.calls[1][0]).toMatchObject({ user_id: "user-1", trip_id: null, payload: { action: "x", unknownTripId: "missing-trip" } });
  });

  it("drops the user too if that's still rejected, and never throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeClient([{ code: "23503" }, { code: "23503" }, { code: "23503" }]);
    await expect(recordAppEvent(client, event)).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls[2][0]).toMatchObject({ user_id: null, trip_id: null, payload: { unknownUserId: "user-1" } });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("doesn't retry other errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, insert } = fakeClient([{ code: "42P01" }]);
    await recordAppEvent(client, event);
    expect(insert).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
