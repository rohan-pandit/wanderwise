/**
 * One user's full activity: account facts, then each trip (newest first)
 * with a snapshot of where it stands now and a chronological timeline of
 * everything that happened in it — both sides of the chat, every option
 * shown and selected, workflow transitions, agent errors, guardrail
 * triggers and feedback. See `../page.tsx` for access/privacy notes and
 * `src/observability/user-activity.ts` for how the timeline is assembled.
 *
 * Unlike the aggregate dashboards, every query here is scoped to one
 * user's trips, so it only pages (`selectAllRows`) where a single chatty
 * trip could plausibly pass PostgREST's 1000-row cap.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { createServiceClient } from "@/src/config/supabase/service";
import { selectAllRows } from "@/src/repositories/shared";
import {
  buildTripSnapshot,
  buildUserTimeline,
  collectDecisionInventoryIds,
  collectInventoryIds,
  countErrors,
  type TimelineItem,
  type TimelineTone,
  type TripSnapshot,
} from "@/src/observability/user-activity";
import { InternalNav } from "../../_components/internal-nav";
import { formatTimestamp } from "../format";

type ServiceClient = ReturnType<typeof createServiceClient>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves inventory ids to readable labels for the timeline and snapshot — only the ids this user's trips actually reference. */
async function loadInventoryNames(
  supabase: ServiceClient,
  ids: { flightIds: string[]; hotelIds: string[]; activityIds: string[] },
): Promise<Map<string, string>> {
  const [flights, hotels, activities] = await Promise.all([
    ids.flightIds.length > 0
      ? supabase
          .from("flights")
          .select("id, airline, flight_number, origin, destination, origin_airport_code, destination_airport_code, departure_time, price_usd")
          .in("id", ids.flightIds)
      : Promise.resolve({ data: [] }),
    ids.hotelIds.length > 0 ? supabase.from("hotels").select("id, name, price_per_night_usd").in("id", ids.hotelIds) : Promise.resolve({ data: [] }),
    ids.activityIds.length > 0 ? supabase.from("activities").select("id, name").in("id", ids.activityIds) : Promise.resolve({ data: [] }),
  ]);

  const names = new Map<string, string>();
  for (const f of flights.data ?? []) {
    const code = [f.airline, f.flight_number].filter(Boolean).join(" ") || "Flight";
    const route = `${f.origin_airport_code ?? f.origin}→${f.destination_airport_code ?? f.destination}`;
    names.set(f.id, `${code} · ${route} · ${f.departure_time.slice(0, 10)} · $${Number(f.price_usd).toLocaleString()}`);
  }
  for (const h of hotels.data ?? []) names.set(h.id, `${h.name} · $${Number(h.price_per_night_usd).toLocaleString()}/night`);
  for (const a of activities.data ?? []) names.set(a.id, a.name);
  return names;
}

function mergeIds(...sets: { flightIds: string[]; hotelIds: string[]; activityIds: string[] }[]) {
  const merge = (key: "flightIds" | "hotelIds" | "activityIds") => [...new Set(sets.flatMap((s) => s[key]))];
  return { flightIds: merge("flightIds"), hotelIds: merge("hotelIds"), activityIds: merge("activityIds") };
}

