import { serveAd } from "../services/ads";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { requireOrg, requireRole, requireUser } from "../auth";
import { HttpError, conflict, forbidden, h, notFound, parse } from "../http";
import { encrypt, randomToken, sha256, humanCode } from "../security";
import { audit } from "../services/audit";
import { describeKeys, getPlan, getPlatformConfig, mergeKeys } from "../services/platform";
import { sendMail } from "../services/mailer";
import { getLegal } from "../services/legal";
import { chargeSavedCard, orgMethods, startPayment } from "../services/payments";
import { ANNUAL_MONTHS_CHARGED, GATEWAYS, toMinor } from "../../shared/model";
import { billingReady } from "../services/platform";

const router = Router();

export function slugify(text: string, max = 40) {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max) || "item"
  );
}

router.post("/orgs", requireUser, h(async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(120),
      orgType: z.string().trim().min(2).max(60),
      acceptTerms: z.literal(true, { errorMap: () => ({ message: "Please confirm you're authorized to act for this organization and accept the Organization Terms." }) }),
    }),
    req.body,
  );
  const termsVersion = (await getLegal()).termsVersion;
  const org = await db.tx(async (q) => {
    const created = await q.one(
      "INSERT INTO organizations (name, slug, org_type) VALUES ($1,$2,$3) RETURNING id, name, slug",
      [body.name, `${slugify(body.name)}-${humanCode(4).toLowerCase()}`, body.orgType],
    );
    await q.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1,$2,'owner')", [created!.id, req.user!.id]);
    await q.query(
      `INSERT INTO audit_log (org_id, actor_user_id, actor_label, action, detail) VALUES ($1,$2,$3,'org.created',$4)`,
      [created!.id, req.user!.id, req.user!.email, JSON.stringify({ name: body.name, acceptedOrganizationTerms: termsVersion, ip: req.ip })],
    );
    return created!;
  });
  res.status(201).json(org);
}));

const org = Router();
org.use(requireUser, requireOrg);

org.get("/", h(async (req, res) => {
  const row = await db.one("SELECT * FROM organizations WHERE id = $1", [req.org!.id]);
  const plan = await getPlan(req.org!.plan);
  res.json({
    id: row!.id,
    name: row!.name,
    slug: row!.slug,
    orgType: row!.org_type,
    plan,
    planExpiresAt: row!.plan_expires_at,
    suspended: row!.suspended,
    role: req.org!.role,
    branding: row!.branding ?? {},
    settings: row!.settings ?? {},
    paymentKeys: ["owner", "admin"].includes(req.org!.role) ? describeKeys(row!.payment_config) : null,
    webhook: ["owner", "admin"].includes(req.org!.role) ? { url: row!.settings?.webhook?.url ?? "", hasSecret: Boolean(row!.settings?.webhook?.secretEnc) } : null,
    webhookUrls: Object.fromEntries(GATEWAYS.map((p) => [p, `${config.publicUrl}/api/webhooks/${p}?org=${row!.id}`])),
    paymentMethods: ["owner", "admin"].includes(req.org!.role) ? await orgMethods(row!.id) : null,
  });
}));

