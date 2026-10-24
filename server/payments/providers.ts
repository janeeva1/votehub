import crypto from "node:crypto";
import { config } from "../config";
import { HttpError } from "../http";
import type { ProviderId } from "../../shared/model";
import { ZERO_DECIMAL, fromMinor } from "../../shared/model";

/** Credentials for a gateway (field names come from GATEWAY_INFO in shared/model.ts). */
export type Keys = Record<string, string | undefined>;

export interface InitArgs {
  reference: string;
  amountMinor: number;
  currency: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** Server-to-server notification URL (used by gateways that take it per payment, e.g. OPay). */
  callbackUrl: string;
}
export interface SavedCard {
  code: string;
  reusable: boolean;
  last4?: string;
  brand?: string;
  expMonth?: string;
  expYear?: string;
}
export interface VerifyResult {
  status: "success" | "failed" | "pending";
  amountMinor?: number;
  currency?: string;
  providerRef?: string;
  raw?: unknown;
  /** Reusable card authorization (Paystack) for automatic renewals. */
  authorization?: SavedCard;
}
export interface PaymentRecord {
  reference: string;
  provider_ref: string | null;
  raw: any;
}
export interface ChargeArgs {
  authorizationCode: string;
  email: string;
  amountMinor: number;
  currency: string;
  reference: string;
}

export interface Provider {
  id: ProviderId;
  init(keys: Keys, args: InitArgs): Promise<{ redirectUrl: string; providerRef?: string }>;
  verify(keys: Keys, payment: PaymentRecord): Promise<VerifyResult>;
  /**
   * Returns the payment reference a webhook concerns (or null to ignore). Throws if a signature is present but invalid.
   * Every reference is re-verified with the gateway's API before anything is credited, so a forged webhook can't add votes.
   */
  webhookReference(keys: Keys, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): string | null;
  /** Charge a saved card without the customer present (recurring subscriptions). */
  charge?(keys: Keys, args: ChargeArgs): Promise<VerifyResult>;
}

const TIMEOUT = 20_000;
const minorFactor = (currency: string) => (ZERO_DECIMAL.has(currency) ? 1 : 100);

async function call(url: string, init: RequestInit & { auth?: string; form?: boolean }): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init.auth ? { Authorization: init.auth } : {}),
        "Content-Type": init.form ? "application/x-www-form-urlencoded" : "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach the payment provider: ${(err as Error).message}`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const msg = body?.message ?? body?.responseMessage ?? body?.error?.message ?? `HTTP ${res.status}`;
    const err = new HttpError(res.status === 404 ? 404 : 502, `Payment provider error: ${msg}`);
    (err as any).providerStatus = res.status;
    throw err;
  }
  return body;
}

function need(keys: Keys, field: string, name: string): string {
  const v = keys[field];
  if (!v) throw new HttpError(503, `${name} is not fully configured. Add the ${field} in Organization settings → Payment methods.`);
  return v;
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
const safeEqual = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------------- Paystack ----------------
function paystackCard(a: any): SavedCard | undefined {
  if (!a?.authorization_code) return undefined;
  return { code: a.authorization_code, reusable: Boolean(a.reusable), last4: a.last4, brand: a.brand ?? a.card_type, expMonth: a.exp_month, expYear: a.exp_year };
}
const paystack: Provider = {
  id: "paystack",
  async init(keys, a) {
    const secret = need(keys, "secretKey", "Paystack");
    const body = await call("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      auth: `Bearer ${secret}`,
      body: JSON.stringify({
        email: a.email,
        amount: a.amountMinor,
        currency: a.currency,
        reference: a.reference,
        callback_url: a.returnUrl,
        metadata: { name: a.name, phone: a.phone, description: a.description, cancel_action: a.cancelUrl },
      }),
    });
    if (!body?.data?.authorization_url) throw new HttpError(502, "Paystack did not return a payment link.");
    return { redirectUrl: body.data.authorization_url, providerRef: body.data.access_code };
  },
  async verify(keys, p) {
    const secret = need(keys, "secretKey", "Paystack");
    const body = await call(`https://api.paystack.co/transaction/verify/${encodeURIComponent(p.reference)}`, { method: "GET", auth: `Bearer ${secret}` });
    const d = body?.data ?? {};
    const status = d.status === "success" ? "success" : ["failed", "reversed", "abandoned"].includes(d.status) ? "failed" : "pending";
    return { status, amountMinor: Number(d.amount), currency: String(d.currency ?? "").toUpperCase(), providerRef: String(d.id ?? ""), raw: { status: d.status, gateway_response: d.gateway_response }, authorization: paystackCard(d.authorization) };
  },
  async charge(keys, a) {
    const secret = need(keys, "secretKey", "Paystack");
    const body = await call("https://api.paystack.co/transaction/charge_authorization", {
      method: "POST",
      auth: `Bearer ${secret}`,
      body: JSON.stringify({ authorization_code: a.authorizationCode, email: a.email, amount: a.amountMinor, currency: a.currency, reference: a.reference }),
    });
    const d = body?.data ?? {};
    const status = d.status === "success" ? "success" : d.status === "failed" ? "failed" : "pending";
    return { status, amountMinor: Number(d.amount), currency: String(d.currency ?? "").toUpperCase(), providerRef: String(d.id ?? ""), raw: { status: d.status, gateway_response: d.gateway_response }, authorization: paystackCard(d.authorization) };
  },
  webhookReference(keys, raw, headers) {
    if (!keys.secretKey) throw new HttpError(401, "No Paystack key.");
    const sig = header(headers, "x-paystack-signature") ?? "";
    const expected = crypto.createHmac("sha512", keys.secretKey).update(raw).digest("hex");
    if (!safeEqual(sig, expected)) throw new HttpError(401, "Invalid Paystack signature.");
    const evt = JSON.parse(raw.toString("utf8"));
    return evt?.event === "charge.success" ? evt?.data?.reference ?? null : null;
  },
};

