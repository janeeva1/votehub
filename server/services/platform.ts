import { z } from "zod";
import { db } from "../db";
import { CURRENCIES, DEFAULT_PASSES, DEFAULT_PLANS, GATEWAYS, GATEWAY_INFO, type EventPass, type GatewayId, type ManualMethod, type Plan } from "../../shared/model";
import { decrypt, encrypt } from "../security";

export const planSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(40),
  price: z.number().min(0),
  maxLiveEvents: z.number().int().min(0).nullable(),
  maxVotersPerEvent: z.number().int().min(0).nullable(),
  maxBallotsPerEvent: z.number().int().min(0).nullable(),
  paidVoting: z.boolean(),
  removeBranding: z.boolean(),
  platformFeePercent: z.number().min(0).max(100),
  sms: z.boolean().default(false),
  api: z.boolean().default(false),
  maxTeamMembers: z.number().int().min(1).nullable().default(null),
  showAds: z.boolean().default(false),
  features: z.array(z.string().max(120)).max(12),
});

export const passSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,32}$/),
  name: z.string().min(1).max(60),
  voters: z.number().int().min(1),
  price: z.number().min(0),
});

export interface PlatformConfig {
  plans: Plan[];
  passes: EventPass[];
  currency: string;
  /** Gateway the platform bills subscriptions through: Paystack (or simulated "test" while setting up). */
  billingProvider: "paystack" | "test";
  allowSignups: boolean;
}

const defaults: PlatformConfig = { plans: DEFAULT_PLANS, passes: DEFAULT_PASSES, currency: "NGN", billingProvider: "paystack", allowSignups: true };

export async function getPlatformConfig(): Promise<PlatformConfig> {
  const row = await db.one("SELECT value FROM platform_settings WHERE key = 'config'");
  const value = (row?.value ?? {}) as Partial<PlatformConfig>;
  return {
    // Older saved plans may lack newer fields; fill them so every plan is complete.
    plans: (Array.isArray(value.plans) && value.plans.length ? value.plans : defaults.plans).map((p: any) => ({ ...p, sms: Boolean(p.sms), api: Boolean(p.api), maxTeamMembers: p.maxTeamMembers ?? null, showAds: typeof p.showAds === "boolean" ? p.showAds : p.id === "free" })) as Plan[],
    passes: Array.isArray(value.passes) ? value.passes : defaults.passes,
    currency: CURRENCIES.includes(value.currency as any) ? value.currency! : defaults.currency,
    billingProvider: value.billingProvider === "test" ? "test" : "paystack",
    allowSignups: value.allowSignups ?? defaults.allowSignups,
  };
}

