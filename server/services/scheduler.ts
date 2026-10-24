import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { readSettings } from "./events";
import { eventLimits } from "./limits";
import { sendMail } from "./mailer";
import { sendSms, smsEnabled } from "./sms";
import { audit } from "./audit";
import { chargeSavedCard } from "./payments";

/**
 * Background jobs (runs inside the web process every 5 minutes):
 * - automatic reminders to voter-list members who haven't voted, N hours before closing.
 */
async function sendDueReminders() {
  const events = await db.query(
    `SELECT e.*, o.plan AS org_plan, o.plan_expires_at AS org_plan_expires_at, o.name AS org_name FROM events e JOIN organizations o ON o.id = e.org_id
      WHERE e.status = 'live' AND e.ends_at IS NOT NULL AND e.ends_at > now() AND e.reminder_sent_at IS NULL AND o.suspended = false
        AND COALESCE((e.settings->'reminders'->>'hoursBeforeClose')::int, 0) > 0
        AND e.ends_at - make_interval(hours => (e.settings->'reminders'->>'hoursBeforeClose')::int) <= now()
        AND (e.starts_at IS NULL OR e.starts_at <= now())`,
  );
  for (const e of events) {
    const settings = readSettings(e.settings);
    if (settings.access !== "roster") {
      await db.query("UPDATE events SET reminder_sent_at = now() WHERE id = $1", [e.id]);
      continue;
    }
    // Claim the job first so two server instances never send twice.
    const claimed = await db.one("UPDATE events SET reminder_sent_at = now() WHERE id = $1 AND reminder_sent_at IS NULL RETURNING id", [e.id]);
    if (!claimed) continue;
    const limits = await eventLimits(e.org_plan, e.org_plan_expires_at, e.pass_voters);
    const useSms = settings.reminders.sms && limits.sms && smsEnabled();
    const voters = await db.query(
      "SELECT id, name, email, phone, access_code FROM voters WHERE event_id = $1 AND voted_at IS NULL AND proxy_voter_id IS NULL",
      [e.id],
    );
    for (const v of voters) {
      const url = `${config.publicUrl}/e/${e.slug}?code=${v.access_code}`;
      if (v.email) {
        await sendMail(v.email, `Reminder: voting closes soon — ${e.title}`, [
          `Hello ${v.name},`,
          `Voting in "${e.title}" (${e.org_name}) closes ${new Date(e.ends_at).toUTCString()} and we haven't received your vote yet.`,
          `Your access code: ${v.access_code}`,
        ], { label: "Vote now", url }).catch(() => undefined);
      }
      if (useSms && v.phone) await sendSms(v.phone, `Reminder: voting in ${e.title} closes soon. Code ${v.access_code} ${url}`);
      await db.query("UPDATE voters SET last_reminded_at = now() WHERE id = $1", [v.id]);
    }
    await audit(null, { orgId: e.org_id, eventId: e.id, action: "voters.auto_reminded", actorLabel: "scheduler", detail: { count: voters.length, sms: useSms } });
    logger.info(`Sent automatic reminders for "${e.title}" to ${voters.length} voter(s)`);
  }
}

/** Emails organization owners 3 days before a paid plan ends, and again once it has ended. */
async function sendPlanReminders() {
  const due = await db.query(
    `SELECT o.id, o.name, o.plan, o.plan_expires_at, o.plan_reminded_at FROM organizations o
      WHERE o.plan <> 'free' AND o.plan_expires_at IS NOT NULL AND o.suspended = false
        AND ((o.plan_expires_at <= now() + interval '3 days' AND o.plan_reminded_at IS NULL)
          OR (o.plan_expires_at <= now() AND (o.plan_reminded_at IS NULL OR o.plan_reminded_at < o.plan_expires_at)))`,
  );
  for (const o of due) {
    const claimed = await db.one("UPDATE organizations SET plan_reminded_at = now() WHERE id = $1 AND (plan_reminded_at IS NULL OR plan_reminded_at < $2) RETURNING id", [o.id, o.plan_reminded_at ?? new Date(0)]);
    if (!claimed) continue;
    const expired = new Date(o.plan_expires_at) <= new Date();
    const owners = await db.query("SELECT u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role IN ('owner','admin')", [o.id]);
    for (const u of owners) {
      await sendMail(
        u.email,
        expired ? `${o.name}: your ${config.appName} plan has ended` : `${o.name}: your ${config.appName} plan renews soon`,
        [
          `Hello ${u.name},`,
          expired
            ? `The ${o.plan} plan for ${o.name} ended on ${new Date(o.plan_expires_at).toDateString()}. Your events and results are safe, and the Free plan limits now apply.`
            : `The ${o.plan} plan for ${o.name} ends on ${new Date(o.plan_expires_at).toDateString()}. Renew any time — unused days are always carried over.`,
        ],
        { label: expired ? "Renew my plan" : "Renew now", url: `${config.publicUrl}/app/billing` },
      ).catch(() => undefined);
    }
    logger.info(`Plan ${expired ? "ended" : "renewal"} reminder sent for ${o.name}`);
  }
}

