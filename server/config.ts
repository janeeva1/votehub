import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const isProd = process.env.NODE_ENV === "production";

/**
 * APP_SECRET signs voter tokens and encrypts payment-provider keys at rest.
 * In development a secret is generated once and stored in ./data so restarts keep working.
 * In production it MUST be provided.
 */
function resolveSecret(dataDir: string): string {
  const fromEnv = process.env.APP_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (isProd) {
    throw new Error("APP_SECRET must be set (at least 32 characters) when NODE_ENV=production.");
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, ".dev-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const generated = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port <= 0) throw new Error(`Invalid PORT: ${process.env.PORT}`);

export const config = {
  isProd,
  port,
  appName: process.env.APP_NAME?.trim() || "VoteHub",
  /** Public URL used in emails and payment redirects, e.g. https://vote.example.com */
  publicUrl: (process.env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, ""),
  databaseUrl: process.env.DATABASE_URL?.trim() || "",
  dataDir,
  secret: resolveSecret(dataDir),
  /** Comma-separated list of emails that become platform super-admins when they sign up. */
  platformAdmins: (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
  smtp: {
    host: process.env.SMTP_HOST?.trim() || "",
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER?.trim() || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM?.trim() || "",
  },
  /** Allow the simulated "test" payment provider (always on in development). */
  allowTestPayments: !isProd || process.env.ALLOW_TEST_PAYMENTS === "true",
  trustProxy: process.env.TRUST_PROXY ?? (isProd ? "1" : "loopback"),
};
