import { Router, type Request } from "express";
import { z } from "zod";
import { config } from "../config";
import { db, type Queryable } from "../db";
import { requireOrg, requireRole, requireUser } from "../auth";
import { HttpError, conflict, h, notFound, parse } from "../http";
import { humanCode } from "../security";
import { audit } from "../services/audit";
import { getEventForOrg, readSettings, tally, votingState, type EventRow } from "../services/events";
import { getPlan, getPlatformConfig } from "../services/platform";
import { eventLimits } from "../services/limits";
import { emitWebhook } from "../services/outbound";
import { sendSms, smsEnabled, whatsappLink } from "../services/sms";
import { eventMethods, orgMethods, startPayment, decideManualPayment } from "../services/payments";
import { hashPassword } from "../security";
import { sendMail } from "../services/mailer";
import { verifyAndFinalize } from "../services/payments";
import { METHODS, TEMPLATES, eventSettingsSchema, mergeSettings, fromMinor } from "../../shared/model";
import { slugify } from "./orgs";

const router = Router();
router.use(requireUser, requireOrg);

const uuid = z.string().uuid();
const dateish = z.union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/), z.null()]).optional();
const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v === "" ? null : new Date(v));

async function uniqueEventSlug(base: string, q: Queryable = db) {
  let slug = slugify(base, 48);
  for (let i = 0; i < 6; i++) {
    const taken = await q.one("SELECT 1 FROM events WHERE slug = $1", [slug]);
    if (!taken) return slug;
    slug = `${slugify(base, 40)}-${humanCode(4).toLowerCase()}`;
  }
  return `${slugify(base, 30)}-${humanCode(8).toLowerCase()}`;
}

async function nextOptionCode(eventId: string, q: Queryable = db) {
  for (let i = 0; i < 10; i++) {
    const code = humanCode(4);
    if (!(await q.one("SELECT 1 FROM options WHERE event_id = $1 AND code = $2", [eventId, code]))) return code;
  }
  return humanCode(6);
}

function serializeEvent(e: EventRow, extra: Record<string, unknown> = {}) {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    description: e.description,
    template: e.template,
    status: e.status,
    state: votingState(e),
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    resultsPublished: e.results_published,
    coverFileId: e.cover_file_id,
    settings: e.settings,
    publicUrl: `${config.publicUrl}/e/${e.slug}`,
    passVoters: e.pass_voters ?? null,
    hasPassword: Boolean(e.access_password_hash),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    ...extra,
  };
}

async function hasVotes(eventId: string, q: Queryable = db) {
  const r = await q.one("SELECT (SELECT count(*) FROM votes WHERE event_id = $1)::int + (SELECT count(*) FROM ballots WHERE event_id = $1)::int AS n", [eventId]);
  return (r?.n ?? 0) > 0;
}

const ev = (req: Request) => getEventForOrg(String(req.params.id), req.org!.id);

// ---------------- Events ----------------
router.get("/events", h(async (req, res) => {
  const rows = await db.query(
    `SELECT e.*,
        (SELECT count(*)::int FROM voters v WHERE v.event_id = e.id) AS voter_count,
        (SELECT count(*)::int FROM ballots b WHERE b.event_id = e.id) AS ballot_count,
        (SELECT COALESCE(SUM(quantity),0)::float8 FROM votes vt WHERE vt.event_id = e.id AND (vt.rank IS NULL OR vt.rank = 1)) AS vote_total,
        (SELECT count(*)::int FROM options o WHERE o.event_id = e.id) AS option_count
       FROM events e WHERE e.org_id = $1 ORDER BY e.created_at DESC`,
    [req.org!.id],
  );
  res.json(
    rows.map((r) =>
      serializeEvent({ ...r, settings: readSettings(r.settings) } as EventRow, {
        voterCount: r.voter_count,
        ballotCount: r.ballot_count,
        voteTotal: r.vote_total,
        optionCount: r.option_count,
      }),
    ),
  );
}));

router.get("/templates", (_req, res) => res.json(TEMPLATES));

