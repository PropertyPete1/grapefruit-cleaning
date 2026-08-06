/**
 * Public-origin resolution.
 *
 * Found in production: robots.txt advertised its sitemap at
 * http://<internal-cloud-run-host>/sitemap.xml and every <loc> in sitemap.xml
 * used that host too, because the origin was built from req.protocol +
 * req.headers.host and the app sits behind a proxy. The same expression backed
 * the Stripe return URLs on emailed balance links, where the browser sends no
 * Origin header either.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicOrigin } from "./publicOrigin";

afterEach(() => {
  vi.unstubAllEnvs();
});

const req = (headers: Record<string, unknown>, protocol = "http") => ({ protocol, headers });

describe("publicOrigin", () => {
  it("prefers PUBLIC_BASE_URL over anything on the request", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com");
    expect(publicOrigin(req({ host: "internal.a.run.app", origin: "https://other.example" }))).toBe(
      "https://grapefruitclean.com"
    );
  });

  it("trims a trailing slash off PUBLIC_BASE_URL so links never double up", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://grapefruitclean.com/");
    expect(publicOrigin(req({}))).toBe("https://grapefruitclean.com");
  });

  it("uses the forwarded host and proto the edge reports", () => {
    expect(
      publicOrigin(
        req({
          host: "zjbssnaukc-ilffhipexa-ue.a.run.app",
          "x-forwarded-host": "grapeclean-skvabkkr.manus.space",
          "x-forwarded-proto": "https",
        })
      )
    ).toBe("https://grapeclean-skvabkkr.manus.space");
  });

  it("assumes https when a forwarded host arrives without a proto", () => {
    expect(publicOrigin(req({ "x-forwarded-host": "grapeclean-skvabkkr.manus.space" }))).toBe(
      "https://grapeclean-skvabkkr.manus.space"
    );
  });

  it("takes the client-facing entry from a comma-joined proxy chain", () => {
    expect(
      publicOrigin(
        req({
          "x-forwarded-host": "grapeclean-skvabkkr.manus.space, inner.a.run.app",
          "x-forwarded-proto": "https, http",
        })
      )
    ).toBe("https://grapeclean-skvabkkr.manus.space");
  });

  it("handles headers that arrive as arrays", () => {
    expect(
      publicOrigin(req({ "x-forwarded-host": ["grapeclean-skvabkkr.manus.space"], "x-forwarded-proto": ["https"] }))
    ).toBe("https://grapeclean-skvabkkr.manus.space");
  });

  it("falls back to the Origin header when there are no forwarded headers", () => {
    expect(publicOrigin(req({ origin: "https://grapeclean-skvabkkr.manus.space", host: "internal" }))).toBe(
      "https://grapeclean-skvabkkr.manus.space"
    );
  });

  it("falls back to protocol + Host last, which is what local dev needs", () => {
    expect(publicOrigin(req({ host: "localhost:3000" }, "http"))).toBe("http://localhost:3000");
  });

  it("still upgrades the scheme from x-forwarded-proto when only Host is present", () => {
    expect(publicOrigin(req({ host: "grapeclean-skvabkkr.manus.space", "x-forwarded-proto": "https" }, "http"))).toBe(
      "https://grapeclean-skvabkkr.manus.space"
    );
  });

  it("returns an empty string for an internal caller with no request and no config", () => {
    expect(publicOrigin(undefined)).toBe("");
    expect(publicOrigin({})).toBe("");
  });

  it("ignores empty header values instead of building a scheme-only origin", () => {
    expect(publicOrigin(req({ "x-forwarded-host": "", origin: "", host: "" }))).toBe("");
  });

  it("never returns the raw internal host once the edge reports the real one", () => {
    const origin = publicOrigin(
      req({
        host: "zjbssnaukc-ilffhipexa-ue.a.run.app",
        "x-forwarded-host": "grapeclean-skvabkkr.manus.space",
        "x-forwarded-proto": "https",
      })
    );
    expect(origin).not.toContain("a.run.app");
    expect(origin.startsWith("https://")).toBe(true);
  });
});
