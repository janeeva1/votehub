import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { Plus, Save, Trash2 } from "lucide-react";
import { applyTheme } from "../theme";
import { THEMES, resolveTheme, type Appearance } from "@shared/theme";
import { del, get, patch, post, put, queryClient, useConfig, useMe } from "../api";
import { Badge, Button, ConfirmButton, ErrorState, Field, ImageUpload, Loading, Modal, PageHead, Panel, Stat, StateBadge, Tabs, Toggle, fmtDate, fmtNum, fromLocalInput, toLocalInput, useToast } from "../ui";
import { AD_PLACEMENTS, AD_PLACEMENT_LABELS, CURRENCIES, formatMoney, fromMinor, type AdPlacement, type Plan } from "@shared/model";

type Tab = "overview" | "orgs" | "users" | "config" | "payments" | "appearance" | "ads" | "legal";

export function AdminPage() {
  const { tab = "overview" } = useParams<{ tab?: Tab }>();
  const [, navigate] = useLocation();
  const me = useMe();
  if (!me.data?.user?.isPlatformAdmin) return <ErrorState error={new Error("Platform administrators only.")} />;
  return (
    <>
      <PageHead eyebrow="Platform" title="Super admin" subtitle="Manage every organization, plan, user and payment on this platform." />
      <Tabs
        value={tab}
        onChange={(t) => navigate(`/admin/${t}`)}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "orgs", label: "Organizations" },
          { value: "users", label: "Users" },
          { value: "config", label: "Plans & settings" },
          { value: "payments", label: "Payments" },
          { value: "appearance", label: "Appearance" },
          { value: "ads", label: "Ads" },
          { value: "legal", label: "Legal" },
        ]}
      />
      <div className="tab-body">
        {tab === "overview" && <Overview />}
        {tab === "orgs" && <Orgs />}
        {tab === "users" && <Users />}
        {tab === "config" && <Config />}
        {tab === "payments" && <Payments />}
        {tab === "appearance" && <AppearanceAdmin />}
        {tab === "ads" && <AdsAdmin />}
        {tab === "legal" && <LegalAdmin />}
      </div>
    </>
  );
}