/** Charges saved cards for subscriptions that are due (unless paused). Failed charges are retried daily, 3 times. */
async function chargeDueRenewals() {
  const due = await db.query(
    `SELECT s.org_id, s.plan_id, s.months, s.failed_attempts, o.name FROM subscriptions s JOIN organizations o ON o.id = s.org_id
      WHERE s.status = 'active' AND s.auth_enc IS NOT NULL AND o.suspended = false
        AND (o.plan_expires_at IS NULL OR o.plan_expires_at <= now() + interval '1 hour')
        AND (s.next_attempt_at IS NULL OR s.next_attempt_at <= now())`,
  );
  for (const s of due) {
    // Claim the attempt first so parallel servers never double-charge.
    const claimed = await db.one(
      "UPDATE subscriptions SET next_attempt_at = now() + interval '1 day', updated_at = now() WHERE org_id = $1 AND (next_attempt_at IS NULL OR next_attempt_at <= now()) RETURNING org_id",
      [s.org_id],
    );
    if (!claimed) continue;
    let ok = false;
    try {
      const r = await chargeSavedCard(s.org_id, s.plan_id, s.months, "renewal");
      ok = r.status === "success";
    } catch (err) {
      logger.warn(`Renewal for ${s.name} failed: ${(err as Error).message}`);
    }
    const owners = await db.query("SELECT u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.role IN ('owner','admin')", [s.org_id]);
    if (ok) {
      for (const u of owners) await sendMail(u.email, `${s.name}: your plan renewed`, [`Hello ${u.name},`, `Your ${s.plan_id} plan renewed automatically. You can pause automatic renewal any time from Plan & billing.`], { label: "View billing", url: `${config.publicUrl}/app/billing` }).catch(() => undefined);
      logger.info(`Renewed ${s.plan_id} for ${s.name}`);
      continue;
    }
    const attempts = s.failed_attempts + 1;
    await db.query("UPDATE subscriptions SET failed_attempts = $1, status = CASE WHEN $1 >= 3 THEN 'past_due' ELSE status END, updated_at = now() WHERE org_id = $2", [attempts, s.org_id]);
    for (const u of owners) {
      await sendMail(u.email, `${s.name}: we couldn't renew your plan`, [
        `Hello ${u.name},`,
        attempts >= 3
          ? "We tried your saved card 3 times without success, so automatic renewal is stopped. Your plan moves to Free when the current period ends — renew with another card any time."
          : `Your card was declined (attempt ${attempts} of 3). We'll try again in 24 hours, or you can pay now with another card.`,
      ], { label: "Update payment", url: `${config.publicUrl}/app/billing` }).catch(() => undefined);
    }
  }
}

/** Runs every background job once (also used by the admin console's "Run jobs now"). */
export async function runScheduledJobs() {
  await sendDueReminders().catch((err) => logger.warn(`Reminder job failed: ${(err as Error).message}`));
  await sendPlanReminders().catch((err) => logger.warn(`Plan reminder job failed: ${(err as Error).message}`));
  await chargeDueRenewals().catch((err) => logger.warn(`Renewal job failed: ${(err as Error).message}`));
}

export function startScheduler() {
  const run = () => {
    sendDueReminders().catch((err) => logger.warn(`Reminder job failed: ${(err as Error).message}`));
    sendPlanReminders().catch((err) => logger.warn(`Plan reminder job failed: ${(err as Error).message}`));
    chargeDueRenewals().catch((err) => logger.warn(`Renewal job failed: ${(err as Error).message}`));
  };
  setTimeout(run, 15_000);
  setInterval(run, 5 * 60_000).unref();
}
