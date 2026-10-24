import express, { type NextFunction, type Request, type Response } from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { config } from "./config";
import { db } from "./db";
import { loadUser, requireCurrentTerms } from "./auth";
import { HttpError, h } from "./http";
import { logger } from "./logger";
import authRoutes from "./routes/auth";
import orgRoutes from "./routes/orgs";
import eventRoutes from "./routes/events";
import publicRoutes from "./routes/public";
import webhookRoutes from "./routes/webhooks";
import adminRoutes from "./routes/admin";
import apiV1Routes from "./routes/api-v1";

export function createApp() {
  const app = express();
  app.set("trust proxy", /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  app.disable("x-powered-by");

  app.use(
    helmet({
      contentSecurityPolicy: config.isProd
        ? {
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: ["'self'", "data:", "blob:"],
              styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
              fontSrc: ["'self'", "https://fonts.gstatic.com"],
              scriptSrc: ["'self'"],
              connectSrc: ["'self'"],
              formAction: ["'self'"],
              frameAncestors: ["'self'"],
              upgradeInsecureRequests: config.publicUrl.startsWith("https://") ? [] : null,
            },
          }
        : false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  // Webhooks need the raw body — mount before JSON parsing.
  app.use("/api/webhooks", webhookRoutes);

  app.use("/api", express.json({ limit: "5mb" }));

  // CSRF defence for cookie-authenticated calls: browsers can't send JSON cross-site without a CORS preflight,
  // which this server never approves. Reject state-changing requests that aren't JSON.
  app.use("/api", (req, _res, next) => {
    // Cross-site HTML forms can neither send JSON nor set custom headers.
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json") && !req.get("x-requested-with")) {
      return next(new HttpError(415, "Requests must be sent as JSON."));
    }
    next();
  });

  app.get("/api/health", h(async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ status: "ok", database: db.kind });
  }));

  // Public images (logos, covers, candidate photos)
  app.get("/api/files/:id", h(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) throw new HttpError(404, "Not found.");
    const file = await db.one("SELECT mime, data FROM files WHERE id = $1", [req.params.id]);
    if (!file) throw new HttpError(404, "Not found.");
    res.setHeader("Content-Type", file.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data));
  }));

  app.use("/api/v1", apiV1Routes);
  app.use("/api/public", publicRoutes);
  app.use("/api", loadUser);
  app.use("/api", authRoutes);
  app.use("/api", requireCurrentTerms);
  app.use("/api/admin", adminRoutes);
  app.use("/api", orgRoutes);
  app.use("/api/org", eventRoutes);

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "API route not found.")));

  return app;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const anyErr = err as any;
  if (anyErr?.type === "entity.parse.failed") {
    res.status(400).json({ error: "The request body is not valid JSON." });
    return;
  }
  if (anyErr?.type === "entity.too.large") {
    res.status(413).json({ error: "The request is too large." });
    return;
  }
  logger.error(`Unhandled error on ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
}
