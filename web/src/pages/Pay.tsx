import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, CircleX, CreditCard, Loader2 } from "lucide-react";
import { get, post } from "../api";
import { Button, fmtNum } from "../ui";
import { formatMoney, fromMinor } from "@shared/model";

interface PayStatus {
  reference: string;
  status: "pending" | "success" | "failed";
  kind: "votes" | "plan";
  quantity: number;
  amountMinor: number;
  currency: string;
  returnPath: string;
}

/** Landing page after the payment provider redirects back. Verifies with the server (which checks with the provider). */
export function PayReturn() {
  const params = new URLSearchParams(location.search);
  const ref = params.get("ref") ?? params.get("reference") ?? params.get("tx_ref") ?? params.get("trxref") ?? "";
  const [status, setStatus] = useState<PayStatus | null>(null);
  const [error, setError] = useState("");
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!ref) return setError("Missing payment reference.");
    let stop = false;
    const check = async () => {
      try {
        const r = await get<PayStatus>(`/public/payments/${encodeURIComponent(ref)}`);
        if (stop) return;
        setStatus(r);
        if (r.status === "pending" && tries < 15) setTimeout(() => setTries((t) => t + 1), 2500);
      } catch (err) {
        if (!stop) setError((err as Error).message);
      }
    };
    void check();
    return () => {
      stop = true;
    };
  }, [ref, tries]);
  const back = status?.returnPath ?? "/";
  return (
    <div className="center-page">
      <div className="panel narrow center-text pay-box">
        {error ? (
          <>
            <CircleX size={40} className="red-icon" />
            <h2>We couldn't confirm this payment</h2>
            <p className="muted">{error}</p>
          </>
        ) : !status || status.status === "pending" ? (
          <>
            <Loader2 size={40} className="spin accent-icon" />
            <h2>Confirming your payment…</h2>
            <p className="muted">This usually takes a few seconds.{tries > 5 && " Your bank may still be processing it — you can leave this page; votes are added automatically once confirmed."}</p>
          </>
        ) : status.status === "success" ? (
          <>
            <BadgeCheck size={44} className="accent-icon" />
            <h2>Payment successful</h2>
            <p>
              {status.kind === "votes" ? (
                <>
                  <b>{fmtNum(status.quantity)} vote{status.quantity === 1 ? "" : "s"}</b> added. Thank you!
                </>
              ) : (
                "Your plan has been upgraded."
              )}
            </p>
            <p className="muted small">
              {formatMoney(fromMinor(status.amountMinor, status.currency), status.currency)} · Ref {status.reference}
            </p>
          </>
        ) : (
          <>
            <CircleX size={40} className="red-icon" />
            <h2>Payment not completed</h2>
            <p className="muted">No money was taken and no votes were added. You can try again.</p>
          </>
        )}
        <a className="btn btn-primary" href={back}>
          {status?.kind === "plan" ? "Back to billing" : "Back to voting"}
        </a>
      </div>
    </div>
  );
}

