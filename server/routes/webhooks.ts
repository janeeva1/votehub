import express, { Router } from "express";
import { db } from "../db";
import { h, HttpError } from "../http";
import { logger } from "../logger";
import { providers } from "../payments/providers";
import { GATEWAYS, type GatewayId } from "../../shared/model";
import { decryptKeys, getPlatformKeys } from "../services/platform";
import { verifyAndFinalize } from "../services/payments";

/**
 * Provider webhooks. Mounted BEFORE the JSON body parser because signatures are computed on the raw body.
 * URL: /api/webhooks/:provider            → platform keys
 *      /api/webhooks/:provider?org=<id>   → that organization's keys (falls back to platform keys)
 */
const router = Router();

router.post("/:provider", express.raw({ type: "*/*", limit: "1mb" }), h(async (req, res) => {
  const id = String(req.params.provider);
  if (!(GATEWAYS as readonly string[]).includes(id)) throw new HttpError(404, "Unknown provider.");
  const provider = providers[id as GatewayId];
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  const candidates = [] as Record<string, string | undefined>[];
  const orgId = typeof req.query.org === "string" && /^[0-9a-f-]{36}$/.test(req.query.org) ? req.query.org : null;
  if (orgId) {
    const row = await db.one("SELECT payment_config FROM organizations WHERE id = $1", [orgId]);
    const keys = decryptKeys(row?.payment_config ?? {})[id as GatewayId];
    if (keys) candidates.push(keys);
  }
  const platform = (await getPlatformKeys())[id as GatewayId];
  if (platform) candidates.push(platform);

  // OPay sends no signature: its reference is always re-checked with OPay's API before anything is credited.
  const usable = id === "opay" ? [candidates[0] ?? {}] : candidates;
  if (!usable.length) throw new HttpError(401, "Webhook received but no signing key is configured.");
  let reference: string | null = null;
  let verified = false;
  for (const keys of usable) {
    try {
      reference = provider.webhookReference(keys, raw, req.headers);
      verified = true;
      break;
    } catch {
      /* try the next key */
    }
  }
  if (!verified) throw new HttpError(401, "Invalid webhook signature.");
  if (reference) {
    try {
      await verifyAndFinalize(reference);
    } catch (err) {
      // Unknown references (e.g. payments from another app on the same account) are acknowledged and ignored.
      if (!(err instanceof HttpError && err.status === 404)) throw err;
      logger.info(`Webhook for unknown reference ${reference} ignored`);
    }
  }
  res.json({ received: true });
}));

export default router;
