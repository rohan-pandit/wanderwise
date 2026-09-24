/**
 * Beta-testing callouts (header Beta chip, dismissible banner, header
 * "Feedback" link — `app/app/_components/beta-callouts.tsx`). One switch
 * here takes every one of them down once the beta ends.
 */
export const BETA_ENABLED = true;

/**
 * The banner's dismissal is remembered as this version string in the
 * `BETA_BANNER_COOKIE` cookie — a cookie rather than `localStorage` so the
 * server-rendered `/app` layout already knows whether to render the banner,
 * with no flash-then-disappear on every page load for someone who closed it.
 * Bump the version (with new banner copy) to show it once more to everyone,
 * e.g. to announce something new worth testing.
 */
export const BETA_BANNER_VERSION = "v1";
export const BETA_BANNER_COOKIE = "ww-beta-banner-dismissed";

export function isBetaBannerDismissed(cookieValue: string | undefined, currentVersion: string = BETA_BANNER_VERSION): boolean {
  return cookieValue === currentVersion;
}
