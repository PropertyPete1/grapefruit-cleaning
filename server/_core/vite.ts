import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";
import { injectWebAppHead } from "@shared/webAppManifest";
import { cachedTemplateLoader, createIndexHtmlHandler, INDEX_CACHE_CONTROL } from "../webAppHead";

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      // Same app-identity splice as production, so dev matches what ships.
      res
        .status(200)
        .set({ "Content-Type": "text/html", "Cache-Control": INDEX_CACHE_CONTROL })
        .end(injectWebAppHead(page, url));
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  // index: false so "/" falls through to the handler below — every HTML
  // response must go through one place that splices in the route's app-identity
  // tags and sets the no-cache headers.
  app.use(express.static(distPath, { index: false }));

  // Hashed build assets that no longer exist (e.g. a browser holding a stale
  // index.html after a redeploy) must 404 — never fall through to index.html.
  // Returning HTML for a .js request causes "Uncaught SyntaxError: Unexpected
  // token '<'" and a broken page instead of a clean, recoverable load error.
  app.use("/assets", (_req, res) => {
    res.status(404).end();
  });

  // fall through to index.html if the file doesn't exist
  app.use("*", createIndexHtmlHandler(cachedTemplateLoader(path.resolve(distPath, "index.html"))));
}
