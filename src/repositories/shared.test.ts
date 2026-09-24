import { describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { selectAllRows } from "./shared";

/** Mimics PostgREST's `.range(from, to)` over an in-memory table, recording every range requested. */
function fakeTable(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: [number, number][] = [];
  const buildPage = async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };
  return { rows, calls, buildPage };
}

describe("selectAllRows", () => {
  it("reads past the page size instead of stopping at the first page", async () => {
    const table = fakeTable(2119);
    const { data, error } = await selectAllRows(table.buildPage, 1000);
    expect(error).toBeNull();
    expect(data).toEqual(table.rows);
    expect(table.calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("makes one extra (empty) request when the total is an exact multiple of the page size", async () => {
    const table = fakeTable(2000);
    const { data } = await selectAllRows(table.buildPage, 1000);
    expect(data).toHaveLength(2000);
    expect(table.calls).toHaveLength(3);
  });

  it("returns an empty table as an empty array, not null", async () => {
    const { data, error } = await selectAllRows(fakeTable(0).buildPage);
    expect(data).toEqual([]);
    expect(error).toBeNull();
  });

  it("stops and surfaces the error from any page, dropping partial results", async () => {
    const error = { message: "boom" } as PostgrestError;
    let call = 0;
    const result = await selectAllRows(async (from, to) => {
      call += 1;
      if (call === 2) return { data: null, error };
      return { data: Array.from({ length: to - from + 1 }, (_, i) => from + i), error: null };
    }, 10);
    expect(result).toEqual({ data: null, error });
  });
});
