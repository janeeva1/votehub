import { getAppearance } from "../services/appearance";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { createSession, destroySession, requireUser } from "../auth";
import { HttpError, h, parse } from "../http";
import { hashPassword, randomToken, sha256, verifyPassword } from "../security";
import { getPlatformConfig } from "../services/platform";
import { mailEnabled, sendMail } from "../services/mailer";
import { audit } from "../services/audit";
import { activePlan } from "../services/limits";
import { getLegal } from "../services/legal";

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many attempts. Please wait a few minutes and try again." } });

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, "Password must be at least 8 characters.").max(200);

async function userPayload(userId: string) {
  const user = await db.one("SELECT id, email, name, is_platform_admin, terms_version, terms_accepted_at FROM users WHERE id = $1", [userId]);
  const legal = await getLegal();
  const orgs = await db.query(
    `SELECT o.id, o.name, o.slug, o.org_type, o.plan, o.plan_expires_at, o.suspended, m.role
       FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 ORDER BY m.created_at`,
    [userId],
  );
  return {
    user: user
      ? { id: user.id, email: user.email, name: user.name, isPlatformAdmin: user.is_platform_admin, termsAccepted: user.terms_version === legal.termsVersion, termsAcceptedAt: user.terms_accepted_at }
      : null,
    organizations: orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      orgType: o.org_type,
      plan: o.plan !== "free" && o.plan_expires_at && new Date(o.plan_expires_at) < new Date() ? "free" : o.plan,
      planExpiresAt: o.plan_expires_at,
      suspended: o.suspended,
      role: o.role,
    })),
  };
}

async function acceptInvite(token: string, userId: string, userEmail: string) {
  const invite = await db.one("SELECT * FROM org_invites WHERE token_hash = $1 AND accepted_at IS NULL", [sha256(token)]);
  if (!invite) throw new HttpError(404, "This invitation is invalid or has already been used.");
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new HttpError(403, `This invitation was sent to ${invite.email}. Sign in with that email to accept it.`);
  }
  const org = await db.one("SELECT plan, plan_expires_at FROM organizations WHERE id = $1", [invite.org_id]);
  const plan = await activePlan(org?.plan ?? "free", org?.plan_expires_at);
  if (plan.maxTeamMembers !== null) {
    const n = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1", [invite.org_id]);
    if ((n?.n ?? 0) >= plan.maxTeamMembers) throw new HttpError(402, "This organization's team is full on its current plan. Ask an admin to upgrade.");
  }
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [invite.org_id, userId, invite.role],
    );
    await q.query("UPDATE org_invites SET accepted_at = now() WHERE id = $1", [invite.id]);
  });
  return invite.org_id as string;
}

router.get("/config", h(async (_req, res) => {
  const p = await getPlatformConfig();
  res.json({
    appName: config.appName,
    allowSignups: p.allowSignups,
    testPayments: config.allowTestPayments,
    mailEnabled: mailEnabled(),
    plans: p.plans,
    passes: p.passes,
    platformCurrency: p.currency,
    legal: await getLegal(),
    appearance: await getAppearance(),
    adsEnabled: true,
  });
}));

router.get("/auth/me", h(async (req, res) => {
  if (!req.user) return res.json({ user: null, organizations: [] });
  res.json(await userPayload(req.user.id));
}));

router.post("/auth/signup", limiter, h(async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(100),
      email,
      password,
      inviteToken: z.string().optional(),
      acceptTerms: z.literal(true, { errorMap: () => ({ message: "Please agree to the Terms of Service and Privacy Policy to create an account." }) }),
    }),
    req.body,
  );
  const legal = await getLegal();
  const platform = await getPlatformConfig();
  if (!platform.allowSignups && !body.inviteToken) throw new HttpError(403, "New sign-ups are currently closed.");
  const exists = await db.one("SELECT id FROM users WHERE email = $1", [body.email]);
  if (exists) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
  const userCount = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM users");
  // The very first account on a fresh install becomes the platform super-admin.
  const isAdmin = config.platformAdmins.includes(body.email) || (userCount?.n ?? 0) === 0;
  const user = await db.one(
    "INSERT INTO users (email, name, password_hash, is_platform_admin, terms_version, terms_accepted_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING id",
    [body.email, body.name, await hashPassword(body.password), isAdmin, legal.termsVersion],
  );
  await createSession(res, user!.id, req.get("user-agent"));
  await audit(req, { action: "user.accepted_terms", actorLabel: body.email, detail: { userId: user!.id, version: legal.termsVersion, ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 200) } });
  if (body.inviteToken) await acceptInvite(body.inviteToken, user!.id, body.email);
  res.status(201).json(await userPayload(user!.id));
}));