export default async function UserActivityPage({ params }: { params: Promise<{ userId: string }> }) {
  await connection();
  const { userId } = await params;
  if (!UUID_PATTERN.test(userId)) notFound();

  const supabase = createServiceClient();
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
  if (userError || !userData.user) notFound();
  const user = userData.user;

  const { data: tripRows } = await supabase
    .from("trips")
    .select("id, name, status, session_id, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  const trips = tripRows ?? [];
  const tripIds = trips.map((t) => t.id);
  const sessionIds = [...new Set(trips.map((t) => t.session_id))];
  const hasTrips = tripIds.length > 0;
  const none = <T,>() => Promise.resolve({ data: [] as T[] });

  // Link requests happen before sign-in, so they carry only the email.
  const emailFilter = user.email ? `,email.eq."${user.email.toLowerCase()}"` : "";
  const [messagesRes, eventsRes, agentErrorsRes, guardrailRes, feedbackRes, requirementsRes, decisionsRes, appEventsRes] = await Promise.all([
    hasTrips
      ? selectAllRows((from, to) =>
          supabase.from("messages").select("session_id, role, content, created_at").in("session_id", sessionIds).order("created_at").order("id").range(from, to),
        )
      : none<{ session_id: string; role: string; content: string; created_at: string }>(),
    hasTrips
      ? selectAllRows((from, to) =>
          supabase.from("trip_events").select("trip_id, event_type, payload, created_at").in("trip_id", tripIds).order("created_at").order("id").range(from, to),
        )
      : none<{ trip_id: string; event_type: string; payload: unknown; created_at: string }>(),
    hasTrips
      ? supabase.from("agent_runs").select("trip_id, agent_name, error_message, created_at").in("trip_id", tripIds).eq("status", "error")
      : none<{ trip_id: string | null; agent_name: string; error_message: string | null; created_at: string }>(),
    hasTrips
      ? supabase.from("guardrail_events").select("trip_id, guardrail_name, layer, detail, created_at").in("trip_id", tripIds).eq("triggered", true)
      : none<{ trip_id: string | null; guardrail_name: string; layer: string; detail: string | null; created_at: string }>(),
    supabase.from("feedback").select("trip_id, kind, categories, message, created_at").eq("user_id", userId),
    hasTrips
      ? supabase.from("trip_requirements").select("trip_id, field, value").in("trip_id", tripIds).neq("status", "retracted")
      : none<{ trip_id: string; field: string; value: unknown }>(),
    hasTrips
      ? supabase.from("trip_decisions").select("trip_id, field, status, value, created_at").in("trip_id", tripIds).order("created_at")
      : none<{ trip_id: string; field: string; status: string; value: unknown; created_at: string }>(),
    // Empty (not an error page) if migration 0021 isn't applied yet.
    supabase.from("app_events").select("event_type, user_id, email, trip_id, payload, created_at").or(`user_id.eq.${userId}${emailFilter}`),
  ]);

  const tripEvents = eventsRes.data ?? [];
  const decisions = decisionsRes.data ?? [];
  const names = await loadInventoryNames(supabase, mergeIds(collectInventoryIds(tripEvents), collectDecisionInventoryIds(decisions)));

  const timeline = buildUserTimeline({
    trips,
    messages: messagesRes.data ?? [],
    tripEvents,
    agentErrors: agentErrorsRes.data ?? [],
    guardrailBlocks: guardrailRes.data ?? [],
    feedback: feedbackRes.data ?? [],
    appEvents: appEventsRes.data ?? [],
    names,
  });

  const itemsByTrip = new Map<string | null, TimelineItem[]>();
  for (const item of timeline) {
    const list = itemsByTrip.get(item.tripId) ?? [];
    list.push(item);
    itemsByTrip.set(item.tripId, list);
  }
  const snapshotFor = (tripId: string): TripSnapshot =>
    buildTripSnapshot(
      (requirementsRes.data ?? []).filter((r) => r.trip_id === tripId),
      decisions.filter((d) => d.trip_id === tripId),
      names,
    );
  const accountLevelItems = itemsByTrip.get(null) ?? [];
  const userMessageCount = timeline.filter((i) => i.tone === "user").length;
  const signInCount = (appEventsRes.data ?? []).filter((e) => e.event_type === "sign_in_succeeded").length;

  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-8 px-6 py-8">
      <div>
        <div className="flex items-center justify-between">
          <Link href="/internal/users" className="text-sm text-teal-700 underline hover:text-teal-800">
            ← All users
          </Link>
          <InternalNav current="/internal/users" />
        </div>
        <h1 className="mt-3 font-serif text-2xl font-semibold break-all text-navy-900">{user.email ?? user.id}</h1>
        <p className="mt-1 text-xs text-navy-400">
          {user.id} · signed up {formatTimestamp(user.created_at)} · last sign-in {user.last_sign_in_at ? formatTimestamp(user.last_sign_in_at) : "never"}
        </p>
      </div>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <StatCard label="Sign-ins" value={String(signInCount)} sub="recorded since migration 0021" />
        <StatCard label="Trips" value={String(trips.length)} sub={`${trips.filter((t) => t.status === "finalized").length} finalized`} />
        <StatCard label="Messages sent" value={String(userMessageCount)} sub="user-typed chat messages" />
        <StatCard label="Selections" value={String(timeline.filter((i) => i.tone === "selection").length)} sub="flights, hotels, activities" />
        <StatCard label="Errors" value={String(countErrors(timeline))} sub={`${timeline.filter((i) => i.tone === "warning").length} warnings`} />
      </section>

      {accountLevelItems.length > 0 ? (
        <section className="rounded-lg border border-sand-200 px-4 py-3">
          <h2 className="font-semibold text-navy-900">Sign-ins &amp; account activity</h2>
          <Timeline items={accountLevelItems} />
        </section>
      ) : null}
      {trips.length === 0 ? <p className="text-sm text-navy-400">This user signed up but hasn&apos;t started a trip.</p> : null}

      {trips.map((trip) => {
        const items = itemsByTrip.get(trip.id) ?? [];
        const snapshot = snapshotFor(trip.id);
        const errors = countErrors(items);
        return (
          <section key={trip.id} className="rounded-lg border border-sand-200">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-sand-200 px-4 py-3">
              <h2 className="font-semibold text-navy-900">{trip.name ?? "Untitled trip"}</h2>
              <div className="text-xs text-navy-400">
                started {formatTimestamp(trip.created_at)} · <span className="font-medium text-navy-700">{trip.status}</span>
                {errors > 0 ? <span className="text-terracotta-700"> · {errors} error{errors === 1 ? "" : "s"}</span> : null}
              </div>
            </div>
            <Snapshot snapshot={snapshot} />
            <details className="px-4 py-3" open={trips.length === 1}>
              <summary className="cursor-pointer text-sm font-medium text-teal-700">Timeline ({items.length} events)</summary>
              <Timeline items={items} />
            </details>
          </section>
        );
      })}

    </div>
  );
}

