import { serveAd } from "../services/ads";
import { Router, type Request, type RequestHandler } from "express";
import QRCode from "qrcode";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { HttpError, conflict, h, notFound, parse, clientIp } from "../http";
import { hmac, humanCode, numericCode, randomToken, sha256, signToken, verifyPassword, verifyToken } from "../security";
import { eventLimits } from "../services/limits";
import { emitWebhook } from "../services/outbound";
import { assertVotingOpen, getEventBySlug, publicResultsVisible, tally, votingState } from "../services/events";
import { sendMail, mailEnabled } from "../services/mailer";
import { eventMethods, startPayment, verifyAndFinalize } from "../services/payments";
import { toMinor, type EventSettings } from "../../shared/model";
import { audit } from "../services/audit";
import { decideRegistrations, registrationOpen } from "../services/registrations";

const router = Router();
const DEVICE_COOKIE = "vh_device";

const voteLimiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many requests. Please slow down." } });
const codeLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many attempts. Please wait a few minutes." } });

/** Gives each browser a stable anonymous id (used to limit free votes in public mode). */
export const deviceCookie: RequestHandler = (req, res, next) => {
  let id = req.cookies?.[DEVICE_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{20,64}$/.test(id)) {
    id = randomToken(18);
    res.cookie(DEVICE_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: config.isProd && config.publicUrl.startsWith("https://"), maxAge: 400 * 86400_000, path: "/" });
  }
  (req as any).deviceId = id;
  next();
};

type VoterToken = { e: string; v?: string; m?: string };

const limitsOf = (e: { org_plan: string; org_plan_expires_at: any; pass_voters?: number | null }) => eventLimits(e.org_plan, e.org_plan_expires_at, e.pass_voters);

function publicSettings(s: EventSettings) {
  return {
    mode: s.mode,
    access: s.access,
    collect: s.collect,
    freeVotes: s.freeVotes,
    paid: { enabled: s.paid.enabled, currency: s.paid.currency, pricePerVote: s.paid.pricePerVote, minVotes: s.paid.minVotes, maxVotes: s.paid.maxVotes, bundles: s.paid.bundles, testMode: s.paid.provider === "test" || s.paid.methods.includes("test") },
    results: s.results,
    ballot: { allowAbstain: s.ballot.allowAbstain, receipts: s.ballot.receipts, weighted: s.ballot.weighted, secret: s.ballot.secret, allowComments: s.ballot.allowComments },
    security: { passwordProtected: s.security.passwordProtected, botProtection: s.security.botProtection },
    nominations: s.nominations,
    display: s.display,
  };
}

async function publicResults(e: Awaited<ReturnType<typeof getEventBySlug>>) {
  if (!publicResultsVisible(e)) return null;
  const t = await tally(e.id, db, e.settings);
  const { showCounts, showPercent } = e.settings.results;
  return {
    ballots: showCounts ? t.ballots : null,
    quorum: t.quorum ?? null,
    categories: t.categories.map((c) => ({
      id: c.id,
      title: c.title,
      method: c.method,
      totalVotes: showCounts ? c.totalVotes : null,
      seats: c.seats,
      threshold: c.threshold,
      quota: showCounts ? c.quota : undefined,
      options: c.options.map((o) => ({ id: o.id, name: o.name, writeIn: o.writeIn, votes: showCounts ? o.votes : null, average: showCounts ? o.average : undefined, percent: showPercent ? o.percent : null, winner: o.winner })),
      rounds: showCounts ? c.rounds : undefined,
    })),
  };
}

const ev = (req: Request) => getEventBySlug(String(req.params.slug));

/** Public scoreboard numbers (only when the organizer switched "live progress" on). */
async function liveStats(e: Awaited<ReturnType<typeof getEventBySlug>>) {
  if (!e.settings.display.liveStats) return null;
  const roster = e.settings.access === "roster";
  const s = await db.one(
    `SELECT (SELECT count(*)::int FROM ballots WHERE event_id = $1) AS ballots,
            (SELECT COALESCE(SUM(quantity),0)::float8 FROM votes WHERE event_id = $1 AND source <> 'ballot') AS tally_votes,
            (SELECT count(*)::int FROM votes WHERE event_id = $1 AND source <> 'ballot' AND created_at > now() - interval '1 hour') AS tally_last_hour,
            (SELECT count(*)::int FROM ballots WHERE event_id = $1 AND created_at > now() - interval '1 hour') AS ballots_last_hour,
            GREATEST((SELECT max(created_at) FROM ballots WHERE event_id = $1), (SELECT max(created_at) FROM votes WHERE event_id = $1)) AS last_at,
            (SELECT count(*)::int FROM voters WHERE event_id = $1) AS eligible,
            (SELECT count(*)::int FROM voters WHERE event_id = $1 AND voted_at IS NOT NULL) AS voted,
            (SELECT count(*)::int FROM registrations WHERE event_id = $1) AS registered`,
    [e.id],
  );
  const tallyMode = e.settings.mode === "tally";
  return {
    eligible: roster ? s!.eligible : null,
    voted: roster ? s!.voted : null,
    turnoutPercent: roster && s!.eligible ? Math.round((s!.voted / s!.eligible) * 1000) / 10 : null,
    ballots: tallyMode ? null : s!.ballots,
    votes: tallyMode ? s!.tally_votes : null,
    lastHour: tallyMode ? s!.tally_last_hour : s!.ballots_last_hour,
    lastActivityAt: s!.last_at,
    registered: e.settings.registration.enabled ? s!.registered : null,
  };
}