org.patch("/", requireRole("admin"), h(async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(2).max(120).optional(),
      orgType: z.string().trim().min(2).max(60).optional(),
      branding: z
        .object({
          primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
          logoFileId: z.string().uuid().nullable().optional(),
          website: z.string().url().max(200).or(z.literal("")).optional(),
          supportEmail: z.string().email().max(200).or(z.literal("")).optional(),
        })
        .optional(),
      defaultCurrency: z.string().length(3).optional(),
      /** { paystack: { enabled, secretKey, … }, monnify: {...}, manual: [{ id, label, instructions, enabled }] } */
      paymentKeys: z
        .object({
          ...Object.fromEntries(GATEWAYS.map((g) => [g, z.record(z.union([z.string().max(500), z.boolean()])).nullable().optional()])),
          manual: z.array(z.object({ id: z.string().max(40).optional(), label: z.string().max(60), instructions: z.string().max(1500), enabled: z.boolean().optional() })).max(6).optional(),
        })
        .optional(),
      /** Outgoing webhook: url + secret (empty secret keeps the existing one; url "" removes it). */
      webhook: z.object({ url: z.string().url().startsWith("https://", "Webhook URLs must use https://").or(z.literal("")), secret: z.string().max(200).optional() }).optional(),
    }),
    req.body,
  );
  if (body.paymentKeys && req.org!.role !== "owner" && req.org!.role !== "admin") throw forbidden();
  const current = await db.one("SELECT * FROM organizations WHERE id = $1", [req.org!.id]);
  const branding = { ...(current!.branding ?? {}), ...(body.branding ?? {}) };
  const settings: Record<string, any> = { ...(current!.settings ?? {}), ...(body.defaultCurrency ? { defaultCurrency: body.defaultCurrency } : {}) };
  if (body.webhook) {
    if (!["owner", "admin"].includes(req.org!.role)) throw forbidden();
    if (!body.webhook.url) delete settings.webhook;
    else {
      const prev = settings.webhook ?? {};
      const secretEnc = body.webhook.secret?.trim() ? encrypt(body.webhook.secret.trim()) : prev.secretEnc;
      if (!secretEnc) throw new HttpError(400, "Enter a signing secret for the webhook.");
      settings.webhook = { url: body.webhook.url, secretEnc };
    }
  }
  const paymentConfig = body.paymentKeys ? mergeKeys(current!.payment_config, body.paymentKeys) : current!.payment_config;
  await db.query(
    "UPDATE organizations SET name = $1, org_type = $2, branding = $3, settings = $4, payment_config = $5 WHERE id = $6",
    [body.name ?? current!.name, body.orgType ?? current!.org_type, JSON.stringify(branding), JSON.stringify(settings), JSON.stringify(paymentConfig), req.org!.id],
  );
  await audit(req, { orgId: req.org!.id, action: body.paymentKeys ? "org.payment_keys_updated" : "org.updated", detail: { fields: Object.keys(body) } });
  res.json({ ok: true });
}));

// Owners can permanently delete their organization and all its data.
org.delete("/", requireRole("owner"), h(async (req, res) => {
  const { confirm } = parse(z.object({ confirm: z.string() }), req.body ?? {});
  if (confirm.trim() !== req.org!.name) throw new HttpError(400, "Type the organization name exactly to confirm.");
  await db.query("DELETE FROM organizations WHERE id = $1", [req.org!.id]);
  await audit(req, { action: "org.deleted", detail: { name: req.org!.name, id: req.org!.id } });
  res.json({ ok: true });
}));

// ---- Dashboard ----
org.get("/dashboard", h(async (req, res) => {
  const id = req.org!.id;
  const [events, votes, revenue, recent] = await Promise.all([
    db.query(`SELECT status, count(*)::int AS n FROM events WHERE org_id = $1 GROUP BY status`, [id]),
    db.one(`SELECT COALESCE(SUM(v.quantity),0)::float8 AS total FROM votes v JOIN events e ON e.id = v.event_id WHERE e.org_id = $1`, [id]),
    db.query(`SELECT currency, SUM(amount_minor)::float8 AS total, SUM(platform_fee_minor)::float8 AS fees, count(*)::int AS n FROM payments WHERE org_id = $1 AND kind = 'votes' AND status = 'success' GROUP BY currency`, [id]),
    db.query(`SELECT a.action, a.actor_label, a.detail, a.created_at, e.title AS event_title FROM audit_log a LEFT JOIN events e ON e.id = a.event_id WHERE a.org_id = $1 ORDER BY a.created_at DESC LIMIT 8`, [id]),
  ]);
  const byStatus = Object.fromEntries(events.map((e) => [e.status, e.n]));
  const ballots = await db.one(`SELECT count(*)::int AS n FROM ballots b JOIN events e ON e.id = b.event_id WHERE e.org_id = $1`, [id]);
  res.json({ eventsByStatus: byStatus, totalVotes: votes?.total ?? 0, ballots: ballots?.n ?? 0, revenue, recent });
}));