function Snapshot({ snapshot }: { snapshot: TripSnapshot }) {
  const rows: [string, string | null][] = [
    ["Requirements", snapshot.requirements],
    ["Progress", snapshot.chainStep],
    ["Outbound flight", snapshot.outboundFlight],
    ["Return flight", snapshot.returnFlight],
    ["Hotel", snapshot.hotel],
    ["Activities", snapshot.activities.length > 0 ? snapshot.activities.join(", ") : null],
  ];
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 border-b border-sand-100 bg-sand-50 px-4 py-3 text-sm sm:grid-cols-[10rem_1fr]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-navy-400">{label}</dt>
          <dd className={value ? "text-navy-900" : "text-navy-400"}>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

const TONE_STYLES: Record<TimelineTone, { chip: string; body: string }> = {
  milestone: { chip: "bg-navy-900 text-sand-50", body: "text-navy-900" },
  user: { chip: "bg-navy-50 text-navy-900 border border-navy-200", body: "text-navy-900" },
  agent: { chip: "bg-teal-50 text-teal-800", body: "text-navy-700" },
  selection: { chip: "bg-teal-100 text-teal-800 font-semibold", body: "text-navy-900 font-medium" },
  workflow: { chip: "bg-sand-100 text-navy-400", body: "text-navy-400 text-xs" },
  warning: { chip: "bg-terracotta-50 text-terracotta-600", body: "text-navy-700" },
  error: { chip: "bg-terracotta-100 text-terracotta-700 font-semibold", body: "text-terracotta-700" },
  feedback: { chip: "bg-sand-200 text-navy-700", body: "text-navy-700" },
};

function Timeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) return <p className="mt-2 text-sm text-navy-400">Nothing recorded.</p>;
  return (
    <ol className="mt-3 flex flex-col gap-2">
      {items.map((item, i) => {
        const style = TONE_STYLES[item.tone];
        return (
          <li key={i} className="grid grid-cols-[7.5rem_1fr] gap-3 text-sm">
            <time className="pt-0.5 text-xs text-navy-400 tabular-nums">{formatTimestamp(item.at).replace(" UTC", "")}</time>
            <div className="min-w-0">
              <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${style.chip}`}>{item.title}</span>
              {item.detail ? <p className={`mt-1 break-words whitespace-pre-wrap ${style.body}`}>{item.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-sand-200 px-4 py-3">
      <div className="text-xs text-navy-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-navy-900">{value}</div>
      <div className="mt-0.5 text-xs text-navy-400">{sub}</div>
    </div>
  );
}
