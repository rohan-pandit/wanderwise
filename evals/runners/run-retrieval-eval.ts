/**
 * Component eval runner for retrieval quality (PROJECT_BRIEF.md §10.3).
 * Calls the real Voyage API — batches every case's query text into ONE
 * embed() call up front (Voyage's free-tier rate limit is a restrictive
 * 3 requests/minute without a payment method on file — see BUILD_LOG.md,
 * 2026-09-16), then runs each case's DB match purely against Postgres with
 * the pre-computed vector. No LLM grading; every assertion is deterministic.
 *
 * Usage: `npm run eval:retrieval`
 */
import { createServiceClient } from "../../src/config/supabase/service";
import { getDestinationByName, matchDestinations } from "../../src/repositories/destinations";
import { matchActivities } from "../../src/repositories/activities";
import { excludeClosedOnDaysConstraint, filterHardConstraints } from "../../src/domain/constraints";
import { OVERFETCH_FACTOR } from "../../src/retrieval/activities-retrieval";
import { VoyageEmbeddingClient } from "../../src/retrieval/providers/voyage-embedding-client";
import { ACTIVITY_RETRIEVAL_CASES, DESTINATION_RETRIEVAL_CASES } from "../cases/retrieval";

const supabase = createServiceClient();

async function main() {
  const embeddingClient = new VoyageEmbeddingClient();

  const destinationQueries = DESTINATION_RETRIEVAL_CASES.map((c) => c.query);
  const activityQueries = ACTIVITY_RETRIEVAL_CASES.map((c) => c.query);
  console.log(`Embedding ${destinationQueries.length + activityQueries.length} queries in one batch call...`);
  const { embeddings } = await embeddingClient.embed([...destinationQueries, ...activityQueries], "query");
  const destinationEmbeddings = embeddings.slice(0, destinationQueries.length);
  const activityEmbeddings = embeddings.slice(destinationQueries.length);

  let passed = 0;
  const total = DESTINATION_RETRIEVAL_CASES.length + ACTIVITY_RETRIEVAL_CASES.length;

  console.log("\n--- Destination retrieval ---");
  for (let i = 0; i < DESTINATION_RETRIEVAL_CASES.length; i++) {
    const testCase = DESTINATION_RETRIEVAL_CASES[i];
    const results = await matchDestinations(supabase, {
      queryEmbedding: destinationEmbeddings[i],
      matchCount: testCase.topK,
      maxDailyCostUsd: testCase.maxDailyCostUsd,
      vibeTags: testCase.vibeTags,
    });
    const assertions = testCase.assert(results);
    const casePass = assertions.every((a) => a.pass);
    if (casePass) passed++;
    console.log(`  [${casePass ? "PASS" : "FAIL"}] ${testCase.name}`);
    for (const a of assertions) if (!a.pass) console.log(`         - ${a.detail}`);
  }

  console.log("\n--- Activity retrieval ---");
  for (let i = 0; i < ACTIVITY_RETRIEVAL_CASES.length; i++) {
    const testCase = ACTIVITY_RETRIEVAL_CASES[i];
    const overfetch = testCase.excludeClosedOnDays?.length ? testCase.topK * OVERFETCH_FACTOR : testCase.topK;
    const destinationRow = await getDestinationByName(supabase, testCase.destination);
    if (!destinationRow) throw new Error(`eval case "${testCase.name}": unknown destination "${testCase.destination}"`);
    let results = await matchActivities(supabase, {
      queryEmbedding: activityEmbeddings[i],
      matchCount: overfetch,
      destinationId: destinationRow.id,
      requiredAccessibility: testCase.accessibilityNeeds,
    });
    if (testCase.excludeClosedOnDays?.length) {
      results = filterHardConstraints(results, [excludeClosedOnDaysConstraint(testCase.excludeClosedOnDays)]).passing.slice(
        0,
        testCase.topK,
      );
    }
    const assertions = testCase.assert(results);
    const casePass = assertions.every((a) => a.pass);
    if (casePass) passed++;
    console.log(`  [${casePass ? "PASS" : "FAIL"}] ${testCase.name}`);
    for (const a of assertions) if (!a.pass) console.log(`         - ${a.detail}`);
  }

  console.log(`\n--- Summary: ${passed}/${total} passed ---`);
  if (passed < total) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
