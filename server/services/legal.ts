import { z } from "zod";
import { config } from "../config";
import { db } from "../db";

/** Operator details printed in the Terms of Service and Privacy Policy. Edited by the platform admin. */
export const legalSchema = z.object({
  companyName: z.string().trim().max(160).default(""),
  tradingName: z.string().trim().max(120).default(""),
  registrationNumber: z.string().trim().max(60).default(""),
  address: z.string().trim().max(400).default(""),
  contactEmail: z.string().trim().max(200).default(""),
  privacyEmail: z.string().trim().max(200).default(""),
  governingLaw: z.string().trim().max(120).default("the Federal Republic of Nigeria"),
  courts: z.string().trim().max(120).default("Lagos State, Nigeria"),
  arbitrationSeat: z.string().trim().max(120).default("Lagos, Nigeria"),
  minimumAge: z.number().int().min(13).max(21).default(18),
  liabilityCapMinor: z.number().int().min(0).default(10_000_000),
  /** Bumping this asks every signed-in user to accept the new terms again. */
  termsVersion: z.string().trim().max(40).default("2026-10-24"),
  updatedAt: z.string().max(40).default("2026-10-24"),
});
export type LegalConfig = z.infer<typeof legalSchema>;

let cache: { at: number; value: LegalConfig } | null = null;

export async function getLegal(): Promise<LegalConfig> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const row = await db.one("SELECT value FROM platform_settings WHERE key = 'legal'");
  const parsed = legalSchema.safeParse(row?.value ?? {});
  const value = parsed.success ? parsed.data : legalSchema.parse({});
  if (!value.tradingName) value.tradingName = config.appName;
  if (!value.companyName) value.companyName = `the operator of ${config.appName}`;
  cache = { at: Date.now(), value };
  return value;
}

export async function setLegal(update: Partial<LegalConfig>, bumpVersion: boolean) {
  const row = await db.one("SELECT value FROM platform_settings WHERE key = 'legal'");
  const today = new Date().toISOString().slice(0, 10);
  const next: any = { ...(row?.value ?? {}), ...update, updatedAt: today };
  if (bumpVersion) next.termsVersion = new Date().toISOString().slice(0, 16).replace("T", " ");
  await db.query(
    `INSERT INTO platform_settings (key, value) VALUES ('legal', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(legalSchema.parse(next))],
  );
  cache = null;
  return getLegal();
}
