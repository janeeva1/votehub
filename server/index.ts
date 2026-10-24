import { injectTheme } from "./services/appearance";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config";
import { initDatabase, db } from "./db";
import { createApp, errorHandler } from "./app";
import { logger } from "./logger";
import { startScheduler } from "./services/scheduler";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The embeddable widget (/embed/...) may be shown inside other websites; everything else may not. */
function allowFraming(path: string, res: express.Response) {
  if (!path.startsWith("/embed/")) return;
  res.removeHeader("X-Frame-Options");
  const csp = res.getHeader("Content-Security-Policy");
  if (csp) res.setHeader("Content-Security-Policy", String(csp).replace(/frame-ancestors [^;]*/, "frame-ancestors *"));
}


async function main() {
  await initDatabase();
  const app = createApp();

  if (config.isProd) {
    // Built frontend lives next to the bundled server: dist/public
    const publicDir = [path.join(here, "public"), path.resolve("dist/public")].find((p) => fs.existsSync(path.join(p, "index.html")));
    if (!publicDir) throw new Error("Frontend build not found. Run `npm run build` first.");
    app.use(express.static(publicDir, { index: false, maxAge: "1h", setHeaders: (res, file) => { if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); } }));
    const indexHtml = fs.readFileSync(path.join(publicDir, "index.html"), "utf8").replaceAll("%APP_NAME%", config.appName);
    app.get(/^(?!\/api\/).*/, (req, res) => {
      allowFraming(req.path, res);
      res.setHeader("Cache-Control", "no-cache");
      void injectTheme(indexHtml).then((html) => res.type("html").send(html), () => res.type("html").send(indexHtml));
    });
  } else {
    // Development: Vite runs inside this same process (one command, one port, hot reload).
    const { createServer } = await import("vite");
    const vite = await createServer({ configFile: path.resolve("vite.config.ts"), server: { middlewareMode: true }, appType: "custom" });
    app.use(vite.middlewares);
    app.get(/^(?!\/api\/).*/, async (req, res, next) => {
      allowFraming(req.path, res);
      try {
        const template = fs.readFileSync(path.resolve("web/index.html"), "utf8").replaceAll("%APP_NAME%", config.appName);
        const html = await injectTheme(await vite.transformIndexHtml(req.originalUrl, template));
        res.status(200).type("html").end(html);
      } catch (err) {
        vite.ssrFixStacktrace(err as Error);
        next(err);
      }
    });
  }

  app.use(errorHandler);
  startScheduler();

  const server = app.listen(config.port, () => {
    logger.info(`${config.appName} running → ${config.publicUrl}  (${config.isProd ? "production" : "development"})`);
  });
  const shutdown = async () => {
    logger.info("Shutting down…");
    server.close();
    await db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.LOG_LEVEL === "debug") console.error(err);
  process.exit(1);
});