// ---------------- Flutterwave ----------------
const flutterwave: Provider = {
  id: "flutterwave",
  async init(keys, a) {
    const secret = need(keys, "secretKey", "Flutterwave");
    const body = await call("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      auth: `Bearer ${secret}`,
      body: JSON.stringify({
        tx_ref: a.reference,
        amount: fromMinor(a.amountMinor, a.currency),
        currency: a.currency,
        redirect_url: a.returnUrl,
        customer: { email: a.email, name: a.name ?? undefined, phonenumber: a.phone ?? undefined },
        customizations: { title: config.appName, description: a.description },
      }),
    });
    if (!body?.data?.link) throw new HttpError(502, "Flutterwave did not return a payment link.");
    return { redirectUrl: body.data.link };
  },
  async verify(keys, p) {
    const secret = need(keys, "secretKey", "Flutterwave");
    let body: any;
    try {
      body = await call(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(p.reference)}`, { method: "GET", auth: `Bearer ${secret}` });
    } catch (err) {
      if ((err as any).providerStatus === 404 || (err as any).providerStatus === 400) return { status: "pending" };
      throw err;
    }
    const d = body?.data ?? {};
    const status = d.status === "successful" ? "success" : d.status === "failed" ? "failed" : "pending";
    const cur = String(d.currency ?? "").toUpperCase();
    return { status, amountMinor: Math.round(Number(d.amount) * minorFactor(cur)), currency: cur, providerRef: String(d.id ?? ""), raw: { status: d.status } };
  },
  webhookReference(keys, raw, headers) {
    if (!keys.webhookSecret) throw new HttpError(401, "No Flutterwave webhook hash.");
    const sig = header(headers, "verif-hash") ?? "";
    if (!safeEqual(sig, keys.webhookSecret)) throw new HttpError(401, "Invalid Flutterwave signature.");
    const evt = JSON.parse(raw.toString("utf8"));
    return evt?.data?.tx_ref ?? evt?.txRef ?? null;
  },
};

// ---------------- Stripe (Checkout) ----------------
const stripe: Provider = {
  id: "stripe",
  async init(keys, a) {
    const secret = need(keys, "secretKey", "Stripe");
    const form = new URLSearchParams({
      mode: "payment",
      success_url: a.returnUrl,
      cancel_url: a.cancelUrl,
      client_reference_id: a.reference,
      customer_email: a.email,
      "metadata[reference]": a.reference,
      "payment_intent_data[metadata][reference]": a.reference,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": a.currency.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(a.amountMinor),
      "line_items[0][price_data][product_data][name]": a.description.slice(0, 250),
    });
    const body = await call("https://api.stripe.com/v1/checkout/sessions", { method: "POST", auth: `Bearer ${secret}`, form: true, body: form.toString() });
    if (!body?.url) throw new HttpError(502, "Stripe did not return a checkout link.");
    return { redirectUrl: body.url, providerRef: body.id };
  },
  async verify(keys, p) {
    const secret = need(keys, "secretKey", "Stripe");
    if (!p.provider_ref) return { status: "pending" };
    const s = await call(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(p.provider_ref)}`, { method: "GET", auth: `Bearer ${secret}` });
    const status = s.payment_status === "paid" ? "success" : s.status === "expired" ? "failed" : "pending";
    return { status, amountMinor: Number(s.amount_total), currency: String(s.currency ?? "").toUpperCase(), providerRef: s.id, raw: { status: s.status, payment_status: s.payment_status } };
  },
  webhookReference(keys, raw, headers) {
    if (!keys.webhookSecret) throw new HttpError(401, "No Stripe webhook secret.");
    const sigHeader = header(headers, "stripe-signature") ?? "";
    const t = sigHeader.split(",").find((kv) => kv.startsWith("t="))?.slice(2);
    const v1s = sigHeader.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
    if (!t || !v1s.length) throw new HttpError(401, "Invalid Stripe signature.");
    if (Math.abs(Date.now() / 1000 - Number(t)) > 600) throw new HttpError(401, "Stale Stripe signature.");
    const expected = crypto.createHmac("sha256", keys.webhookSecret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
    if (!v1s.some((v) => safeEqual(v, expected))) throw new HttpError(401, "Invalid Stripe signature.");
    const evt = JSON.parse(raw.toString("utf8"));
    if (evt?.type === "checkout.session.completed" || evt?.type === "checkout.session.async_payment_succeeded") {
      return evt.data?.object?.client_reference_id ?? evt.data?.object?.metadata?.reference ?? null;
    }
    return null;
  },
};