function publicRegistration(e: Awaited<ReturnType<typeof getEventBySlug>>, groups: string[]) {
  const r = e.settings.registration;
  if (!r.enabled || e.settings.access !== "roster") return null;
  return {
    open: registrationOpen(e),
    autoApprove: r.autoApprove,
    phone: r.phone,
    ref: r.ref,
    refLabel: r.refLabel,
    askGroup: r.askGroup,
    groupLabel: r.groupLabel,
    groupOptions: r.groupOptions.length ? r.groupOptions : groups,
    questions: r.questions,
    message: r.message,
    closesAt: r.closesAt,
  };
}

router.get("/events/:slug", deviceCookie, h(async (req, res) => {
  const e = await ev(req);
  const plan = await limitsOf(e);
  const locked = !isUnlocked(e, typeof req.query.pt === "string" ? req.query.pt : null);
  const categories = locked ? [] : await db.query("SELECT id, title, description, method, max_choices, points, allow_write_in, voter_groups FROM categories WHERE event_id = $1 ORDER BY sort_order, created_at", [e.id]);
  const options = await db.query(
    "SELECT id, category_id, name, subtitle, description, image_file_id, code FROM options WHERE event_id = $1 AND status = 'approved' ORDER BY sort_order, created_at",
    [e.id],
  );
  res.json({
    slug: e.slug,
    title: e.title,
    description: e.description,
    coverFileId: e.cover_file_id,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    state: votingState(e),
    org: { name: e.org_name, logoFileId: e.org_branding?.logoFileId ?? null, primaryColor: e.org_branding?.primaryColor && e.org_branding.primaryColor !== "#286352" ? e.org_branding.primaryColor : null, website: e.org_branding?.website ?? null },
    showPlatformBranding: !plan.removeBranding,
    appName: config.appName,
    mailEnabled: mailEnabled(),
    settings: publicSettings(e.settings),
    paymentMethods: e.settings.mode === "tally" && e.settings.paid.enabled ? (await eventMethods(e.settings.paid, e.org_id)).map((m) => ({ id: m.id, label: m.label, kind: m.kind })) : [],
    categories: categories.map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      method: c.method,
      maxChoices: c.max_choices,
      points: c.points,
      allowWriteIn: c.allow_write_in,
      voterGroups: e.settings.access === "roster" ? c.voter_groups ?? [] : [],
      options: options.filter((o) => o.category_id === c.id).map((o) => ({ id: o.id, name: o.name, subtitle: o.subtitle, description: o.description, imageFileId: o.image_file_id, code: o.code })),
    })),
    results: locked ? null : await publicResults(e),
    live: locked ? null : await liveStats(e),
    registration: publicRegistration(e, [...new Set(categories.flatMap((c) => (c.voter_groups ?? []) as string[]))]),
    locked,
  });
}));

router.get("/events/:slug/live", h(async (req, res) => {
  const e = await ev(req);
  assertUnlocked(e, typeof req.query.pt === "string" ? req.query.pt : null);
  res.json({ state: votingState(e), live: await liveStats(e), results: await publicResults(e) });
}));

const registerLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many registrations from this network. Please try again later." } });

router.post("/events/:slug/register", registerLimiter, h(async (req, res) => {
  const e = await ev(req);
  const r = e.settings.registration;
  if (!r.enabled || e.settings.access !== "roster") throw notFound("This event doesn't take registrations.");
  if (!registrationOpen(e)) throw new HttpError(409, "Registration for this event is closed.");
  const need = (mode: string) => (mode === "required" ? z.string().trim().min(1, "This field is required.") : z.string().trim().optional());
  const body = parse(
    z.object({
      name: z.string().trim().min(2, "Please enter your full name.").max(200),
      email: z.string().trim().toLowerCase().email("Please enter a valid email address.").max(200),
      phone: r.phone === "off" ? z.any().optional() : need(r.phone).pipe(z.string().max(40).optional()),
      ref: r.ref === "off" ? z.any().optional() : need(r.ref).pipe(z.string().max(100).optional()),
      group: z.string().trim().max(60).optional(),
      answers: z.record(z.string().max(1000)).default({}),
      website: z.string().optional(),
    }),
    req.body,
  );
  if (body.website) throw new HttpError(400, "Your registration could not be accepted.");
  for (const q of r.questions) if (q.required && !body.answers[q.id]?.trim()) throw new HttpError(400, `Please answer: ${q.label}`);
  const answers = Object.fromEntries(r.questions.map((q) => [q.id, (body.answers[q.id] ?? "").trim()]).filter(([, v]) => v));
  const ref = r.ref === "off" ? null : (body.ref as string | undefined)?.trim() || null;
  const phone = r.phone === "off" ? null : (body.phone as string | undefined)?.trim() || null;
  const group = r.askGroup && body.group ? body.group : null;
  // Already on the voter list or already applied?
  const onList = await db.one("SELECT 1 FROM voters WHERE event_id = $1 AND (lower(email) = $2 OR ($3::text IS NOT NULL AND lower(ref) = lower($3)))", [e.id, body.email, ref]);
  const dup = await db.one("SELECT status, lower(email) = $2 AS same_email FROM registrations WHERE event_id = $1 AND (lower(email) = $2 OR ($3::text IS NOT NULL AND lower(ref) = lower($3)))", [e.id, body.email, ref]);
  if (onList) throw conflict("You're already on the voter list for this event. Check your email for your voting code, or contact the organizer.");
  if (dup) throw conflict(dup.same_email ? `This email has already registered (status: ${dup.status}).` : `This ${r.refLabel.toLowerCase()} has already been used to register. Contact the organizer if that wasn't you.`);
  const row = await db.one(
    "INSERT INTO registrations (event_id, name, email, phone, ref, group_name, answers, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [e.id, body.name, body.email, phone, ref, group, JSON.stringify(answers), clientIp(req)],
  );
  let status: "pending" | "approved" = "pending";
  if (r.autoApprove) {
    const d = await decideRegistrations(e, { id: e.org_id, name: e.org_name, plan: e.org_plan }, [row!.id], "approve", "auto-approval").catch(() => null);
    if (d?.changed) status = "approved";
  } else {
    // Let the organizer's team know someone is waiting (at most a handful of emails: first registrations of the hour).
    const recent = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM registrations WHERE event_id = $1 AND created_at > now() - interval '1 hour'", [e.id]);
    if ((recent?.n ?? 0) <= 3) {
      const staff = await db.query("SELECT u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role IN ('owner','admin','officer')", [e.org_id]);
      for (const s of staff) void sendMail(s.email, `New registration for ${e.title}`, [`${body.name} registered to vote in "${e.title}".`, "Review and shortlist registrations on the event's Voters tab."], { label: "Review registrations", url: `${config.publicUrl}/app/events/${e.id}/voters` }).catch(() => undefined);
    }
  }
  await audit(null, { orgId: e.org_id, eventId: e.id, action: "registration.submitted", actorLabel: body.email, detail: { name: body.name, autoApproved: status === "approved" } });
  res.status(201).json({ status, email: body.email });
}));

