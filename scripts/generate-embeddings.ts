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
import { createServiceClient } from "../src/config/supabase/service";
import { CURRENT_INVENTORY_VERSION } from "../src/domain/inventory";
import { VoyageEmbeddingClient } from "../src/retrieval/providers/voyage-embedding-client";

const supabase = createServiceClient();

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
  const { data, error } = await supabase
    .from("destinations")
    .select("*")
    .eq("inventory_version", CURRENT_INVENTORY_VERSION);
  if (error) throw error;
  if (data.length === 0) {
    console.log("destinations: no current-inventory-version rows found, nothing to embed.");
    return;
  }

  console.log(`destinations: embedding ${data.length} rows...`);
  const { embeddings, totalTokens } = await embeddingClient.embed(data.map(destinationDocument), "document");

  await Promise.all(
    data.map(async (row, i) => {
      const { error: updateError } = await supabase.from("destinations").update({ embedding: embeddings[i] }).eq("id", row.id);
      if (updateError) throw updateError;
    }),
  );
  console.log(`destinations: done (${totalTokens} tokens).`);
}

async function embedActivities(embeddingClient: VoyageEmbeddingClient) {
  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("inventory_version", CURRENT_INVENTORY_VERSION);
  if (error) throw error;
  if (data.length === 0) {
    console.log("activities: no current-inventory-version rows found, nothing to embed.");
    return;
  }

  console.log(`activities: embedding ${data.length} rows...`);
  const { embeddings, totalTokens } = await embeddingClient.embed(data.map(activityDocument), "document");

  await Promise.all(
    data.map(async (row, i) => {
      const { error: updateError } = await supabase.from("activities").update({ embedding: embeddings[i] }).eq("id", row.id);
      if (updateError) throw updateError;
    }),
  );
  console.log(`activities: done (${totalTokens} tokens).`);
}

async function main() {
  const embeddingClient = new VoyageEmbeddingClient();
  console.log(`Using model "${embeddingClient.model}" (${embeddingClient.dimension} dims).`);

  await embedDestinations(embeddingClient);
  await embedActivities(embeddingClient);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
