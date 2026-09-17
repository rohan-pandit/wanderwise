/**
 * `eval_runs`/`eval_results` (PROJECT_BRIEF.md §9.8: persist results and
 * compare pass-rate trend over commits/build iterations). Internal,
 * service-role only (supabase/migrations/0001_initial_schema.sql) — every
 * eval runner (`evals/runners/*.ts`) writes here so the engineering
 * dashboard (Phase 8) has real history to read instead of only the latest
 * console output.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type EvalRun = Database["public"]["Tables"]["eval_runs"]["Row"];
export type EvalResult = Database["public"]["Tables"]["eval_results"]["Row"];

export async function createEvalRun(
  supabase: SupabaseClient<Database>,
  runLabel: string,
): Promise<EvalRun> {
  return unwrapOrThrow(
    supabase.from("eval_runs").insert({ run_label: runLabel }).select().single(),
  );
}

export interface NewEvalResult {
  evalRunId: string;
  testCaseName: string;
  passed: boolean;
  score?: number | null;
  details?: Json | null;
}

export async function recordEvalResult(
  supabase: SupabaseClient<Database>,
  result: NewEvalResult,
): Promise<EvalResult> {
  return unwrapOrThrow(
    supabase
      .from("eval_results")
      .insert({
        eval_run_id: result.evalRunId,
        test_case_name: result.testCaseName,
        passed: result.passed,
        score: result.score ?? null,
        details: result.details ?? null,
      })
      .select()
      .single(),
  );
}
