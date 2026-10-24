import { db } from "../db";
import { HttpError } from "../http";
import { eventLimits, activePlan } from "./limits";
import { smsEnabled } from "./sms";
import { notifyVoters, uniqueAccessCode } from "./voters";
import type { EventRow } from "./events";

/**
 * Approve (shortlist) or reject registrations. Approving creates the voter with a private code
 * and, if the event says so, sends the code straight away. Rejecting an approved person removes
 * them from the voter list again (only if they haven't voted).
 */
export async function decideRegistrations(
  e: EventRow,
  org: { id: string; name: string; plan: string },
  ids: string[],
  decision: "approve" | "reject",
  actor: string,
  note?: string,
) {
  const regs = await db.query("SELECT * FROM registrations WHERE event_id = $1 AND id = ANY($2::uuid[])", [e.id, ids]);
  let changed = 0;
  const skipped: string[] = [];
  const newVoters: any[] = [];
  if (decision === "approve") {
    const limits = await eventLimits(org.plan, null, e.pass_voters);
    let count = (await db.one<{ n: number }>("SELECT count(*)::int AS n FROM voters WHERE event_id = $1", [e.id]))?.n ?? 0;
    for (const r of regs) {
      if (r.status === "approved") continue;
      const existing = r.email ? await db.one("SELECT id FROM voters WHERE event_id = $1 AND lower(email) = lower($2)", [e.id, r.email]) : null;
      let voterId = existing?.id;
      if (!voterId) {
        if (limits.maxVoters !== null && count >= limits.maxVoters) {
          skipped.push(r.name);
          continue;
        }
        const v = await db.one(
          "INSERT INTO voters (event_id, name, email, phone, ref, group_name, access_code) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, email, phone, access_code",
          [e.id, r.name, r.email, r.phone, r.ref, r.group_name, await uniqueAccessCode(e.id)],
        );
        voterId = v!.id;
        newVoters.push(v);
        count++;
      }
      await db.query("UPDATE registrations SET status = 'approved', voter_id = $1, decided_by = $2, decided_at = now(), note = COALESCE($3, note) WHERE id = $4", [voterId, actor, note ?? null, r.id]);
      changed++;
    }
  } else {
    for (const r of regs) {
      if (r.status === "rejected") continue;
      if (r.voter_id) {
        const gone = await db.one("DELETE FROM voters WHERE id = $1 AND voted_at IS NULL RETURNING id", [r.voter_id]);
        if (!gone && (await db.one("SELECT 1 FROM voters WHERE id = $1", [r.voter_id]))) {
          skipped.push(r.name);
          continue; // already voted — can't un-shortlist
        }
      }
      await db.query("UPDATE registrations SET status = 'rejected', voter_id = NULL, decided_by = $1, decided_at = now(), note = COALESCE($2, note) WHERE id = $3", [actor, note ?? null, r.id]);
      changed++;
    }
  }
  let notified = null;
  if (newVoters.length && e.settings.registration.sendCodeOnApproval) {
    const plan = await activePlan(org.plan, null);
    notified = await notifyVoters(e, org.name, newVoters, "invite", plan.sms && smsEnabled());
  }
  if (decision === "approve" && skipped.length && !changed) {
    throw new HttpError(402, "Your plan's voter limit for this event is reached. Upgrade your plan or buy an event pass to approve more people.");
  }
  return { changed, skipped, notified };
}

export function registrationOpen(e: EventRow) {
  const r = e.settings.registration;
  if (!r.enabled || e.settings.access !== "roster") return false;
  if (["closed", "archived", "draft"].includes(e.status)) return false;
  if (r.closesAt && new Date(r.closesAt) <= new Date()) return false;
  if (e.ends_at && new Date(e.ends_at) <= new Date()) return false;
  return true;
}
