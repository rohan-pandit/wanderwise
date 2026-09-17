/**
 * Templated content generation for the large-scale seed data script
 * (`scripts/generate-large-seed-data.ts`). Deterministic (seeded per city,
 * via `src/domain/random.ts`) so re-running the generator against the same
 * city list reproduces the same catalog. Not meant to be realistic in the
 * "matches a real hotel" sense — this is mock inventory whose job is
 * plausible variety for testing, per the project's existing seed-data
 * conventions (`supabase/migrations/0002_seed_data.sql`).
 */
import { deriveVibeTags, dailyCostRangeUsd } from "@/src/domain/geography";
import { WEEKDAYS } from "@/src/domain/dates";
import { chance, pick, pickMany, randomFloat, randomInt, type Rng } from "@/src/domain/random";

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

const DESCRIPTION_TEMPLATES: ((city: string, country: string, vibes: string[]) => string)[] = [
  (city, country, vibes) => `A ${vibes[0]} getaway in ${country}, known for its ${vibes[1]} scene and easy day trips around ${city}.`,
  (city, country, vibes) => `${city} draws travelers for its mix of ${vibes[0]} and ${vibes[1]} — a favorite stop in ${country}.`,
  (city, country, vibes) => `One of ${country}'s most visited spots, ${city} pairs a strong ${vibes[0]} identity with plenty of ${vibes[1]}.`,
  (city, country, vibes) => `${city}, ${country} — a destination built around ${vibes[0]}, with ${vibes[1]} close by.`,
];

export function generateDestinationDescription(rng: Rng, city: string, country: string): string {
  const vibes = deriveVibeTags(country);
  return pick(rng, DESCRIPTION_TEMPLATES)(city, country, vibes);
}

export function generateEstimatedDailyCostUsd(rng: Rng, country: string): number {
  const [low, high] = dailyCostRangeUsd(country);
  return Math.round(randomFloat(rng, low, high));
}

// ---------------------------------------------------------------------------
// Hotels
// ---------------------------------------------------------------------------

const HOTEL_ADJECTIVES = [
  "Grand", "Royal", "Golden", "Riverside", "Central", "Garden", "Skyline", "Harbor",
  "Old Town", "Modern", "Hillside", "Sunset", "Plaza", "Heritage", "Palm", "Azure",
];
const HOTEL_NOUNS = ["Hotel", "Inn", "Suites", "Resort", "Lodge", "Boutique Hotel", "Guesthouse", "Residence"];
const NEIGHBORHOODS = [
  "Old Town", "Downtown", "Riverside", "Harbor District", "City Center", "Uptown",
  "Historic Quarter", "Market District", "Waterfront", "Hillside",
];
const AMENITIES_POOL = [
  "Free WiFi", "Breakfast Included", "Pool", "Gym", "Spa", "Bar", "Parking",
  "Pet Friendly", "Air Conditioning", "Ocean View", "Room Service", "Airport Shuttle",
];
const CANCELLATION_POLICIES = [
  "Free cancellation up to 48 hours before check-in",
  "Free cancellation up to 24 hours before check-in",
  "Free cancellation up to 7 days before check-in",
  "Free cancellation up to 7 days before check-in",
  "Non-refundable",
];

export interface GeneratedHotel {
  name: string;
  neighborhood: string;
  price_per_night_usd: number;
  taxes_fees_usd: number;
  rating: number;
  room_capacity: number;
  available_rooms: number;
  amenities: string[];
  cancellation_policy: string;
  vibe_tags: string[];
}

export function generateHotel(rng: Rng, city: string, country: string, sparse: boolean): GeneratedHotel {
  const [low, high] = dailyCostRangeUsd(country);
  const pricePerNight = Math.round(randomFloat(rng, low * 0.7, high * 1.4));
  const name =
    chance(rng, 0.4)
      ? `${pick(rng, HOTEL_ADJECTIVES)} ${city} ${pick(rng, HOTEL_NOUNS)}`
      : `The ${pick(rng, HOTEL_ADJECTIVES)} ${pick(rng, HOTEL_NOUNS)}`;
  const roomCapacity = chance(rng, 0.2) ? randomInt(rng, 4, 6) : randomInt(rng, 1, 3);
  const availableRooms = sparse || chance(rng, 0.15) ? randomInt(rng, 1, 3) : randomInt(rng, 4, 20);

  return {
    name,
    neighborhood: pick(rng, NEIGHBORHOODS),
    price_per_night_usd: pricePerNight,
    taxes_fees_usd: Math.round(pricePerNight * randomFloat(rng, 0.08, 0.18)),
    rating: Math.round(randomFloat(rng, 3.3, 4.9) * 10) / 10,
    room_capacity: roomCapacity,
    available_rooms: availableRooms,
    amenities: pickMany(rng, AMENITIES_POOL, randomInt(rng, 2, 6)),
    cancellation_policy: pick(rng, CANCELLATION_POLICIES),
    vibe_tags: deriveVibeTags(country),
  };
}

