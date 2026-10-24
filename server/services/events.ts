import { db, type Queryable } from "../db";
import { PROVIDERS, eventSettingsSchema, type EventSettings } from "../../shared/model";
import { HttpError, notFound } from "../http";

export interface EventRow {
  id: string;
  org_id: string;
  slug: string;
  title: string;
  description: string;
  template: string;
  status: "draft" | "live" | "paused" | "closed" | "archived";
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  results_published: boolean;
  cover_file_id: string | null;
  settings: EventSettings;
  access_password_hash: string | null;
  pass_voters: number | null;
  reminder_sent_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function readSettings(raw: unknown): EventSettings {
  const value: any = raw && typeof raw === "object" ? structuredClone(raw) : {};
  // Gateways that are no longer offered fall back to Paystack instead of resetting all settings.
  if (value.paid && !(PROVIDERS as readonly string[]).includes(value.paid.provider)) value.paid.provider = "paystack";
  const parsed = eventSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : eventSettingsSchema.parse({});
}

export async function getEventForOrg(eventId: string, orgId: string, q: Queryable = db): Promise<EventRow> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw notFound("Event not found.");
  const row = await q.one("SELECT * FROM events WHERE id = $1 AND org_id = $2", [eventId, orgId]);
  if (!row) throw notFound("Event not found.");
  return { ...row, settings: readSettings(row.settings) } as EventRow;
}

export async function getEventBySlug(slug: string, q: Queryable = db): Promise<EventRow & { org_name: string; org_plan: string; org_branding: any; org_suspended: boolean; org_plan_expires_at: any }> {
  const row = await q.one(
    `SELECT e.*, o.name AS org_name, o.plan AS org_plan, o.plan_expires_at AS org_plan_expires_at, o.branding AS org_branding, o.suspended AS org_suspended
       FROM events e JOIN organizations o ON o.id = e.org_id WHERE e.slug = $1`,
    [slug],
  );
  if (!row || row.status === "draft" || row.status === "archived") throw notFound("This voting page does not exist or is not published yet.");
  return { ...row, settings: readSettings(row.settings) } as any;
}

export type VotingState = "draft" | "not_started" | "open" | "paused" | "ended" | "closed" | "archived";

export function votingState(e: Pick<EventRow, "status" | "starts_at" | "ends_at">, now = new Date()): VotingState {
  if (e.status === "draft") return "draft";
  if (e.status === "archived") return "archived";
  if (e.status === "closed") return "closed";
  if (e.status === "paused") return "paused";
  if (e.starts_at && new Date(e.starts_at) > now) return "not_started";
  if (e.ends_at && new Date(e.ends_at) <= now) return "ended";
  return "open";
}

export function assertVotingOpen(e: EventRow) {
  const state = votingState(e);
  const messages: Record<VotingState, string> = {
    draft: "Voting has not been published yet.",
    not_started: "Voting has not started yet.",
    open: "",
    paused: "Voting is temporarily paused by the organizer.",
    ended: "Voting has ended.",
    closed: "Voting is closed.",
    archived: "This event is archived.",
  };
  if (state !== "open") throw new HttpError(409, messages[state]);
}

export function publicResultsVisible(e: EventRow): boolean {
  if (e.results_published) return true;
  const state = votingState(e);
  if (e.settings.results.visibility === "live") return state !== "draft";
  if (e.settings.results.visibility === "after_close") return state === "ended" || state === "closed";
  return false;
}

