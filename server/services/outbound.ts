import crypto from "node:crypto";
import { db } from "../db";
import { logger } from "../logger";
import { decrypt } from "../security";
import { activePlan } from "./limits";

/**
 * Outgoing webhooks: POSTs a signed JSON event to the organization's endpoint.
 * Header X-VoteHub-Signature: sha256=<hex HMAC of the raw body with the webhook secret>.
 * Fire-and-forget; failures are logged and never affect voting.
 */
export async function emitWebhook(orgId: string, type: string, data: Record<string, unknown>) {
  try {
    const org = await db.one("SELECT settings, plan, plan_expires_at FROM organizations WHERE id = $1", [orgId]);
    const hook = org?.settings?.webhook;
    if (!hook?.url || !hook?.secretEnc) return;
    if (!(await activePlan(org!.plan, org!.plan_expires_at)).api) return;
    const body = JSON.stringify({ id: crypto.randomUUID(), type, createdAt: new Date().toISOString(), data });
    const signature = crypto.createHmac("sha256", decrypt(hook.secretEnc)).update(body).digest("hex");
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VoteHub-Event": type, "X-VoteHub-Signature": `sha256=${signature}` },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) logger.warn(`Webhook ${type} to ${hook.url} returned ${res.status}`);
  } catch (err) {
    logger.warn(`Webhook ${type} failed: ${(err as Error).message}`);
  }
}
