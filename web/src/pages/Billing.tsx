import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { AlertTriangle, Check, CreditCard, Pause, Play } from "lucide-react";
import { del, get, isAdmin, post, useCurrentOrg } from "../api";
import { Badge, Button, ErrorState, Loading, PageHead, Panel, Segmented, StateBadge, fmtDate, fmtNum, useToast } from "../ui";
import { formatMoney, fromMinor, type Plan } from "@shared/model";

function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max === null ? 0 : Math.min(100, Math.round((used / Math.max(1, max)) * 100));
  return (
    <div className="meter">
      <div className="meter-line">
        <span>{label}</span>
        <b>
          {fmtNum(used)} / {max === null ? "∞" : fmtNum(max)}
        </b>
      </div>
      <div className={`meter-bar ${pct >= 100 ? "full" : pct >= 80 ? "near" : ""}`}>
        <span style={{ width: `${max === null ? 4 : pct}%` }} />
      </div>
    </div>
  );
}

export function BillingPage() {
  const org = useCurrentOrg();
  const toast = useToast();
  const search = useSearch();
  const wanted = new URLSearchParams(search).get("plan");
  const q = useQuery({ queryKey: ["billing", org?.id], queryFn: () => get("/org/billing") });
  const [busy, setBusy] = useState("");
  const [months, setMonths] = useState<"1" | "12">("1");
  const autoStarted = useRef(false);

  const subAction = async (tag: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(tag);
    try {
      await fn();
      toast.ok(okMsg);
      void q.refetch();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy("");
    }
  };

  const checkout = async (planId: string) => {
    setBusy(planId);
    try {
      const r = await post<{ redirectUrl?: string; charged?: boolean }>("/org/billing/checkout", { planId, months: Number(months) });
      if (r.redirectUrl) return void (location.href = r.redirectUrl);
      toast.ok("Done — charged to your saved card and your plan is updated.");
      setBusy("");
      void q.refetch();
    } catch (err) {
      toast.error(err);
      setBusy("");
    }
  };

  // Coming from "Choose Starter" on the pricing page: highlight that plan.
  useEffect(() => {
    if (!wanted || autoStarted.current || !q.data) return;
    autoStarted.current = true;
    document.getElementById(`plan-${wanted}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [wanted, q.data]);

  if (q.isLoading) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const current: Plan = d.plan;
  const expiresAt = d.planExpiresAt ? new Date(d.planExpiresAt) : null;
  const expired = d.storedPlan !== "free" && expiresAt && expiresAt < new Date();
  const daysLeft = expiresAt && !expired ? Math.ceil((expiresAt.getTime() - Date.now()) / 86400_000) : 0;
  const yearly = months === "12";
  const canPay = isAdmin(org?.role);
  const price = (p: Plan) => (yearly ? p.price * d.annualMonthsCharged : p.price);

  return (
    <>
      <PageHead eyebrow="Billing" title="Plan & billing" subtitle="Choose the plan that fits your organization. Upgrade, renew or switch whenever you like — you're always in control." />

      {expired && (
        <div className="banner-inline warn">
          <AlertTriangle size={16} /> Your {d.storedPlan} plan ended on {expiresAt!.toLocaleDateString()}. Free plan limits apply until you renew — your events and results are safe.
        </div>
      )}
      {!d.billingReady && (
        <div className="banner-inline">
          <AlertTriangle size={16} /> Online payments for plans aren't switched on yet by the platform. Please check back soon.
        </div>
      )}

      <div className="grid-2">
        <Panel title={`Current plan: ${current.name}`} subtitle={current.id === "free" ? "Free forever — no card needed." : expiresAt ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left · ends ${expiresAt.toLocaleDateString()}` : "Active"}>
          <div className="meters">
            <Meter label="Live events" used={d.usage.live_events} max={current.maxLiveEvents} />
            <Meter label="Team members (incl. invitations)" used={d.usage.members + d.usage.invites} max={current.maxTeamMembers ?? null} />
            <Meter label="Largest voter list" used={d.usage.max_voters} max={current.maxVotersPerEvent} />
          </div>
          <ul className="kv">
            <li>
              <span>Paid voting fee</span>
              <b>{current.paidVoting ? `${current.platformFeePercent}%` : "Not included"}</b>
            </li>
            <li>
              <span>SMS invitations & reminders</span>
              <b>{current.sms ? "Included" : "Starter and above"}</b>
            </li>
            <li>
              <span>API & webhooks</span>
              <b>{current.api ? "Included" : "Pro and above"}</b>
            </li>
            <li>
              <span>Ads</span>
              <b>{current.showAds ? "Shown (upgrade to remove)" : "None"}</b>
            </li>
            <li>
              <span>Your branding only</span>
              <b>{current.removeBranding ? "Yes" : "Pro and above"}</b>
            </li>
          </ul>
        </Panel>
        <Panel title="How billing works">
          <ul className="howto">
            <li>
              Pay once with Paystack (card, bank transfer or USSD). If you pay by card, your plan <b>renews automatically</b> every month or year on that card.
            </li>
            <li>
              <b>Pause any time</b> — nothing is charged while paused, and your plan simply runs until the end of the time you've paid for. Resume whenever you need it again.
            </li>
            <li>
              <b>Renewing</b> adds time on top of what you have left.
            </li>
            <li>
              <b>Switching plans</b> converts your unused days into credit on the new plan — upgrades start straight away and you never lose what you paid for.
            </li>
            <li>
              <b>Downgrading</b>: pause automatic renewal. When a paid plan ends, you move to Free automatically; nothing is deleted.
            </li>
            <li>Paying yearly costs {d.annualMonthsCharged} months — {12 - d.annualMonthsCharged} months free.</li>
          </ul>
        </Panel>
      </div>

      {d.subscription && d.storedPlan !== "free" && <SubscriptionPanel sub={d.subscription} canManage={canPay} expiresAt={expiresAt} busy={busy} act={subAction} plans={d.plans} currency={d.currency} annualMonthsCharged={d.annualMonthsCharged} />}

      <div className="billing-toggle">
        <Segmented
          value={months}
          onChange={setMonths}
          options={[
            { value: "1", label: "Monthly" },
            { value: "12", label: "Yearly", hint: `${12 - d.annualMonthsCharged} months free` },
          ]}
        />
      </div>

      <div className="plan-grid in-app">
        {d.plans.map((p: Plan) => {
          const isCurrent = p.id === current.id && !expired;
          const upgrade = p.price > current.price;
          return (
            <article key={p.id} id={`plan-${p.id}`} className={`plan-card ${isCurrent ? "featured" : ""} ${wanted === p.id ? "wanted" : ""}`}>
              <h3>
                {p.name} {isCurrent && <Badge tone="green">Current</Badge>}
              </h3>
              <p className="plan-price">
                {p.price === 0 ? "Free" : formatMoney(price(p), d.currency)}
                {p.price > 0 && <small>/{yearly ? "year" : "month"}</small>}
              </p>
              {yearly && p.price > 0 && <small className="muted">≈ {formatMoney(Math.round(price(p) / 12), d.currency)} per month</small>}
              <ul>
                {p.features.map((f) => (
                  <li key={f}>
                    <Check size={14} /> {f}
                  </li>
                ))}
              </ul>
              {p.price === 0 ? (
                <p className="muted small">{current.id === "free" ? "You're on Free." : "You move here automatically if a paid plan isn't renewed."}</p>
              ) : canPay ? (
                <Button kind={isCurrent ? "outline" : upgrade ? "primary" : "outline"} busy={busy === p.id} disabled={!d.billingReady || busy !== ""} onClick={() => checkout(p.id)}>
                  {isCurrent ? `Renew ${yearly ? "for a year" : "for a month"} now` : upgrade ? `Upgrade to ${p.name}` : `Switch to ${p.name}`}
                </Button>
              ) : null}
              {p.price > 0 && canPay && d.subscription?.card && !isCurrent && <small className="muted center-text">Charged instantly to card •••• {d.subscription.card.last4}</small>}
              {p.price > 0 && !canPay && (
                <p className="muted small">Ask an owner or admin to change the plan.</p>
              )}
            </article>
          );
        })}
      </div>

      {d.passes?.length > 0 && (
        <Panel title="Event passes — pay once, no subscription" subtitle="Perfect for an annual election or AGM. Buy a pass from the event's Overview page; it lifts that event's voter limit, unlocks unlimited ballots and lowers the paid-vote fee.">
          <div className="pass-grid wide-grid">
            {d.passes.map((p: any) => (
              <div key={p.id} className="pass-option static">
                <b>{p.name}</b>
                <span>{formatMoney(p.price, d.currency)}</span>
                <small className="muted">≈ {formatMoney(Math.round((p.price / p.voters) * 100) / 100, d.currency)} per voter</small>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {d.history.length > 0 && (
        <Panel title="Payment history">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {d.history.map((h: any) => (
                  <tr key={h.reference}>
                    <td>{fmtDate(h.created_at)}</td>
                    <td>{h.plan_id}</td>
                    <td>{formatMoney(fromMinor(Number(h.amount_minor), h.currency), h.currency)}</td>
                    <td>
                      <StateBadge value={h.status} />
                    </td>
                    <td className="mono small">{h.reference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

function SubscriptionPanel({ sub, canManage, expiresAt, busy, act, plans, currency, annualMonthsCharged }: { sub: any; canManage: boolean; expiresAt: Date | null; busy: string; act: (tag: string, fn: () => Promise<unknown>, ok: string) => void; plans: Plan[]; currency: string; annualMonthsCharged: number }) {
  const plan = plans.find((p) => p.id === sub.planId);
  const amount = plan ? plan.price * (sub.months === 12 ? annualMonthsCharged : 1) : 0;
  const statusText: Record<string, string> = {
    active: sub.card ? "Automatic renewal is on" : "No saved card — renew manually",
    paused: "Paused — you won't be charged",
    past_due: "Renewal failed — update your card",
    canceled: "Canceled",
  };
  return (
    <Panel title="Automatic renewal" subtitle={statusText[sub.status] ?? sub.status}>
      <ul className="kv">
        <li>
          <span>Renews as</span>
          <b>
            {plan?.name ?? sub.planId} · {formatMoney(amount, currency)} {sub.months === 12 ? "per year" : "per month"}
          </b>
        </li>
        <li>
          <span>{sub.status === "active" && sub.card ? "Next charge" : "Paid until"}</span>
          <b>{expiresAt ? expiresAt.toLocaleDateString() : "—"}</b>
        </li>
        <li>
          <span>Card</span>
          <b>{sub.card ? `${sub.card.brand ?? "Card"} •••• ${sub.card.last4 ?? ""}${sub.card.exp ? ` · exp ${sub.card.exp}` : ""}` : "None saved"}</b>
        </li>
        {sub.failedAttempts > 0 && (
          <li>
            <span>Failed attempts</span>
            <b className="red-text">{sub.failedAttempts} of 3</b>
          </li>
        )}
      </ul>
      {canManage && (
        <div className="btn-row">
          {sub.status === "active" && sub.card && (
            <Button kind="outline" busy={busy === "pause"} onClick={() => act("pause", () => post("/org/billing/pause"), "Automatic renewal paused. You keep your plan until the paid period ends.")}>
              <Pause size={15} /> Pause renewal
            </Button>
          )}
          {sub.status !== "active" && sub.card && (
            <Button busy={busy === "resume"} onClick={() => act("resume", () => post("/org/billing/resume"), "Automatic renewal is back on.")}>
              <Play size={15} /> Resume renewal
            </Button>
          )}
          {sub.card && (
            <Button kind="outline" busy={busy === "freq"} onClick={() => act("freq", () => post("/org/billing/frequency", { months: sub.months === 12 ? 1 : 12 }), "Billing frequency updated for your next renewal.")}>
              Switch to {sub.months === 12 ? "monthly" : `yearly (${12 - annualMonthsCharged} months free)`}
            </Button>
          )}
          {sub.card && (
            <Button kind="quiet" busy={busy === "card"} onClick={() => act("card", () => del("/org/billing/card"), "Card removed. Automatic renewal is off.")}>
              <CreditCard size={15} /> Remove card
            </Button>
          )}
        </div>
      )}
      {!sub.card && <p className="muted small">To turn on automatic renewal, renew or upgrade below and pay with a card.</p>}
    </Panel>
  );
}