// ---------------- Tallying ----------------
export interface OptionResult {
  id: string;
  name: string;
  subtitle: string;
  code: string;
  imageFileId: string | null;
  writeIn: boolean;
  votes: number;
  percent: number;
  /** Score voting: average rating among ballots that rated this category. */
  average?: number;
  winner: boolean;
}
export interface CategoryResult {
  id: string;
  title: string;
  method: string;
  maxChoices: number;
  seats: number;
  points: number;
  totalVotes: number;
  ballots: number;
  abstentions: number;
  options: OptionResult[];
  threshold?: { percent: number; met: boolean };
  quota?: number;
  rounds?: { round: number; counts: Record<string, number>; eliminated: string[]; elected: string[] }[];
}
export interface TallyResult {
  categories: CategoryResult[];
  ballots: number;
  paidVotes: number;
  freeVotes: number;
  quorum?: { percent: number; required: number; achieved: number; met: boolean; basis: "voters" | "weight" };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

type Pref = { weight: number; order: string[] };

/** Instant-runoff (single winner). */
function irv(optionIds: string[], prefs: Pref[]) {
  const eliminated = new Set<string>();
  const rounds: NonNullable<CategoryResult["rounds"]> = [];
  let winner: string | null = null;
  for (let r = 1; r <= optionIds.length + 1 && !winner; r++) {
    const counts: Record<string, number> = {};
    for (const id of optionIds) if (!eliminated.has(id)) counts[id] = 0;
    let active = 0;
    for (const p of prefs) {
      const top = p.order.find((id) => !eliminated.has(id));
      if (top) {
        counts[top] = (counts[top] ?? 0) + p.weight;
        active += p.weight;
      }
    }
    const remaining = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const info = { round: r, counts: Object.fromEntries(remaining.map(([k, v]) => [k, round4(v)])), eliminated: [] as string[], elected: [] as string[] };
    rounds.push(info);
    if (!remaining.length || active === 0) break;
    if (remaining[0]![1] > active / 2 || remaining.length === 1) {
      winner = remaining[0]![0];
      info.elected = [winner];
      break;
    }
    const lowest = remaining[remaining.length - 1]![1];
    const drop = remaining.filter(([, v]) => v === lowest).map(([k]) => k);
    if (drop.length === remaining.length) break; // complete tie
    drop.forEach((id) => eliminated.add(id));
    info.eliminated = drop;
  }
  return { winners: winner ? [winner] : [], rounds };
}

/** Single transferable vote (Droop quota, fractional surplus transfer). */
function stv(optionIds: string[], prefs: Pref[], seats: number) {
  const ballots = prefs.map((p) => ({ order: p.order, value: p.weight, current: null as string | null }));
  const total = ballots.reduce((a, b) => a + b.value, 0);
  const quota = total / (seats + 1);
  const continuing = new Set(optionIds);
  const elected: string[] = [];
  const rounds: NonNullable<CategoryResult["rounds"]> = [];
  for (let r = 1; r <= optionIds.length * 2 + 2 && elected.length < seats && continuing.size; r++) {
    const counts: Record<string, number> = {};
    for (const id of continuing) counts[id] = 0;
    for (const b of ballots) {
      b.current = b.order.find((id) => continuing.has(id)) ?? null;
      if (b.current && b.value > 0) counts[b.current] = (counts[b.current] ?? 0) + b.value;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const info = { round: r, counts: Object.fromEntries(sorted.map(([k, v]) => [k, round4(v)])), eliminated: [] as string[], elected: [] as string[] };
    rounds.push(info);
    if (continuing.size <= seats - elected.length) {
      for (const [id] of sorted) {
        elected.push(id);
        info.elected.push(id);
        continuing.delete(id);
      }
      break;
    }
    const over = sorted.filter(([, v]) => v > quota && v > 0);
    if (over.length) {
      for (const [id, votes] of over) {
        if (elected.length >= seats) break;
        elected.push(id);
        info.elected.push(id);
        continuing.delete(id);
        const factor = (votes - quota) / votes;
        for (const b of ballots) if (b.current === id) b.value *= factor;
      }
      continue;
    }
    const lowest = sorted[sorted.length - 1]!;
    continuing.delete(lowest[0]);
    info.eliminated = [lowest[0]];
  }
  return { winners: elected, rounds, quota: round4(quota) };
}

export async function tally(eventId: string, q: Queryable = db, settings?: EventSettings): Promise<TallyResult> {
  const categories = await q.query(
    "SELECT id, title, method, max_choices, points, threshold_percent::float8 AS threshold_percent FROM categories WHERE event_id = $1 ORDER BY sort_order, created_at",
    [eventId],
  );
  const options = await q.query(
    `SELECT id, category_id, name, subtitle, code, image_file_id, status FROM options
      WHERE event_id = $1 AND status IN ('approved','writein') ORDER BY sort_order, created_at`,
    [eventId],
  );
  const direct = await q.query(
    `SELECT option_id, SUM(quantity)::float8 AS total FROM votes WHERE event_id = $1 AND source <> 'ballot' GROUP BY option_id`,
    [eventId],
  );
  const bySource = await q.query(`SELECT source, SUM(quantity)::float8 AS total FROM votes WHERE event_id = $1 GROUP BY source`, [eventId]);
  const ballotRows = await q.query("SELECT weight::float8 AS weight, choices FROM ballots WHERE event_id = $1", [eventId]);
  const directMap = new Map(direct.map((s) => [s.option_id, Number(s.total)]));

  const results: CategoryResult[] = categories.map((c) => {
    const opts = options.filter((o) => o.category_id === c.id);
    const optionIds = opts.map((o) => o.id);
    const valid = new Set(optionIds);
    const method = c.method as string;
    const seats = ["multiple", "stv", "score", "cumulative", "borda"].includes(method) ? Math.max(1, c.max_choices) : 1;
    const counts = new Map<string, number>(optionIds.map((id) => [id, directMap.get(id) ?? 0]));
    const raters = new Map<string, number>();
    let abstentions = 0;
    let participating = 0;
    const prefs: Pref[] = [];

    for (const b of ballotRows) {
      const pick = (b.choices ?? {})[c.id];
      if (pick === undefined) continue; // category not on this voter's ballot (voter groups)
      const w = Number(b.weight);
      const empty = Array.isArray(pick) ? pick.length === 0 : !pick || Object.values(pick).every((v) => !Number(v));
      if (empty) {
        abstentions += w;
        continue;
      }
      participating += w;
      if (Array.isArray(pick)) {
        const order = (pick as string[]).filter((id) => valid.has(id));
        if (method === "ranked" || method === "stv") prefs.push({ weight: w, order });
        else if (method === "borda") {
          const n = optionIds.length;
          order.forEach((id, i) => counts.set(id, (counts.get(id) ?? 0) + (n - 1 - i) * w));
        } else order.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + w));
      } else {
        for (const [id, v] of Object.entries(pick as Record<string, number>)) {
          if (!valid.has(id)) continue;
          counts.set(id, (counts.get(id) ?? 0) + Number(v) * w);
          raters.set(id, (raters.get(id) ?? 0) + w);
        }
      }
    }

    const base: CategoryResult = {
      id: c.id,
      title: c.title,
      method,
      maxChoices: c.max_choices,
      seats,
      points: c.points,
      totalVotes: 0,
      ballots: round4(participating),
      abstentions: round4(abstentions),
      options: opts.map((o) => ({
        id: o.id,
        name: o.name,
        subtitle: o.status === "writein" ? "Write-in" : o.subtitle,
        code: o.code,
        imageFileId: o.image_file_id,
        writeIn: o.status === "writein",
        votes: 0,
        percent: 0,
        winner: false,
      })),
    };

    let winners: string[] = [];
    if (method === "ranked" || method === "stv") {
      const run = method === "ranked" ? irv(optionIds, prefs) : stv(optionIds, prefs, seats);
      winners = run.winners;
      base.rounds = run.rounds;
      if ("quota" in run) base.quota = run.quota as number;
      const first = run.rounds[0]?.counts ?? {};
      const final = method === "ranked" ? run.rounds[run.rounds.length - 1]?.counts ?? {} : first;
      const finalTotal = Object.values(final).reduce((a, b) => a + b, 0);
      base.totalVotes = round4(prefs.reduce((a, p) => a + p.weight, 0));
      base.options = base.options.map((o) => ({ ...o, votes: final[o.id] ?? 0, percent: finalTotal ? round4(((final[o.id] ?? 0) / finalTotal) * 100) : 0 }));
    } else {
      base.options = base.options.map((o) => ({
        ...o,
        votes: round4(counts.get(o.id) ?? 0),
        ...(method === "score" ? { average: raters.get(o.id) ? round4((counts.get(o.id) ?? 0) / (raters.get(o.id) ?? 1)) : 0 } : {}),
      }));
      const total = base.options.reduce((a, o) => a + o.votes, 0);
      base.totalVotes = round4(total);
      base.options = base.options.map((o) => ({ ...o, percent: total ? round4((o.votes / total) * 100) : 0 }));
      const ranked = [...base.options].sort((a, b) => b.votes - a.votes);
      const cutoff = ranked[seats - 1]?.votes ?? 0;
      if (cutoff > 0) winners = ranked.filter((o) => o.votes >= cutoff).map((o) => o.id);
    }

    // Majority / super-majority threshold (e.g. 50% or 66.67%) based on valid votes for the leading option.
    if (c.threshold_percent !== null && c.threshold_percent !== undefined && Number(c.threshold_percent) > 0) {
      const top = [...base.options].sort((a, b) => b.votes - a.votes)[0];
      const met = Boolean(top && top.votes > 0 && top.percent + 0.01 >= Number(c.threshold_percent));
      base.threshold = { percent: Number(c.threshold_percent), met };
      if (!met) winners = [];
      else if (seats === 1) winners = [top!.id];
    }
    const win = new Set(winners);
    base.options = base.options.map((o) => ({ ...o, winner: win.has(o.id) })).sort((a, b) => Number(b.winner) - Number(a.winner) || b.votes - a.votes);
    return base;
  });

