import { PASS_FEE_PERCENT, type Plan } from "../../shared/model";
import { getPlan } from "./platform";

export interface Limits {
  plan: Plan;
  maxVoters: number | null;
  maxBallots: number | null;
  paidVoting: boolean;
  feePercent: number;
  removeBranding: boolean;
  sms: boolean;
  api: boolean;
  passVoters: number | null;
}

/** The plan currently in force (paid plans fall back to Free when expired). */
export async function activePlan(planId: string, expiresAt: Date | string | null | undefined): Promise<Plan> {
  const expired = planId !== "free" && expiresAt && new Date(expiresAt) < new Date();
  return getPlan(expired ? "free" : planId);
}

/** Effective limits for one event: the organization's plan, raised by any one-off event pass bought for it. */
export async function eventLimits(planId: string, expiresAt: Date | string | null | undefined, passVoters: number | null | undefined): Promise<Limits> {
  const plan = await activePlan(planId, expiresAt);
  const base: Limits = {
    plan,
    maxVoters: plan.maxVotersPerEvent,
    maxBallots: plan.maxBallotsPerEvent,
    paidVoting: plan.paidVoting,
    feePercent: plan.platformFeePercent,
    removeBranding: plan.removeBranding,
    sms: plan.sms,
    api: plan.api,
    passVoters: passVoters ?? null,
  };
  if (!passVoters) return base;
  return {
    ...base,
    maxVoters: plan.maxVotersPerEvent === null ? null : Math.max(plan.maxVotersPerEvent, passVoters),
    maxBallots: null,
    paidVoting: true,
    feePercent: plan.paidVoting ? Math.min(plan.platformFeePercent, PASS_FEE_PERCENT) : PASS_FEE_PERCENT,
    removeBranding: true,
  };
}
