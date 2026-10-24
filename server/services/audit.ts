import type { Request } from "express";
import { db, type Queryable } from "../db";
import { clientIp } from "../http";

export async function audit(
  req: Request | null,
  entry: { orgId?: string | null; eventId?: string | null; action: string; detail?: Record<string, unknown>; actorLabel?: string },
  q: Queryable = db,
) {
  await q.query(
    `INSERT INTO audit_log (org_id, event_id, actor_user_id, actor_label, action, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.orgId ?? null,
      entry.eventId ?? null,
      req?.user?.id ?? null,
      entry.actorLabel ?? req?.user?.email ?? "system",
      entry.action,
      JSON.stringify(entry.detail ?? {}),
      req ? clientIp(req) : null,
    ],
  );
}