// ---------------- Monnify ----------------
const monnifyBase = (keys: Keys) => (keys.mode === "sandbox" ? "https://sandbox.monnify.com" : "https://api.monnify.com");
async function monnifyToken(keys: Keys) {
  const apiKey = need(keys, "apiKey", "Monnify");
  const secret = need(keys, "secretKey", "Monnify");
  const body = await call(`${monnifyBase(keys)}/api/v1/auth/login`, { method: "POST", auth: `Basic ${Buffer.from(`${apiKey}:${secret}`).toString("base64")}`, body: "{}" });
  const token = body?.responseBody?.accessToken;
  if (!token) throw new HttpError(502, "Monnify login failed — check the API key and secret key.");
  return token as string;
}
const monnify: Provider = {
  id: "monnify",
  async init(keys, a) {
    const token = await monnifyToken(keys);
    const body = await call(`${monnifyBase(keys)}/api/v1/merchant/transactions/init-transaction`, {
      method: "POST",
      auth: `Bearer ${token}`,
      body: JSON.stringify({
        amount: fromMinor(a.amountMinor, a.currency),
        customerName: a.name || a.email,
        customerEmail: a.email,
        paymentReference: a.reference,
        paymentDescription: a.description.slice(0, 200),
        currencyCode: a.currency,
        contractCode: need(keys, "contractCode", "Monnify"),
        redirectUrl: a.returnUrl,
        paymentMethods: ["CARD", "ACCOUNT_TRANSFER", "USSD"],
      }),
    });
    const url = body?.responseBody?.checkoutUrl;
    if (!url) throw new HttpError(502, body?.responseMessage ?? "Monnify did not return a payment link.");
    return { redirectUrl: url, providerRef: body.responseBody.transactionReference };
  },
  async verify(keys, p) {
    const token = await monnifyToken(keys);
    let body: any;
    try {
      body = await call(`${monnifyBase(keys)}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(p.reference)}`, { method: "GET", auth: `Bearer ${token}` });
    } catch (err) {
      if ((err as any).providerStatus === 404 || (err as any).providerStatus === 400) return { status: "pending" };
      throw err;
    }
    const d = body?.responseBody ?? {};
    const st = String(d.paymentStatus ?? "");
    const status = st === "PAID" || st === "OVERPAID" ? "success" : ["FAILED", "EXPIRED", "CANCELLED", "REVERSED"].includes(st) ? "failed" : "pending";
    const cur = String(d.currencyCode ?? d.currency ?? "NGN").toUpperCase();
    return { status, amountMinor: Math.round(Number(d.amountPaid ?? d.amount ?? 0) * minorFactor(cur)), currency: cur, providerRef: d.transactionReference, raw: { paymentStatus: st } };
  },
  webhookReference(keys, raw, headers) {
    if (!keys.secretKey) throw new HttpError(401, "No Monnify key.");
    const sig = header(headers, "monnify-signature") ?? "";
    const expected = crypto.createHmac("sha512", keys.secretKey).update(raw).digest("hex");
    if (!safeEqual(sig, expected)) throw new HttpError(401, "Invalid Monnify signature.");
    const evt = JSON.parse(raw.toString("utf8"));
    return evt?.eventData?.paymentReference ?? null;
  },
};