/** Most destinations get a healthy spread of hotels; ~12% deliberately get only a couple (a smaller destination with fewer lodging choices — realistic, not a bug). */
export function hotelCountForDestination(rng: Rng): { count: number; sparse: boolean } {
  if (chance(rng, 0.12)) {
    return { count: randomInt(rng, 2, 3), sparse: true };
  }
  return { count: randomInt(rng, 5, 8), sparse: false };
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export type ActivityCategory =
  | "food" | "cultural" | "tour" | "spa" | "concert" | "show" | "movie" | "sporting_event" | "outdoor" | "nightlife";

interface CategoryDef {
  category: ActivityCategory;
  /** Probability this category appears at all for a given destination. Core categories are 1. */
  inclusionProbability: number;
  countRange: [number, number];
  priceRangeUsd: [number, number];
  durationMinutesRange: [number, number];
  nameOf: (rng: Rng, city: string) => string;
  descriptionOf: (city: string) => string;
  /** Rough daily window this category tends to operate in. */
  hoursRange: [number, number];
  reservationProbability: number;
}

const CUISINES = ["Local", "Seafood", "Street Food", "Farm-to-Table", "Traditional", "Fusion", "Rooftop", "Family-Style"];
const SPORTS = ["Football", "Basketball", "Baseball", "Rugby", "Cricket"];
const ACTIVITY_ADJECTIVES = ["Grand", "Royal", "Old Town", "Riverside", "Central", "Hidden", "Iconic", "Local"];

const CATEGORY_DEFS: CategoryDef[] = [
  {
    category: "food",
    inclusionProbability: 1,
    countRange: [3, 5],
    priceRangeUsd: [15, 90],
    durationMinutesRange: [60, 120],
    nameOf: (rng, city) => `${pick(rng, CUISINES)} Dining in ${city}`,
    descriptionOf: (city) => `A well-regarded spot for a proper meal while in ${city}.`,
    hoursRange: [11, 22],
    reservationProbability: 0.4,
  },
  {
    category: "cultural",
    inclusionProbability: 1,
    countRange: [2, 4],
    priceRangeUsd: [0, 35],
    durationMinutesRange: [60, 180],
    nameOf: (rng) => `${pick(rng, ACTIVITY_ADJECTIVES)} Museum & Heritage Tour`,
    descriptionOf: (city) => `A museum and heritage site giving context on ${city}'s history.`,
    hoursRange: [9, 18],
    reservationProbability: 0.1,
  },
  {
    category: "tour",
    inclusionProbability: 1,
    countRange: [1, 3],
    priceRangeUsd: [10, 60],
    durationMinutesRange: [90, 240],
    nameOf: (rng, city) => `${city} Walking Tour & Sightseeing`,
    descriptionOf: (city) => `A guided walk through ${city}'s most-visited sights.`,
    hoursRange: [8, 17],
    reservationProbability: 0.2,
  },
  {
    category: "spa",
    inclusionProbability: 0.6,
    countRange: [1, 2],
    priceRangeUsd: [40, 150],
    durationMinutesRange: [60, 150],
    nameOf: (rng) => `${pick(rng, ACTIVITY_ADJECTIVES)} Spa & Wellness Retreat`,
    descriptionOf: (city) => `A spa and wellness retreat popular with visitors to ${city}.`,
    hoursRange: [9, 20],
    reservationProbability: 0.7,
  },
  {
    category: "concert",
    inclusionProbability: 0.45,
    countRange: [1, 2],
    priceRangeUsd: [25, 120],
    durationMinutesRange: [90, 180],
    nameOf: (rng) => `Live Music at ${pick(rng, ACTIVITY_ADJECTIVES)} Hall`,
    descriptionOf: (city) => `A live-music venue that's a regular stop on ${city}'s nightlife circuit.`,
    hoursRange: [19, 24],
    reservationProbability: 0.5,
  },
  {
    category: "show",
    inclusionProbability: 0.4,
    countRange: [1, 2],
    priceRangeUsd: [30, 140],
    durationMinutesRange: [90, 150],
    nameOf: (rng) => `${pick(rng, ACTIVITY_ADJECTIVES)} Theater Evening Show`,
    descriptionOf: (city) => `A theater production well-known among visitors to ${city}.`,
    hoursRange: [18, 23],
    reservationProbability: 0.8,
  },
  {
    category: "movie",
    inclusionProbability: 0.35,
    countRange: [1, 1],
    priceRangeUsd: [8, 20],
    durationMinutesRange: [100, 150],
    nameOf: (rng, city) => `${city} Cinema Screening`,
    descriptionOf: (city) => `A local cinema showing first-run films in ${city}.`,
    hoursRange: [12, 23],
    reservationProbability: 0.1,
  },
  {
    category: "sporting_event",
    inclusionProbability: 0.3,
    countRange: [1, 1],
    priceRangeUsd: [20, 150],
    durationMinutesRange: [120, 180],
    nameOf: (rng) => `Local ${pick(rng, SPORTS)} Match`,
    descriptionOf: (city) => `A local sporting fixture, a good pick for sports fans visiting ${city}.`,
    hoursRange: [13, 21],
    reservationProbability: 0.6,
  },
  {
    category: "outdoor",
    inclusionProbability: 0.55,
    countRange: [1, 3],
    priceRangeUsd: [0, 70],
    durationMinutesRange: [90, 240],
    nameOf: (rng) => `${pick(rng, ACTIVITY_ADJECTIVES)} Nature & Adventure Excursion`,
    descriptionOf: (city) => `An outdoor excursion in and around ${city}.`,
    hoursRange: [7, 18],
    reservationProbability: 0.3,
  },
  {
    category: "nightlife",
    inclusionProbability: 0.5,
    countRange: [1, 2],
    priceRangeUsd: [10, 50],
    durationMinutesRange: [90, 180],
    nameOf: (rng) => `${pick(rng, ACTIVITY_ADJECTIVES)} Rooftop Bar`,
    descriptionOf: (city) => `A well-known nightlife spot in ${city}.`,
    hoursRange: [20, 26], // 26 = past-midnight close, handled below
    reservationProbability: 0.2,
  },
];

export interface GeneratedActivity {
  name: string;
  description: string;
  category: ActivityCategory;
  vibe_tags: string[];
  price_usd: number;
  duration_minutes: number;
  opening_hours: Record<string, string>;
  closed_days: string[];
  location: string;
  accessibility_attributes: string[];
  reservation_required: boolean;
}

function formatHour(h: number): string {
  const wrapped = h % 24;
  return `${String(wrapped).padStart(2, "0")}:00`;
}

function generateOpeningHours(rng: Rng, hoursRange: [number, number]): Record<string, string> {
  const [start, end] = hoursRange;
  const hours: Record<string, string> = {};
  for (const day of WEEKDAYS) {
    hours[day] = `${formatHour(start)}-${formatHour(end)}`;
  }
  return hours;
}

const ACCESSIBILITY_POOL = ["wheelchair_accessible", "step_free_access", "hearing_assistance"];

export function generateActivity(rng: Rng, city: string, country: string, category: ActivityCategory): GeneratedActivity {
  const def = CATEGORY_DEFS.find((d) => d.category === category)!;
  const closedDays = chance(rng, 0.4) ? [pick(rng, WEEKDAYS)] : [];
  return {
    name: def.nameOf(rng, city),
    description: def.descriptionOf(city),
    category: def.category,
    vibe_tags: deriveVibeTags(country),
    price_usd: Math.round(randomFloat(rng, def.priceRangeUsd[0], def.priceRangeUsd[1])),
    duration_minutes: randomInt(rng, def.durationMinutesRange[0], def.durationMinutesRange[1]),
    opening_hours: generateOpeningHours(rng, def.hoursRange),
    closed_days: closedDays,
    location: pick(rng, NEIGHBORHOODS),
    accessibility_attributes: chance(rng, 0.25) ? pickMany(rng, ACCESSIBILITY_POOL, randomInt(rng, 1, 2)) : [],
    reservation_required: chance(rng, def.reservationProbability),
  };
}

/**
 * Which categories a destination gets, and how many of each — every
 * destination gets the "always present" categories (food/cultural/tour);
 * niche categories are included with a probability tied to their own
 * `inclusionProbability`, roughly doubled/halved by whether the destination
 * is generally sparse (a smaller city plausibly has no major concert venue
 * or sports stadium — matches real life, not a data gap).
 */
export function planActivitiesForDestination(rng: Rng, sparse: boolean): { category: ActivityCategory; count: number }[] {
  const plan: { category: ActivityCategory; count: number }[] = [];
  for (const def of CATEGORY_DEFS) {
    const probability = def.inclusionProbability === 1 ? 1 : sparse ? def.inclusionProbability * 0.5 : def.inclusionProbability;
    if (!chance(rng, probability)) continue;
    const [minCount, maxCount] = def.countRange;
    const count = sparse ? Math.max(1, Math.floor(randomInt(rng, minCount, maxCount) / 2)) : randomInt(rng, minCount, maxCount);
    plan.push({ category: def.category, count });
  }
  return plan;
}