function Overview() {
  const q = useQuery({ queryKey: ["admin", "overview"], queryFn: () => get("/admin/overview"), staleTime: 0, refetchOnMount: "always" });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} />;
  const { counts, money, plans, mrr, currency, expiring, recentOrgs, checklist } = q.data;
  const pending = checklist.filter((c: any) => !c.ok);
  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat label="Monthly recurring revenue" value={formatMoney(mrr, currency)} note="Active paid plans × monthly price" accent />
        <Stat label="Organizations" value={fmtNum(counts.orgs)} note={plans.map((p: any) => `${p.n} ${p.plan}`).join(" · ")} />
        <Stat label="Users" value={fmtNum(counts.users)} />
        <Stat label="Events" value={fmtNum(counts.events)} note={`${counts.live_events} live · ${fmtNum(counts.ballots)} ballots`} />
      </div>
      <div className="grid-2">
        <Panel title="Platform readiness" subtitle={pending.length ? `${pending.length} item(s) need attention so organizations can fully serve themselves.` : "Everything is set — organizations can sign up, pay and run votes on their own."}>
          <ul className="checklist-admin">
            {checklist.map((c: any) => (
              <li key={c.key} className={c.ok ? "ok" : ""}>
                <span className="check-dot" />
                <span>
                  <b>{c.label}</b>
                  {!c.ok && <small>{c.help}</small>}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Renewals to watch" subtitle="Paid plans ending in the next 14 days (or ended in the last 7). Owners are emailed automatically.">
          {!expiring.length ? (
            <p className="muted">Nothing expiring soon.</p>
          ) : (
            <ul className="row-list">
              {expiring.map((o: any) => (
                <li key={o.id} className="row-item">
                  <span>
                    <b>{o.name}</b>
                    <small>
                      {o.plan} · {new Date(o.plan_expires_at) < new Date() ? "ended" : "ends"} {new Date(o.plan_expires_at).toLocaleDateString()}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <div className="grid-2">
        <Panel title="Newest organizations">
          <ul className="row-list">
            {recentOrgs.map((o: any) => (
              <li key={o.id} className="row-item">
                <span>
                  <b>{o.name}</b>
                  <small>
                    {o.org_type} · signed up {new Date(o.created_at).toLocaleDateString()}
                  </small>
                </span>
                <Badge tone={o.plan === "free" ? "neutral" : "gold"}>{o.plan}</Badge>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Money processed">
          {!money.length ? (
            <p className="muted">No successful payments yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Payments</th>
                  <th>Total</th>
                  <th>Platform fees</th>
                </tr>
              </thead>
              <tbody>
                {money.map((m: any) => (
                  <tr key={m.kind + m.currency}>
                    <td>{m.kind === "plan" ? "Plan subscriptions" : m.kind === "pass" ? "Event passes" : "Paid votes"}</td>
                    <td>{fmtNum(m.n)}</td>
                    <td>{formatMoney(fromMinor(m.total, m.currency), m.currency)}</td>
                    <td>{m.kind === "votes" ? formatMoney(fromMinor(m.fees, m.currency), m.currency) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Orgs() {
  const toast = useToast();
  const [q, setQ] = useState("");
  const orgs = useQuery({ queryKey: ["admin", "orgs", q], queryFn: () => get<any[]>(`/admin/orgs?q=${encodeURIComponent(q)}`) });
  const cfg = useQuery({ queryKey: ["admin", "config"], queryFn: () => get("/admin/config") });
  const update = async (id: string, body: unknown) => {
    try {
      await patch(`/admin/orgs/${id}`, body);
      toast.ok("Organization updated.");
      void orgs.refetch();
      void queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Panel title="Organizations" subtitle="Organizations sign up, pay and manage themselves. Use these controls only for support: complimentary upgrades, extensions or suspending abuse." action={<input className="input input-sm" placeholder="Search" value={q} onChange={(x) => setQ(x.target.value)} />}>
      {orgs.isLoading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Organization</th>
                <th>Owner</th>
                <th>Events</th>
                <th>Plan</th>
                <th>Plan expires</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orgs.data?.map((o) => (
                <tr key={o.id}>
                  <td>
                    <b>{o.name}</b>
                    <small className="block muted">
                      {o.org_type} · {o.members} member(s) · since {new Date(o.created_at).toLocaleDateString()}
                    </small>
                  </td>
                  <td className="small">{o.owner_email}</td>
                  <td>{o.events}</td>
                  <td>
                    <select className="input input-sm" value={o.plan} onChange={(x) => update(o.id, { plan: x.target.value, planExpiresAt: x.target.value === "free" ? null : o.plan_expires_at ?? new Date(Date.now() + 30 * 86400e3).toISOString() })}>
                      {(cfg.data?.plans ?? []).map((p: Plan) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {o.plan === "free" ? (
                      "—"
                    ) : (
                      <input
                        className="input input-sm"
                        type="date"
                        value={o.plan_expires_at ? new Date(o.plan_expires_at).toISOString().slice(0, 10) : ""}
                        onChange={(x) => update(o.id, { planExpiresAt: x.target.value ? new Date(`${x.target.value}T23:59:59Z`).toISOString() : null })}
                        title="Empty = never expires"
                      />
                    )}
                  </td>
                  <td>
                    <Button size="sm" kind={o.suspended ? "primary" : "quiet"} onClick={() => update(o.id, { suspended: !o.suspended })}>
                      {o.suspended ? "Unsuspend" : "Suspend"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Users() {
  const toast = useToast();
  const me = useMe();
  const [q, setQ] = useState("");
  const users = useQuery({ queryKey: ["admin", "users", q], queryFn: () => get<any[]>(`/admin/users?q=${encodeURIComponent(q)}`) });
  const update = async (id: string, body: unknown) => {
    try {
      await patch(`/admin/users/${id}`, body);
      toast.ok("User updated.");
      void users.refetch();
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <Panel title="Users" action={<input className="input input-sm" placeholder="Search" value={q} onChange={(x) => setQ(x.target.value)} />}>
      {users.isLoading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Orgs</th>
                <th>Joined</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <td>
                    <b>{u.name}</b> {u.disabled && <Badge tone="red">Disabled</Badge>}
                    <small className="block muted">{u.email}</small>
                  </td>
                  <td>{u.orgs}</td>
                  <td className="small">{fmtDate(u.created_at)}</td>
                  <td>{u.is_platform_admin ? <Badge tone="gold">Super admin</Badge> : <Badge>User</Badge>}</td>
                  <td className="nowrap">
                    {u.id !== me.data?.user?.id && (
                      <>
                        <Button size="sm" kind="quiet" onClick={() => update(u.id, { isPlatformAdmin: !u.is_platform_admin })}>
                          {u.is_platform_admin ? "Remove admin" : "Make admin"}
                        </Button>
                        <Button size="sm" kind={u.disabled ? "primary" : "quiet"} onClick={() => update(u.id, { disabled: !u.disabled })}>
                          {u.disabled ? "Enable" : "Disable"}
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Config() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin", "config"], queryFn: () => get("/admin/config") });
  const [cfg, setCfg] = useState<any>(null);
  const [keys, setKeys] = useState({ publicKey: "", secretKey: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !cfg) {
      setCfg(structuredClone(q.data));
      setKeys({ publicKey: q.data.paymentKeys?.gateways?.paystack?.values?.publicKey ?? "", secretKey: "" });
    }
  }, [q.data, cfg]);
  if (q.isLoading || !cfg) return <Loading />;
  const setPlan = (i: number, v: Partial<Plan>) => setCfg({ ...cfg, plans: cfg.plans.map((p: Plan, j: number) => (j === i ? { ...p, ...v } : p)) });
  const num = (v: string) => (v === "" ? null : Math.max(0, Number(v)));
  return (
    <div className="stack">
      <Panel title="Platform">
        <div className="grid-3 tight">
          <Field label="Plan pricing currency">
            <select className="input" value={cfg.currency} onChange={(x) => setCfg({ ...cfg, currency: x.target.value })}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Subscription billing" hint="Plans renew automatically on organizations' saved cards.">
            <select className="input" value={cfg.billingProvider} onChange={(x) => setCfg({ ...cfg, billingProvider: x.target.value })}>
              <option value="paystack">Paystack (live billing)</option>
              <option value="test">Test mode (simulated — development only)</option>
            </select>
          </Field>
          <div className="toggle-list">
            <Toggle label="Allow public sign-ups" checked={cfg.allowSignups} onChange={(v) => setCfg({ ...cfg, allowSignups: v })} />
          </div>
        </div>
      </Panel>
      <Panel title="Platform Paystack account" subtitle="Collects subscription and event-pass payments and renews plans automatically. Organizations without their own gateway can also sell votes through it (settled to them minus the platform fee). PAYSTACK_SECRET_KEY in .env overrides the saved key.">
        <div className="gateway">
          <header>
            <b>Paystack</b>
            {q.data.paymentKeys?.gateways?.paystack?.saved?.secretKey || q.data.envPaystack ? <Badge tone="green">Connected</Badge> : <Badge>Not connected</Badge>}
          </header>
          <div className="grid-2 tight">
            <Field label="Secret key">
              <input className="input mono" type="password" placeholder={q.data.paymentKeys?.gateways?.paystack?.saved?.secretKey ? "•••••••• (saved)" : "sk_live_…"} value={keys.secretKey} onChange={(x) => setKeys({ ...keys, secretKey: x.target.value })} autoComplete="new-password" />
            </Field>
            <Field label="Public key (optional)">
              <input className="input mono" value={keys.publicKey} onChange={(x) => setKeys({ ...keys, publicKey: x.target.value })} />
            </Field>
          </div>
          <small className="muted">Webhook URL for your Paystack dashboard: {location.origin}/api/webhooks/paystack</small>
        </div>
      </Panel>
      <Panel title="Plans" subtitle="Leave a limit empty for unlimited. Keep a plan with id “free” — it's the default for new organizations.">
        <div className="stack">
          {cfg.plans.map((p: Plan, i: number) => (
            <div key={i} className="plan-editor">
              <div className="grid-4 tight">
                <Field label="Id">
                  <input className="input mono" value={p.id} onChange={(x) => setPlan(i, { id: x.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
                </Field>
                <Field label="Name">
                  <input className="input" value={p.name} onChange={(x) => setPlan(i, { name: x.target.value })} />
                </Field>
                <Field label={`Price / 30 days (${cfg.currency})`}>
                  <input className="input" type="number" min={0} step="any" value={p.price} onChange={(x) => setPlan(i, { price: Number(x.target.value) })} />
                </Field>
                <Field label="Platform fee on paid votes %">
                  <input className="input" type="number" min={0} max={100} step="any" value={p.platformFeePercent} onChange={(x) => setPlan(i, { platformFeePercent: Number(x.target.value) })} />
                </Field>
                <Field label="Live events">
                  <input className="input" type="number" min={0} placeholder="∞" value={p.maxLiveEvents ?? ""} onChange={(x) => setPlan(i, { maxLiveEvents: num(x.target.value) })} />
                </Field>
                <Field label="Team members">
                  <input className="input" type="number" min={1} placeholder="∞" value={p.maxTeamMembers ?? ""} onChange={(x) => setPlan(i, { maxTeamMembers: num(x.target.value) })} />
                </Field>
                <Field label="Voters / event">
                  <input className="input" type="number" min={0} placeholder="∞" value={p.maxVotersPerEvent ?? ""} onChange={(x) => setPlan(i, { maxVotersPerEvent: num(x.target.value) })} />
                </Field>
                <Field label="Ballots / free votes per event">
                  <input className="input" type="number" min={0} placeholder="∞" value={p.maxBallotsPerEvent ?? ""} onChange={(x) => setPlan(i, { maxBallotsPerEvent: num(x.target.value) })} />
                </Field>
                <div className="toggle-list">
                  <Toggle label="Paid voting" checked={p.paidVoting} onChange={(v) => setPlan(i, { paidVoting: v })} />
                  <Toggle label="Remove branding" checked={p.removeBranding} onChange={(v) => setPlan(i, { removeBranding: v })} />
                  <Toggle label="Show ads" checked={p.showAds} onChange={(v) => setPlan(i, { showAds: v })} />
                  <Toggle label="SMS invites & reminders" checked={p.sms} onChange={(v) => setPlan(i, { sms: v })} />
                  <Toggle label="API & webhooks" checked={p.api} onChange={(v) => setPlan(i, { api: v })} />
                </div>
              </div>
              <Field label="Feature bullets (one per line)">
                <textarea className="input" rows={3} value={p.features.join("\n")} onChange={(x) => setPlan(i, { features: x.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 12) })} />
              </Field>
              {p.id !== "free" && (
                <Button kind="quiet" size="sm" onClick={() => setCfg({ ...cfg, plans: cfg.plans.filter((_: Plan, j: number) => j !== i) })}>
                  <Trash2 size={14} /> Remove plan
                </Button>
              )}
            </div>
          ))}
          <Button
            kind="outline"
            onClick={() =>
              setCfg({
                ...cfg,
                plans: [...cfg.plans, { id: `plan-${cfg.plans.length + 1}`, name: "New plan", price: 10000, maxLiveEvents: 3, maxVotersPerEvent: 1000, maxBallotsPerEvent: null, paidVoting: true, removeBranding: false, platformFeePercent: 5, sms: false, api: false, maxTeamMembers: 5, showAds: false, features: [] }],
              })
            }
          >
            <Plus size={15} /> Add plan
          </Button>
        </div>
      </Panel>
      <Panel title="Event passes (one-off, per event)" subtitle="Organizations can upgrade a single event without subscribing. A pass lifts that event's voter limit, removes the ballot cap and branding, and enables paid voting.">
        <div className="stack">
          {(cfg.passes ?? []).map((p: any, i: number) => (
            <div key={i} className="grid-4 tight pass-editor">
              <Field label="Id">
                <input className="input mono" value={p.id} onChange={(x) => setCfg({ ...cfg, passes: cfg.passes.map((y: any, j: number) => (j === i ? { ...y, id: x.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") } : y)) })} />
              </Field>
              <Field label="Name">
                <input className="input" value={p.name} onChange={(x) => setCfg({ ...cfg, passes: cfg.passes.map((y: any, j: number) => (j === i ? { ...y, name: x.target.value } : y)) })} />
              </Field>
              <Field label="Voters">
                <input className="input" type="number" min={1} value={p.voters} onChange={(x) => setCfg({ ...cfg, passes: cfg.passes.map((y: any, j: number) => (j === i ? { ...y, voters: Number(x.target.value) } : y)) })} />
              </Field>
              <Field label={`Price (${cfg.currency})`}>
                <div className="suffix-input">
                  <input className="input" type="number" min={0} value={p.price} onChange={(x) => setCfg({ ...cfg, passes: cfg.passes.map((y: any, j: number) => (j === i ? { ...y, price: Number(x.target.value) } : y)) })} />
                  <button type="button" className="icon-btn" aria-label="Remove pass" onClick={() => setCfg({ ...cfg, passes: cfg.passes.filter((_: any, j: number) => j !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </Field>
            </div>
          ))}
          <Button kind="outline" onClick={() => setCfg({ ...cfg, passes: [...(cfg.passes ?? []), { id: `pass-${Date.now() % 100000}`, name: "Up to 500 voters", voters: 500, price: 15000 }] })}>
            <Plus size={15} /> Add pass
          </Button>
        </div>
      </Panel>
      <div className="save-bar">
        <span className="muted small">Saving updates pricing everywhere immediately.</span>
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const paymentKeys = { paystack: { publicKey: keys.publicKey, ...(keys.secretKey.trim() ? { secretKey: keys.secretKey.trim() } : {}) } };
              await put("/admin/config", { plans: cfg.plans, passes: cfg.passes ?? [], currency: cfg.currency, billingProvider: cfg.billingProvider, allowSignups: cfg.allowSignups, paymentKeys });
              toast.ok("Platform settings saved.");
              setCfg(null);
              void q.refetch();
              void queryClient.invalidateQueries({ queryKey: ["config"] });
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save size={15} /> Save platform settings
        </Button>
      </div>
    </div>
  );
}

function Payments() {
  const q = useQuery({ queryKey: ["admin", "payments"], queryFn: () => get<any[]>("/admin/payments") });
  if (q.isLoading) return <Loading />;
  return (
    <Panel title="Latest payments">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Organization</th>
              <th>Details</th>
              <th>Amount</th>
              <th>Fee</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((p) => (
              <tr key={p.reference}>
                <td className="small nowrap">{fmtDate(p.created_at)}</td>
                <td>{p.kind}</td>
                <td>{p.org_name ?? "—"}</td>
                <td className="small">
                  {p.event_title ?? ""} {p.quantity ? `· ${p.quantity} votes` : ""}
                  <span className="block muted">
                    {p.provider} · {p.reference}
                  </span>
                </td>
                <td>{formatMoney(fromMinor(p.amount_minor, p.currency), p.currency)}</td>
                <td>{p.platform_fee_minor ? formatMoney(fromMinor(p.platform_fee_minor, p.currency), p.currency) : "—"}</td>
                <td>
                  <StateBadge value={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---------------- Ads ----------------
interface AdForm {
  id?: string;
  title: string;
  body: string;
  imageFileId: string | null;
  linkUrl: string;
  cta: string;
  placements: AdPlacement[];
  planIds: string[];
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  weight: number;
}
const blankAd = (): AdForm => ({ title: "", body: "", imageFileId: null, linkUrl: "https://", cta: "Learn more", placements: ["voting_page", "dashboard"], planIds: [], active: true, startsAt: null, endsAt: null, weight: 1 });

function AdsAdmin() {
  const toast = useToast();
  const cfg = useConfig();
  const ads = useQuery({ queryKey: ["admin", "ads"], queryFn: () => get<any[]>("/admin/ads") });
  const [editing, setEditing] = useState<AdForm | null>(null);
  const [busy, setBusy] = useState(false);
  const adPlans = (cfg.data?.plans ?? []).filter((p) => p.showAds);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const { id, ...body } = editing;
      if (id) await patch(`/admin/ads/${id}`, body);
      else await post("/admin/ads", body);
      toast.ok("Ad saved.");
      setEditing(null);
      void ads.refetch();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <Panel
        title="Ads"
        subtitle={`Shown on plans with “Show ads” switched on (${adPlans.map((p) => p.name).join(", ") || "none right now — turn it on per plan in Plans & settings"}). Paid plans and events with a pass stay ad-free. Advertisers never receive voter or organizer data.`}
        action={
          <Button size="sm" onClick={() => setEditing(blankAd())}>
            <Plus size={14} /> New ad
          </Button>
        }
      >
        {ads.isLoading ? (
          <Loading />
        ) : !ads.data?.length ? (
          <p className="muted">No ads yet. Free organizations see no ads until you add one.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Where</th>
                  <th>Schedule</th>
                  <th>Impressions</th>
                  <th>Clicks</th>
                  <th>CTR</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ads.data.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <b>{a.title}</b> {a.active ? <Badge tone="green">Active</Badge> : <Badge>Paused</Badge>}
                      <small className="block muted">{a.linkUrl}</small>
                    </td>
                    <td className="small">
                      {a.placements.map((p: AdPlacement) => AD_PLACEMENT_LABELS[p]).join(", ")}
                      <small className="block muted">{a.planIds.length ? a.planIds.join(", ") : "All ad plans"} · weight {a.weight}</small>
                    </td>
                    <td className="small">{a.startsAt || a.endsAt ? `${a.startsAt ? fmtDate(a.startsAt) : "now"} → ${a.endsAt ? fmtDate(a.endsAt) : "no end"}` : "Always"}</td>
                    <td>{fmtNum(a.impressions)}</td>
                    <td>{fmtNum(a.clicks)}</td>
                    <td>{a.impressions ? `${((a.clicks / a.impressions) * 100).toFixed(1)}%` : "—"}</td>
                    <td>
                      <div className="btn-row nowrap">
                        <Button size="sm" kind="outline" onClick={() => setEditing({ ...blankAd(), ...a })}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          kind="quiet"
                          onClick={async () => {
                            try {
                              await patch(`/admin/ads/${a.id}`, { ...blankAd(), ...a, id: undefined, impressions: undefined, clicks: undefined, createdAt: undefined, active: !a.active });
                              void ads.refetch();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          {a.active ? "Pause" : "Activate"}
                        </Button>
                        <ConfirmButton size="sm" kind="quiet" confirm={`Delete “${a.title}”?`} onConfirm={() => del(`/admin/ads/${a.id}`).then(() => ads.refetch(), toast.error)}>
                          <Trash2 size={14} />
                        </ConfirmButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? "Edit ad" : "New ad"}>
        {editing && (
          <div className="form-stack">
            <Field label="Headline">
              <input className="input" maxLength={80} value={editing.title} onChange={(x) => setEditing({ ...editing, title: x.target.value })} />
            </Field>
            <Field label="Text (optional)">
              <textarea className="input" rows={2} maxLength={240} value={editing.body} onChange={(x) => setEditing({ ...editing, body: x.target.value })} />
            </Field>
            <div className="grid-2 tight">
              <Field label="Link">
                <input className="input" type="url" value={editing.linkUrl} onChange={(x) => setEditing({ ...editing, linkUrl: x.target.value })} />
              </Field>
              <Field label="Button text">
                <input className="input" maxLength={30} value={editing.cta} onChange={(x) => setEditing({ ...editing, cta: x.target.value })} />
              </Field>
            </div>
            <ImageUpload label="Image (optional, square works best)" endpoint="/admin/files" value={editing.imageFileId} onChange={(id) => setEditing({ ...editing, imageFileId: id })} />
            <div>
              <span className="field-label">Show on</span>
              <div className="method-picks">
                {AD_PLACEMENTS.map((p) => (
                  <label key={p} className="check">
                    <input type="checkbox" checked={editing.placements.includes(p)} onChange={(x) => setEditing({ ...editing, placements: x.target.checked ? [...editing.placements, p] : editing.placements.filter((y) => y !== p) })} />
                    {AD_PLACEMENT_LABELS[p]}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <span className="field-label">Plans (none ticked = every plan that shows ads)</span>
              <div className="method-picks">
                {(cfg.data?.plans ?? []).map((p) => (
                  <label key={p.id} className={`check ${p.showAds ? "" : "is-disabled"}`}>
                    <input type="checkbox" disabled={!p.showAds} checked={editing.planIds.includes(p.id)} onChange={(x) => setEditing({ ...editing, planIds: x.target.checked ? [...editing.planIds, p.id] : editing.planIds.filter((y) => y !== p.id) })} />
                    {p.name}
                    {!p.showAds && <small className="muted"> (ad-free)</small>}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid-3 tight">
              <Field label="Starts (optional)">
                <input className="input" type="datetime-local" value={toLocalInput(editing.startsAt)} onChange={(x) => setEditing({ ...editing, startsAt: fromLocalInput(x.target.value) })} />
              </Field>
              <Field label="Ends (optional)">
                <input className="input" type="datetime-local" value={toLocalInput(editing.endsAt)} onChange={(x) => setEditing({ ...editing, endsAt: fromLocalInput(x.target.value) })} />
              </Field>
              <Field label="Weight" hint="Higher = shown more often">
                <input className="input" type="number" min={1} max={100} value={editing.weight} onChange={(x) => setEditing({ ...editing, weight: Math.min(100, Math.max(1, Number(x.target.value) || 1)) })} />
              </Field>
            </div>
            <Toggle label="Active" checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} />
            <div className="modal-actions">
              <Button kind="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button busy={busy} onClick={save}>
                <Save size={15} /> Save ad
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ---------------- Legal ----------------
function LegalAdmin() {
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin", "legal"], queryFn: () => get<any>("/admin/legal") });
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (q.data && !f) setF({ ...q.data, liabilityCap: q.data.liabilityCapMinor / 100 });
  }, [q.data, f]);
  if (q.isLoading || !f) return <Loading />;
  const save = async (requireReaccept: boolean) => {
    setBusy(requireReaccept ? "publish" : "save");
    try {
      await put("/admin/legal", {
        companyName: f.companyName,
        tradingName: f.tradingName,
        registrationNumber: f.registrationNumber,
        address: f.address,
        contactEmail: f.contactEmail,
        privacyEmail: f.privacyEmail,
        governingLaw: f.governingLaw,
        courts: f.courts,
        arbitrationSeat: f.arbitrationSeat,
        minimumAge: Number(f.minimumAge),
        liabilityCapMinor: Math.round(Number(f.liabilityCap) * 100),
        requireReaccept,
      });
      toast.ok(requireReaccept ? "New version published — everyone will be asked to accept it." : "Legal details saved.");
      setF(null);
      void q.refetch();
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      if (requireReaccept) void queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy("");
    }
  };
  const text = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input" value={f[k] ?? ""} onChange={(x) => setF({ ...f, [k]: x.target.value })} />
    </Field>
  );
  return (
    <div className="stack">
      <div className="notice">
        The <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a> are strong templates written for a Nigerian operator (NDPA 2023, FCCPA 2018, Arbitration and Mediation Act 2023). They are not legal advice — have a lawyer review them for your business before launch. Fill in your company details below so they appear in both documents.
      </div>
      <Panel title="Operator details" subtitle={`Current version ${q.data.termsVersion} · ${q.data.accepted.n} of ${q.data.accepted.total} users have accepted it.`}>
        <div className="form-stack">
          <div className="grid-2 tight">
            {text("companyName", "Registered company name", "e.g. VoteHub Technologies Ltd")}
            {text("tradingName", "Trading / product name")}
            {text("registrationNumber", "CAC registration number (RC)")}
            {text("contactEmail", "Legal / support email")}
            {text("privacyEmail", "Privacy / DPO email (optional)")}
            {text("address", "Registered address")}
            {text("governingLaw", "Governing law")}
            {text("courts", "Courts")}
            {text("arbitrationSeat", "Arbitration seat")}
            <Field label="Minimum account age">
              <input className="input" type="number" min={13} max={21} value={f.minimumAge} onChange={(x) => setF({ ...f, minimumAge: x.target.value })} />
            </Field>
            <Field label="Liability floor (NGN)" hint="Liability cap = the greater of 12 months' fees and this amount.">
              <input className="input" type="number" min={0} value={f.liabilityCap} onChange={(x) => setF({ ...f, liabilityCap: x.target.value })} />
            </Field>
          </div>
          <div className="btn-row">
            <Button busy={busy === "save"} onClick={() => save(false)}>
              <Save size={15} /> Save details
            </Button>
            <ConfirmButton kind="outline" confirm="Publish a new version? Every user will have to accept the terms again before they can continue." onConfirm={() => save(true)}>
              Publish new version (everyone re-accepts)
            </ConfirmButton>
          </div>
          <small className="muted">Use “Publish new version” after material changes to the terms. Correcting your address or email doesn't need re-acceptance.</small>
        </div>
      </Panel>
    </div>
  );
}

// ---------------- Appearance ----------------
function AppearanceAdmin() {
  const toast = useToast();
  const cfg = useConfig();
  const q = useQuery({ queryKey: ["admin", "appearance"], queryFn: () => get<Appearance>("/admin/appearance") });
  const [a, setA] = useState<Appearance | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !a) setA(structuredClone(q.data));
  }, [q.data, a]);
  // Preview the draft across the whole app; put the saved theme back when leaving without saving.
  useEffect(() => {
    if (a) applyTheme(a);
  }, [a]);
  useEffect(() => () => applyTheme(queryClient.getQueryData<any>(["config"])?.appearance), []);
  if (q.isLoading || !a) return <Loading />;
  const custom = resolveTheme({ ...a, themeId: "custom" });
  const setCustom = (k: "primary" | "accent" | "sidebar" | "bg", v: string) => setA({ ...a, themeId: "custom", custom: { ...(a.custom ?? {}), [k]: v } });
  const dirty = JSON.stringify(a) !== JSON.stringify(q.data);
  const save = async () => {
    setBusy(true);
    try {
      await put("/admin/appearance", { ...a, custom: a.custom ?? {}, galleryImageIds: a.galleryImageIds ?? [], heroImageId: a.heroImageId ?? null, headline: a.headline ?? "", subheadline: a.subheadline ?? "" });
      toast.ok("Appearance saved — everyone now sees these colours.");
      await q.refetch();
      setA(null);
      await queryClient.invalidateQueries({ queryKey: ["config"] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const gallery = a.galleryImageIds ?? [];
  return (
    <div className="stack">
      <Panel title="Colours" subtitle="Pick a theme for the whole platform: landing page, dashboards and every voting page. You're previewing it now; nothing changes for others until you save. Organizations can still set their own colour for their voting pages.">
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button key={t.id} type="button" className={`theme-card ${a.themeId === t.id ? "on" : ""}`} onClick={() => setA({ ...a, themeId: t.id })} aria-pressed={a.themeId === t.id}>
              <span className="theme-swatch">
                <i style={{ background: t.sidebar }} />
                <i style={{ background: t.primary }} />
                <i style={{ background: t.accent }} />
                <i style={{ background: t.bg }} />
              </span>
              <b>{t.name}</b>
              <small>{t.note}</small>
            </button>
          ))}
          <div className={`theme-card custom ${a.themeId === "custom" ? "on" : ""}`}>
            <span className="theme-swatch">
              <i style={{ background: custom.sidebar }} />
              <i style={{ background: custom.primary }} />
              <i style={{ background: custom.accent }} />
              <i style={{ background: custom.bg }} />
            </span>
            <b>Your own colours</b>
            <div className="custom-pickers">
              {(
                [
                  ["primary", "Main"],
                  ["accent", "Accent"],
                  ["sidebar", "Dark"],
                  ["bg", "Background"],
                ] as const
              ).map(([k, label]) => (
                <label key={k}>
                  <input type="color" value={custom[k]} onChange={(x) => setCustom(k, x.target.value)} />
                  <small>{label}</small>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Panel>
      <Panel title="Landing page" subtitle="Your own words and photos make the front page feel like yours. Photos of real events (award nights, AGMs, campus elections) work best.">
        <div className="form-stack">
          <Field label="Headline" hint="Leave empty for the default.">
            <input className="input" maxLength={90} placeholder="Every vote counted. Every result trusted." value={a.headline ?? ""} onChange={(x) => setA({ ...a, headline: x.target.value })} />
          </Field>
          <Field label="Sub-heading">
            <textarea className="input" rows={2} maxLength={260} value={a.subheadline ?? ""} onChange={(x) => setA({ ...a, subheadline: x.target.value })} />
          </Field>
          <ImageUpload label="Hero background photo (wide, at least 1600px)" endpoint="/admin/files" value={a.heroImageId ?? null} onChange={(id) => setA({ ...a, heroImageId: id })} />
          {a.heroImageId && (
            <button type="button" className="text-link small fit" onClick={() => setA({ ...a, heroImageId: null })}>
              Remove hero photo
            </button>
          )}
          <div>
            <span className="field-label">Photo strip ({gallery.length} of 6) — shown under “Made for the room where it happens”</span>
            <div className="gallery-edit">
              {gallery.map((id, i) => (
                <div key={id} className="gallery-thumb">
                  <img src={`/api/files/${id}`} alt="" />
                  <button type="button" className="icon-btn" aria-label="Remove photo" onClick={() => setA({ ...a, galleryImageIds: gallery.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {gallery.length < 6 && <ImageUpload label="Add photo" endpoint="/admin/files" value={null} onChange={(id) => id && setA({ ...a, galleryImageIds: [...gallery, id] })} />}
            </div>
          </div>
        </div>
      </Panel>
      <div className="save-bar">
        <span className="muted small">{dirty ? "Previewing unsaved changes." : `Saved. Live for everyone on ${cfg.data?.appName ?? "the platform"}.`}</span>
        <div className="btn-row">
          {dirty && (
            <Button kind="outline" onClick={() => setA(structuredClone(q.data!))}>
              Discard
            </Button>
          )}
          <Button busy={busy} disabled={!dirty} onClick={save}>
            <Save size={15} /> Save appearance
          </Button>
        </div>
      </div>
    </div>
  );
}
