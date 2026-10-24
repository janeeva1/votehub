import { z } from "zod";
import { db } from "../db";
import { AD_PLACEMENTS, type AdPlacement } from "../../shared/model";
import { activePlan } from "./limits";

export const adSchema = z.object({
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().max(240).default(""),
  imageFileId: z.string().uuid().nullable().default(null),
  linkUrl: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "Links must start with http:// or https://"),
  cta: z.string().trim().min(1).max(30).default("Learn more"),
  placements: z.array(z.enum(AD_PLACEMENTS)).min(1).default(["voting_page", "dashboard"]),
  /** Empty = every plan that shows ads. */
  planIds: z.array(z.string().max(32)).max(20).default([]),
  active: z.boolean().default(true),
  startsAt: z.string().datetime({ offset: true }).nullable().default(null),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
  weight: z.number().int().min(1).max(100).default(1),
});

export function adRow(r: any) {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    imageFileId: r.image_file_id,
    linkUrl: r.link_url,
    cta: r.cta,
    placements: r.placements,
    planIds: r.plan_ids,
    active: r.active,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    weight: r.weight,
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    createdAt: r.created_at,
  };
}

/** Picks one ad (weighted) for an organization's plan and placement, and counts the impression. Returns null on ad-free plans. */
export async function serveAd(planId: string, planExpiresAt: Date | string | null | undefined, placement: AdPlacement) {
  const plan = await activePlan(planId, planExpiresAt);
  if (!plan.showAds) return null;
  const ads = await db.query(
    `SELECT * FROM ads WHERE active AND $1 = ANY(placements) AND (cardinality(plan_ids) = 0 OR $2 = ANY(plan_ids))
       AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`,
    [placement, plan.id],
  );
  if (!ads.length) return null;
  let roll = Math.random() * ads.reduce((a, x) => a + x.weight, 0);
  const ad = ads.find((x) => (roll -= x.weight) < 0) ?? ads[0]!;
  await db.query("UPDATE ads SET impressions = impressions + 1 WHERE id = $1", [ad.id]);
  return { id: ad.id, title: ad.title, body: ad.body, imageUrl: ad.image_file_id ? `/api/files/${ad.image_file_id}` : null, cta: ad.cta, clickUrl: `/api/public/ads/${ad.id}/click` };
}