  const src = Object.fromEntries(bySource.map((s) => [s.source, Number(s.total)]));
  const out: TallyResult = { categories: results, ballots: ballotRows.length, paidVotes: src.paid ?? 0, freeVotes: src.free ?? 0 };

  if (settings && settings.ballot.quorumPercent > 0 && settings.access === "roster") {
    const t = await q.one(
      `SELECT count(*)::int AS voters, count(voted_at)::int AS voted, COALESCE(SUM(weight),0)::float8 AS wt,
              COALESCE(SUM(weight) FILTER (WHERE voted_at IS NOT NULL),0)::float8 AS wv FROM voters WHERE event_id = $1`,
      [eventId],
    );
    const byWeight = settings.ballot.weighted;
    const totalBase = byWeight ? Number(t?.wt ?? 0) : Number(t?.voters ?? 0);
    const achieved = byWeight ? Number(t?.wv ?? 0) : Number(t?.voted ?? 0);
    const exact = (totalBase * settings.ballot.quorumPercent) / 100;
    // Whole voters can't be split: round a head-count quorum up (50% of 3 voters = 2 voters).
    const required = byWeight ? round4(exact) : Math.ceil(exact - 1e-9);
    out.quorum = { percent: settings.ballot.quorumPercent, required, achieved: round4(achieved), met: achieved >= required, basis: byWeight ? "weight" : "voters" };
  }
  return out;
}
