/**
 * The inventory_version that reads should default to when the caller
 * doesn't explicitly ask for a specific one. PROJECT_BRIEF.md §7.4 models
 * inventory as versioned snapshots; this is the single place that decides
 * what "current" means, so repositories don't each hardcode the number.
 */
export const CURRENT_INVENTORY_VERSION = 1;