org.get("/audit", h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const eventId = typeof req.query.eventId === "string" && /^[0-9a-f-]{36}$/.test(req.query.eventId) ? req.query.eventId : null;
  const rows = await db.query(
    `SELECT a.id, a.action, a.actor_label, a.detail, a.ip, a.created_at, e.title AS event_title
       FROM audit_log a LEFT JOIN events e ON e.id = a.event_id
      WHERE a.org_id = $1 ${eventId ? "AND a.event_id = $3" : ""} ORDER BY a.created_at DESC LIMIT $2`,
    eventId ? [req.org!.id, limit, eventId] : [req.org!.id, limit],
  );
  res.json(rows);
}));

// ---- Team ----
org.get("/team", h(async (req, res) => {
  const members = await db.query(
    `SELECT u.id, u.name, u.email, m.role, m.created_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY m.created_at`,
    [req.org!.id],
  );
  const invites = await db.query(
    `SELECT id, email, role, created_at FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL ORDER BY created_at DESC`,
    [req.org!.id],
  );
  res.json({ members, invites });
}));

org.post("/team/invites", requireRole("admin"), h(async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(["admin", "officer", "viewer"]) }), req.body);
  if (body.role === "admin" && req.org!.role !== "owner") throw forbidden("Only the owner can invite admins.");
  const member = await db.one(`SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2`, [req.org!.id, body.email]);
  if (member) throw conflict("That person is already on the team.");
  const plan = await getPlan(req.org!.plan);
  if (plan.maxTeamMembers !== null) {
    const seats = await db.one<{ n: number }>(
      "SELECT (SELECT count(*) FROM org_members WHERE org_id = $1) + (SELECT count(*) FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL AND email <> $2) AS n",
      [req.org!.id, body.email],
    );
    if (Number(seats?.n ?? 0) >= plan.maxTeamMembers) throw new HttpError(402, `Your ${plan.name} plan includes ${plan.maxTeamMembers} team members (including pending invitations). Upgrade in Plan & billing to add more.`);
  }
  const token = randomToken();
  await db.query("DELETE FROM org_invites WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL", [req.org!.id, body.email]);
  await db.query("INSERT INTO org_invites (org_id, email, role, token_hash, invited_by) VALUES ($1,$2,$3,$4,$5)", [req.org!.id, body.email, body.role, sha256(token), req.user!.id]);
  const url = `${config.publicUrl}/invite/${token}`;
  const sent = await sendMail(body.email, `You're invited to ${req.org!.name} on ${config.appName}`, [`${req.user!.name} invited you to help manage voting for ${req.org!.name}.`], { label: "Accept invitation", url });
  await audit(req, { orgId: req.org!.id, action: "team.invited", detail: { email: body.email, role: body.role } });
  res.status(201).json({ inviteUrl: url, emailed: sent.delivered });
}));

org.delete("/team/invites/:id", requireRole("admin"), h(async (req, res) => {
  await db.query("DELETE FROM org_invites WHERE id::text = $1 AND org_id = $2", [req.params.id, req.org!.id]);
  res.json({ ok: true });
}));