router.get("/events/:slug/results", h(async (req, res) => {
  const e = await ev(req);
  assertUnlocked(e, typeof req.query.pt === "string" ? req.query.pt : null);
  const results = await publicResults(e);
  if (!results) throw new HttpError(403, "Results are not public yet.");
  res.json(results);
}));

function assertHuman(e: { settings: EventSettings }, honeypot?: string) {
  if (e.settings.security.botProtection && honeypot) throw new HttpError(400, "Your vote could not be accepted.");
}

/** Password-protected events: voters first unlock the page with the shared password. */
function isUnlocked(e: { id: string; access_password_hash: string | null; settings: EventSettings }, passToken?: string | null) {
  if (!e.settings.security.passwordProtected || !e.access_password_hash) return true;
  const p = verifyToken<{ e: string; p: number }>(passToken);
  return Boolean(p && p.e === e.id && p.p === 1);
}
function assertUnlocked(e: { id: string; access_password_hash: string | null; settings: EventSettings }, passToken?: string | null) {
  if (!isUnlocked(e, passToken)) throw new HttpError(401, "Enter the event password to continue.");
}

router.post("/events/:slug/unlock", codeLimiter, h(async (req, res) => {
  const e = await ev(req);
  const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  if (!e.settings.security.passwordProtected || !e.access_password_hash) return res.json({ passToken: null });
  if (!(await verifyPassword(password, e.access_password_hash))) throw new HttpError(401, "That password isn't right.");
  res.json({ passToken: signToken({ e: e.id, p: 1 }, 12 * 3600) });
}));

// QR code of the voting page (SVG) — for posters, flyers and presenter screens.
router.get("/events/:slug/qr.svg", h(async (req, res) => {
  const e = await ev(req);
  const svg = await QRCode.toString(`${config.publicUrl}/e/${e.slug}`, { type: "svg", margin: 1, color: { dark: "#1d2f2a", light: "#ffffff" } });
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(svg);
}));

// ---- Access: roster code ----
router.post("/events/:slug/access", codeLimiter, h(async (req, res) => {
  const e = await ev(req);
  if (e.settings.access !== "roster") throw new HttpError(400, "This event does not use access codes.");
  const { code } = parse(z.object({ code: z.string().trim().toUpperCase().min(4).max(20) }), req.body);
  const voter = await db.one(
    `SELECT v.id, v.name, v.weight::float8 AS weight, v.voted_at, v.group_name,
            (SELECT count(*)::int FROM voters p WHERE p.proxy_voter_id = v.id AND p.voted_at IS NULL) AS proxies,
            (SELECT h.name FROM voters h WHERE h.id = v.proxy_voter_id) AS proxy_holder
       FROM voters v WHERE v.event_id = $1 AND v.access_code = $2`,
    [e.id, code.replace(/[^A-Z0-9]/g, "")],
  );
  if (!voter) throw new HttpError(401, "That access code wasn't recognised. Check it and try again.");
  const freeUsed = e.settings.mode === "tally" ? await freeVotesUsed(e.id, `voter:${voter.id}`, e.settings) : {};
  res.json({
    token: signToken({ e: e.id, v: voter.id } satisfies VoterToken, 3 * 3600),
    voter: { name: voter.name, weight: e.settings.ballot.weighted ? voter.weight : 1, hasVoted: Boolean(voter.voted_at), group: voter.group_name, proxies: voter.proxies, proxyHolder: voter.proxy_holder },
    freeUsed,
  });
}));

