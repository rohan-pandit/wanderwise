/**
 * One-time (re-runnable) backfill: embeds every current-inventory-version
 * `destinations`/`activities` row and writes the vector back. Calls the
 * real Voyage AI API — cheap (well within the 200M-token free tier for
 * this corpus) but still a real external call, run deliberately, not from
 * CI or on every save.
 *
 * Idempotent by construction: re-running it just recomputes and overwrites
 * every embedding, which is exactly what you want after seed data changes
 * or a model/dimension change — there's no partial-progress state to track.
 *
 * Usage: `npm run generate-embeddings`
 */
import type { Database } from "../src/config/supabase/database.types";
import { createServiceClient } from "../src/config/supabase/service";
import { CURRENT_INVENTORY_VERSION } from "../src/domain/inventory";
import { VoyageEmbeddingClient } from "../src/retrieval/providers/voyage-embedding-client";

const supabase = createServiceClient();

/**
 * PostgREST caps a single `select` response at 1000 rows by default — never
 * an issue while this project's inventory was small, but a real, silent
 * under-fetch once the large-scale seed data pushed `activities` well past
 * that (found live: only 1000 of ~8,100 activities got embedded on the first
 * run of this script after the reseed). Pages through with `.range()`
 * instead of relying on a single `select("*")` returning everything.
 */
const PAGE_SIZE = 1000;
const UPDATE_BATCH_SIZE = 200;

async function selectAllCurrentDestinations(): Promise<Database["public"]["Tables"]["destinations"]["Row"][]> {
  const rows: Database["public"]["Tables"]["destinations"]["Row"][] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("destinations")
      .select("*")
      .eq("inventory_version", CURRENT_INVENTORY_VERSION)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function selectAllCurrentActivities(): Promise<Database["public"]["Tables"]["activities"]["Row"][]> {
  const rows: Database["public"]["Tables"]["activities"]["Row"][] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("activities")
      .select("*")
      .eq("inventory_version", CURRENT_INVENTORY_VERSION)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Writes embeddings back in bounded-size concurrent batches — at ~8,100 activities, firing every update at once risks overwhelming the connection pool. */
async function writeDestinationEmbeddingsBack(
  rows: Database["public"]["Tables"]["destinations"]["Row"][],
  embeddings: number[][],
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPDATE_BATCH_SIZE) {
    const batchRows = rows.slice(i, i + UPDATE_BATCH_SIZE);
    const batchEmbeddings = embeddings.slice(i, i + UPDATE_BATCH_SIZE);
    await Promise.all(
      batchRows.map(async (row, j) => {
        const { error } = await supabase.from("destinations").update({ embedding: batchEmbeddings[j] }).eq("id", row.id);
        if (error) throw error;
      }),
    );
  }
}

async function writeActivityEmbeddingsBack(
  rows: Database["public"]["Tables"]["activities"]["Row"][],
  embeddings: number[][],
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPDATE_BATCH_SIZE) {
    const batchRows = rows.slice(i, i + UPDATE_BATCH_SIZE);
    const batchEmbeddings = embeddings.slice(i, i + UPDATE_BATCH_SIZE);
    await Promise.all(
      batchRows.map(async (row, j) => {
        const { error } = await supabase.from("activities").update({ embedding: batchEmbeddings[j] }).eq("id", row.id);
        if (error) throw error;
      }),
    );
  }
}

function destinationDocument(row: {
  name: string;
  country: string | null;
  description: string | null;
  vibe_tags: string[] | null;
}): string {
  const parts = [
    [row.name, row.country].filter(Boolean).join(", "),
    row.description,
    row.vibe_tags?.length ? `Vibe: ${row.vibe_tags.join(", ")}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}

function activityDocument(row: {
  name: string;
  destination: string;
  description: string | null;
  category: string | null;
  vibe_tags: string[] | null;
}): string {
  const parts = [
    `${row.name} in ${row.destination}.`,
    row.category ? `Category: ${row.category}.` : null,
    row.description,
    row.vibe_tags?.length ? `Vibe: ${row.vibe_tags.join(", ")}.` : null,
  ];
  return parts.filter(Boolean).join(" ");
}

async function embedDestinations(embeddingClient: VoyageEmbeddingClient) {
  const data = await selectAllCurrentDestinations();
  if (data.length === 0) {
    console.log("destinations: no current-inventory-version rows found, nothing to embed.");
    return;
  }

  console.log(`destinations: embedding ${data.length} rows...`);
  const { embeddings, totalTokens } = await embeddingClient.embed(data.map(destinationDocument), "document");
  await writeDestinationEmbeddingsBack(data, embeddings);
  console.log(`destinations: done (${totalTokens} tokens).`);
}

async function embedActivities(embeddingClient: VoyageEmbeddingClient) {
  const data = await selectAllCurrentActivities();
  if (data.length === 0) {
    console.log("activities: no current-inventory-version rows found, nothing to embed.");
    return;
  }

  console.log(`activities: embedding ${data.length} rows...`);
  const { embeddings, totalTokens } = await embeddingClient.embed(data.map(activityDocument), "document");
  await writeActivityEmbeddingsBack(data, embeddings);
  console.log(`activities: done (${totalTokens} tokens).`);
}

async function main() {
  const embeddingClient = new VoyageEmbeddingClient();
  console.log(`Using model "${embeddingClient.model}" (${embeddingClient.dimension} dims).`);

  await embedDestinations(embeddingClient);
  // Same rate-limit spacing reason as VoyageEmbeddingClient's inter-chunk
  // delay — otherwise the last destinations chunk and the first activities
  // chunk land back-to-back and can still trip the 3 RPM free-tier limit.
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  await embedActivities(embeddingClient);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