org.patch("/team/:userId", requireRole("admin"), h(async (req, res) => {
  const body = parse(z.object({ role: z.enum(["owner", "admin", "officer", "viewer"]) }), req.body);
  const target = await db.one("SELECT role FROM org_members WHERE org_id = $1 AND user_id::text = $2", [req.org!.id, req.params.userId]);
  if (!target) throw notFound("Team member not found.");
  if ((target.role === "owner" || body.role === "owner" || body.role === "admin") && req.org!.role !== "owner") throw forbidden("Only the owner can change owners or admins.");
  if (target.role === "owner" && body.role !== "owner") {
    const owners = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [req.org!.id]);
    if ((owners?.n ?? 0) <= 1) throw conflict("An organization needs at least one owner.");
  }
  await db.query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id::text = $3", [body.role, req.org!.id, req.params.userId]);
  await audit(req, { orgId: req.org!.id, action: "team.role_changed", detail: { userId: req.params.userId, role: body.role } });
  res.json({ ok: true });
}));

org.delete("/team/:userId", h(async (req, res) => {
  const self = req.params.userId === req.user!.id;
  if (!self && !["owner", "admin"].includes(req.org!.role)) throw forbidden();
  const target = await db.one("SELECT role FROM org_members WHERE org_id = $1 AND user_id::text = $2", [req.org!.id, req.params.userId]);
  if (!target) throw notFound("Team member not found.");
  if (target.role === "owner") {
    const owners = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [req.org!.id]);
    if ((owners?.n ?? 0) <= 1) throw conflict("Transfer ownership before removing the last owner.");
    if (!self && req.org!.role !== "owner") throw forbidden();
  }
  await db.query("DELETE FROM org_members WHERE org_id = $1 AND user_id::text = $2", [req.org!.id, req.params.userId]);
  await audit(req, { orgId: req.org!.id, action: "team.removed", detail: { userId: req.params.userId } });
  res.json({ ok: true });
}));

// ---- Files (images: logos, covers, candidate photos) ----
org.post("/files", requireRole("officer"), h(async (req, res) => {
  const body = parse(z.object({ dataUrl: z.string().max(4_000_000) }), req.body);
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl);
  if (!m) throw new HttpError(400, "Upload a PNG, JPEG, WebP or GIF image.");
  const data = Buffer.from(m[3]!, "base64");
  if (data.length > 2_500_000) throw new HttpError(413, "Images must be 2.5 MB or smaller.");
  const row = await db.one("INSERT INTO files (org_id, mime, size, data) VALUES ($1,$2,$3,$4) RETURNING id", [req.org!.id, m[1], data.length, data]);
  res.status(201).json({ id: row!.id, url: `/api/files/${row!.id}` });
}));

// ---- Billing (platform subscription) ----
org.get("/billing", h(async (req, res) => {
  const platform = await getPlatformConfig();
  const row = await db.one("SELECT plan, plan_expires_at FROM organizations WHERE id = $1", [req.org!.id]);
  const plan = await getPlan(req.org!.plan);
  const usage = await db.one(
    `SELECT (SELECT count(*)::int FROM events WHERE org_id = $1 AND status IN ('live','paused') AND pass_voters IS NULL) AS live_events,
            (SELECT count(*)::int FROM events WHERE org_id = $1) AS events,
            (SELECT count(*)::int FROM org_members WHERE org_id = $1) AS members,
            (SELECT count(*)::int FROM org_invites WHERE org_id = $1 AND accepted_at IS NULL) AS invites,
            (SELECT COALESCE(MAX(c),0)::int FROM (SELECT count(*) AS c FROM voters v JOIN events e ON e.id = v.event_id WHERE e.org_id = $1 AND e.status <> 'archived' GROUP BY v.event_id) x) AS max_voters`,
    [req.org!.id],
  );
  const history = await db.query(
    `SELECT reference, plan_id, amount_minor, currency, status, created_at, paid_at FROM payments WHERE org_id = $1 AND kind = 'plan' ORDER BY created_at DESC LIMIT 20`,
    [req.org!.id],
  );
  res.json({
    plan,
    storedPlan: row!.plan,
    planExpiresAt: row!.plan_expires_at,
    plans: platform.plans,
    passes: platform.passes,
    annualMonthsCharged: ANNUAL_MONTHS_CHARGED,
    subscription: await subscriptionInfo(req.org!.id),
    billingReady: await billingReady(),
    currency: platform.currency,
    provider: platform.billingProvider,
    usage,
    history,
  });
}));

