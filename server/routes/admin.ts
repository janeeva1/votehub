import { appearanceSchema, getAppearance, setAppearance } from "../services/appearance";
import { adRow, adSchema } from "../services/ads";
import { getLegal, legalSchema, setLegal } from "../services/legal";
import { runScheduledJobs } from "../services/scheduler";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { requirePlatformAdmin } from "../auth";
import { HttpError, h, notFound, parse } from "../http";
import { audit } from "../services/audit";
import { config } from "../config";
import { mailEnabled } from "../services/mailer";
import { smsEnabled } from "../services/sms";
import { CURRENCIES } from "../../shared/model";
import { billingReady, passSchema, describeKeys, getPlatformConfig, getPlatformKeysStored, mergeKeys, planSchema, setPlatformConfig, setPlatformKeysStored } from "../services/platform";

/** Platform super-admin (the SaaS operator). */
const router = Router();
router.use(requirePlatformAdmin);

router.get("/overview", h(async (_req, res) => {
  const counts = await db.one(
    `SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM organizations) AS orgs,
            (SELECT count(*)::int FROM events) AS events, (SELECT count(*)::int FROM events WHERE status = 'live') AS live_events,
            (SELECT count(*)::int FROM ballots) AS ballots, (SELECT COALESCE(SUM(quantity),0)::float8 FROM votes WHERE rank IS NULL OR rank = 1) AS votes`,
  );
  const money = await db.query(
    `SELECT kind, currency, SUM(amount_minor)::float8 AS total, SUM(platform_fee_minor)::float8 AS fees, count(*)::int AS n
       FROM payments WHERE status = 'success' GROUP BY kind, currency ORDER BY kind, currency`,
  );
  const plans = await db.query(
    "SELECT CASE WHEN plan <> 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at < now() THEN 'free' ELSE plan END AS plan, count(*)::int AS n FROM organizations GROUP BY 1",
  );
  const cfg = await getPlatformConfig();
  const priceOf = new Map(cfg.plans.map((p) => [p.id, p.price]));
  const mrr = plans.reduce((a, p) => a + (priceOf.get(p.plan) ?? 0) * p.n, 0);
  const expiring = await db.query(
    `SELECT id, name, plan, plan_expires_at FROM organizations WHERE plan <> 'free' AND plan_expires_at IS NOT NULL
        AND plan_expires_at BETWEEN now() - interval '7 days' AND now() + interval '14 days' ORDER BY plan_expires_at LIMIT 20`,
  );
  const recentOrgs = await db.query("SELECT id, name, org_type, plan, created_at FROM organizations ORDER BY created_at DESC LIMIT 8");
  const checklist = [
    { key: "billing", label: `Online plan payments (${cfg.billingProvider})`, ok: await billingReady(), help: "Add the platform Paystack secret key in Plans & settings (or PAYSTACK_SECRET_KEY in .env) so organizations can upgrade themselves." },
    { key: "smtp", label: "Email delivery (SMTP)", ok: mailEnabled(), help: "Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in .env for invitations, codes, reminders and password resets." },
    { key: "sms", label: "SMS (Termii)", ok: smsEnabled(), help: "Set TERMII_API_KEY and TERMII_SENDER_ID in .env to send SMS invitations and reminders." },
    { key: "https", label: "Public HTTPS address", ok: config.publicUrl.startsWith("https://"), help: "Set PUBLIC_URL to your https:// domain before going live (needed for Paystack callbacks and webhooks)." },
    { key: "signups", label: "Self-service sign-ups open", ok: cfg.allowSignups, help: "Organizations register and manage themselves. Turn this on in Plans & settings." },
    { key: "testpay", label: "Test payments off in production", ok: !(config.isProd && config.allowTestPayments), help: "Set ALLOW_TEST_PAYMENTS=false in production." },
  ];
  res.json({ counts, money, plans, mrr, currency: cfg.currency, expiring, recentOrgs, checklist });
}));

router.get("/orgs", h(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const rows = await db.query(
    `SELECT o.id, o.name, o.slug, o.org_type, o.plan, o.plan_expires_at, o.suspended, o.created_at,
            (SELECT count(*)::int FROM org_members m WHERE m.org_id = o.id) AS members,
            (SELECT count(*)::int FROM events e WHERE e.org_id = o.id) AS events,
            (SELECT u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email
       FROM organizations o ${q ? "WHERE o.name ILIKE $1 OR o.slug ILIKE $1" : ""} ORDER BY o.created_at DESC LIMIT 500`,
    q ? [`%${q}%`] : [],
  );
  res.json(rows);
}));

