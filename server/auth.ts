import type { Request, RequestHandler, Response } from "express";
import { config } from "./config";
import { db } from "./db";
import { forbidden, h, HttpError } from "./http";
import { randomToken, sha256 } from "./security";
import type { Role } from "../shared/model";

export const SESSION_COOKIE = "vh_session";
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  termsVersion: string | null;
}
declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
      org?: { id: string; name: string; slug: string; plan: string; role: Role; suspended: boolean };
    }
  }
}

export async function createSession(res: Response, userId: string, userAgent?: string) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.query("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)", [
    sha256(token),
    userId,
    expires,
    userAgent?.slice(0, 300) ?? null,
  ]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProd && config.publicUrl.startsWith("https://"),
    expires,
    path: "/",
  });
}

export async function destroySession(req: Request, res: Response) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

/** Loads the signed-in user (if any). Never rejects. */
export const loadUser: RequestHandler = h(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) {
    const row = await db.one(
      `SELECT u.id, u.email, u.name, u.is_platform_admin, u.terms_version
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now() AND u.disabled = false`,
      [sha256(token)],
    );
    if (row) req.user = { id: row.id, email: row.email, name: row.name, isPlatformAdmin: row.is_platform_admin, termsVersion: row.terms_version ?? null };
  }
  next();
});

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "Please sign in to continue."));
  next();
};

/**
 * Signed-in users must have accepted the current Terms of Service and Privacy Policy before they change anything.
 * (Reading is allowed so the app can show the acceptance screen.)
 */
export const requireCurrentTerms: RequestHandler = h(async (req, _res, next) => {
  if (!req.user || req.method === "GET" || req.method === "HEAD") return next();
  const { getLegal } = await import("./services/legal");
  const legal = await getLegal();
  if (req.user.termsVersion !== legal.termsVersion) {
    throw new HttpError(428, "Please review and accept the updated Terms of Service and Privacy Policy to continue.", "TERMS_REQUIRED");
  }
  next();
});

export const requirePlatformAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, "Please sign in to continue."));
  if (!req.user.isPlatformAdmin) return next(forbidden("Platform administrators only."));
  next();
};

/**
 * Resolves the active organization from the X-Org-Id header (or the user's first org)
 * and checks the user is a member of it.
 */
export const requireOrg: RequestHandler = h(async (req, _res, next) => {
  if (!req.user) throw new HttpError(401, "Please sign in to continue.");
  const requested = req.get("x-org-id");
  const rows = await db.query(
    `SELECT o.id, o.name, o.slug, o.plan, o.plan_expires_at, o.suspended, m.role
       FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 ${requested ? "AND o.id::text = $2" : ""}
      ORDER BY m.created_at LIMIT 1`,
    requested ? [req.user.id, requested] : [req.user.id],
  );
  const row = rows[0];
  if (!row) {
    throw requested
      ? forbidden("You are not a member of that organization.")
      : new HttpError(409, "Create an organization to continue.", "NO_ORG");
  }
  const expired = row.plan !== "free" && row.plan_expires_at && new Date(row.plan_expires_at) < new Date();
  req.org = { id: row.id, name: row.name, slug: row.slug, plan: expired ? "free" : row.plan, role: row.role, suspended: row.suspended };
  next();
});

const rank: Record<Role, number> = { viewer: 0, officer: 1, admin: 2, owner: 3 };
/** Require at least the given role in the active organization. */
export const requireRole =
  (min: Role): RequestHandler =>
  (req, _res, next) => {
    if (!req.org) return next(new HttpError(500, "Organization context missing."));
    if (rank[req.org.role] < rank[min]) return next(forbidden(`This action needs the ${min} role or higher.`));
    if (req.org.suspended && min !== "viewer") return next(forbidden("This organization is suspended. Contact support."));
    next();
  };