org.post("/billing/checkout", requireRole("admin"), h(async (req, res) => {
  const body = parse(z.object({ planId: z.string(), months: z.union([z.literal(1), z.literal(12)]).default(1), useSavedCard: z.boolean().optional() }), req.body);
  const platform = await getPlatformConfig();
  const plan = platform.plans.find((p) => p.id === body.planId);
  if (!plan) throw notFound("Plan not found.");
  if (plan.price <= 0) throw new HttpError(400, "This plan is free — no payment needed.");
  if (!(await billingReady())) throw new HttpError(503, "Online plan payments aren't available yet. Please try again later or contact support.");
  const charged = body.months === 12 ? ANNUAL_MONTHS_CHARGED : 1;
  // Organizations with a saved card change plan instantly — no redirect needed.
  const sub = await db.one("SELECT status, auth_enc FROM subscriptions WHERE org_id = $1", [req.org!.id]);
  if (sub?.auth_enc && body.useSavedCard !== false) {
    const r = await chargeSavedCard(req.org!.id, plan.id, body.months, "change");
    await db.query("UPDATE subscriptions SET months = $1, status = 'active', paused_at = NULL, updated_at = now() WHERE org_id = $2", [body.months, req.org!.id]);
    await audit(req, { orgId: req.org!.id, action: "plan.changed_with_saved_card", detail: { planId: plan.id, months: body.months, status: r.status } });
    if (r.status === "failed") throw new HttpError(402, "Your saved card was declined. Pay with another card instead.");
    return res.json({ charged: true, status: r.status });
  }
  const result = await startPayment({
    kind: "plan",
    provider: platform.billingProvider,
    orgId: req.org!.id,
    planId: plan.id,
    months: body.months,
    amountMinor: toMinor(plan.price * charged, platform.currency),
    currency: platform.currency,
    email: req.user!.email,
    name: req.user!.name,
    description: `${config.appName} ${plan.name} plan — ${body.months === 12 ? "12 months" : "1 month"}`,
    returnPath: "/app/billing",
  });
  await audit(req, { orgId: req.org!.id, action: "plan.checkout_started", detail: { planId: plan.id, months: body.months, reference: result.reference } });
  res.json(result);
}));

// ---- Ads on the dashboard (ad-supported plans only) ----
org.get("/ad", h(async (req, res) => {
  const o = await db.one("SELECT plan, plan_expires_at FROM organizations WHERE id = $1", [req.org!.id]);
  res.json({ ad: await serveAd(o!.plan, o!.plan_expires_at, "dashboard") });
}));

// ---- Automatic renewal controls ----
async function subscriptionInfo(orgId: string) {
  const sub = await db.one("SELECT plan_id, months, status, card_last4, card_brand, card_exp, failed_attempts, next_attempt_at, paused_at, auth_enc IS NOT NULL AS has_card FROM subscriptions WHERE org_id = $1", [orgId]);
  if (!sub) return null;
  return {
    planId: sub.plan_id,
    months: sub.months,
    status: sub.status,
    autoRenew: sub.status === "active" && sub.has_card,
    card: sub.has_card ? { last4: sub.card_last4, brand: sub.card_brand, exp: sub.card_exp } : null,
    failedAttempts: sub.failed_attempts,
    nextAttemptAt: sub.next_attempt_at,
    pausedAt: sub.paused_at,
  };
}

org.post("/billing/pause", requireRole("admin"), h(async (req, res) => {
  const r = await db.one("UPDATE subscriptions SET status = 'paused', paused_at = now(), updated_at = now() WHERE org_id = $1 RETURNING org_id", [req.org!.id]);
  if (!r) throw notFound("There's no subscription to pause.");
  await audit(req, { orgId: req.org!.id, action: "subscription.paused" });
  res.json(await subscriptionInfo(req.org!.id));
}));