export async function setPlatformConfig(cfg: PlatformConfig) {
  await db.query(
    `INSERT INTO platform_settings (key, value) VALUES ('config', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(cfg)],
  );
}

export async function getPlan(planId: string): Promise<Plan> {
  const { plans } = await getPlatformConfig();
  return plans.find((p) => p.id === planId) ?? plans.find((p) => p.id === "free") ?? DEFAULT_PLANS[0]!;
}

// ---- Payment gateway credentials: per organization (paid voting), plus the platform's Paystack (subscriptions) ----
export type ProviderKeys = Partial<Record<GatewayId, Record<string, string | undefined>>>;

function safeDecrypt(v: string) {
  try {
    return decrypt(v);
  } catch {
    return undefined;
  }
}

/** Is a stored gateway switched on and complete enough to take payments? */
export function gatewayReady(id: GatewayId, s: any): boolean {
  if (!s || s.enabled === false) return false;
  const info = GATEWAY_INFO[id];
  return info.fields.filter((f) => f.required).every((f) => (f.secret ? Boolean(s[`${f.key}Enc`]) : Boolean(s[f.key])));
}

/** Stored shape: { paystack: { enabled, publicKey, secretKeyEnc }, monnify: { apiKey, secretKeyEnc, contractCode, mode }, manual: [...] } */
export function decryptKeys(stored: any): ProviderKeys {
  const out: ProviderKeys = {};
  for (const id of GATEWAYS) {
    const s = stored?.[id];
    if (!s || s.enabled === false) continue;
    const keys: Record<string, string | undefined> = {};
    for (const f of GATEWAY_INFO[id].fields) keys[f.key] = f.secret ? (s[`${f.key}Enc`] ? safeDecrypt(s[`${f.key}Enc`]) : undefined) : s[f.key] || undefined;
    out[id] = keys;
  }
  return out;
}

/** Apply an update from a settings form. Empty secret fields keep the existing secret; null removes the gateway. */
export function mergeKeys(stored: any, update: any): any {
  const out: any = { ...(stored ?? {}) };
  for (const id of GATEWAYS) {
    const u = update?.[id];
    if (u === undefined) continue;
    if (u === null) {
      delete out[id];
      continue;
    }
    const cur = { ...(out[id] ?? {}) };
    if (typeof u.enabled === "boolean") cur.enabled = u.enabled;
    for (const f of GATEWAY_INFO[id].fields) {
      const v = u[f.key];
      if (typeof v !== "string") continue;
      if (f.secret) {
        if (v.trim()) cur[`${f.key}Enc`] = encrypt(v.trim());
      } else cur[f.key] = v.trim();
    }
    out[id] = cur;
  }
  if (Array.isArray(update?.manual)) out.manual = normalizeManual(update.manual);
  return out;
}

export function normalizeManual(list: any[]): ManualMethod[] {
  return list.slice(0, 6).map((m, i) => ({
    id: String(m.id || `m${i + 1}`).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || `m${i + 1}`,
    label: String(m.label ?? "").trim().slice(0, 60) || "Bank transfer",
    instructions: String(m.instructions ?? "").trim().slice(0, 1500),
    enabled: m.enabled !== false,
  }));
}

/** What the UI may see about stored credentials (never the secrets). */
export function describeKeys(stored: any) {
  const gateways: Record<string, { enabled: boolean; ready: boolean; values: Record<string, string>; saved: Record<string, boolean> }> = {};
  for (const id of GATEWAYS) {
    const s = stored?.[id] ?? {};
    const values: Record<string, string> = {};
    const saved: Record<string, boolean> = {};
    for (const f of GATEWAY_INFO[id].fields) {
      if (f.secret) saved[f.key] = Boolean(s[`${f.key}Enc`]);
      else values[f.key] = s[f.key] ?? (f.options ? f.options[0]!.value : "");
    }
    gateways[id] = { enabled: Boolean(stored?.[id]) && s.enabled !== false, ready: gatewayReady(id, s), values, saved };
  }
  return { gateways, manual: (stored?.manual ?? []) as ManualMethod[] };
}

/** Payment options an organization can offer on events (ids like "paystack" or "manual:bank"). */
export function availableMethods(stored: any, allowTest: boolean): { id: string; label: string; kind: "gateway" | "manual" | "test"; instructions?: string }[] {
  const out: { id: string; label: string; kind: "gateway" | "manual" | "test"; instructions?: string }[] = [];
  for (const id of GATEWAYS) if (gatewayReady(id, stored?.[id])) out.push({ id, label: GATEWAY_INFO[id].name, kind: "gateway" });
  for (const m of (stored?.manual ?? []) as ManualMethod[]) if (m.enabled) out.push({ id: `manual:${m.id}`, label: m.label, kind: "manual", instructions: m.instructions });
  if (allowTest) out.push({ id: "test", label: "Test payment (simulated)", kind: "test" });
  return out;
}

export async function getPlatformKeys(): Promise<ProviderKeys> {
  const row = await db.one("SELECT value FROM platform_settings WHERE key = 'payment_keys'");
  const fromDb = decryptKeys(row?.value ?? {});
  // Environment variables override the database for the platform's own Paystack account.
  const env = process.env.PAYSTACK_SECRET_KEY?.trim();
  return { ...fromDb, paystack: { ...fromDb.paystack, ...(env ? { secretKey: env } : {}) } };
}

export async function getPlatformKeysStored() {
  const row = await db.one("SELECT value FROM platform_settings WHERE key = 'payment_keys'");
  return row?.value ?? {};
}
export async function setPlatformKeysStored(value: unknown) {
  await db.query(
    `INSERT INTO platform_settings (key, value) VALUES ('payment_keys', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
}

/** True when organizations can pay for plans online (the platform's billing gateway has a secret key). */
export async function billingReady(): Promise<boolean> {
  const cfg = await getPlatformConfig();
  if (cfg.billingProvider === "test") return (await import("../config")).config.allowTestPayments;
  const keys = (await getPlatformKeys()).paystack;
  return Boolean(keys?.secretKey);
}