/** Simulated checkout for the "test" provider. */
export function PayTest() {
  const ref = new URLSearchParams(location.search).get("ref") ?? "";
  const info = useQuery({ queryKey: ["pay-info", ref], queryFn: () => get<any>(`/public/payments/${encodeURIComponent(ref)}/info`), enabled: Boolean(ref), retry: false });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const finish = async (result: "success" | "failed") => {
    setBusy(result);
    try {
      await post(`/public/payments/${encodeURIComponent(ref)}/test-complete`, { result });
      location.href = `/pay/return?ref=${encodeURIComponent(ref)}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy("");
    }
  };
  const p = info.data;
  return (
    <div className="center-page test-pay">
      <div className="panel narrow center-text pay-box">
        <span className="test-ribbon">TEST MODE</span>
        <CreditCard size={36} className="accent-icon" />
        <h2>Simulated checkout</h2>
        <p className="muted">This organizer is using test payments. No real money moves.</p>
        {p && (
          <div className="pay-summary">
            <b>{formatMoney(fromMinor(p.amount_minor, p.currency), p.currency)}</b>
            <span>{p.kind === "votes" ? `${fmtNum(p.quantity)} vote(s) for ${p.option_name} — ${p.event_title}` : "Plan upgrade"}</span>
          </div>
        )}
        {(error || info.error) && <div className="inline-error">{error || (info.error as Error).message}</div>}
        {p?.status === "pending" ? (
          <div className="btn-row center">
            <Button busy={busy === "success"} onClick={() => finish("success")}>
              Simulate successful payment
            </Button>
            <Button kind="outline" busy={busy === "failed"} onClick={() => finish("failed")}>
              Simulate failure
            </Button>
          </div>
        ) : p ? (
          <a className="btn btn-primary" href={`/pay/return?ref=${encodeURIComponent(ref)}`}>
            View result
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** Manual methods (bank transfer, OPay transfer, POS…): show the organizer's instructions and let the voter confirm they've paid. */
export function PayManual() {
  const ref = new URLSearchParams(location.search).get("ref") ?? "";
  const info = useQuery({ queryKey: ["pay-info", ref], queryFn: () => get<any>(`/public/payments/${encodeURIComponent(ref)}/info`), enabled: Boolean(ref), retry: false, refetchInterval: 15000 });
  const [form, setForm] = useState({ senderName: "", paidAt: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const p = info.data;
  const back = p?.event_slug ? `/e/${p.event_slug}` : "/";
  return (
    <div className="center-page">
      <div className="panel narrow pay-box manual-pay">
        <p className="eyebrow">{p?.org_name ?? "Payment"}</p>
        <h2>{p?.manual_label ?? "Manual payment"}</h2>
        {info.error && <div className="inline-error">{(info.error as Error).message}</div>}
        {p && (
          <>
            <div className="pay-summary">
              <b>{formatMoney(fromMinor(p.amount_minor, p.currency), p.currency)}</b>
              <span>
                {fmtNum(p.quantity)} vote(s) for {p.option_name} — {p.event_title}
              </span>
            </div>
            {p.status === "success" ? (
              <div className="notice ok-notice">
                <BadgeCheck size={18} /> Confirmed — your votes have been added. Thank you!
              </div>
            ) : p.status === "failed" ? (
              <div className="inline-error">The organizer couldn't find this payment and declined it. Contact them with reference {p.reference} if you believe this is wrong.</div>
            ) : (
              <>
                <div className="instructions">
                  <span className="field-label">How to pay</span>
                  <pre>{p.instructions || "The organizer hasn't added instructions. Please contact them."}</pre>
                  <p className="small">
                    Use this reference as the payment narration/description: <b className="mono">{p.reference}</b>
                  </p>
                </div>
                {p.claimed ? (
                  <div className="notice">
                    <Loader2 size={16} className="spin" /> Thanks — the organizer has been told. Your votes are added as soon as they confirm the payment. You can keep this page open or come back later.
                  </div>
                ) : (
                  <form
                    className="form-stack"
                    onSubmit={async (ev) => {
                      ev.preventDefault();
                      setBusy(true);
                      setError("");
                      try {
                        await post(`/public/payments/${encodeURIComponent(ref)}/claim`, { senderName: form.senderName, paidAt: form.paidAt || undefined, note: form.note || undefined });
                        await info.refetch();
                      } catch (err) {
                        setError((err as Error).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <span className="field-label">After paying, tell the organizer</span>
                    {error && <div className="inline-error">{error}</div>}
                    <input className="input" required minLength={2} maxLength={120} placeholder="Name on the sending account" value={form.senderName} onChange={(x) => setForm({ ...form, senderName: x.target.value })} />
                    <input className="input" maxLength={40} placeholder="When you paid (e.g. today 3:15pm)" value={form.paidAt} onChange={(x) => setForm({ ...form, paidAt: x.target.value })} />
                    <input className="input" maxLength={500} placeholder="Note (optional — bank, last digits…)" value={form.note} onChange={(x) => setForm({ ...form, note: x.target.value })} />
                    <Button type="submit" busy={busy}>
                      I've paid
                    </Button>
                  </form>
                )}
              </>
            )}
          </>
        )}
        <a className="text-link center" href={back}>
          Back to voting
        </a>
      </div>
    </div>
  );
}