router.post("/events", requireRole("officer"), h(async (req, res) => {
  const body = parse(
    z.object({ title: z.string().trim().min(3).max(160), templateId: z.string().default("custom"), description: z.string().max(5000).optional(), startsAt: dateish, endsAt: dateish }),
    req.body,
  );
  const template = TEMPLATES.find((t) => t.id === body.templateId) ?? TEMPLATES.find((t) => t.id === "custom")!;
  const startsAt = toDate(body.startsAt) ?? null;
  const endsAt = toDate(body.endsAt) ?? null;
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(400, "The end time must be after the start time.");
  const plan = await getPlan(req.org!.plan);
  let settings = mergeSettings({}, template.settings);
  if (settings.paid.enabled && !plan.paidVoting) {
    // Keep the template usable on the free plan; paid voting can be switched on after upgrading.
    settings = mergeSettings(settings, { paid: { enabled: false }, freeVotes: { enabled: true } });
  }
  const orgSettings = (await db.one("SELECT settings FROM organizations WHERE id = $1", [req.org!.id]))?.settings ?? {};
  if (orgSettings.defaultCurrency && (template.settings as any).paid) settings = mergeSettings(settings, { paid: { currency: orgSettings.defaultCurrency } });

  const created = await db.tx(async (q) => {
    const slug = await uniqueEventSlug(body.title, q);
    const e = await q.one(
      `INSERT INTO events (org_id, slug, title, description, template, starts_at, ends_at, settings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.org!.id, slug, body.title, body.description ?? "", template.id, startsAt, endsAt, JSON.stringify(settings)],
    );
    let order = 0;
    for (const c of template.categories) {
      const cat = await q.one(
        "INSERT INTO categories (event_id, title, method, max_choices, points, threshold_percent, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [e!.id, c.title, c.method ?? "single", c.maxChoices ?? 1, c.points ?? 10, c.thresholdPercent ?? null, order++],
      );
      let optOrder = 0;
      for (const name of c.options ?? []) {
        await q.query("INSERT INTO options (event_id, category_id, name, code, sort_order) VALUES ($1,$2,$3,$4,$5)", [e!.id, cat!.id, name, await nextOptionCode(e!.id, q), optOrder++]);
      }
    }
    await audit(req, { orgId: req.org!.id, eventId: e!.id, action: "event.created", detail: { title: body.title, template: template.id } }, q);
    return e!;
  });
  res.status(201).json(serializeEvent({ ...created, settings: readSettings(created.settings) } as EventRow));
}));

router.get("/events/:id", h(async (req, res) => {
  const e = await ev(req);
  const categories = await db.query("SELECT * FROM categories WHERE event_id = $1 ORDER BY sort_order, created_at", [e.id]);
  const options = await db.query("SELECT * FROM options WHERE event_id = $1 ORDER BY sort_order, created_at", [e.id]);
  const stats = await db.one(
    `SELECT (SELECT count(*)::int FROM voters WHERE event_id = $1) AS voters,
            (SELECT count(*)::int FROM voters WHERE event_id = $1 AND voted_at IS NOT NULL) AS voted,
            (SELECT count(*)::int FROM ballots WHERE event_id = $1) AS ballots,
            (SELECT COALESCE(SUM(quantity),0)::float8 FROM votes WHERE event_id = $1 AND (rank IS NULL OR rank = 1)) AS votes,
            (SELECT count(*)::int FROM options WHERE event_id = $1 AND status = 'pending') AS pending_nominations`,
    [e.id],
  );
  const revenue = await db.query(
    `SELECT currency, SUM(amount_minor)::float8 AS total, SUM(platform_fee_minor)::float8 AS fees, SUM(quantity)::int AS votes, count(*)::int AS n
       FROM payments WHERE event_id = $1 AND status = 'success' GROUP BY currency`,
    [e.id],
  );
  const limits = await eventLimits(req.org!.plan, null, e.pass_voters);
  const plan = limits.plan;
  const groups = await db.query("SELECT DISTINCT group_name FROM voters WHERE event_id = $1 AND group_name IS NOT NULL ORDER BY group_name", [e.id]);
  const comments = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM ballots WHERE event_id = $1 AND comment IS NOT NULL", [e.id]);
  res.json(
    serializeEvent(e, {
      voterGroups: groups.map((g) => g.group_name),
      commentCount: comments?.n ?? 0,
      smsAvailable: limits.sms && smsEnabled(),
      paymentMethods: await orgMethods(req.org!.id),
      categories: categories.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        method: c.method,
        maxChoices: c.max_choices,
        points: c.points,
        allowWriteIn: c.allow_write_in,
        thresholdPercent: c.threshold_percent === null ? null : Number(c.threshold_percent),
        voterGroups: c.voter_groups ?? [],
        sortOrder: c.sort_order,
        options: options
          .filter((o) => o.category_id === c.id)
          .map((o) => ({ id: o.id, name: o.name, subtitle: o.subtitle, description: o.description, imageFileId: o.image_file_id, code: o.code, status: o.status, sortOrder: o.sort_order, submittedByEmail: o.submitted_by_email })),
      })),
      stats: { ...stats, revenue: revenue.map((r) => ({ ...r, totalMajor: fromMinor(r.total, r.currency), feesMajor: fromMinor(r.fees, r.currency) })) },
      locked: await hasVotes(e.id),
      plan: { id: plan.id, name: plan.name, paidVoting: limits.paidVoting, maxVotersPerEvent: limits.maxVoters, maxBallotsPerEvent: limits.maxBallots, platformFeePercent: limits.feePercent, sms: limits.sms, api: limits.api },
    }),
  );
}));

router.patch("/events/:id", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(
    z.object({
      title: z.string().trim().min(3).max(160).optional(),
      description: z.string().max(5000).optional(),
      slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,60}$/, "Use 3–60 lowercase letters, numbers and dashes.").optional(),
      startsAt: dateish,
      endsAt: dateish,
      coverFileId: uuid.nullable().optional(),
      settings: z.record(z.any()).optional(),
      /** Shared voting-page password; null removes it. */
      accessPassword: z.string().min(4, "Use at least 4 characters for the password.").max(100).nullable().optional(),
    }),
    req.body,
  );
  const startsAt = body.startsAt !== undefined ? toDate(body.startsAt) : e.starts_at ? new Date(e.starts_at) : null;
  const endsAt = body.endsAt !== undefined ? toDate(body.endsAt) : e.ends_at ? new Date(e.ends_at) : null;
  if (startsAt && endsAt && endsAt <= startsAt) throw new HttpError(400, "The end time must be after the start time.");

  let settings = e.settings;
  if (body.settings) {
    const merged = eventSettingsSchema.safeParse(mergeSettings(e.settings, body.settings));
    if (!merged.success) throw new HttpError(400, merged.error.issues[0]?.message ?? "Invalid settings.");
    settings = merged.data;
    const voted = await hasVotes(e.id);
    if (voted && (settings.mode !== e.settings.mode || settings.access !== e.settings.access || settings.ballot.weighted !== e.settings.ballot.weighted || settings.ballot.secret !== e.settings.ballot.secret)) {
      throw conflict("Voting mode, access, secrecy and weighting can't change after votes have been cast.");
    }
    if (voted && settings.paid.currency !== e.settings.paid.currency) throw conflict("The currency can't change after votes have been cast.");
    if (settings.paid.enabled) {
      const limits = await eventLimits(req.org!.plan, null, e.pass_voters);
      if (!limits.paidVoting) throw new HttpError(402, `Paid voting isn't included in the ${limits.plan.name} plan. Upgrade in Billing or buy an event pass to enable it.`);
      if ((settings.paid.provider === "test" || settings.paid.methods.includes("test")) && !config.allowTestPayments) throw new HttpError(400, "Test payments are disabled on this server.");
      const offered = (await orgMethods(req.org!.id)).map((m) => m.id);
      const unknown = settings.paid.methods.filter((m) => !offered.includes(m));
      if (unknown.length) throw new HttpError(400, `These payment methods aren't set up for your organization: ${unknown.join(", ")}. Configure them in Organization settings → Payment methods.`);
      if (settings.mode !== "tally") throw new HttpError(400, "Paid voting is available for contest/tally-style events.");
    }
    if (settings.mode === "tally" && settings.access === "roster" && !settings.freeVotes.enabled && !settings.paid.enabled) {
      throw new HttpError(400, "Enable free votes or paid votes so people can vote.");
    }
    if (settings.mode === "tally" && !settings.freeVotes.enabled && !settings.paid.enabled) {
      throw new HttpError(400, "Enable free votes, paid votes, or both.");
    }
  }
  if (body.slug && body.slug !== e.slug) {
    const taken = await db.one("SELECT 1 FROM events WHERE slug = $1 AND id <> $2", [body.slug, e.id]);
    if (taken) throw conflict("That link is already taken. Try another.");
  }
  let passwordHash = e.access_password_hash;
  if (body.accessPassword !== undefined) passwordHash = body.accessPassword ? await hashPassword(body.accessPassword) : null;
  if (settings.security.passwordProtected && !passwordHash) throw new HttpError(400, "Set a password for the voting page, or turn off password protection.");
  const updated = await db.one(
    `UPDATE events SET title = $1, description = $2, slug = $3, starts_at = $4, ends_at = $5, cover_file_id = $6, settings = $7, access_password_hash = $8,
            reminder_sent_at = CASE WHEN $5::timestamptz IS DISTINCT FROM ends_at THEN NULL ELSE reminder_sent_at END, updated_at = now()
      WHERE id = $9 RETURNING *`,
    [body.title ?? e.title, body.description ?? e.description, body.slug ?? e.slug, startsAt, endsAt, body.coverFileId !== undefined ? body.coverFileId : e.cover_file_id, JSON.stringify(settings), passwordHash, e.id],
  );
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "event.updated", detail: { fields: Object.keys(body), settings: body.settings ? Object.keys(body.settings) : undefined } });
  res.json(serializeEvent({ ...updated, settings: readSettings(updated!.settings) } as EventRow));
}));

