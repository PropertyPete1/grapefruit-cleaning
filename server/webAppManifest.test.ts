/**
 * Route → web-app manifest mapping. Pure function, so the rule that decides
 * which home-screen app a URL belongs to is pinned down without a browser.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { appScopeForPath, webAppTargetForPath } from "@shared/webAppManifest";

describe("appScopeForPath", () => {
  it("maps the admin dashboard and everything under it", () => {
    expect(appScopeForPath("/admin")).toBe("admin");
    expect(appScopeForPath("/admin/")).toBe("admin");
    expect(appScopeForPath("/admin/invoices")).toBe("admin");
    expect(appScopeForPath("/admin/services/pricing")).toBe("admin");
  });

  it("maps the staff dashboard and everything under it", () => {
    expect(appScopeForPath("/staff")).toBe("staff");
    expect(appScopeForPath("/staff/")).toBe("staff");
    expect(appScopeForPath("/staff/join/abc123")).toBe("staff");
  });

  it("leaves every customer route on the customer site", () => {
    for (const path of ["/", "/en", "/en/pricing", "/es/precios", "/en/services/deep-cleaning", "/home"]) {
      expect(appScopeForPath(path)).toBe("customer");
    }
  });

  it("does not match paths that merely start with the same letters", () => {
    expect(appScopeForPath("/administrator")).toBe("customer");
    expect(appScopeForPath("/admin-tools")).toBe("customer");
    expect(appScopeForPath("/staffing")).toBe("customer");
    expect(appScopeForPath("/en/staff-picks")).toBe("customer");
  });

  it("does not match the segment anywhere but the start", () => {
    expect(appScopeForPath("/en/admin")).toBe("customer");
    expect(appScopeForPath("/blog/staff")).toBe("customer");
  });

  it("ignores query strings and hashes", () => {
    expect(appScopeForPath("/admin?tab=invoices")).toBe("admin");
    expect(appScopeForPath("/staff#today")).toBe("staff");
    expect(appScopeForPath("/admin/invoices?id=5#top")).toBe("admin");
  });

  it("is case-insensitive", () => {
    expect(appScopeForPath("/Admin")).toBe("admin");
    expect(appScopeForPath("/STAFF/join/x")).toBe("staff");
  });

  it("falls back to the customer site for junk input", () => {
    expect(appScopeForPath("")).toBe("customer");
    expect(appScopeForPath(undefined as unknown as string)).toBe("customer");
    expect(appScopeForPath("not-a-path")).toBe("customer");
  });
});

describe("webAppTargetForPath", () => {
  it("points admin routes at the admin manifest, icon and title", () => {
    expect(webAppTargetForPath("/admin/invoices")).toEqual({
      scope: "admin",
      manifestHref: "/manifest.admin.webmanifest",
      appleTouchIcon: "/icons/admin-180.png",
      appleTitle: "Grapefruit",
      themeColor: "#F26D5B",
    });
  });

  it("points staff routes at the staff manifest, icon and title", () => {
    expect(webAppTargetForPath("/staff")).toEqual({
      scope: "staff",
      manifestHref: "/manifest.staff.webmanifest",
      appleTouchIcon: "/icons/staff-180.png",
      appleTitle: "GF Staff",
      themeColor: "#2E6E5B",
    });
  });

  it("points customer routes at the Grapefruit public manifest and brand icon", () => {
    expect(webAppTargetForPath("/en/pricing")).toEqual({
      scope: "customer",
      manifestHref: "/manifest.webmanifest",
      appleTouchIcon: "/manus-storage/favicon-256_0edfb26b.png",
      appleTitle: "Grapefruit Cleaning",
      themeColor: "#F26D5B",
    });
  });

  it("gives the two dashboards different icons and titles", () => {
    const admin = webAppTargetForPath("/admin");
    const staff = webAppTargetForPath("/staff");
    expect(admin.manifestHref).not.toBe(staff.manifestHref);
    expect(admin.appleTouchIcon).not.toBe(staff.appleTouchIcon);
    expect(admin.appleTitle).not.toBe(staff.appleTitle);
    expect(admin.themeColor).not.toBe(staff.themeColor);
  });
});

describe("the shipped manifests", () => {
  const load = (name: string) =>
    JSON.parse(readFileSync(new URL(`../client/public/${name}`, import.meta.url), "utf-8"));

  it("is the one crew app: standalone, started and scoped at /admin", () => {
    const manifest = load("manifest.admin.webmanifest");
    expect(manifest).toMatchObject({
      name: "Grapefruit Team",
      short_name: "Grapefruit",
      start_url: "/admin",
      scope: "/admin",
      display: "standalone",
    });
  });

  it("ships a public Grapefruit manifest using the production-storage brand icon", () => {
    const manifest = load("manifest.webmanifest");
    expect(manifest).toMatchObject({
      name: "Grapefruit Cleaning Co.",
      short_name: "Grapefruit",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.icons).toEqual([
      expect.objectContaining({
        src: "/manus-storage/favicon-256_0edfb26b.png",
        sizes: "256x256",
      }),
    ]);
  });

  // Kept working for anyone who already installed it; staff opening the crew
  // app are redirected to /staff anyway, so the two behave identically.
  it("still launches the staff app standalone at /staff and keeps it in scope", () => {
    const manifest = load("manifest.staff.webmanifest");
    expect(manifest).toMatchObject({
      name: "Grapefruit Staff",
      short_name: "GF Staff",
      start_url: "/staff",
      scope: "/staff",
      display: "standalone",
    });
  });

  it("ships the icon sizes installers need, including a maskable one", () => {
    for (const name of ["manifest.admin.webmanifest", "manifest.staff.webmanifest"]) {
      const icons = load(name).icons as { sizes: string; purpose: string; src: string }[];
      expect(icons.map(i => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
      expect(icons.some(i => i.purpose === "maskable")).toBe(true);
      expect(icons.every(i => i.src.startsWith("/icons/"))).toBe(true);
    }
  });

  it("references icon files that actually exist", () => {
    for (const name of ["manifest.admin.webmanifest", "manifest.staff.webmanifest"]) {
      for (const icon of load(name).icons as { src: string }[]) {
        const file = new URL(`../client/public${icon.src}`, import.meta.url);
        expect(readFileSync(file).subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );
      }
    }
  });

  it("ships the apple-touch-icon each scope points at", () => {
    for (const scope of ["/admin", "/staff"]) {
      const { appleTouchIcon } = webAppTargetForPath(scope);
      const file = new URL(`../client/public${appleTouchIcon}`, import.meta.url);
      expect(readFileSync(file).length).toBeGreaterThan(0);
    }
  });
});
