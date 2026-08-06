/**
 * Serves the SPA shell with the right app identity already in the HTML.
 *
 * The crew's home-screen app only works if the manifest link and apple-* meta
 * are present in the document iOS receives — it snapshots the head when the
 * user taps "Add to Home Screen" and ignores tags injected later by script.
 * So the same built index.html is served for every route, with the scoped tags
 * spliced in per request. One file, no forked copies to drift apart.
 */
import fs from "fs";
import type { Request, Response } from "express";
import { injectWebAppHead } from "@shared/webAppManifest";

/**
 * The shell varies by path, so it must never be reused across routes from a
 * cache. "no-cache" still allows storage, but forces revalidation every time —
 * which also stops a stale shell lingering after a redeploy.
 */
export const INDEX_CACHE_CONTROL = "no-cache, must-revalidate";

/**
 * Builds the catch-all handler that serves index.html for SPA routes.
 * `loadTemplate` is injected so the response path can be tested without a build.
 */
export function createIndexHtmlHandler(loadTemplate: () => string | null) {
  return function serveIndexHtml(req: Request, res: Response): void {
    const template = loadTemplate();
    if (template === null) {
      res.status(500).type("text/plain").send("Client build is missing");
      return;
    }
    res
      .status(200)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": INDEX_CACHE_CONTROL,
      })
      .send(injectWebAppHead(template, req.originalUrl ?? req.url ?? "/"));
  };
}

/**
 * Reads index.html once and keeps it in memory. The file cannot change while
 * the process lives — a redeploy starts a new one — and re-reading it on every
 * navigation would be pointless I/O.
 */
export function cachedTemplateLoader(indexPath: string): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached === undefined) {
      try {
        cached = fs.readFileSync(indexPath, "utf-8");
      } catch (error) {
        console.error(`[SPA] Could not read ${indexPath}:`, error);
        cached = null;
      }
    }
    return cached;
  };
}