const transitions: Record<string, string[]> = {
  draft: ["live", "archived"],
  live: ["paused", "closed"],
  paused: ["live", "closed"],
  closed: ["live", "archived"],
  archived: ["closed"],
};

router.post("/events/:id/status", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const { status } = parse(z.object({ status: z.enum(["draft", "live", "paused", "closed", "archived"]) }), req.body);
  if (status === e.status) return res.json(serializeEvent(e));
  if (!transitions[e.status]?.includes(status)) throw conflict(`An event can't move from ${e.status} to ${status}.`);
  if (status === "archived" && !["owner", "admin"].includes(req.org!.role)) throw new HttpError(403, "Only admins can archive events.");
  if (status === "live") {
    const plan = await getPlan(req.org!.plan);
    // Events upgraded with a one-off pass don't use up the plan's live-event allowance.
    if (plan.maxLiveEvents !== null && e.status !== "paused" && !e.pass_voters) {
      const live = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND status IN ('live','paused') AND id <> $2 AND pass_voters IS NULL", [req.org!.id, e.id]);
      if ((live?.n ?? 0) >= plan.maxLiveEvents) throw new HttpError(402, `Your ${plan.name} plan allows ${plan.maxLiveEvents} live event(s). Close another event or upgrade.`);
    }
    if (e.ends_at && new Date(e.ends_at) <= new Date()) throw conflict("The end time has already passed. Update the schedule first.");
    const cats = await db.query(
      `SELECT c.id, c.title, c.method, (SELECT count(*)::int FROM options o WHERE o.category_id = c.id AND o.status = 'approved') AS n
         FROM categories c WHERE c.event_id = $1`,
      [e.id],
    );
    if (!cats.length) throw conflict("Add at least one category/position before going live.");
    const empty = cats.find((c) => c.n < 1);
    if (empty && !(e.settings.mode === "tally" && e.settings.nominations.enabled)) throw conflict(`"${empty.title}" has no options yet. Add at least one before going live.`);
    if (e.settings.access === "roster") {
      const voters = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM voters WHERE event_id = $1", [e.id]);
      if (!voters?.n) throw conflict("This event uses a voter list. Add voters before going live.");
    }
    if (e.settings.paid.enabled && !(await eventMethods(e.settings.paid, req.org!.id)).length) {
      throw conflict("Paid voting is on, but no payment method is available. Connect a gateway or add a manual method (e.g. bank transfer) in Organization settings → Payment methods.");
    }
  }
  const updated = await db.one("UPDATE events SET status = $1, updated_at = now() WHERE id = $2 RETURNING *", [status, e.id]);
  void emitWebhook(req.org!.id, "event.status_changed", { event: { id: e.id, slug: e.slug, title: e.title }, from: e.status, to: status });
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: `event.${status}`, detail: { from: e.status } });
  res.json(serializeEvent({ ...updated, settings: readSettings(updated!.settings) } as EventRow));
}));