org.post("/billing/resume", requireRole("admin"), h(async (req, res) => {
  const sub = await db.one("SELECT * FROM subscriptions WHERE org_id = $1", [req.org!.id]);
  if (!sub) throw notFound("There's no subscription to resume.");
  if (!sub.auth_enc) throw new HttpError(409, "No saved card. Choose a plan and pay once to switch automatic renewal back on.");
  await db.query("UPDATE subscriptions SET status = 'active', paused_at = NULL, failed_attempts = 0, next_attempt_at = NULL, updated_at = now() WHERE org_id = $1", [req.org!.id]);
  const o = await db.one("SELECT plan_expires_at FROM organizations WHERE id = $1", [req.org!.id]);
  let charged: any = null;
  // If the paid period already ran out while paused, start a new period right away.
  if (!o?.plan_expires_at || new Date(o.plan_expires_at) <= new Date()) {
    charged = await chargeSavedCard(req.org!.id, sub.plan_id, sub.months, "renewal");
    if (charged.status === "failed") {
      await db.query("UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE org_id = $1", [req.org!.id]);
      throw new HttpError(402, "Your saved card was declined. Pay with another card from the plans below.");
    }
  }
  await audit(req, { orgId: req.org!.id, action: "subscription.resumed", detail: { charged: Boolean(charged) } });
  res.json(await subscriptionInfo(req.org!.id));
}));

org.post("/billing/frequency", requireRole("admin"), h(async (req, res) => {
  const { months } = parse(z.object({ months: z.union([z.literal(1), z.literal(12)]) }), req.body);
  const r = await db.one("UPDATE subscriptions SET months = $1, updated_at = now() WHERE org_id = $2 RETURNING org_id", [months, req.org!.id]);
  if (!r) throw notFound("There's no subscription yet.");
  await audit(req, { orgId: req.org!.id, action: "subscription.frequency_changed", detail: { months } });
  res.json(await subscriptionInfo(req.org!.id));
}));

org.delete("/billing/card", requireRole("admin"), h(async (req, res) => {
  await db.query("UPDATE subscriptions SET auth_enc = NULL, card_last4 = NULL, card_brand = NULL, card_exp = NULL, status = 'paused', paused_at = now(), updated_at = now() WHERE org_id = $1", [req.org!.id]);
  await audit(req, { orgId: req.org!.id, action: "subscription.card_removed" });
  res.json(await subscriptionInfo(req.org!.id));
}));

// ---- API keys (Pro and above) ----
org.get("/api-keys", requireRole("admin"), h(async (req, res) => {
  const rows = await db.query("SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC", [req.org!.id]);
  res.json({ keys: rows, available: (await getPlan(req.org!.plan)).api });
}));

org.post("/api-keys", requireRole("admin"), h(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), req.body);
  if (!(await getPlan(req.org!.plan)).api) throw new HttpError(402, "API access is included in the Pro plan and above.");
  const key = `vh_live_${randomToken(24)}`;
  await db.query("INSERT INTO api_keys (org_id, name, prefix, key_hash, created_by) VALUES ($1,$2,$3,$4,$5)", [req.org!.id, name, key.slice(0, 12), sha256(key), req.user!.id]);
  await audit(req, { orgId: req.org!.id, action: "api_key.created", detail: { name } });
  res.status(201).json({ key });
}));

org.delete("/api-keys/:id", requireRole("admin"), h(async (req, res) => {
  await db.query("DELETE FROM api_keys WHERE id::text = $1 AND org_id = $2", [req.params.id, req.org!.id]);
  await audit(req, { orgId: req.org!.id, action: "api_key.revoked", detail: { id: req.params.id } });
  res.json({ ok: true });
}));

router.use("/org", org);
export default router;
