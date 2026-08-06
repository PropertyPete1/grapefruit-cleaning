/**
 * Applies the route-scoped web-app manifest to the document head.
 *
 * Runs at load and on every route change, so saving /admin or /staff to a phone
 * home screen installs that dashboard as its own standalone app instead of the
 * customer homepage. On customer routes the head is restored to exactly what it
 * was, leaving the marketing site's install behavior untouched.
 */
import { WEBAPP_TAG_ATTR, webAppTargetForPath, type WebAppTarget } from "@shared/webAppManifest";

/** Marks the tags this module owns, so we never remove someone else's. */
const OWNED = WEBAPP_TAG_ATTR;

/**
 * Whatever the document declared before we touched it. Captured once, so
 * returning to a customer route restores the original rather than guessing.
 */
let originalManifestHref: string | null | undefined;

function ownedMeta(doc: Document, name: string, content: string): void {
  let el = doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = doc.createElement("meta");
    el.setAttribute("name", name);
    el.setAttribute(OWNED, "true");
    doc.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function removeOwned(doc: Document, selector: string): void {
  doc.querySelectorAll(`${selector}[${OWNED}="true"]`).forEach(el => el.remove());
}

/** Swaps manifest, apple-touch-icon and iOS meta to match `pathname`. */
export function applyWebAppTarget(pathname: string, doc: Document = document): WebAppTarget {
  const target = webAppTargetForPath(pathname);

  let manifestLink = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (originalManifestHref === undefined) {
    // Tags the server spliced in for this route are ours, not the document's
    // own — treating them as "original" would restore the admin manifest when
    // navigating back to a customer page.
    const serverRendered = manifestLink?.getAttribute(OWNED) === "true";
    originalManifestHref = serverRendered ? null : (manifestLink?.getAttribute("href") ?? null);
  }

  if (target.manifestHref) {
    if (!manifestLink) {
      manifestLink = doc.createElement("link");
      manifestLink.setAttribute("rel", "manifest");
      manifestLink.setAttribute(OWNED, "true");
      doc.head.appendChild(manifestLink);
    }
    manifestLink.setAttribute("href", target.manifestHref);

    // iOS ignores the manifest for the home-screen icon and title, and (before
    // 17.4) for standalone display — these meta tags are what make the saved
    // admin app open chrome-less at /admin.
    let icon = doc.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (!icon) {
      icon = doc.createElement("link");
      icon.setAttribute("rel", "apple-touch-icon");
      icon.setAttribute("sizes", "180x180");
      icon.setAttribute(OWNED, "true");
      doc.head.appendChild(icon);
    }
    icon.setAttribute("href", target.appleTouchIcon!);

    ownedMeta(doc, "apple-mobile-web-app-capable", "yes");
    ownedMeta(doc, "mobile-web-app-capable", "yes");
    ownedMeta(doc, "apple-mobile-web-app-status-bar-style", "default");
    ownedMeta(doc, "apple-mobile-web-app-title", target.appleTitle!);
    ownedMeta(doc, "theme-color", target.themeColor!);
  } else {
    // Back on the customer site: restore, or remove what we added.
    if (manifestLink) {
      if (originalManifestHref) manifestLink.setAttribute("href", originalManifestHref);
      else if (manifestLink.getAttribute(OWNED) === "true") manifestLink.remove();
    }
    removeOwned(doc, "link[rel='apple-touch-icon']");
    removeOwned(doc, "meta[name='apple-mobile-web-app-capable']");
    removeOwned(doc, "meta[name='mobile-web-app-capable']");
    removeOwned(doc, "meta[name='apple-mobile-web-app-status-bar-style']");
    removeOwned(doc, "meta[name='apple-mobile-web-app-title']");
    removeOwned(doc, "meta[name='theme-color']");
  }

  return target;
}

/** Test-only: forgets the captured original manifest href. */
export function __resetWebAppManifestCapture(): void {
  originalManifestHref = undefined;
}
