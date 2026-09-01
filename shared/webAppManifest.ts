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
  /** Manifest to link for this route; every surface is explicitly branded. */
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
  manifestHref: "/manifest.webmanifest",
  appleTouchIcon: "/manus-storage/favicon-256_0edfb26b.png",
  appleTitle: "Grapefruit Cleaning",
  themeColor: "#F26D5B",
};

const SCOPED_TARGETS: Record<Exclude<AppScope, "customer">, WebAppTarget> = {
  admin: {
    scope: "admin",
    manifestHref: "/manifest.admin.webmanifest",
    appleTouchIcon: "/icons/admin-180.png",
    appleTitle: "Grapefruit",
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

/**
 * Attribute marking the tags the app-identity machinery owns, on both the
 * server-rendered and the client-injected copies. The client only ever removes
 * or restores tags carrying it, so it can't clobber anything else in the head.
 */
export const WEBAPP_TAG_ATTR = "data-scoped-webapp";

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The app-identity tags for a path, as HTML.
 *
 * These have to be in the document the server sends: iOS reads the head when
 * the user taps "Add to Home Screen" and does not pick up a manifest link that
 * JavaScript added after load — it just saves a plain bookmark, which is why a
 * client-only swap produced an icon that opened the customer site.
 *
 * Includes crawler-visible social metadata because preview bots generally do
 * not execute the client-side SEO hook.
 */
export function webAppHeadTags(pathname: string): string {
  const target = webAppTargetForPath(pathname);
  const owned = `${WEBAPP_TAG_ATTR}="true"`;
  const path = pathname.split(/[?#]/)[0]!.toLowerCase();
  const spanish = path === "/es" || path.startsWith("/es/");
  const publicTitle = spanish
    ? "Grapefruit Cleaning Co. | Limpieza residencial y comercial"
    : "Grapefruit Cleaning Co. | Premium Residential & Commercial Cleaning";
  const publicDescription = spanish
    ? "Limpieza residencial, comercial, profunda y de Airbnb. Obtenga una cotización y reserve en línea."
    : "Premium residential, commercial, deep, and Airbnb cleaning. Get an instant quote and book online.";
  const title = target.scope === "admin"
    ? "Grapefruit Team | Admin"
    : target.scope === "staff"
      ? "Grapefruit Staff | Schedule"
      : publicTitle;
  const description = target.scope === "customer"
    ? publicDescription
    : "Grapefruit Cleaning Co. team scheduling and operations.";
  const image = "https://grapeclean.com/manus-storage/grapefruit-logo_9a11bb63.jpg";
  return [
    `<link rel="manifest" href="${escapeAttr(target.manifestHref!)}" ${owned}>`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${escapeAttr(target.appleTouchIcon!)}" ${owned}>`,
    `<meta name="apple-mobile-web-app-capable" content="yes" ${owned}>`,
    `<meta name="mobile-web-app-capable" content="yes" ${owned}>`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default" ${owned}>`,
    `<meta name="apple-mobile-web-app-title" content="${escapeAttr(target.appleTitle!)}" ${owned}>`,
    `<meta name="theme-color" content="${escapeAttr(target.themeColor!)}" ${owned}>`,
    `<meta property="og:title" content="${escapeAttr(title)}" ${owned}>`,
    `<meta property="og:description" content="${escapeAttr(description)}" ${owned}>`,
    `<meta property="og:type" content="website" ${owned}>`,
    `<meta property="og:image" content="${escapeAttr(image)}" ${owned}>`,
    `<meta property="og:site_name" content="Grapefruit Cleaning Co." ${owned}>`,
    `<meta property="og:locale" content="${spanish ? "es_LA" : "en_US"}" ${owned}>`,
    `<meta name="twitter:card" content="summary_large_image" ${owned}>`,
    `<meta name="twitter:title" content="${escapeAttr(title)}" ${owned}>`,
    `<meta name="twitter:description" content="${escapeAttr(description)}" ${owned}>`,
    `<meta name="twitter:image" content="${escapeAttr(image)}" ${owned}>`,
  ].join("\n    ");
}

/**
 * Inserts the app-identity tags for `url` into an index.html string, just
 * before </head>. Customer routes get the document back untouched, so their
 * install behavior is unchanged.
 */
export function injectWebAppHead(html: string, url: string): string {
  const tags = webAppHeadTags(url);
  if (!tags) return html;
  const closing = html.indexOf("</head>");
  if (closing === -1) return html;
  return `${html.slice(0, closing)}    ${tags}\n  ${html.slice(closing)}`;
}