router.post("/events/:id/results-published", requireRole("admin"), h(async (req, res) => {
  const e = await ev(req);
  const { published } = parse(z.object({ published: z.boolean() }), req.body);
  await db.query("UPDATE events SET results_published = $1, updated_at = now() WHERE id = $2", [published, e.id]);
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: published ? "results.published" : "results.unpublished" });
  res.json({ ok: true });
}));

router.post("/events/:id/duplicate", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const copy = await db.tx(async (q) => {
    const slug = await uniqueEventSlug(`${e.title} copy`, q);
    const created = await q.one(
      `INSERT INTO events (org_id, slug, title, description, template, settings, cover_file_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [req.org!.id, slug, `${e.title} (copy)`, e.description, e.template, JSON.stringify(e.settings), e.cover_file_id],
    );
    const cats = await q.query("SELECT * FROM categories WHERE event_id = $1", [e.id]);
    for (const c of cats) {
      const nc = await q.one(
        "INSERT INTO categories (event_id, title, description, method, max_choices, points, allow_write_in, threshold_percent, voter_groups, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
        [created!.id, c.title, c.description, c.method, c.max_choices, c.points, c.allow_write_in, c.threshold_percent, c.voter_groups, c.sort_order],
      );
      const opts = await q.query("SELECT * FROM options WHERE category_id = $1 AND status = 'approved'", [c.id]);
      for (const o of opts) {
        await q.query("INSERT INTO options (event_id, category_id, name, subtitle, description, image_file_id, code, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [created!.id, nc!.id, o.name, o.subtitle, o.description, o.image_file_id, o.code, o.sort_order]);
      }
    }
    await audit(req, { orgId: req.org!.id, eventId: created!.id, action: "event.duplicated", detail: { from: e.id } }, q);
    return created!;
  });
  res.status(201).json({ id: copy.id });
}));

router.delete("/events/:id", requireRole("admin"), h(async (req, res) => {
  const e = await ev(req);
  if (e.status !== "draft" && (await hasVotes(e.id))) throw conflict("Events with votes can't be deleted. Archive it instead.");
  await db.query("DELETE FROM events WHERE id = $1", [e.id]);
  await audit(req, { orgId: req.org!.id, action: "event.deleted", detail: { title: e.title } });
  res.json({ ok: true });
}));

// ---------------- Categories ----------------
const categoryInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  method: z.enum(METHODS).optional(),
  maxChoices: z.number().int().min(1).max(100).optional(),
  points: z.number().int().min(1).max(1000).optional(),
  allowWriteIn: z.boolean().optional(),
  thresholdPercent: z.number().min(0).max(100).nullable().optional(),
  voterGroups: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  sortOrder: z.number().int().optional(),
});

async function assertStructureEditable(e: EventRow) {
  if (e.settings.mode === "ballot" && (await hasVotes(e.id))) throw conflict("The ballot can't change after ballots have been cast. You can still edit names and descriptions.");
}

router.post("/events/:id/categories", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(categoryInput, req.body);
  await assertStructureEditable(e);
  const max = await db.one<{ n: number }>("SELECT COALESCE(MAX(sort_order),-1)::int AS n FROM categories WHERE event_id = $1", [e.id]);
  const row = await db.one(
    "INSERT INTO categories (event_id, title, description, method, max_choices, points, allow_write_in, threshold_percent, voter_groups, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
    [e.id, body.title, body.description ?? "", body.method ?? "single", body.maxChoices ?? 1, body.points ?? (body.method === "score" ? 5 : 10), body.allowWriteIn ?? false, body.thresholdPercent || null, body.voterGroups ?? [], body.sortOrder ?? (max?.n ?? -1) + 1],
  );
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "category.created", detail: { title: body.title } });
  res.status(201).json({ id: row!.id });
}));

router.patch("/events/:id/categories/:cid", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(categoryInput.partial(), req.body);
  const cat = await db.one("SELECT * FROM categories WHERE id::text = $1 AND event_id = $2", [req.params.cid, e.id]);
  if (!cat) throw notFound("Category not found.");
  const structural =
    (body.method && body.method !== cat.method) ||
    (body.maxChoices && body.maxChoices !== cat.max_choices) ||
    (body.points && body.points !== cat.points) ||
    (body.allowWriteIn !== undefined && body.allowWriteIn !== cat.allow_write_in) ||
    (body.voterGroups && JSON.stringify(body.voterGroups) !== JSON.stringify(cat.voter_groups ?? []));
  if (structural) await assertStructureEditable(e);
  await db.query(
    `UPDATE categories SET title = $1, description = $2, method = $3, max_choices = $4, points = $5, allow_write_in = $6, threshold_percent = $7, voter_groups = $8, sort_order = $9 WHERE id = $10`,
    [
      body.title ?? cat.title,
      body.description ?? cat.description,
      body.method ?? cat.method,
      body.maxChoices ?? cat.max_choices,
      body.points ?? cat.points,
      body.allowWriteIn ?? cat.allow_write_in,
      body.thresholdPercent !== undefined ? body.thresholdPercent || null : cat.threshold_percent,
      body.voterGroups ?? cat.voter_groups ?? [],
      body.sortOrder ?? cat.sort_order,
      cat.id,
    ],
  );
  res.json({ ok: true });
}));

router.delete("/events/:id/categories/:cid", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const used = await db.one("SELECT 1 FROM votes WHERE category_id::text = $1 LIMIT 1", [req.params.cid]);
  if (used) throw conflict("This category already has votes and can't be removed.");
  await assertStructureEditable(e);
  await db.query("DELETE FROM categories WHERE id::text = $1 AND event_id = $2", [req.params.cid, e.id]);
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "category.deleted", detail: { id: req.params.cid } });
  res.json({ ok: true });
}));

// ---------------- Options (candidates / contestants / answers) ----------------
const optionInput = z.object({
  categoryId: uuid,
  name: z.string().trim().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  imageFileId: uuid.nullable().optional(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,12}$/, "Codes use 2–12 letters/numbers.").optional(),
  sortOrder: z.number().int().optional(),
  status: z.enum(["approved", "pending", "rejected"]).optional(),
});

router.post("/events/:id/options", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(optionInput, req.body);
  const cat = await db.one("SELECT id FROM categories WHERE id = $1 AND event_id = $2", [body.categoryId, e.id]);
  if (!cat) throw notFound("Category not found.");
  await assertStructureEditable(e);
  if (body.code && (await db.one("SELECT 1 FROM options WHERE event_id = $1 AND code = $2", [e.id, body.code]))) throw conflict("That code is already used in this event.");
  const max = await db.one<{ n: number }>("SELECT COALESCE(MAX(sort_order),-1)::int AS n FROM options WHERE category_id = $1", [cat.id]);
  const row = await db.one(
    `INSERT INTO options (event_id, category_id, name, subtitle, description, image_file_id, code, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [e.id, cat.id, body.name, body.subtitle ?? "", body.description ?? "", body.imageFileId ?? null, body.code ?? (await nextOptionCode(e.id)), body.sortOrder ?? (max?.n ?? -1) + 1],
  );
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "option.created", detail: { name: body.name } });
  res.status(201).json({ id: row!.id });
}));