router.patch("/orgs/:id", h(async (req, res) => {
  const body = parse(
    z.object({ plan: z.string().optional(), planExpiresAt: z.string().datetime({ offset: true }).nullable().optional(), suspended: z.boolean().optional() }),
    req.body,
  );
  const org = await db.one("SELECT * FROM organizations WHERE id::text = $1", [req.params.id]);
  if (!org) throw notFound("Organization not found.");
  if (body.plan) {
    const { plans } = await getPlatformConfig();
    if (!plans.some((p) => p.id === body.plan)) throw new HttpError(400, "Unknown plan.");
  }
  await db.query("UPDATE organizations SET plan = $1, plan_expires_at = $2, suspended = $3 WHERE id = $4", [
    body.plan ?? org.plan,
    body.planExpiresAt !== undefined ? body.planExpiresAt : org.plan_expires_at,
    body.suspended ?? org.suspended,
    org.id,
  ]);
  await audit(req, { orgId: org.id, action: "admin.org_updated", detail: body });
  res.json({ ok: true });
}));

router.get("/users", h(async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const rows = await db.query(
    `SELECT u.id, u.name, u.email, u.is_platform_admin, u.disabled, u.created_at,
            (SELECT count(*)::int FROM org_members m WHERE m.user_id = u.id) AS orgs
       FROM users u ${q ? "WHERE u.email ILIKE $1 OR u.name ILIKE $1" : ""} ORDER BY u.created_at DESC LIMIT 500`,
    q ? [`%${q}%`] : [],
  );
  res.json(rows);
}));

router.patch("/users/:id", h(async (req, res) => {
  const body = parse(z.object({ disabled: z.boolean().optional(), isPlatformAdmin: z.boolean().optional() }), req.body);
  if (req.params.id === req.user!.id && (body.disabled || body.isPlatformAdmin === false)) throw new HttpError(400, "You can't disable or demote yourself.");
  const user = await db.one("SELECT * FROM users WHERE id::text = $1", [req.params.id]);
  if (!user) throw notFound("User not found.");
  await db.query("UPDATE users SET disabled = $1, is_platform_admin = $2 WHERE id = $3", [body.disabled ?? user.disabled, body.isPlatformAdmin ?? user.is_platform_admin, user.id]);
  if (body.disabled) await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
  await audit(req, { action: "admin.user_updated", detail: { userId: user.id, ...body } });
  res.json({ ok: true });
}));

router.get("/config", h(async (_req, res) => {
  res.json({ ...(await getPlatformConfig()), paymentKeys: describeKeys(await getPlatformKeysStored()), envPaystack: Boolean(process.env.PAYSTACK_SECRET_KEY?.trim()) });
}));

router.put("/config", h(async (req, res) => {
  const body = parse(
    z.object({
      plans: z.array(planSchema).min(1).max(10).refine((p) => p.some((x) => x.id === "free"), "Keep a plan with id 'free' (the default plan)."),
      currency: z.enum(CURRENCIES),
      billingProvider: z.enum(["paystack", "test"]),
      allowSignups: z.boolean(),
      passes: z.array(passSchema).max(10).default([]),
      paymentKeys: z.object({ paystack: z.object({ secretKey: z.string().optional(), publicKey: z.string().optional() }).nullable().optional() }).optional(),
    }),
    req.body,
  );
  const ids = new Set(body.plans.map((p) => p.id));
  if (ids.size !== body.plans.length) throw new HttpError(400, "Plan ids must be unique.");
  await setPlatformConfig({ plans: body.plans, passes: body.passes, currency: body.currency, billingProvider: body.billingProvider, allowSignups: body.allowSignups });
  if (body.paymentKeys) await setPlatformKeysStored(mergeKeys(await getPlatformKeysStored(), body.paymentKeys));
  await audit(req, { action: "admin.platform_config_updated" });
  res.json({ ok: true });
}));

