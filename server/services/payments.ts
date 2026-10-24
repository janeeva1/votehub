import { config } from "../config";
import { db } from "../db";
import { HttpError, notFound } from "../http";
import { logger } from "../logger";
import { providers, type Keys } from "../payments/providers";
import { humanCode } from "../security";
import type { ProviderId } from "../../shared/model";
import { availableMethods, decryptKeys, gatewayReady, getPlatformConfig, getPlatformKeys } from "./platform";
import { decrypt, encrypt } from "../security";
import { PERIOD_DAYS, type Plan } from "../../shared/model";
import { audit } from "./audit";
import { emitWebhook } from "./outbound";

/**
 * Which keys to use for a payment: the organization's own gateway keys if configured,
 * otherwise the platform's keys (the platform collects and settles minus its fee).
 */
export async function resolveKeys(provider: ProviderId, orgId: string | null): Promise<{ keys: Keys; owner: "org" | "platform" }> {
  if (provider === "test" || provider === "manual") return { keys: {}, owner: orgId ? "org" : "platform" };
  if (orgId) {
    const row = await db.one("SELECT payment_config FROM organizations WHERE id = $1", [orgId]);
    const orgKeys = decryptKeys(row?.payment_config ?? {})[provider];
    if (orgKeys && gatewayReady(provider, row?.payment_config?.[provider])) return { keys: orgKeys, owner: "org" };
  }
  // Only Paystack falls back to the platform's own account (the platform then settles to the organization minus its fee).
  const platform = provider === "paystack" ? (await getPlatformKeys()).paystack ?? {} : {};
  return { keys: platform, owner: "platform" };
}

/**
 * New plan expiry after a successful plan payment.
 * - Renewing the same plan extends from the current expiry.
 * - Switching plans converts the unused value of the current plan into days of the new plan
 *   (upgrades get fewer bonus days, downgrades more), so nobody loses what they paid for.
 */
export function newPlanExpiry(currentPlanId: string, currentExpiry: Date | string | null, newPlanId: string, months: number, plans: Plan[], now = new Date()): Date {
  const day = 86400_000;
  const current = plans.find((p) => p.id === currentPlanId);
  const next = plans.find((p) => p.id === newPlanId);
  const remainingMs = currentExpiry && currentPlanId !== "free" ? Math.max(0, new Date(currentExpiry).getTime() - now.getTime()) : 0;
  let creditMs = 0;
  if (remainingMs > 0 && current && next) {
    creditMs = current.id === next.id ? remainingMs : next.price > 0 ? (remainingMs * current.price) / next.price : 0;
  }
  return new Date(now.getTime() + months * PERIOD_DAYS * day + Math.floor(creditMs));
}

export const newReference = () => `VH-${Date.now().toString(36).toUpperCase()}-${humanCode(6)}`;

export interface StartPaymentInput {
  kind: "votes" | "plan" | "pass";
  provider: ProviderId;
  orgId: string | null;
  eventId?: string | null;
  categoryId?: string | null;
  optionId?: string | null;
  planId?: string | null;
  /** Plan purchases: number of months bought (1 or 12). */
  months?: number;
  quantity?: number;
  amountMinor: number;
  platformFeeMinor?: number;
  currency: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  description: string;
  /** Where to send the user afterwards (app path, e.g. /e/my-contest). */
  returnPath: string;
  /** Extra data stored with the payment (manual method id, subscription intent…). */
  extra?: Record<string, unknown>;
}

