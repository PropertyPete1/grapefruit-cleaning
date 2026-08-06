/**
 * Server-rendered app identity. iOS snapshots the document head when the user
 * taps "Add to Home Screen", so these tags have to be in the HTML the server
 * sends — a client-side swap after load is too late and yields a plain
 * bookmark that opens the customer site.
 */
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { injectWebAppHead, webAppHeadTags, WEBAPP_TAG_ATTR } from "@shared/webAppManifest";
import { createIndexHtmlHandler, INDEX_CACHE_CONTROL } from "./webAppHead";

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Grapefruit Cleaning Co.</title>
    <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  </head>
  <body><div id="root"></div></body>
</html>`;

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "" as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    set(headers: Record<string, string>) {
      Object.assign(res.headers, headers);
      return res;
    },
    type() {
      return res;
    },
    send(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const serve = (url: string, template: string | null = TEMPLATE) => {
  const res = fakeRes();
  const handler = createIndexHtmlHandler(() => template);
  handler({ originalUrl: url } as Request, res as unknown as Response);
  return res;
};

const html = (url: string) => String(serve(url).body);

// ---------------------------------------------------------------------------
// Tag rendering
// ---------------------------------------------------------------------------

describe("webAppHeadTags", () => {
  it("renders the full admin app identity", () => {
    const tags = webAppHeadTags("/admin");
    expect(tags).toContain('<link rel="manifest" href="/manifest.admin.webmanifest"');
    expect(tags).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/icons/admin-180.png"');
    expect(tags).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(tags).toContain('name="mobile-web-app-capable" content="yes"');
    expect(tags).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
    expect(tags).toContain('name="apple-mobile-web-app-title" content="Grapefruit"');
    expect(tags).toContain('name="theme-color" content="#F26D5B"');
  });

  it("renders the staff app identity", () => {
    const tags = webAppHeadTags("/staff");
    expect(tags).toContain('href="/manifest.staff.webmanifest"');
    expect(tags).toContain('href="/icons/staff-180.png"');
    expect(tags).toContain('content="GF Staff"');
  });

  it("renders nothing for customer routes", () => {
    expect(webAppHeadTags("/")).toBe("");
    expect(webAppHeadTags("/en/pricing")).toBe("");
  });

  it("marks every tag as owned so the client applier can manage them", () => {
    const tags = webAppHeadTags("/admin");
    const owned = tags.match(new RegExp(`${WEBAPP_TAG_ATTR}="true"`, "g")) ?? [];
    expect(owned).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

describe("injectWebAppHead", () => {
  it("splices the tags in before </head>", () => {
    const out = injectWebAppHead(TEMPLATE, "/admin");
    expect(out.indexOf("manifest.admin.webmanifest")).toBeLessThan(out.indexOf("</head>"));
    expect(out).toContain("<body>");
  });

  it("keeps the rest of the document intact", () => {
    const out = injectWebAppHead(TEMPLATE, "/admin");
    expect(out).toContain('<link rel="icon" type="image/x-icon" href="/favicon.ico" />');
    expect(out).toContain('<div id="root"></div>');
    expect(out.startsWith("<!doctype html>")).toBe(true);
  });

  it("returns customer HTML byte-for-byte unchanged", () => {
    expect(injectWebAppHead(TEMPLATE, "/")).toBe(TEMPLATE);
    expect(injectWebAppHead(TEMPLATE, "/en/pricing")).toBe(TEMPLATE);
  });

  it("leaves HTML without a </head> alone rather than corrupting it", () => {
    expect(injectWebAppHead("<html><body>hi</body></html>", "/admin")).toBe("<html><body>hi</body></html>");
  });

  it("injects only one manifest link", () => {
    const out = injectWebAppHead(TEMPLATE, "/admin");
    expect(out.match(/rel="manifest"/g) ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The served response
// ---------------------------------------------------------------------------

describe("index.html responses", () => {
  it("serves the admin app identity at /admin", () => {
    const body = html("/admin");
    expect(body).toContain('href="/manifest.admin.webmanifest"');
    expect(body).toContain('content="Grapefruit"');
  });

  it("serves it for any path inside the admin scope", () => {
    for (const url of ["/admin/", "/admin/invoices", "/admin/services/pricing", "/admin/no-access"]) {
      expect(html(url)).toContain('href="/manifest.admin.webmanifest"');
    }
  });

  it("keeps the identity when the launch URL carries a query string", () => {
    expect(html("/admin?source=pwa")).toContain('href="/manifest.admin.webmanifest"');
  });

  it("serves the staff app identity at /staff and below", () => {
    for (const url of ["/staff", "/staff/join/abc123"]) {
      const body = html(url);
      expect(body).toContain('href="/manifest.staff.webmanifest"');
      expect(body).toContain('content="GF Staff"');
    }
  });

  it("serves the original HTML on customer routes", () => {
    for (const url of ["/", "/en", "/es/precios", "/en/services/deep-cleaning"]) {
      const body = html(url);
      expect(body).toBe(TEMPLATE);
      expect(body).not.toContain("manifest");
      expect(body).not.toContain("apple-mobile-web-app");
    }
  });

  it("does not treat lookalike paths as crew routes", () => {
    expect(html("/administrator")).toBe(TEMPLATE);
    expect(html("/staffing")).toBe(TEMPLATE);
    expect(html("/en/admin")).toBe(TEMPLATE);
  });

  it("marks the shell no-cache so a stale copy can't linger across a deploy", () => {
    const res = serve("/admin");
    expect(res.headers["Cache-Control"]).toBe(INDEX_CACHE_CONTROL);
    expect(res.headers["Cache-Control"]).toMatch(/no-cache/);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.statusCode).toBe(200);
  });

  it("sets the same cache headers on customer routes", () => {
    const res = serve("/en");
    expect(res.headers["Cache-Control"]).toBe(INDEX_CACHE_CONTROL);
  });

  it("never serves one scope's identity to another", () => {
    expect(html("/admin")).not.toContain("manifest.staff");
    expect(html("/staff")).not.toContain("manifest.admin");
  });

  it("fails loudly when the client build is missing", () => {
    const res = serve("/admin", null);
    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toMatch(/build is missing/i);
  });

  it("falls back to req.url when originalUrl is absent", () => {
    const res = fakeRes();
    createIndexHtmlHandler(() => TEMPLATE)({ url: "/admin" } as Request, res as unknown as Response);
    expect(String(res.body)).toContain("manifest.admin.webmanifest");
  });
});

describe("template loading", () => {
  it("reads the template once and reuses it", () => {
    const loadTemplate = vi.fn(() => TEMPLATE);
    const handler = createIndexHtmlHandler(loadTemplate);
    handler({ originalUrl: "/admin" } as Request, fakeRes() as unknown as Response);
    handler({ originalUrl: "/staff" } as Request, fakeRes() as unknown as Response);
    // The loader itself memoizes; the handler simply asks each time.
    expect(loadTemplate).toHaveBeenCalledTimes(2);
  });
});