// ---- Access: email one-time code ----
router.post("/events/:slug/email-code", codeLimiter, h(async (req, res) => {
  const e = await ev(req);
  if (e.settings.access !== "email") throw new HttpError(400, "This event does not use email verification.");
  assertVotingOpen(e);
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200) }), req.body);
  const recent = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM email_codes WHERE event_id = $1 AND email = $2 AND created_at > now() - interval '15 minutes'", [e.id, email]);
  if ((recent?.n ?? 0) >= 5) throw new HttpError(429, "Too many codes requested. Please wait a few minutes.");
  const code = numericCode(6);
  await db.query("INSERT INTO email_codes (event_id, email, code_hash, expires_at) VALUES ($1,$2,$3, now() + interval '15 minutes')", [e.id, email, sha256(`${e.id}:${email}:${code}`)]);
  const r = await sendMail(email, `${code} is your voting code for ${e.title}`, [`Use this code to confirm your email and vote in "${e.title}":`, code, "It expires in 15 minutes. If you didn't request it, ignore this email."]);
  // Without SMTP (development), return the code so the flow can be tested.
  res.json({ sent: true, devCode: !r.delivered && !config.isProd ? code : undefined });
}));

router.post("/events/:slug/email-verify", codeLimiter, h(async (req, res) => {
  const e = await ev(req);
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), code: z.string().trim().regex(/^\d{6}$/) }), req.body);
  const row = await db.one(
    "SELECT id, code_hash, attempts FROM email_codes WHERE event_id = $1 AND email = $2 AND consumed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
    [e.id, body.email],
  );
  if (!row || row.attempts >= 5) throw new HttpError(401, "That code has expired. Request a new one.");
  if (row.code_hash !== sha256(`${e.id}:${body.email}:${body.code}`)) {
    await db.query("UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    throw new HttpError(401, "That code is incorrect.");
  }
  await db.query("UPDATE email_codes SET consumed_at = now() WHERE id = $1", [row.id]);
  const identity = `email:${body.email}`;
  const voted = e.settings.mode === "ballot" ? await db.one("SELECT 1 FROM participants WHERE event_id = $1 AND identity_hash = $2", [e.id, hmac(`${e.id}:${identity}`)]) : null;
  res.json({
    token: signToken({ e: e.id, m: body.email } satisfies VoterToken, 3 * 3600),
    voter: { email: body.email, hasVoted: Boolean(voted) },
    freeUsed: e.settings.mode === "tally" ? await freeVotesUsed(e.id, identity, e.settings) : {},
  });
}));

// ---- Identity & collected details ----
interface Identity {
  key: string;
  voterId?: string;
  weight: number;
  email?: string;
  group?: string | null;
}

async function resolveIdentity(req: Request, e: Awaited<ReturnType<typeof getEventBySlug>>, token: string | undefined): Promise<Identity> {
  const payload = verifyToken<VoterToken>(token);
  if (e.settings.access === "roster") {
    if (!payload || payload.e !== e.id || !payload.v) throw new HttpError(401, "Enter your access code to vote.");
    const voter = await db.one("SELECT id, weight::float8 AS weight, email, group_name FROM voters WHERE id = $1 AND event_id = $2", [payload.v, e.id]);
    if (!voter) throw new HttpError(401, "Your access is no longer valid.");
    return { key: `voter:${voter.id}`, voterId: voter.id, weight: e.settings.ballot.weighted ? Number(voter.weight) : 1, email: voter.email ?? undefined, group: voter.group_name };
  }
  if (e.settings.access === "email") {
    if (!payload || payload.e !== e.id || !payload.m) throw new HttpError(401, "Confirm your email to vote.");
    return { key: `email:${payload.m}`, weight: 1, email: payload.m };
  }
  return { key: `device:${(req as any).deviceId}`, weight: 1 };
}

const detailsSchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().toLowerCase().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
});
function collectDetails(s: EventSettings, input: z.infer<typeof detailsSchema>, identity: Identity) {
  const out: Record<string, string> = {};
  const check = (field: "name" | "email" | "phone", label: string) => {
    const mode = s.collect[field];
    let value = input[field]?.trim() ?? "";
    if (field === "email" && !value && identity.email) value = identity.email;
    if (mode === "required" && !value) throw new HttpError(400, `Please enter your ${label}.`);
    if (mode !== "off" && value) {
      if (field === "email" && !z.string().email().safeParse(value).success) throw new HttpError(400, "Please enter a valid email address.");
      if (field === "phone" && !/^[+\d][\d\s()-]{5,}$/.test(value)) throw new HttpError(400, "Please enter a valid phone number.");
      out[field] = value;
    }
  };
  check("name", "name");
  check("email", "email");
  check("phone", "phone number");
  return out;
}

async function freeVotesUsed(eventId: string, identityKey: string, s: EventSettings): Promise<Record<string, number>> {
  const rows = await db.query(
    `SELECT category_id, count(*)::int AS n FROM votes WHERE event_id = $1 AND identity_hash = $2 AND source = 'free'
       ${s.freeVotes.period === "daily" ? "AND created_at >= date_trunc('day', now())" : ""} GROUP BY category_id`,
    [eventId, hmac(`${eventId}:${identityKey}`)],
  );
  return Object.fromEntries(rows.map((r) => [r.category_id, r.n]));
}

