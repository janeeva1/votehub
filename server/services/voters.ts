import { config } from "../config";
import { db, type Queryable } from "../db";
import { HttpError } from "../http";
import { humanCode } from "../security";
import { eventLimits } from "./limits";
import { sendMail } from "./mailer";
import { sendSms } from "./sms";
import type { EventRow } from "./events";

export async function assertVoterCapacity(orgPlan: string, e: EventRow, adding: number) {
  const limits = await eventLimits(orgPlan, null, e.pass_voters);
  if (limits.maxVoters === null) return;
  const r = await db.one<{ n: number }>("SELECT count(*)::int AS n FROM voters WHERE event_id = $1", [e.id]);
  if ((r?.n ?? 0) + adding > limits.maxVoters) {
    throw new HttpError(402, `This event allows ${limits.maxVoters} voters on your current plan. Upgrade your plan or buy an event pass to add more.`);
  }
}

export async function uniqueAccessCode(eventId: string, q: Queryable = db) {
  for (let i = 0; i < 10; i++) {
    const code = humanCode(8);
    if (!(await q.one("SELECT 1 FROM voters WHERE event_id = $1 AND access_code = $2", [eventId, code]))) return code;
  }
  throw new HttpError(500, "Could not generate a unique access code.");
}

export async function notifyVoters(e: EventRow, orgName: string, rows: any[], kind: "invite" | "reminder", useSms: boolean) {
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
          kind === "invite" ? `You are on the voter list for "${e.title}" (${orgName}).` : `This is a friendly reminder that you haven't voted yet in "${e.title}".`,
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