router.post("/auth/login", limiter, h(async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(200), inviteToken: z.string().optional() }), req.body);
  const user = await db.one("SELECT id, password_hash, disabled FROM users WHERE email = $1", [body.email]);
  const ok = user ? await verifyPassword(body.password, user.password_hash) : await verifyPassword(body.password, "scrypt$AAAA$AAAA").catch(() => false);
  if (!user || !ok) throw new HttpError(401, "Incorrect email or password.");
  if (user.disabled) throw new HttpError(403, "This account has been disabled.");
  if (config.platformAdmins.includes(body.email)) await db.query("UPDATE users SET is_platform_admin = true WHERE id = $1", [user.id]);
  await createSession(res, user.id, req.get("user-agent"));
  if (body.inviteToken) await acceptInvite(body.inviteToken, user.id, body.email);
  res.json(await userPayload(user.id));
}));

router.post("/auth/accept-terms", requireUser, h(async (req, res) => {
  const { version } = parse(z.object({ version: z.string().max(40) }), req.body);
  const legal = await getLegal();
  if (version !== legal.termsVersion) throw new HttpError(409, "The terms changed while you were reading. Please review the latest version.");
  await db.query("UPDATE users SET terms_version = $1, terms_accepted_at = now() WHERE id = $2", [legal.termsVersion, req.user!.id]);
  await audit(req, { action: "user.accepted_terms", detail: { userId: req.user!.id, version: legal.termsVersion, ip: req.ip, userAgent: req.get("user-agent")?.slice(0, 200) } });
  res.json(await userPayload(req.user!.id));
}));

router.post("/auth/logout", h(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

router.post("/auth/accept-invite", requireUser, h(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const orgId = await acceptInvite(token, req.user!.id, req.user!.email);
  res.json({ orgId, ...(await userPayload(req.user!.id)) });
}));

router.get("/auth/invite/:token", h(async (req, res) => {
  const invite = await db.one(
    `SELECT i.email, i.role, i.accepted_at, o.name AS org_name FROM org_invites i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = $1`,
    [sha256(String(req.params.token))],
  );
  if (!invite || invite.accepted_at) throw new HttpError(404, "This invitation is invalid or has already been used.");
  res.json({ email: invite.email, role: invite.role, organization: invite.org_name });
}));

router.post("/auth/forgot", limiter, h(async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await db.one("SELECT id FROM users WHERE email = $1 AND disabled = false", [body.email]);
  if (user) {
    const token = randomToken();
    await db.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [user.id, sha256(token)]);
    await sendMail(body.email, `Reset your ${config.appName} password`, ["Someone asked to reset the password for this account.", "If it was you, use the link below within one hour. Otherwise you can ignore this email."], {
      label: "Choose a new password",
      url: `${config.publicUrl}/reset-password?token=${token}`,
    });
  }
  res.json({ ok: true, mailEnabled: mailEnabled() });
}));

router.post("/auth/reset", limiter, h(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10), password }), req.body);
  const row = await db.one("SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()", [sha256(body.token)]);
  if (!row) throw new HttpError(400, "This reset link is invalid or has expired.");
  await db.tx(async (q) => {
    await q.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(body.password), row.user_id]);
    await q.query("UPDATE password_resets SET used_at = now() WHERE id = $1", [row.id]);
    await q.query("DELETE FROM sessions WHERE user_id = $1", [row.user_id]);
  });
  res.json({ ok: true });
}));

router.patch("/auth/profile", requireUser, h(async (req, res) => {
  const body = parse(
    z.object({ name: z.string().trim().min(2).max(100).optional(), currentPassword: z.string().optional(), newPassword: password.optional() }),
    req.body,
  );
  if (body.name) await db.query("UPDATE users SET name = $1 WHERE id = $2", [body.name, req.user!.id]);
  if (body.newPassword) {
    const row = await db.one("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
    if (!body.currentPassword || !(await verifyPassword(body.currentPassword, row!.password_hash))) {
      throw new HttpError(400, "Your current password is incorrect.");
    }
    await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(body.newPassword), req.user!.id]);
    await audit(req, { action: "user.password_changed" });
  }
  res.json(await userPayload(req.user!.id));
}));

export default router;