// ---------------- OPay (Cashier) ----------------
const opayBase = (keys: Keys) => (keys.mode === "sandbox" ? "https://testapi.opaycheckout.com" : "https://liveapi.opaycheckout.com");
const opay: Provider = {
  id: "opay",
  async init(keys, a) {
    const merchantId = need(keys, "merchantId", "OPay");
    const publicKey = need(keys, "publicKey", "OPay");
    const body = await call(`${opayBase(keys)}/api/v1/international/cashier/create`, {
      method: "POST",
      auth: `Bearer ${publicKey}`,
      headers: { MerchantId: merchantId },
      body: JSON.stringify({
        country: "NG",
        reference: a.reference,
        amount: { total: a.amountMinor, currency: a.currency },
        returnUrl: a.returnUrl,
        callbackUrl: a.callbackUrl,
        cancelUrl: a.cancelUrl,
        expireAt: 30,
        userInfo: { userEmail: a.email, userName: a.name ?? undefined, userMobile: a.phone ?? undefined },
        product: { name: a.description.slice(0, 100), description: a.description.slice(0, 200) },
      }),
    });
    const url = body?.data?.cashierUrl;
    if (!url) throw new HttpError(502, body?.message ?? "OPay did not return a payment link.");
    return { redirectUrl: url, providerRef: body.data.orderNo };
  },
  async verify(keys, p) {
    const merchantId = need(keys, "merchantId", "OPay");
    const secret = need(keys, "secretKey", "OPay");
    const payload = JSON.stringify({ country: "NG", reference: p.reference });
    const signature = crypto.createHmac("sha512", secret).update(payload).digest("hex");
    const body = await call(`${opayBase(keys)}/api/v1/international/cashier/status`, { method: "POST", auth: `Bearer ${signature}`, headers: { MerchantId: merchantId }, body: payload });
    const d = body?.data ?? {};
    const st = String(d.status ?? "");
    const status = st === "SUCCESS" ? "success" : ["FAIL", "CLOSE"].includes(st) ? "failed" : "pending";
    return { status, amountMinor: Number(d.amount?.total ?? 0), currency: String(d.amount?.currency ?? "NGN").toUpperCase(), providerRef: d.orderNo, raw: { status: st } };
  },
  webhookReference(_keys, raw) {
    const evt = JSON.parse(raw.toString("utf8"));
    return evt?.payload?.reference ?? null;
  },
};

// ---------------- Manual (bank transfer, POS, cash … confirmed by the organizer) ----------------
const manual: Provider = {
  id: "manual",
  async init(_keys, a) {
    return { redirectUrl: `${config.publicUrl}/pay/manual?ref=${encodeURIComponent(a.reference)}` };
  },
  async verify(_keys, p) {
    const d = p.raw?.manualDecision;
    return { status: d === "approved" ? "success" : d === "rejected" ? "failed" : "pending" };
  },
  webhookReference() {
    return null;
  },
};

// ---------------- Test (simulated) ----------------
const test: Provider = {
  id: "test",
  async init(_keys, a) {
    if (!config.allowTestPayments) throw new HttpError(503, "Test payments are disabled on this server.");
    return { redirectUrl: `${config.publicUrl}/pay/test?ref=${encodeURIComponent(a.reference)}` };
  },
  async verify(_keys, p) {
    const r = p.raw?.testResult;
    return {
      status: r === "success" ? "success" : r === "failed" ? "failed" : "pending",
      authorization: r === "success" ? { code: `AUTH_test_${p.reference.slice(-6)}`, reusable: true, last4: "4081", brand: "visa", expMonth: "12", expYear: "2030" } : undefined,
    };
  },
  async charge(_keys, a) {
    if (!config.allowTestPayments) throw new HttpError(503, "Test payments are disabled on this server.");
    // Simulated card: emails containing "fail" are declined, so renewals failures can be tested.
    const ok = !/fail/i.test(a.email);
    return { status: ok ? "success" : "failed", amountMinor: a.amountMinor, currency: a.currency, raw: { simulated: true } };
  },
  webhookReference() {
    return null;
  },
};

export const providers: Record<ProviderId, Provider> = { paystack, flutterwave, stripe, monnify, opay, manual, test };