router.patch("/events/:id/options/:oid", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(optionInput.partial(), req.body);
  const opt = await db.one("SELECT * FROM options WHERE id::text = $1 AND event_id = $2", [req.params.oid, e.id]);
  if (!opt) throw notFound("Option not found.");
  if ((body.categoryId && body.categoryId !== opt.category_id) || (body.status && body.status !== opt.status && opt.status === "approved")) await assertStructureEditable(e);
  if (body.code && body.code !== opt.code && (await db.one("SELECT 1 FROM options WHERE event_id = $1 AND code = $2", [e.id, body.code]))) throw conflict("That code is already used in this event.");
  if (body.categoryId && !(await db.one("SELECT 1 FROM categories WHERE id = $1 AND event_id = $2", [body.categoryId, e.id]))) throw notFound("Category not found.");
  await db.query(
    `UPDATE options SET category_id = $1, name = $2, subtitle = $3, description = $4, image_file_id = $5, code = $6, sort_order = $7, status = $8 WHERE id = $9`,
    [
      body.categoryId ?? opt.category_id,
      body.name ?? opt.name,
      body.subtitle ?? opt.subtitle,
      body.description ?? opt.description,
      body.imageFileId !== undefined ? body.imageFileId : opt.image_file_id,
      body.code ?? opt.code,
      body.sortOrder ?? opt.sort_order,
      body.status ?? opt.status,
      opt.id,
    ],
  );
  if (body.status && body.status !== opt.status) await audit(req, { orgId: req.org!.id, eventId: e.id, action: `option.${body.status}`, detail: { name: opt.name } });
  res.json({ ok: true });
}));

router.delete("/events/:id/options/:oid", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const used = await db.one("SELECT 1 FROM votes WHERE option_id::text = $1 LIMIT 1", [req.params.oid]);
  if (used) throw conflict("This option already has votes and can't be removed.");
  await assertStructureEditable(e);
  const opt = await db.one("DELETE FROM options WHERE id::text = $1 AND event_id = $2 RETURNING name", [req.params.oid, e.id]);
  if (opt) await audit(req, { orgId: req.org!.id, eventId: e.id, action: "option.deleted", detail: { name: opt.name } });
  res.json({ ok: true });
}));

// ---------------- Voter roster ----------------
const voterInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(200).or(z.literal("")).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  ref: z.string().trim().max(100).nullable().optional(),
  weight: z.number().positive().max(1e12).optional(),
  group: z.string().trim().max(60).nullable().optional(),
});

async function assertVoterCapacity(orgPlan: string, e: EventRow, adding: number) {
  const limits = await eventLimits(orgPlan, null, e.pass_voters);
  if (limits.maxVoters === null) return;
  const r = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM voters WHERE event_id = $1", [e.id]);
  if ((r?.n ?? 0) + adding > limits.maxVoters) {
    throw new HttpError(402, `This event allows ${limits.maxVoters} voters on your current plan. Upgrade your plan or buy an event pass to add more.`);
  }
}

async function uniqueAccessCode(eventId: string, q: Queryable = db) {
  for (let i = 0; i < 10; i++) {
    const code = humanCode(8);
    if (!(await q.one("SELECT 1 FROM voters WHERE event_id = $1 AND access_code = $2", [eventId, code]))) return code;
  }
  throw new HttpError(500, "Could not generate a unique access code.");
}