router.get("/payments", h(async (_req, res) => {
  const rows = await db.query(
    `SELECT p.reference, p.kind, p.provider, p.status, p.amount_minor::float8 AS amount_minor, p.platform_fee_minor::float8 AS platform_fee_minor,
            p.currency, p.quantity, p.payer_email, p.created_at, p.paid_at, o.name AS org_name, e.title AS event_title
       FROM payments p LEFT JOIN organizations o ON o.id = p.org_id LEFT JOIN events e ON e.id = p.event_id
      ORDER BY p.created_at DESC LIMIT 500`,
  );
  res.json(rows);
}));

// ---- Ads (shown on plans with showAds, e.g. Free) ----
router.get("/ads", h(async (_req, res) => {
  const rows = await db.query("SELECT * FROM ads ORDER BY active DESC, created_at DESC");
  res.json(rows.map(adRow));
}));

router.post("/ads", h(async (req, res) => {
  const a = parse(adSchema, req.body);
  const row = await db.one(
    `INSERT INTO ads (title, body, image_file_id, link_url, cta, placements, plan_ids, active, starts_at, ends_at, weight)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [a.title, a.body, a.imageFileId, a.linkUrl, a.cta, a.placements, a.planIds, a.active, a.startsAt, a.endsAt, a.weight],
  );
  await audit(req, { action: "admin.ad_created", detail: { id: row!.id, title: a.title } });
  res.status(201).json(adRow(row));
}));

router.patch("/ads/:id", h(async (req, res) => {
  const a = parse(adSchema, req.body);
  const row = await db.one(
    `UPDATE ads SET title=$1, body=$2, image_file_id=$3, link_url=$4, cta=$5, placements=$6, plan_ids=$7, active=$8, starts_at=$9, ends_at=$10, weight=$11
      WHERE id::text = $12 RETURNING *`,
    [a.title, a.body, a.imageFileId, a.linkUrl, a.cta, a.placements, a.planIds, a.active, a.startsAt, a.endsAt, a.weight, req.params.id],
  );
  if (!row) throw notFound("Ad not found.");
  await audit(req, { action: "admin.ad_updated", detail: { id: row.id } });
  res.json(adRow(row));
}));

router.delete("/ads/:id", h(async (req, res) => {
  await db.query("DELETE FROM ads WHERE id::text = $1", [req.params.id]);
  await audit(req, { action: "admin.ad_deleted", detail: { id: req.params.id } });
  res.json({ ok: true });
}));

/** Platform-level image upload (ad creatives); not tied to any organization. */
router.post("/files", h(async (req, res) => {
  const body = parse(z.object({ dataUrl: z.string().max(4_000_000) }), req.body);
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(body.dataUrl);
  if (!m) throw new HttpError(400, "Upload a PNG, JPEG, WebP or GIF image.");
  const data = Buffer.from(m[3]!, "base64");
  if (data.length > 2_500_000) throw new HttpError(413, "Images must be 2.5 MB or smaller.");
  const row = await db.one("INSERT INTO files (org_id, mime, size, data) VALUES (NULL,$1,$2,$3) RETURNING id", [m[1], data.length, data]);
  res.status(201).json({ id: row!.id, url: `/api/files/${row!.id}` });
}));

router.get("/appearance", h(async (_req, res) => {
  res.json(await getAppearance());
}));

router.put("/appearance", h(async (req, res) => {
  const body = parse(appearanceSchema, req.body);
  const saved = await setAppearance(body);
  await audit(req, { action: "admin.appearance_updated", detail: { themeId: body.themeId } });
  res.json(saved);
}));

router.get("/legal", h(async (_req, res) => {
  const accepted = await db.one<{ n: number; total: number }>("SELECT count(*) FILTER (WHERE terms_version = $1)::int AS n, count(*)::int AS total FROM users", [(await getLegal()).termsVersion]);
  res.json({ ...(await getLegal()), accepted });
}));

router.put("/legal", h(async (req, res) => {
  const body = parse(legalSchema.partial().omit({ termsVersion: true, updatedAt: true }).extend({ requireReaccept: z.boolean().default(false) }), req.body);
  const { requireReaccept, ...update } = body;
  const legal = await setLegal(update, requireReaccept);
  await audit(req, { action: requireReaccept ? "admin.terms_version_published" : "admin.legal_updated", detail: { version: legal.termsVersion } });
  res.json(legal);
}));

router.post("/jobs/run", h(async (_req, res) => {
  await runScheduledJobs();
  res.json({ ok: true });
}));

export default router;
