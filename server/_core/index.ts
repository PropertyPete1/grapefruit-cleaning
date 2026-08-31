import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { registerStripeWebhook } from "../stripeWebhook";
import { registerSeoRoutes } from "../seoRoutes";
import { registerScheduledRoutes } from "../scheduledRoutes";
import { registerBalanceRoutes } from "../balanceRoutes";
import { registerBrainRoutes } from "../brainRoutes";
import { registerBrainWriteRoutes } from "../brainWriteRoutes";
import { registerMarketingRoutes } from "../marketingRoutes";
import { registerVersionRoutes } from "../versionRoutes";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Stripe webhook needs the raw body — register BEFORE express.json()
  registerStripeWebhook(app);
  // SEO: robots.txt + sitemap.xml
  registerSeoRoutes(app);
  // Deploy verification: which commit is this process running?
  registerVersionRoutes(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Heartbeat cron callbacks (reminder emails)
  registerScheduledRoutes(app);
  // Customer-facing balance payment links (/api/pay/balance/:token)
  registerBalanceRoutes(app);
  // Token-authenticated REST surface for the brain (/api/brain/*): reads
  // first (their guard owns the prefix's method policing), then the five
  // write routes behind their own separate token.
  registerBrainRoutes(app);
  registerBrainWriteRoutes(app);
  // One-click unsubscribe from re-booking nudges (/unsubscribe/:token).
  // Must precede the SPA catch-all so the branded confirmation page wins.
  registerMarketingRoutes(app);
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