router.get("/events/:id/voters", h(async (req, res) => {
  const e = await ev(req);
  const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const page = Math.max(1, Number(req.query.page ?? 1));
  const size = Math.min(200, Math.max(10, Number(req.query.size ?? 50)));
  const showCodes = ["owner", "admin", "officer"].includes(req.org!.role);
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const conds: string[] = [];
  const params: unknown[] = [e.id];
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(v.name ILIKE $${params.length} OR v.email ILIKE $${params.length} OR v.ref ILIKE $${params.length} OR v.phone ILIKE $${params.length} OR v.group_name ILIKE $${params.length})`);
  }
  if (status === "voted") conds.push("v.voted_at IS NOT NULL");
  if (status === "not_voted") conds.push("v.voted_at IS NULL");
  const where = conds.length ? `AND ${conds.join(" AND ")}` : "";
  const rows = await db.query(
    `SELECT v.id, v.name, v.email, v.phone, v.ref, v.weight::float8 AS weight, v.access_code, v.invited_at, v.voted_at, v.voted_by_proxy, v.created_at,
            v.group_name, v.proxy_voter_id, p.name AS proxy_name, v.last_reminded_at
       FROM voters v LEFT JOIN voters p ON p.id = v.proxy_voter_id
      WHERE v.event_id = $1 ${where} ORDER BY v.name LIMIT ${size} OFFSET ${(page - 1) * size}`,
    params,
  );
  const total = await db.one<{ n: number; voted: number }>(`SELECT count(*)::int AS n, count(v.voted_at)::int AS voted FROM voters v WHERE v.event_id = $1 ${where}`, params);
  const link = `${config.publicUrl}/e/${e.slug}`;
  res.json({
    total: total?.n ?? 0,
    voted: total?.voted ?? 0,
    page,
    size,
    voters: rows.map((r) => ({
      ...r,
      access_code: showCodes ? r.access_code : null,
      whatsapp: showCodes && !r.voted_at ? whatsappLink(r.phone, `Hello ${r.name}, your access code for "${e.title}" is ${r.access_code}. Vote here: ${link}?code=${r.access_code}`) : null,
    })),
  });
}));

router.post("/events/:id/voters", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(voterInput, req.body);
  await assertVoterCapacity(req.org!.plan, e, 1);
  try {
    const row = await db.one(
      `INSERT INTO voters (event_id, name, email, phone, ref, weight, group_name, access_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, access_code`,
      [e.id, body.name, body.email || null, body.phone || null, body.ref || null, body.weight ?? 1, body.group || null, await uniqueAccessCode(e.id)],
    );
    await audit(req, { orgId: req.org!.id, eventId: e.id, action: "voter.added", detail: { name: body.name } });
    res.status(201).json(row);
  } catch (err: any) {
    if (err?.code === "23505" || /duplicate key/.test(err?.message ?? "")) throw conflict("A voter with that email is already on this list.");
    throw err;
  }
}));

router.post("/events/:id/voters/import", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(z.object({ voters: z.array(voterInput).min(1).max(20000), skipDuplicates: z.boolean().default(true) }), req.body);
  await assertVoterCapacity(req.org!.plan, e, body.voters.length);
  const result = await db.tx(async (q) => {
    const existing = new Set((await q.query("SELECT lower(email) AS email FROM voters WHERE event_id = $1 AND email IS NOT NULL", [e.id])).map((r) => r.email));
    const codes = new Set((await q.query("SELECT access_code FROM voters WHERE event_id = $1", [e.id])).map((r) => r.access_code));
    let added = 0;
    const skipped: string[] = [];
    for (const v of body.voters) {
      const email = v.email ? v.email.toLowerCase() : null;
      if (email && existing.has(email)) {
        if (!body.skipDuplicates) throw conflict(`Duplicate email: ${email}`);
        skipped.push(email);
        continue;
      }
      let code = humanCode(8);
      while (codes.has(code)) code = humanCode(8);
      codes.add(code);
      if (email) existing.add(email);
      await q.query("INSERT INTO voters (event_id, name, email, phone, ref, weight, group_name, access_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [e.id, v.name, email, v.phone || null, v.ref || null, v.weight ?? 1, v.group || null, code]);
      added++;
    }
    await audit(req, { orgId: req.org!.id, eventId: e.id, action: "voters.imported", detail: { added, skipped: skipped.length } }, q);
    return { added, skipped: skipped.length };
  });
  res.json(result);
}));

router.patch("/events/:id/voters/:vid", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(voterInput.partial().extend({ proxyVoterId: uuid.nullable().optional() }), req.body);
  const v = await db.one("SELECT * FROM voters WHERE id::text = $1 AND event_id = $2", [req.params.vid, e.id]);
  if (!v) throw notFound("Voter not found.");
  if (v.voted_at && body.weight !== undefined && Number(body.weight) !== Number(v.weight)) throw conflict("Weight can't change after this voter has voted.");
  let proxy = v.proxy_voter_id;
  if (body.proxyVoterId !== undefined) {
    if (v.voted_at) throw conflict("This voter has already voted, so a proxy can't be changed.");
    if (body.proxyVoterId) {
      if (body.proxyVoterId === v.id) throw new HttpError(400, "A voter can't be their own proxy.");
      const holder = await db.one("SELECT id, voted_at, proxy_voter_id FROM voters WHERE id = $1 AND event_id = $2", [body.proxyVoterId, e.id]);
      if (!holder) throw notFound("Proxy holder not found on this voter list.");
      if (holder.voted_at) throw conflict("The proxy holder has already voted.");
      if (holder.proxy_voter_id) throw conflict("The chosen proxy holder has appointed a proxy themselves.");
    }
    proxy = body.proxyVoterId;
  }
  try {
    await db.query("UPDATE voters SET name = $1, email = $2, phone = $3, ref = $4, weight = $5, group_name = $6, proxy_voter_id = $7 WHERE id = $8", [
      body.name ?? v.name,
      body.email === undefined ? v.email : body.email || null,
      body.phone === undefined ? v.phone : body.phone || null,
      body.ref === undefined ? v.ref : body.ref || null,
      body.weight ?? v.weight,
      body.group === undefined ? v.group_name : body.group || null,
      proxy,
      v.id,
    ]);
    if (body.proxyVoterId !== undefined) await audit(req, { orgId: req.org!.id, eventId: e.id, action: proxy ? "voter.proxy_assigned" : "voter.proxy_revoked", detail: { name: v.name } });
  } catch (err: any) {
    if (err?.code === "23505" || /duplicate key/.test(err?.message ?? "")) throw conflict("A voter with that email is already on this list.");
    throw err;
  }
  res.json({ ok: true });
}));

router.post("/events/:id/voters/:vid/reset-code", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const code = await uniqueAccessCode(e.id);
  const row = await db.one("UPDATE voters SET access_code = $1 WHERE id::text = $2 AND event_id = $3 AND voted_at IS NULL RETURNING id", [code, req.params.vid, e.id]);
  if (!row) throw conflict("Voter not found or has already voted.");
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "voter.code_reset", detail: { voterId: req.params.vid } });
  res.json({ access_code: code });
}));

router.delete("/events/:id/voters/:vid", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const row = await db.one("DELETE FROM voters WHERE id::text = $1 AND event_id = $2 AND voted_at IS NULL RETURNING name", [req.params.vid, e.id]);
  if (!row) throw conflict("Voter not found, or they have already voted (voters who voted can't be removed).");
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "voter.removed", detail: { name: row.name } });
  res.json({ ok: true });
}));

async function notifyVoters(req: Request, e: EventRow, rows: any[], kind: "invite" | "reminder", useSms: boolean) {
  let emailed = 0;
  let texted = 0;
  let logged = 0;
  for (const v of rows) {
    const url = `${config.publicUrl}/e/${e.slug}?code=${v.access_code}`;
    const closes = e.ends_at ? `Voting closes ${new Date(e.ends_at).toUTCString()}.` : "";
    if (v.email) {
      const r = await sendMail(
        v.email,
        kind === "invite" ? `Your voting access for ${e.title}` : `Reminder: you haven't voted yet in ${e.title}`,
        [
          `Hello ${v.name},`,
          kind === "invite" ? `You are on the voter list for "${e.title}" (${req.org?.name ?? ""}).` : `This is a friendly reminder that you haven't voted yet in "${e.title}".`,
          `Your personal access code is: ${v.access_code}`,
          closes,
          "Keep this code private — it lets you cast your ballot once.",
        ].filter(Boolean),
        { label: "Open my ballot", url },
      );
      if (r.delivered) emailed++;
      else logged++;
    }
    if (useSms && v.phone) {
      const r = await sendSms(v.phone, `${kind === "invite" ? "Vote" : "Reminder: vote"} in ${e.title}. Code: ${v.access_code} ${url}`);
      if (r.delivered) texted++;
    }
    await db.query(kind === "invite" ? "UPDATE voters SET invited_at = now() WHERE id = $1" : "UPDATE voters SET last_reminded_at = now() WHERE id = $1", [v.id]);
  }
  return { processed: rows.length, emailed, texted, loggedOnly: logged };
}

