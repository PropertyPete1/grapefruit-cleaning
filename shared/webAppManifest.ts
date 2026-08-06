/**
 * Route-scoped web-app manifests.
 *
 * The site serves three installable surfaces from one origin: the customer
 * site, the admin dashboard, and the staff dashboard. A single manifest with
 * start_url "/" makes every home-screen icon open the customer homepage, so
 * saving /admin to a phone gives you the marketing site instead of the
 * dashboard. Each dashboard therefore gets its own manifest, scoped to its own
 * path, and the document's manifest link is swapped to match the current route.
 *
 * Pure data + mapping, kept free of DOM access so it can be unit-tested.
 */

export type AppScope = "customer" | "admin" | "staff";

export interface WebAppTarget {
  scope: AppScope;
  /**
   * Manifest to link for this route. null on the customer site: it has never
   * declared one, and adding one would change how phones treat "Add to Home
   * Screen" there — explicitly out of scope.
   */
  manifestHref: string | null;
  /** iOS home-screen icon (iOS ignores manifest icons for apple-touch-icon). */
  appleTouchIcon: string | null;
  /** Name shown under the iOS home-screen icon. */
  appleTitle: string | null;
  /** Browser/status-bar tint for the installed app. */
  themeColor: string | null;
}

const CUSTOMER_TARGET: WebAppTarget = {
  scope: "customer",
  manifestHref: null,
  appleTouchIcon: null,
  appleTitle: null,
  themeColor: null,
};

const SCOPED_TARGETS: Record<Exclude<AppScope, "customer">, WebAppTarget> = {
  admin: {
    scope: "admin",
    manifestHref: "/manifest.admin.webmanifest",
    appleTouchIcon: "/icons/admin-180.png",
    appleTitle: "GF Admin",
    themeColor: "#F26D5B",
  },
  staff: {
    scope: "staff",
    manifestHref: "/manifest.staff.webmanifest",
    appleTouchIcon: "/icons/staff-180.png",
    appleTitle: "GF Staff",
    themeColor: "#2E6E5B",
  },
};

/**
 * Which installable app a path belongs to.
 *
 * Matches the path segment exactly, so "/administrator" or "/staffing" stay on
 * the customer site. Query strings and hashes are ignored, and a trailing slash
 * makes no difference.
 */
export function appScopeForPath(pathname: string): AppScope {
  if (typeof pathname !== "string" || pathname.length === 0) return "customer";
  // Tolerate a full URL or a path carrying ?query / #hash.
  const path = pathname.split(/[?#]/)[0]!.toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const first = segments[0];
  if (first === "admin") return "admin";
  if (first === "staff") return "staff";
  return "customer";
}

/** Manifest, icon, title and theme colour to apply for a path. */
export function webAppTargetForPath(pathname: string): WebAppTarget {
  const scope = appScopeForPath(pathname);
  return scope === "customer" ? CUSTOMER_TARGET : SCOPED_TARGETS[scope];
}
