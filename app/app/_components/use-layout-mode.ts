"use client";

import { useEffect, useState } from "react";

/**
 * Which of the three chat+itinerary layouts `TripWorkspace` renders —
 * "drawer" (mobile and tablet-portrait: itinerary as a bottom sheet over
 * full-width chat), "split" (tablet-landscape: a collapsible side panel,
 * manual toggle only), or "sidebar" (desktop: today's fixed `w-96` panel,
 * unchanged). Decided purely from viewport width, not the `orientation`
 * media feature — a real tablet rotated to landscape is simply wider than
 * the same tablet in portrait, so width alone already tracks the intended
 * distinction without `orientation`'s flakiness around on-screen keyboards.
 */
export type LayoutMode = "drawer" | "split" | "sidebar";

const DRAWER_MAX_WIDTH = 839;
const SPLIT_MAX_WIDTH = 1149;

function computeLayoutMode(width: number): LayoutMode {
  if (width <= DRAWER_MAX_WIDTH) return "drawer";
  if (width <= SPLIT_MAX_WIDTH) return "split";
  return "sidebar";
}

/** Defaults to "sidebar" for the first render (matches the server-rendered markup exactly until the client can measure a real viewport), then corrects on mount and on every resize. */
export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("sidebar");

  useEffect(() => {
    const update = () => setMode(computeLayoutMode(window.innerWidth));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return mode;
}