router.post("/events/:id/voters/invite", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(z.object({ voterIds: z.array(uuid).optional(), onlyNotInvited: z.boolean().default(true), sms: z.boolean().default(false) }), req.body);
  const limits = await eventLimits(req.org!.plan, null, e.pass_voters);
  const useSms = body.sms && limits.sms && smsEnabled();
  const rows = await db.query(
    `SELECT id, name, email, phone, access_code FROM voters WHERE event_id = $1 AND (email IS NOT NULL ${useSms ? "OR phone IS NOT NULL" : ""}) AND voted_at IS NULL
       ${body.voterIds ? "AND id = ANY($2::uuid[])" : body.onlyNotInvited ? "AND invited_at IS NULL" : ""}`,
    body.voterIds ? [e.id, body.voterIds] : [e.id],
  );
  const result = await notifyVoters(req, e, rows, "invite", useSms);
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "voters.invited", detail: { count: rows.length, sms: useSms } });
  res.json(result);
}));

router.post("/events/:id/voters/remind", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(z.object({ sms: z.boolean().default(false) }), req.body);
  const limits = await eventLimits(req.org!.plan, null, e.pass_voters);
  const useSms = body.sms && limits.sms && smsEnabled();
  const rows = await db.query(
    `SELECT id, name, email, phone, access_code FROM voters WHERE event_id = $1 AND voted_at IS NULL AND proxy_voter_id IS NULL
        AND (email IS NOT NULL ${useSms ? "OR phone IS NOT NULL" : ""})`,
    [e.id],
  );
  const result = await notifyVoters(req, e, rows, "reminder", useSms);
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "voters.reminded", detail: { count: rows.length, sms: useSms } });
  res.json(result);
}));

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

router.get("/events/:id/voters.csv", requireRole("officer"), h(async (req, res) => {
  const e = await ev(req);
  const rows = await db.query("SELECT name, email, phone, ref, group_name, weight::float8 AS weight, access_code, voted_at, voted_by_proxy FROM voters WHERE event_id = $1 ORDER BY name", [e.id]);
  const link = `${config.publicUrl}/e/${e.slug}`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${e.slug}-voters.csv"`);
  res.send(toCsv([["name", "email", "phone", "ref", "group", "weight", "access_code", "voting_link", "voted_at", "voted_by_proxy"], ...rows.map((r) => [r.name, r.email, r.phone, r.ref, r.group_name, r.weight, r.access_code, `${link}?code=${r.access_code}`, r.voted_at ? new Date(r.voted_at).toISOString() : "", r.voted_by_proxy ? "yes" : ""])]));
}));

// ---------------- Results, votes, payments ----------------
router.get("/events/:id/results", h(async (req, res) => {
  const e = await ev(req);
  const t = await tally(e.id, db, e.settings);
  const turnout = await db.one(`SELECT count(*)::int AS voters, count(voted_at)::int AS voted, COALESCE(SUM(weight),0)::float8 AS weight_total, COALESCE(SUM(weight) FILTER (WHERE voted_at IS NOT NULL),0)::float8 AS weight_voted FROM voters WHERE event_id = $1`, [e.id]);
  res.json({ ...t, turnout, state: votingState(e), resultsPublished: e.results_published });
}));