async function assertCapacity(e: Awaited<ReturnType<typeof getEventBySlug>>) {
  const plan = await limitsOf(e);
  if (plan.maxBallots === null) return;
  const r = await db.one<{ n: number }>(
    e.settings.mode === "ballot" ? "SELECT count(*)::int AS n FROM ballots WHERE event_id = $1" : "SELECT count(*)::int AS n FROM votes WHERE event_id = $1 AND source = 'free'",
    [e.id],
  );
  if ((r?.n ?? 0) >= plan.maxBallots) throw new HttpError(402, "This event has reached its voting capacity. Please contact the organizer.");
}

// ---- Ballot submission (ballot mode) ----
const choiceValue = z.union([z.array(z.string().uuid()).max(200), z.record(z.string().uuid(), z.number().min(0).max(100000))]);

/** Categories a voter may vote on (voter groups only apply to voter-list events). */
export function appliesTo(c: { voter_groups?: string[] | null } | Record<string, any>, access: string, group?: string | null) {
  const groups = c.voter_groups ?? [];
  if (access !== "roster" || !groups.length) return true;
  return Boolean(group && groups.map((g: string) => g.toLowerCase()).includes(group.toLowerCase()));
}

router.post("/events/:slug/ballot", deviceCookie, voteLimiter, h(async (req, res) => {
  const e = await ev(req);
  if (e.org_suspended) throw new HttpError(403, "Voting for this organization is suspended.");
  if (e.settings.mode !== "ballot") throw new HttpError(400, "This event uses per-entry voting.");
  assertVotingOpen(e);
  const body = parse(
    detailsSchema.extend({
      token: z.string().optional(),
      passToken: z.string().optional(),
      website: z.string().optional(),
      choices: z.record(z.string().uuid(), choiceValue),
      writeIns: z.record(z.string().uuid(), z.string().trim().max(120)).optional(),
      comment: z.string().trim().max(1000).optional(),
    }),
    req.body,
  );
  assertHuman(e, body.website);
  assertUnlocked(e, body.passToken);
  const identity = await resolveIdentity(req, e, body.token);
  const details = collectDetails(e.settings, body, identity);
  await assertCapacity(e);

  const categories = await db.query("SELECT id, title, method, max_choices, points, allow_write_in, voter_groups FROM categories WHERE event_id = $1", [e.id]);
  const options = await db.query("SELECT id, category_id, name FROM options WHERE event_id = $1 AND status = 'approved'", [e.id]);
  const abstainOk = e.settings.ballot.allowAbstain;
  const clean: Record<string, string[] | Record<string, number>> = {};
  const writeIns: { categoryId: string; name: string }[] = [];

  for (const key of Object.keys(body.choices)) if (!categories.some((c) => c.id === key)) throw new HttpError(400, "The ballot has changed. Refresh and try again.");
  for (const c of categories) {
    const allowed = appliesTo(c, e.settings.access, identity.group);
    const raw = body.choices[c.id];
    const writeIn = body.writeIns?.[c.id]?.trim();
    if (!allowed) {
      if ((Array.isArray(raw) && raw.length) || (raw && !Array.isArray(raw) && Object.keys(raw).length) || writeIn) throw new HttpError(403, `You are not eligible to vote on "${c.title}".`);
      continue;
    }
    const valid = new Set(options.filter((o) => o.category_id === c.id).map((o) => o.id));
    if (c.method === "score" || c.method === "cumulative") {
      const values = raw && !Array.isArray(raw) ? raw : {};
      const entries = Object.entries(values).filter(([, v]) => v > 0);
      if (entries.some(([id]) => !valid.has(id))) throw new HttpError(400, `"${c.title}": an invalid option was selected. Refresh and try again.`);
      if (entries.some(([, v]) => !Number.isInteger(v))) throw new HttpError(400, `"${c.title}": use whole numbers.`);
      if (c.method === "score" && entries.some(([, v]) => v > c.points)) throw new HttpError(400, `"${c.title}": ratings go from 0 to ${c.points}.`);
      const sum = entries.reduce((a, [, v]) => a + v, 0);
      if (c.method === "cumulative" && sum > c.points) throw new HttpError(400, `"${c.title}": you can share out at most ${c.points} points (you used ${sum}).`);
      if (!entries.length && !abstainOk) throw new HttpError(400, `Please complete "${c.title}".`);
      clean[c.id] = Object.fromEntries(entries);
      continue;
    }
    const picked = Array.isArray(raw) ? raw : [];
    if (new Set(picked).size !== picked.length) throw new HttpError(400, `"${c.title}": each option can only be chosen once.`);
    if (picked.some((id) => !valid.has(id))) throw new HttpError(400, `"${c.title}": an invalid option was selected. Refresh and try again.`);
    if (writeIn) {
      if (!c.allow_write_in || !["single", "multiple"].includes(c.method)) throw new HttpError(400, `"${c.title}" doesn't accept write-in candidates.`);
      if (writeIn.length < 2) throw new HttpError(400, `"${c.title}": the write-in name is too short.`);
      const existing = options.find((o) => o.category_id === c.id && o.name.trim().toLowerCase() === writeIn.toLowerCase());
      if (existing) {
        if (!picked.includes(existing.id)) picked.push(existing.id);
      } else writeIns.push({ categoryId: c.id, name: writeIn });
    }
    const count = picked.length + (writeIns.some((w) => w.categoryId === c.id) ? 1 : 0);
    if (count === 0 && !abstainOk) throw new HttpError(400, `Please make a choice for "${c.title}".`);
    if (c.method === "single" && count > 1) throw new HttpError(400, `"${c.title}": choose only one.`);
    if (c.method === "multiple" && count > c.max_choices) throw new HttpError(400, `"${c.title}": choose up to ${c.max_choices}.`);
    clean[c.id] = picked;
  }
  const comment = e.settings.ballot.allowComments && body.comment ? body.comment : null;

  const receipt = humanCode(10);
  let proxied = 0;
  await db.tx(async (q) => {
    let weight = identity.weight;
    if (identity.voterId) {
      const marked = await q.one("UPDATE voters SET voted_at = now() WHERE id = $1 AND voted_at IS NULL RETURNING id", [identity.voterId]);
      if (!marked) throw conflict("You have already voted in this event.");
      // Proxy votes: this voter also casts the votes of members who appointed them and haven't voted themselves.
      const delegated = await q.query(
        "UPDATE voters SET voted_at = now(), voted_by_proxy = true WHERE event_id = $1 AND proxy_voter_id = $2 AND voted_at IS NULL RETURNING weight::float8 AS weight",
        [e.id, identity.voterId],
      );
      proxied = delegated.length;
      weight += delegated.reduce((a, d) => a + (e.settings.ballot.weighted ? Number(d.weight) : 1), 0);
    } else {
      const inserted = await q.one("INSERT INTO participants (event_id, identity_hash) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id", [e.id, hmac(`${e.id}:${identity.key}`)]);
      if (!inserted) throw conflict("You have already voted in this event.");
    }
    for (const w of writeIns) {
      const found = await q.one("SELECT id FROM options WHERE category_id = $1 AND lower(name) = lower($2) AND status IN ('approved','writein')", [w.categoryId, w.name]);
      let id = found?.id;
      if (!id) {
        let code = humanCode(5);
        while (await q.one("SELECT 1 FROM options WHERE event_id = $1 AND code = $2", [e.id, code])) code = humanCode(5);
        id = (await q.one("INSERT INTO options (event_id, category_id, name, code, status, sort_order) VALUES ($1,$2,$3,$4,'writein',9999) RETURNING id", [e.id, w.categoryId, w.name, code]))!.id;
      }
      (clean[w.categoryId] as string[]).push(id);
    }
    const secret = e.settings.ballot.secret;
    const ballot = await q.one(
      "INSERT INTO ballots (event_id, receipt, weight, voter_id, choices, voter_info, comment) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [e.id, receipt, weight, secret ? null : identity.voterId ?? null, JSON.stringify(clean), secret || !Object.keys(details).length ? null : JSON.stringify(details), comment],
    );
    void ballot;
  });
  void emitWebhook(e.org_id, "ballot.cast", { event: { id: e.id, slug: e.slug, title: e.title }, receipt: e.settings.ballot.receipts ? receipt : null });
  res.status(201).json({ receipt: e.settings.ballot.receipts ? receipt : null, message: e.settings.display.thankYouMessage, proxied });
}));