export async function startPayment(input: StartPaymentInput) {
  if (input.amountMinor <= 0) throw new HttpError(400, "The amount must be greater than zero.");
  const provider = providers[input.provider];
  if (!provider) throw new HttpError(400, "Unknown payment provider.");
  const { keys } = await resolveKeys(input.provider, input.kind === "votes" ? input.orgId : null);
  const reference = newReference();
  const payment = await db.one(
    `INSERT INTO payments (org_id, event_id, kind, provider, reference, amount_minor, currency, platform_fee_minor, quantity,
                           category_id, option_id, plan_id, payer_name, payer_email, payer_phone, raw, months)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [
      input.orgId,
      input.eventId ?? null,
      input.kind,
      input.provider,
      reference,
      input.amountMinor,
      input.currency,
      input.platformFeeMinor ?? 0,
      input.quantity ?? 0,
      input.categoryId ?? null,
      input.optionId ?? null,
      input.planId ?? null,
      input.name ?? null,
      input.email,
      input.phone ?? null,
      JSON.stringify({ returnPath: input.returnPath, ...(input.extra ?? {}) }),
      input.months ?? 1,
    ],
  );
  const returnUrl = `${config.publicUrl}/pay/return?ref=${encodeURIComponent(reference)}`;
  const cancelUrl = `${config.publicUrl}${input.returnPath}${input.returnPath.includes("?") ? "&" : "?"}payment=cancelled`;
  try {
    const { redirectUrl, providerRef } = await provider.init(keys, {
      reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      email: input.email,
      name: input.name,
      phone: input.phone,
      description: input.description,
      returnUrl,
      cancelUrl,
      callbackUrl: `${config.publicUrl}/api/webhooks/${input.provider}${input.orgId && input.kind === "votes" ? `?org=${input.orgId}` : ""}`,
    });
    if (providerRef) await db.query("UPDATE payments SET provider_ref = $1 WHERE id = $2", [providerRef, payment!.id]);
    return { reference, redirectUrl };
  } catch (err) {
    await db.query("UPDATE payments SET status = 'failed', raw = raw || $1::jsonb WHERE id = $2", [
      JSON.stringify({ initError: (err as Error).message }),
      payment!.id,
    ]);
    throw err;
  }
}

/**
 * Verifies a payment with the provider and, on success, credits it exactly once
 * (votes are added, or the organization plan is extended). Safe to call repeatedly
 * from the return page, webhooks and manual re-checks.
 */
export async function verifyAndFinalize(reference: string) {
  const payment = await db.one("SELECT * FROM payments WHERE reference = $1", [reference]);
  if (!payment) throw notFound("Payment not found.");
  if (payment.status !== "pending") return summarize(payment);

  const provider = providers[payment.provider as ProviderId];
  const { keys } = await resolveKeys(payment.provider, payment.kind === "votes" ? payment.org_id : null);
  const result = await provider.verify(keys, payment as any);
  if (result.status === "pending") return summarize(payment);

  if (result.status === "success") {
    const expectedCurrency = String(payment.currency).toUpperCase();
    if (
      payment.provider !== "test" && payment.provider !== "manual" &&
      (result.amountMinor === undefined || result.amountMinor < Number(payment.amount_minor) || (result.currency && result.currency !== expectedCurrency))
    ) {
      logger.warn(`Payment ${reference} amount/currency mismatch`, result);
      await db.query("UPDATE payments SET status = 'failed', raw = raw || $1::jsonb WHERE id = $2 AND status = 'pending'", [
        JSON.stringify({ mismatch: result }),
        payment.id,
      ]);
      return summarize({ ...payment, status: "failed" });
    }
  }

  const plans = payment.kind === "plan" ? (await getPlatformConfig()).plans : [];
  const finalRow = await db.tx(async (q) => {
    const locked = await q.one("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [payment.id]);
    if (!locked || locked.status !== "pending") return locked;
    if (result.status === "failed") {
      return q.one("UPDATE payments SET status = 'failed', raw = raw || $1::jsonb WHERE id = $2 RETURNING *", [JSON.stringify({ verify: result.raw ?? null }), payment.id]);
    }
    const updated = await q.one(
      `UPDATE payments SET status = 'success', paid_at = now(), provider_ref = COALESCE($1, provider_ref), raw = raw || $2::jsonb
        WHERE id = $3 RETURNING *`,
      [result.providerRef || null, JSON.stringify({ verify: result.raw ?? null }), payment.id],
    );
    if (locked.kind === "votes" && locked.option_id && locked.category_id && locked.event_id) {
      await q.query(
        `INSERT INTO votes (event_id, category_id, option_id, quantity, source, payment_id, identity_hash)
         VALUES ($1,$2,$3,$4,'paid',$5,$6) ON CONFLICT (payment_id) DO NOTHING`,
        [locked.event_id, locked.category_id, locked.option_id, locked.quantity, locked.id, null],
      );
    }
    if (locked.kind === "plan" && locked.plan_id && locked.org_id) {
      const org = await q.one("SELECT plan, plan_expires_at FROM organizations WHERE id = $1 FOR UPDATE", [locked.org_id]);
      const expiresAt = newPlanExpiry(org?.plan ?? "free", org?.plan_expires_at ?? null, locked.plan_id, Number(locked.months ?? 1), plans);
      await q.query("UPDATE organizations SET plan = $1, plan_expires_at = $2, plan_started_at = now(), plan_reminded_at = NULL WHERE id = $3", [locked.plan_id, expiresAt, locked.org_id]);
      // Save the reusable card so the platform can renew automatically (unless the organization pauses).
      const card = result.authorization;
      const existing = await q.one("SELECT auth_enc FROM subscriptions WHERE org_id = $1", [locked.org_id]);
      const authEnc = card?.reusable ? encrypt(card.code) : existing?.auth_enc ?? null;
      await q.query(
        `INSERT INTO subscriptions (org_id, plan_id, months, status, provider, email, auth_enc, card_last4, card_brand, card_exp, failed_attempts, next_attempt_at, last_charged_at)
         VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,0,NULL,now())
         ON CONFLICT (org_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, months = EXCLUDED.months, status = CASE WHEN subscriptions.status = 'paused' AND $10 THEN 'paused' ELSE 'active' END,
           provider = EXCLUDED.provider, email = EXCLUDED.email, auth_enc = COALESCE(EXCLUDED.auth_enc, subscriptions.auth_enc),
           card_last4 = COALESCE(EXCLUDED.card_last4, subscriptions.card_last4), card_brand = COALESCE(EXCLUDED.card_brand, subscriptions.card_brand),
           card_exp = COALESCE(EXCLUDED.card_exp, subscriptions.card_exp), failed_attempts = 0, next_attempt_at = NULL, last_charged_at = now(), updated_at = now()`,
        [
          locked.org_id,
          locked.plan_id,
          Number(locked.months ?? 1),
          locked.provider,
          locked.payer_email,
          authEnc,
          card?.reusable ? card.last4 ?? null : null,
          card?.reusable ? card.brand ?? null : null,
          card?.reusable && card.expMonth ? `${card.expMonth}/${card.expYear}` : null,
          Boolean(locked.raw?.renewal),
        ],
      );
    }
    if (locked.kind === "pass" && locked.event_id) {
      await q.query("UPDATE events SET pass_voters = GREATEST(COALESCE(pass_voters, 0), $1) WHERE id = $2", [locked.quantity, locked.event_id]);
    }
    await audit(
      null,
      {
        orgId: locked.org_id,
        eventId: locked.event_id,
        action: locked.kind === "plan" ? "plan.payment_succeeded" : locked.kind === "pass" ? "pass.purchased" : "votes.purchased",
        actorLabel: locked.payer_email ?? "payer",
        detail: { reference, quantity: locked.quantity, amountMinor: Number(locked.amount_minor), currency: locked.currency, provider: locked.provider },
      },
      q,
    );
    return updated;
  });
  if (finalRow?.status === "success" && payment.status === "pending" && finalRow.org_id && finalRow.kind === "votes") {
    void emitWebhook(finalRow.org_id, "payment.succeeded", {
      reference,
      eventId: finalRow.event_id,
      optionId: finalRow.option_id,
      quantity: Number(finalRow.quantity),
      amountMinor: Number(finalRow.amount_minor),
      currency: finalRow.currency,
    });
  }
  return summarize(finalRow ?? payment);
}

function summarize(p: any) {
  return {
    reference: p.reference,
    status: p.status as "pending" | "success" | "failed",
    kind: p.kind as "votes" | "plan" | "pass",
    quantity: Number(p.quantity),
    amountMinor: Number(p.amount_minor),
    currency: p.currency,
    returnPath: p.raw?.returnPath ?? "/",
    provider: p.provider,
  };
}

/** Organizer decision on a manual payment (bank transfer, POS, cash…). */
export async function decideManualPayment(reference: string, orgId: string, approve: boolean, actor: string) {
  const p = await db.one("SELECT * FROM payments WHERE reference = $1 AND org_id = $2 AND provider = 'manual'", [reference, orgId]);
  if (!p) throw notFound("Manual payment not found.");
  if (p.status !== "pending") throw new HttpError(409, `This payment is already ${p.status}.`);
  await db.query("UPDATE payments SET raw = raw || $1::jsonb WHERE id = $2", [JSON.stringify({ manualDecision: approve ? "approved" : "rejected", decidedBy: actor, decidedAt: new Date().toISOString() }), p.id]);
  return verifyAndFinalize(reference);
}

/**
 * Charges an organization's saved card for its next subscription period (no customer present).
 * Used by the renewal scheduler and for instant plan changes.
 */
export async function chargeSavedCard(orgId: string, planId: string, months: number, reason: "renewal" | "change") {
  const sub = await db.one("SELECT * FROM subscriptions WHERE org_id = $1", [orgId]);
  if (!sub?.auth_enc) throw new HttpError(409, "No saved card on file. Pay once by checkout to set up automatic renewals.");
  const cfg = await getPlatformConfig();
  const plan = cfg.plans.find((p) => p.id === planId);
  if (!plan || plan.price <= 0) throw new HttpError(400, "That plan can't be charged.");
  const providerId = sub.provider as ProviderId;
  const provider = providers[providerId];
  if (!provider.charge) throw new HttpError(400, "Automatic renewals aren't supported for this payment method.");
  const { ANNUAL_MONTHS_CHARGED, toMinor } = await import("../../shared/model");
  const amountMinor = toMinor(plan.price * (months === 12 ? ANNUAL_MONTHS_CHARGED : 1), cfg.currency);
  const reference = newReference();
  await db.query(
    `INSERT INTO payments (org_id, kind, provider, reference, amount_minor, currency, plan_id, payer_email, raw, months)
     VALUES ($1,'plan',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [orgId, providerId, reference, amountMinor, cfg.currency, planId, sub.email, JSON.stringify({ returnPath: "/app/billing", renewal: reason === "renewal", autoCharge: true }), months],
  );
  const keys = providerId === "test" ? {} : (await getPlatformKeys()).paystack ?? {};
  let result;
  try {
    result = await provider.charge(keys, { authorizationCode: decrypt(sub.auth_enc), email: sub.email, amountMinor, currency: cfg.currency, reference });
  } catch (err) {
    result = { status: "failed" as const, raw: { error: (err as Error).message } };
  }
  if (result.status === "success" && providerId === "test") {
    await db.query("UPDATE payments SET raw = raw || $1::jsonb WHERE reference = $2", [JSON.stringify({ testResult: "success" }), reference]);
  }
  if (result.status === "failed") {
    await db.query("UPDATE payments SET status = 'failed', raw = raw || $1::jsonb WHERE reference = $2", [JSON.stringify({ charge: result.raw ?? null }), reference]);
    return { reference, status: "failed" as const };
  }
  // Success (or pending): verify and credit exactly once through the normal path.
  return verifyAndFinalize(reference);
}

export interface OfferedMethod {
  id: string;
  label: string;
  kind: "gateway" | "manual" | "test";
  instructions?: string;
}

/** Everything an organization can currently accept: its own gateways, its manual methods, the platform's Paystack, and test mode in development. */
export async function orgMethods(orgId: string): Promise<OfferedMethod[]> {
  const row = await db.one("SELECT payment_config FROM organizations WHERE id = $1", [orgId]);
  const list = availableMethods(row?.payment_config ?? {}, config.allowTestPayments);
  if (!list.some((m) => m.id === "paystack") && (await getPlatformKeys()).paystack?.secretKey) {
    list.unshift({ id: "paystack", label: "Paystack", kind: "gateway" });
  }
  return list;
}

/** The payment options an event offers voters (its chosen subset, or everything the organization accepts). */
export async function eventMethods(paid: { methods: string[]; provider: string }, orgId: string): Promise<OfferedMethod[]> {
  const all = await orgMethods(orgId);
  if (paid.methods.length) return all.filter((m) => paid.methods.includes(m.id));
  if (paid.provider === "test") return all.filter((m) => m.id === "test");
  return all.filter((m) => m.kind !== "test");
}
