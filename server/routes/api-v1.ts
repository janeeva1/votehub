import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { HttpError, h, parse } from "../http";
import { humanCode, sha256 } from "../security";
import { getEventForOrg, tally, votingState } from "../services/events";
import { activePlan } from "../services/limits";

/**
 * Public REST API for integrations (Pro plan and above).
 * Authenticate with:  Authorization: Bearer vh_live_…
 */
const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Rate limit exceeded." } }));

router.use(h(async (req, _res, next) => {
  const auth = req.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key) throw new HttpError(401, "Missing API key. Send Authorization: Bearer <key>.");
  const row = await db.one(
    `SELECT k.id, k.org_id, o.plan, o.plan_expires_at, o.suspended FROM api_keys k JOIN organizations o ON o.id = k.org_id WHERE k.key_hash = $1`,
    [sha256(key)],
  );
  if (!row) throw new HttpError(401, "Invalid API key.");
  if (row.suspended) throw new HttpError(403, "Organization suspended.");
  if (!(await activePlan(row.plan, row.plan_expires_at)).api) throw new HttpError(402, "API access requires the Pro plan or above.");
  await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]);
  (req as any).apiOrgId = row.org_id;
  next();
}));

const orgId = (req: any) => req.apiOrgId as string;

router.get("/events", h(async (req, res) => {
  const rows = await db.query("SELECT id, slug, title, status, starts_at, ends_at, settings, created_at FROM events WHERE org_id = $1 ORDER BY created_at DESC", [orgId(req)]);
  res.json({
    data: rows.map((e) => ({ id: e.id, slug: e.slug, title: e.title, status: e.status, state: votingState(e as any), startsAt: e.starts_at, endsAt: e.ends_at, mode: e.settings?.mode, url: `${config.publicUrl}/e/${e.slug}` })),
  });
}));

router.get("/events/:id/results", h(async (req, res) => {
  const e = await getEventForOrg(String(req.params.id), orgId(req));
  res.json({ data: await tally(e.id, db, e.settings) });
}));

router.get("/events/:id/turnout", h(async (req, res) => {
  const e = await getEventForOrg(String(req.params.id), orgId(req));
  const t = await db.one("SELECT count(*)::int AS voters, count(voted_at)::int AS voted FROM voters WHERE event_id = $1", [e.id]);
  const b = await db.one("SELECT count(*)::int AS n FROM ballots WHERE event_id = $1", [e.id]);
  res.json({ data: { voters: t?.voters ?? 0, voted: t?.voted ?? 0, ballots: b?.n ?? 0 } });
}));

router.get("/events/:id/voters", h(async (req, res) => {
  const e = await getEventForOrg(String(req.params.id), orgId(req));
  const rows = await db.query("SELECT id, name, email, phone, ref, group_name AS group, weight::float8 AS weight, voted_at IS NOT NULL AS voted FROM voters WHERE event_id = $1 ORDER BY name LIMIT 50000", [e.id]);
  res.json({ data: rows });
}));

router.post("/events/:id/voters", h(async (req, res) => {
  const e = await getEventForOrg(String(req.params.id), orgId(req));
  const body = parse(
    z.object({
      voters: z.array(z.object({ name: z.string().min(1).max(200), email: z.string().email().optional(), phone: z.string().max(40).optional(), ref: z.string().max(100).optional(), group: z.string().max(60).optional(), weight: z.number().positive().optional() })).min(1).max(5000),
    }),
    req.body,
  );
  const added: { email?: string; ref?: string; accessCode: string }[] = [];
  await db.tx(async (q) => {
    for (const v of body.voters) {
      const email = v.email?.toLowerCase() ?? null;
      if (email && (await q.one("SELECT 1 FROM voters WHERE event_id = $1 AND lower(email) = $2", [e.id, email]))) continue;
      let code = humanCode(8);
      while (await q.one("SELECT 1 FROM voters WHERE event_id = $1 AND access_code = $2", [e.id, code])) code = humanCode(8);
      await q.query("INSERT INTO voters (event_id, name, email, phone, ref, group_name, weight, access_code) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [e.id, v.name, email, v.phone ?? null, v.ref ?? null, v.group ?? null, v.weight ?? 1, code]);
      added.push({ email: email ?? undefined, ref: v.ref, accessCode: code });
    }
  });
  res.status(201).json({ data: { added: added.length, voters: added } });
}));

export default router;
