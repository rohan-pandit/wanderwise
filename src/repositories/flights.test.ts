import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { routeSchedule } from "@/src/domain/flight-generator";
import { weekdayOf } from "@/src/domain/dates";
import { findFlights, type Flight } from "./flights";
import { flight } from "./fixtures";

/**
 * No repository in this codebase has a dedicated unit test yet (`findFlights`
 * and friends are normally exercised via `vi.mock`'d workflow-level tests or
 * live spot-checks) — but the generate-on-miss fallback added here is real
 * logic worth testing directly, not just a passthrough query. This fakes the
 * minimal slice of the Supabase query-builder chain `findFlights` actually
 * calls: every chain method returns the same thenable builder, and each
 * *awaited* chain (one real query, optionally one insert) consumes the next
 * queued `{data, error}` response.
 */
function fakeSupabase(responses: { data: unknown; error: unknown }[]): {
  client: SupabaseClient<Database>;
  insertedRows: () => unknown[] | undefined;
} {
  let call = 0;
  let inserted: unknown[] | undefined;
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  Object.assign(builder, {
    select: chain,
    eq: chain,
    gte: chain,
    lt: chain,
    lte: chain,
    order: chain,
    insert: (rows: unknown[]) => {
      inserted = rows;
      return builder;
    },
    then: (resolve: (value: { data: unknown; error: unknown }) => void) => resolve(responses[call++]),
  });
  const client = { from: () => builder } as unknown as SupabaseClient<Database>;
  return { client, insertedRows: () => inserted };
}

const DATE_WINDOW = Array.from({ length: 14 }, (_, i) =>
  new Date(Date.UTC(2027, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
);

/** Finds a route (from a small pool) and a date whose weekday matches `wantsOperating` — some routes fly every day, so no single route is guaranteed to have a non-operating date. */
function routeAndDateWithWeekday(wantsOperating: boolean): { origin: string; destination: string; date: string } {
  const pairs = [
    ["Chicago", "Lisbon"],
    ["Miami", "Tokyo"],
    ["Boston", "Cairo"],
    ["Denver", "Bangkok"],
    ["Seattle", "Nairobi"],
  ];
  for (const [origin, destination] of pairs) {
    const schedule = routeSchedule(origin, destination);
    const date = DATE_WINDOW.find((d) => schedule.has(weekdayOf(d)) === wantsOperating);
    if (date) return { origin, destination, date };
  }
  throw new Error("no route/date combination found — widen the pair pool or date window");
}

describe("findFlights generate-on-miss fallback", () => {
  it("returns real rows without attempting to generate/insert", async () => {
    const real = flight({ id: "real-1" });
    const { client, insertedRows } = fakeSupabase([{ data: [real], error: null }]);

    const result = await findFlights(client, { destination: "Lisbon" });

    expect(result).toEqual([real]);
    expect(insertedRows()).toBeUndefined();
  });

  it("does nothing on a miss if departureDate/origin/destination aren't all present", async () => {
    const { client, insertedRows } = fakeSupabase([{ data: [], error: null }]);

    const result = await findFlights(client, { destinationId: "some-id" });

    expect(result).toEqual([]);
    expect(insertedRows()).toBeUndefined();
  });

  it("generates and persists flights on a miss when the route operates that weekday", async () => {
    const { origin, destination, date } = routeAndDateWithWeekday(true);
    const { client, insertedRows } = fakeSupabase([
      { data: [], error: null }, // real query: nothing found
      { data: [flight({ id: "generated-1", source: "generated" })], error: null }, // insert().select()
    ]);

    const result = await findFlights(client, {
      origin,
      destination,
      destinationId: "known-destination-id",
      departureDate: date,
    });

    expect(result).toHaveLength(1);
    const rows = insertedRows() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.origin).toBe(origin);
      expect(row.destination).toBe(destination);
      expect(row.destination_id).toBe("known-destination-id");
      expect(row.source).toBe("generated");
    }
  });

  it("returns an empty array (no insert) when the route doesn't operate on the requested weekday", async () => {
    const { origin, destination, date } = routeAndDateWithWeekday(false);
    const { client, insertedRows } = fakeSupabase([{ data: [], error: null }]);

    const result = await findFlights(client, { origin, destination, departureDate: date });

    expect(result).toEqual([]);
    expect(insertedRows()).toBeUndefined();
  });

  it("filters generated flights by the requested maxPriceUsd/excludeRedEye before returning", async () => {
    const { origin, destination, date } = routeAndDateWithWeekday(true);
    const cheap = flight({ id: "cheap", price_usd: 50, is_red_eye: false });
    const expensive = flight({ id: "pricey", price_usd: 900, is_red_eye: true });
    const { client } = fakeSupabase([
      { data: [], error: null },
      { data: [cheap, expensive] as Flight[], error: null },
    ]);

    const result = await findFlights(client, {
      origin,
      destination,
      departureDate: date,
      maxPriceUsd: 200,
      excludeRedEye: true,
    });

    expect(result).toEqual([cheap]);
  });
});