router.get("/events/:id/results.csv", h(async (req, res) => {
  const e = await ev(req);
  const t = await tally(e.id, db, e.settings);
  const rows: unknown[][] = [["category", "method", "seats", "option", "write_in", "code", "votes_or_points", "average_score", "percent", "winner", "threshold", "threshold_met"]];
  for (const c of t.categories)
    for (const o of c.options)
      rows.push([c.title, c.method, c.seats, o.name, o.writeIn ? "yes" : "", o.code, o.votes, o.average ?? "", o.percent.toFixed(2), o.winner ? "yes" : "", c.threshold ? `${c.threshold.percent}%` : "", c.threshold ? (c.threshold.met ? "yes" : "no") : ""]);
  if (t.quorum) rows.push([], ["quorum", `${t.quorum.percent}%`, "", `required ${t.quorum.required}`, "", "", `achieved ${t.quorum.achieved}`, "", "", t.quorum.met ? "met" : "not met"]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${e.slug}-results.csv"`);
  res.send(toCsv(rows));
}));

router.get("/events/:id/votes", h(async (req, res) => {
  const e = await ev(req);
  const rows = await db.query(
    `SELECT v.id, v.quantity::float8 AS quantity, v.source, v.created_at, v.voter_info, o.name AS option_name, c.title AS category_title, p.reference
       FROM votes v JOIN options o ON o.id = v.option_id JOIN categories c ON c.id = v.category_id LEFT JOIN payments p ON p.id = v.payment_id
      WHERE v.event_id = $1 AND v.source <> 'ballot' ORDER BY v.created_at DESC LIMIT 500`,
    [e.id],
  );
  res.json(rows);
}));

router.post("/events/:id/manual-votes", requireRole("admin"), h(async (req, res) => {
  const e = await ev(req);
  const body = parse(z.object({ optionId: uuid, quantity: z.number().int().min(-1_000_000).max(1_000_000).refine((n) => n !== 0, "Quantity can't be zero."), note: z.string().trim().min(3).max(300) }), req.body);
  if (e.settings.mode !== "tally") throw new HttpError(400, "Manual votes are only available for contest/tally events.");
  const opt = await db.one("SELECT id, category_id, name FROM options WHERE id = $1 AND event_id = $2", [body.optionId, e.id]);
  if (!opt) throw notFound("Option not found.");
  await db.query("INSERT INTO votes (event_id, category_id, option_id, quantity, source, voter_info) VALUES ($1,$2,$3,$4,'manual',$5)", [e.id, opt.category_id, opt.id, body.quantity, JSON.stringify({ note: body.note, by: req.user!.email })]);
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "votes.manual_adjustment", detail: { option: opt.name, quantity: body.quantity, note: body.note } });
  res.status(201).json({ ok: true });
}));

router.get("/events/:id/payments", h(async (req, res) => {
  const e = await ev(req);
  const rows = await db.query(
    `SELECT p.reference, p.provider, p.status, p.amount_minor::float8 AS amount_minor, p.platform_fee_minor::float8 AS platform_fee_minor, p.currency, p.quantity,
            p.payer_name, p.payer_email, p.payer_phone, p.created_at, p.paid_at, o.name AS option_name,
            p.raw->>'manualLabel' AS manual_label, p.raw->'claim' AS claim
       FROM payments p LEFT JOIN options o ON o.id = p.option_id WHERE p.event_id = $1 ORDER BY p.created_at DESC LIMIT 1000`,
    [e.id],
  );
  res.json(rows);
}));

router.post("/payments/:ref/verify", requireRole("officer"), h(async (req, res) => {
  const p = await db.one("SELECT org_id FROM payments WHERE reference = $1", [req.params.ref]);
  if (!p || p.org_id !== req.org!.id) throw notFound("Payment not found.");
  res.json(await verifyAndFinalize(String(req.params.ref)));
}));

// ---------------- Event passes (one-off upgrade for a single event) ----------------
router.post("/events/:id/pass/checkout", requireRole("admin"), h(async (req, res) => {
  const e = await ev(req);
  const { passId } = parse(z.object({ passId: z.string() }), req.body);
  const platform = await getPlatformConfig();
  const pass = platform.passes.find((p) => p.id === passId);
  if (!pass) throw notFound("Pass not found.");
  if ((e.pass_voters ?? 0) >= pass.voters) throw conflict("This event already has a pass of this size or larger.");
  const result = await startPayment({
    kind: "pass",
    provider: platform.billingProvider,
    orgId: req.org!.id,
    eventId: e.id,
    planId: pass.id,
    quantity: pass.voters,
    amountMinor: Math.round(pass.price * 100),
    currency: platform.currency,
    email: req.user!.email,
    name: req.user!.name,
    description: `Event pass (${pass.name}) — ${e.title}`,
    returnPath: `/app/events/${e.id}`,
  });
  await audit(req, { orgId: req.org!.id, eventId: e.id, action: "pass.checkout_started", detail: { passId, reference: result.reference } });
  res.json(result);
}));

router.get("/events/:id/comments", h(async (req, res) => {
  const e = await ev(req);
  const rows = await db.query("SELECT comment, created_at FROM ballots WHERE event_id = $1 AND comment IS NOT NULL ORDER BY created_at DESC LIMIT 1000", [e.id]);
  res.json(rows);
}));

router.post("/payments/:ref/:decision", requireRole("officer"), h(async (req, res) => {
  if (!["approve", "reject"].includes(String(req.params.decision))) throw notFound();
  const approve = req.params.decision === "approve";
  const r = await decideManualPayment(String(req.params.ref), req.org!.id, approve, req.user!.email);
  await audit(req, { orgId: req.org!.id, action: approve ? "payment.manual_approved" : "payment.manual_rejected", detail: { reference: req.params.ref } });
  res.json(r);
}));

export default router;