router.get("/events/:slug/receipts/:receipt", codeLimiter, h(async (req, res) => {
  const e = await ev(req);
  const row = await db.one("SELECT created_at FROM ballots WHERE event_id = $1 AND receipt = $2", [e.id, String(req.params.receipt).toUpperCase()]);
  res.json({ found: Boolean(row), recordedAt: row?.created_at ?? null });
}));

// ---- Free vote (tally mode) ----
router.post("/events/:slug/vote", deviceCookie, voteLimiter, h(async (req, res) => {
  const e = await ev(req);
  if (e.org_suspended) throw new HttpError(403, "Voting for this organization is suspended.");
  if (e.settings.mode !== "tally") throw new HttpError(400, "This event uses a full ballot.");
  if (!e.settings.freeVotes.enabled) throw new HttpError(400, "This event only accepts paid votes.");
  assertVotingOpen(e);
  const body = parse(detailsSchema.extend({ token: z.string().optional(), passToken: z.string().optional(), website: z.string().optional(), optionId: z.string().uuid() }), req.body);
  assertHuman(e, body.website);
  assertUnlocked(e, body.passToken);
  const identity = await resolveIdentity(req, e, body.token);
  const details = collectDetails(e.settings, body, identity);
  const opt = await db.one("SELECT id, category_id FROM options WHERE id = $1 AND event_id = $2 AND status = 'approved'", [body.optionId, e.id]);
  if (!opt) throw notFound("That entry is not available.");
  await assertCapacity(e);
  const idHash = hmac(`${e.id}:${identity.key}`);
  const ipHash = hmac(`${e.id}:ip:${clientIp(req)}`);
  const periodSql = e.settings.freeVotes.period === "daily" ? "AND created_at >= date_trunc('day', now())" : "";
  await db.tx(async (q) => {
    const used = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM votes WHERE event_id = $1 AND category_id = $2 AND identity_hash = $3 AND source = 'free' ${periodSql}`, [e.id, opt.category_id, idHash]);
    if ((used?.n ?? 0) >= e.settings.freeVotes.perVoter) {
      const when = e.settings.freeVotes.period === "daily" ? " today" : "";
      throw conflict(`You've used your free vote${e.settings.freeVotes.perVoter > 1 ? "s" : ""} in this category${when}.${e.settings.paid.enabled ? " You can still buy extra votes." : ""}`);
    }
    if (e.settings.access === "public") {
      // Soft per-network limit to slow down scripted voting from one connection.
      const ipUsed = await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM votes WHERE event_id = $1 AND category_id = $2 AND voter_info->>'ip' = $3 AND source = 'free' ${periodSql}`, [e.id, opt.category_id, ipHash]);
      if ((ipUsed?.n ?? 0) >= e.settings.freeVotes.perVoter * 25) throw new HttpError(429, "Too many votes from this network. Please try again later.");
    }
    await q.query("INSERT INTO votes (event_id, category_id, option_id, quantity, source, identity_hash, voter_info) VALUES ($1,$2,$3,1,'free',$4,$5)", [e.id, opt.category_id, opt.id, idHash, JSON.stringify({ ...details, ip: ipHash })]);
  });
  void emitWebhook(e.org_id, "vote.cast", { event: { id: e.id, slug: e.slug, title: e.title }, optionId: opt.id, source: "free", quantity: 1 });
  res.status(201).json({ ok: true, message: e.settings.display.thankYouMessage, freeUsed: await freeVotesUsed(e.id, identity.key, e.settings) });
}));

router.post("/events/:slug/free-status", deviceCookie, h(async (req, res) => {
  const e = await ev(req);
  if (e.settings.mode !== "tally") return res.json({ freeUsed: {} });
  const body = parse(z.object({ token: z.string().optional() }), req.body ?? {});
  try {
    const identity = await resolveIdentity(req, e, body.token);
    res.json({ freeUsed: await freeVotesUsed(e.id, identity.key, e.settings) });
  } catch {
    res.json({ freeUsed: {} });
  }
}));

// ---- Paid votes ----
router.post("/events/:slug/checkout", deviceCookie, voteLimiter, h(async (req, res) => {
  const e = await ev(req);
  if (e.org_suspended) throw new HttpError(403, "Voting for this organization is suspended.");
  const s = e.settings;
  if (s.mode !== "tally" || !s.paid.enabled) throw new HttpError(400, "This event does not accept paid votes.");
  assertVotingOpen(e);
  const plan = await limitsOf(e);
  if (!plan.paidVoting) throw new HttpError(402, "Paid voting is not available for this event right now. Please contact the organizer.");
  const body = parse(detailsSchema.extend({ token: z.string().optional(), passToken: z.string().optional(), website: z.string().optional(), optionId: z.string().uuid(), quantity: z.number().int().min(1).max(1_000_000), method: z.string().max(60).optional(), acceptTerms: z.literal(true, { errorMap: () => ({ message: "Please agree to the Terms of Service to buy votes." }) }) }), req.body);
  assertHuman(e, body.website);
  assertUnlocked(e, body.passToken);
  const offered = await eventMethods(s.paid, e.org_id);
  if (!offered.length) throw new HttpError(503, "Paid voting isn't available right now. Please contact the organizer.");
  const method = body.method ? offered.find((m) => m.id === body.method) : offered[0];
  if (!method) throw new HttpError(400, "That payment method isn't available for this event.");
  const identity = s.access === "public" ? { key: `device:${(req as any).deviceId}`, weight: 1 } : await resolveIdentity(req, e, body.token);
  const details = collectDetails(s, body, identity);
  const email = details.email || identity.email || body.email;
  if (!email || !z.string().email().safeParse(email).success) throw new HttpError(400, "An email address is required to receive your payment receipt.");
  const bundle = s.paid.bundles.find((b) => b.votes === body.quantity);
  if (!bundle && (body.quantity < s.paid.minVotes || body.quantity > s.paid.maxVotes)) {
    throw new HttpError(400, `You can buy between ${s.paid.minVotes} and ${s.paid.maxVotes} votes at a time.`);
  }
  const opt = await db.one("SELECT id, category_id, name FROM options WHERE id = $1 AND event_id = $2 AND status = 'approved'", [body.optionId, e.id]);
  if (!opt) throw notFound("That entry is not available.");
  const amount = bundle ? bundle.price : body.quantity * s.paid.pricePerVote;
  const amountMinor = toMinor(amount, s.paid.currency);
  if (amountMinor <= 0) throw new HttpError(400, "The vote price is not configured.");
  const manual = method.kind === "manual" ? method : null;
  const result = await startPayment({
    kind: "votes",
    provider: manual ? "manual" : (method.id as any),
    extra: manual ? { manualId: manual.id, manualLabel: manual.label, instructions: manual.instructions ?? "" } : undefined,
    orgId: e.org_id,
    eventId: e.id,
    categoryId: opt.category_id,
    optionId: opt.id,
    quantity: body.quantity,
    amountMinor,
    platformFeeMinor: Math.round((amountMinor * plan.feePercent) / 100),
    currency: s.paid.currency,
    email,
    name: details.name ?? null,
    phone: details.phone ?? null,
    description: `${body.quantity} vote${body.quantity > 1 ? "s" : ""} for ${opt.name} — ${e.title}`,
    returnPath: `/e/${e.slug}`,
  });
  res.json(result);
}));

// ---- Public nominations ----
router.post("/events/:slug/nominate", deviceCookie, codeLimiter, h(async (req, res) => {
  const e = await ev(req);
  if (!e.settings.nominations.enabled) throw new HttpError(400, "Nominations are closed for this event.");
  const st = votingState(e);
  if (st === "closed" || st === "ended" || st === "archived") throw new HttpError(409, "Nominations are closed.");
  const body = parse(
    z.object({ categoryId: z.string().uuid(), name: z.string().trim().min(2).max(200), subtitle: z.string().trim().max(200).optional(), description: z.string().trim().max(2000).optional(), email: z.string().trim().toLowerCase().email() }),
    req.body,
  );
  const cat = await db.one("SELECT id FROM categories WHERE id = $1 AND event_id = $2", [body.categoryId, e.id]);
  if (!cat) throw notFound("Category not found.");
  const recent = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM options WHERE event_id = $1 AND submitted_by_email = $2 AND created_at > now() - interval '1 day'", [e.id, body.email]);
  if ((recent?.n ?? 0) >= 10) throw new HttpError(429, "You've submitted many nominations today. Please try again tomorrow.");
  let code = humanCode(4);
  while (await db.one("SELECT 1 FROM options WHERE event_id = $1 AND code = $2", [e.id, code])) code = humanCode(4);
  const status = e.settings.nominations.requireApproval ? "pending" : "approved";
  await db.query(
    "INSERT INTO options (event_id, category_id, name, subtitle, description, code, status, submitted_by_email, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, 1000)",
    [e.id, cat.id, body.name, body.subtitle ?? "", body.description ?? "", code, status, body.email],
  );
  await audit(null, { orgId: e.org_id, eventId: e.id, action: "nomination.submitted", actorLabel: body.email, detail: { name: body.name, status } });
  res.status(201).json({ status });
}));

// ---- Payments: return page + test provider ----
// ---- Ads on public voting pages (only for organizations on ad-supported plans, and not on events with a pass) ----
router.get("/events/:slug/ad", h(async (req, res) => {
  const e = await getEventBySlug(String(req.params.slug));
  if (e.pass_voters) return res.json({ ad: null });
  res.json({ ad: await serveAd(e.org_plan, e.org_plan_expires_at, "voting_page") });
}));

router.get("/ads/:id/click", h(async (req, res) => {
  const ad = /^[0-9a-f-]{36}$/i.test(String(req.params.id)) ? await db.one("UPDATE ads SET clicks = clicks + 1 WHERE id = $1 RETURNING link_url", [req.params.id]) : null;
  if (!ad) throw notFound("Ad not found.");
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, ad.link_url);
}));

router.get("/payments/:ref", h(async (req, res) => {
  res.json(await verifyAndFinalize(String(req.params.ref)));
}));

router.get("/payments/:ref/info", h(async (req, res) => {
  const p = await db.one(
    `SELECT p.reference, p.status, p.amount_minor::float8 AS amount_minor, p.currency, p.quantity, p.provider, p.kind, o.name AS option_name, e.title AS event_title, e.slug AS event_slug,
            p.raw->>'manualLabel' AS manual_label, p.raw->>'instructions' AS instructions, (p.raw ? 'claim') AS claimed, org.name AS org_name
       FROM payments p LEFT JOIN options o ON o.id = p.option_id LEFT JOIN events e ON e.id = p.event_id LEFT JOIN organizations org ON org.id = p.org_id
      WHERE p.reference = $1`,
    [req.params.ref],
  );
  if (!p) throw notFound("Payment not found.");
  res.json(p);
}));

/** Manual payments: the voter says "I've paid" (with sender name / note); organizers then approve or reject. */
router.post("/payments/:ref/claim", codeLimiter, h(async (req, res) => {
  const body = parse(z.object({ senderName: z.string().trim().min(2).max(120), note: z.string().trim().max(500).optional(), paidAt: z.string().max(40).optional() }), req.body);
  const p = await db.one(
    `UPDATE payments SET raw = raw || $1::jsonb WHERE reference = $2 AND provider = 'manual' AND status = 'pending' RETURNING org_id, event_id, quantity, amount_minor, currency, raw`,
    [JSON.stringify({ claim: { ...body, claimedAt: new Date().toISOString() } }), req.params.ref],
  );
  if (!p) throw notFound("Pending manual payment not found.");
  const admins = await db.query("SELECT u.email FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role IN ('owner','admin','officer')", [p.org_id]);
  for (const a of admins) {
    void sendMail(a.email, `Payment to confirm: ${req.params.ref}`, [
      `${body.senderName} says they paid ${(Number(p.amount_minor) / 100).toLocaleString()} ${p.currency} by ${p.raw?.manualLabel ?? "manual payment"} for ${p.quantity} vote(s).`,
      body.note ? `Note: ${body.note}` : "",
      "Check your account, then approve or reject it on the event's Votes & payments tab.",
    ].filter(Boolean), { label: "Review payment", url: `${config.publicUrl}/app/events/${p.event_id}/payments` }).catch(() => undefined);
  }
  res.json({ ok: true });
}));

router.post("/payments/:ref/test-complete", h(async (req, res) => {
  if (!config.allowTestPayments) throw new HttpError(403, "Test payments are disabled.");
  const { result } = parse(z.object({ result: z.enum(["success", "failed"]) }), req.body);
  const p = await db.one("UPDATE payments SET raw = raw || $1::jsonb WHERE reference = $2 AND provider = 'test' AND status = 'pending' RETURNING reference", [JSON.stringify({ testResult: result }), req.params.ref]);
  if (!p) throw notFound("Test payment not found or already completed.");
  res.json(await verifyAndFinalize(String(req.params.ref)));
}));

export default router;
