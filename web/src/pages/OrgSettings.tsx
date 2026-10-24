import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Save, Trash2 } from "lucide-react";
import { api, del, get, isAdmin, patch, post, queryClient, setOrgId, useCurrentOrg } from "../api";
import { Badge, Button, CopyField, ErrorState, Field, ImageUpload, Loading, PageHead, Panel, useToast } from "../ui";
import { themePrimary } from "../theme";
import { CURRENCIES, GATEWAYS, GATEWAY_INFO, type GatewayId } from "@shared/model";

export function OrgSettingsPage() {
  const org = useCurrentOrg();
  const toast = useToast();
  const q = useQuery({ queryKey: ["org", org?.id], queryFn: () => get("/org") });
  if (q.isLoading) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return <SettingsForm data={q.data} canEditAll={isAdmin(org?.role)} onSaved={() => (toast.ok("Saved."), void q.refetch(), void queryClient.invalidateQueries({ queryKey: ["me"] }))} />;
}

function SettingsForm({ data, canEditAll, onSaved }: { data: any; canEditAll: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: data.name,
    orgType: data.orgType,
    primaryColor: (data.branding.primaryColor && data.branding.primaryColor !== "#286352" ? data.branding.primaryColor : null) as string | null,
    logoFileId: data.branding.logoFileId ?? null,
    website: data.branding.website ?? "",
    supportEmail: data.branding.supportEmail ?? "",
    defaultCurrency: data.settings.defaultCurrency ?? "NGN",
  });
  const [busy, setBusy] = useState("");
  const saveGeneral = async () => {
    setBusy("general");
    try {
      await patch("/org", {
        name: form.name,
        orgType: form.orgType,
        defaultCurrency: form.defaultCurrency,
        branding: { primaryColor: form.primaryColor, logoFileId: form.logoFileId, website: form.website, supportEmail: form.supportEmail },
      });
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy("");
    }
  };
  return (
    <>
      <PageHead eyebrow="Settings" title="Organization settings" subtitle="Name, branding and payment gateways for your voting pages." />
      <fieldset disabled={!canEditAll} className="stack">
        <Panel title="General">
          <div className="form-stack">
            <div className="grid-2 tight">
              <Field label="Organization name">
                <input className="input" value={form.name} onChange={(x) => setForm({ ...form, name: x.target.value })} />
              </Field>
              <Field label="Type">
                <input className="input" value={form.orgType} onChange={(x) => setForm({ ...form, orgType: x.target.value })} />
              </Field>
            </div>
            <div className="grid-3 tight">
              <Field label="Brand colour">
                <div className="color-row">
                  <input className="input color" type="color" value={form.primaryColor ?? themePrimary()} onChange={(x) => setForm({ ...form, primaryColor: x.target.value })} />
                  {form.primaryColor ? (
                    <button type="button" className="text-link small" onClick={() => setForm({ ...form, primaryColor: null })}>
                      Use platform colour
                    </button>
                  ) : (
                    <small className="muted">Platform colour</small>
                  )}
                </div>
              </Field>
              <Field label="Website">
                <input className="input" type="url" placeholder="https://" value={form.website} onChange={(x) => setForm({ ...form, website: x.target.value })} />
              </Field>
              <Field label="Default currency for paid votes">
                <select className="input" value={form.defaultCurrency} onChange={(x) => setForm({ ...form, defaultCurrency: x.target.value })}>
                  {CURRENCIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Support email shown to voters">
              <input className="input" type="email" value={form.supportEmail} onChange={(x) => setForm({ ...form, supportEmail: x.target.value })} />
            </Field>
            <ImageUpload label="Logo" value={form.logoFileId} onChange={(id) => setForm({ ...form, logoFileId: id })} />
            <div>
              <Button busy={busy === "general"} onClick={saveGeneral}>
                <Save size={15} /> Save
              </Button>
            </div>
          </div>
        </Panel>

        {data.paymentKeys ? (
          <PaymentMethodsPanel data={data} onSaved={onSaved} />
        ) : (
          <Panel title="Payment methods">
            <p className="muted">Only owners and admins can view payment settings.</p>
          </Panel>
        )}
        {canEditAll && <DeveloperPanel data={data} onSaved={onSaved} />}
        {data.role === "owner" && <DangerZone name={data.name} />}
      </fieldset>
    </>
  );
}

function DeveloperPanel({ data, onSaved }: { data: any; onSaved: () => void }) {
  const toast = useToast();
  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => get<{ keys: any[]; available: boolean }>("/org/api-keys") });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [hook, setHook] = useState({ url: data.webhook?.url ?? "", secret: "" });
  const [busy, setBusy] = useState("");
  const available = keys.data?.available;
  return (
    <Panel title="Developers: API & webhooks" subtitle="Connect your member database, CRM or website. Included in Pro and above.">
      {!available && keys.data && (
        <div className="notice">
          API keys and webhooks are part of the Pro plan. <a href="/app/billing">See plans</a>
        </div>
      )}
      <fieldset disabled={!available} className="stack">
        <div>
          <span className="field-label">API keys</span>
          {newKey && (
            <div className="notice">
              Copy this key now — it won't be shown again.
              <CopyField value={newKey} />
            </div>
          )}
          <ul className="row-list">
            {(keys.data?.keys ?? []).map((k) => (
              <li key={k.id} className="row-item">
                <span>
                  <b>{k.name}</b>
                  <small>
                    {k.prefix}… · created {new Date(k.created_at).toLocaleDateString()} · {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : "never used"}
                  </small>
                </span>
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={async () => {
                    await del(`/org/api-keys/${k.id}`).catch(toast.error);
                    void keys.refetch();
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
          <div className="inline-form">
            <Field label="New key name">
              <input className="input" value={name} onChange={(x) => setName(x.target.value)} placeholder="e.g. Member portal" />
            </Field>
            <Button
              busy={busy === "key"}
              disabled={name.trim().length < 2}
              onClick={async () => {
                setBusy("key");
                try {
                  const r = await post<{ key: string }>("/org/api-keys", { name });
                  setNewKey(r.key);
                  setName("");
                  void keys.refetch();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy("");
                }
              }}
            >
              Create key
            </Button>
          </div>
          <p className="muted small">
            Endpoints: <code>GET /api/v1/events</code>, <code>GET /api/v1/events/:id/results</code>, <code>GET /api/v1/events/:id/turnout</code>, <code>GET|POST /api/v1/events/:id/voters</code> — send <code>Authorization: Bearer &lt;key&gt;</code>.
          </p>
        </div>
        <div className="form-stack">
          <span className="field-label">Outgoing webhook</span>
          <p className="muted small">
            We POST JSON to your URL on <code>ballot.cast</code>, <code>vote.cast</code>, <code>payment.succeeded</code> and <code>event.status_changed</code>, signed with <code>X-VoteHub-Signature: sha256=…</code> (HMAC of the body with your secret). Voter choices are never sent.
          </p>
          <div className="grid-2 tight">
            <Field label="HTTPS URL">
              <input className="input" value={hook.url} onChange={(x) => setHook({ ...hook, url: x.target.value })} placeholder="https://example.com/votehub-webhook" />
            </Field>
            <Field label="Signing secret" hint={data.webhook?.hasSecret ? "Saved (hidden). Enter a new one to replace it." : undefined}>
              <input className="input mono" type="password" value={hook.secret} onChange={(x) => setHook({ ...hook, secret: x.target.value })} autoComplete="new-password" />
            </Field>
          </div>
          <div className="btn-row">
            <Button
              size="sm"
              busy={busy === "hook"}
              onClick={async () => {
                setBusy("hook");
                try {
                  await patch("/org", { webhook: hook });
                  setHook({ ...hook, secret: "" });
                  onSaved();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy("");
                }
              }}
            >
              Save webhook
            </Button>
            {data.webhook?.url && (
              <Button kind="quiet" size="sm" onClick={() => patch("/org", { webhook: { url: "" } }).then(() => (setHook({ url: "", secret: "" }), onSaved()), toast.error)}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </fieldset>
    </Panel>
  );
}

function DangerZone({ name }: { name: string }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Panel title="Delete organization" className="danger-panel" subtitle="Permanently deletes this organization, its events, voter lists, ballots, results and payment records. This can't be undone.">
      <fieldset className="inline-form" disabled={false}>
        <Field label={`Type "${name}" to confirm`}>
          <input className="input" value={confirm} onChange={(x) => setConfirm(x.target.value)} />
        </Field>
        <Button
          kind="danger"
          busy={busy}
          disabled={confirm.trim() !== name}
          onClick={async () => {
            setBusy(true);
            try {
              await api("DELETE", "/org", { confirm });
              setOrgId(null);
              queryClient.clear();
              location.href = "/app";
            } catch (err) {
              toast.error(err);
              setBusy(false);
            }
          }}
        >
          Delete permanently
        </Button>
      </fieldset>
    </Panel>
  );
}

type ManualDraft = { id?: string; label: string; instructions: string; enabled: boolean };

/** Every gateway is optional — events can be free. Organizations enable any mix of online gateways and manual methods (bank transfer, POS, cash…). */
function PaymentMethodsPanel({ data, onSaved }: { data: any; onSaved: () => void }) {
  const toast = useToast();
  const gw = data.paymentKeys.gateways as Record<GatewayId, { enabled: boolean; ready: boolean; values: Record<string, string>; saved: Record<string, boolean> }>;
  const [drafts, setDrafts] = useState<Record<string, Record<string, string>>>(() => Object.fromEntries(GATEWAYS.map((g) => [g, { ...gw[g].values }])));
  const [open, setOpen] = useState<string | null>(null);
  const [manual, setManual] = useState<ManualDraft[]>(data.paymentKeys.manual ?? []);
  const [busy, setBusy] = useState("");
  const send = async (paymentKeys: any, tag: string) => {
    setBusy(tag);
    try {
      await patch("/org", { paymentKeys });
      onSaved();
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setBusy("");
    }
  };
  const methods: any[] = data.paymentMethods ?? [];
  return (
    <Panel
      title="Payment methods"
      subtitle="Only needed for paid voting — free elections and polls need none of this. Turn on any mix of gateways and manual methods; each event then chooses which to offer voters."
    >
      <div className="notice soft">
        {methods.length ? (
          <>
            Voters can currently pay with: <b>{methods.filter((m) => m.kind !== "test").map((m) => m.label).join(", ") || "test mode only"}</b>.
            {!gw.paystack.ready && methods.some((m) => m.id === "paystack") && " (Paystack uses the platform's account, settled to you minus the platform fee, until you connect your own.)"}
          </>
        ) : (
          "No payment methods yet. That's fine for free events — add one below when you need paid voting."
        )}
      </div>
      <div className="stack">
        {GATEWAYS.map((id) => {
          const info = GATEWAY_INFO[id];
          const st = gw[id];
          const d = drafts[id]!;
          const isOpen = open === id;
          return (
            <div key={id} className="gateway">
              <header>
                <b>{info.name}</b>
                {st.ready ? <Badge tone="green">On</Badge> : st.enabled ? <Badge tone="gold">Needs keys</Badge> : <Badge>Off</Badge>}
                <span className="spacer" />
                <Button size="sm" kind="outline" onClick={() => setOpen(isOpen ? null : id)}>
                  {isOpen ? "Close" : st.enabled ? "Edit" : "Set up"}
                </Button>
              </header>
              <p className="muted small">{info.tagline}</p>
              {isOpen && (
                <div className="form-stack">
                  <div className="grid-2 tight">
                    {info.fields.map((f) => (
                      <Field key={f.key} label={f.label} hint={f.secret && st.saved[f.key] ? "Saved (hidden). Type a new value to replace it." : undefined}>
                        {f.options ? (
                          <select className="input" value={d[f.key] ?? f.options[0]!.value} onChange={(x) => setDrafts({ ...drafts, [id]: { ...d, [f.key]: x.target.value } })}>
                            {f.options.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="input mono"
                            type={f.secret ? "password" : "text"}
                            autoComplete={f.secret ? "new-password" : "off"}
                            value={d[f.key] ?? ""}
                            placeholder={f.secret && st.saved[f.key] ? "••••••••••••" : f.placeholder}
                            onChange={(x) => setDrafts({ ...drafts, [id]: { ...d, [f.key]: x.target.value } })}
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                  <CopyField label={`Webhook URL — ${info.webhookHelp}`} value={data.webhookUrls[id]} />
                  <div className="btn-row">
                    <Button
                      size="sm"
                      busy={busy === id}
                      onClick={async () => {
                        if (await send({ [id]: { ...d, enabled: true } }, id)) {
                          setDrafts({ ...drafts, [id]: Object.fromEntries(Object.entries(d).filter(([k]) => !info.fields.find((f) => f.key === k)?.secret)) });
                          setOpen(null);
                        }
                      }}
                    >
                      Save and turn on
                    </Button>
                    {st.enabled && (
                      <Button size="sm" kind="outline" onClick={() => send({ [id]: { enabled: false } }, id)}>
                        Turn off (keep keys)
                      </Button>
                    )}
                    {(st.enabled || Object.values(st.saved).some(Boolean)) && (
                      <Button size="sm" kind="quiet" onClick={() => send({ [id]: null }, id)}>
                        Remove keys
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <div className="gateway">
          <header>
            <b>Manual methods</b>
            <Badge tone={manual.some((m) => m.enabled) ? "green" : "neutral"}>{manual.filter((m) => m.enabled).length} on</Badge>
          </header>
          <p className="muted small">
            Bank transfer, OPay/PalmPay/Moniepoint transfer, POS or cash. Voters see your instructions, pay you directly and submit a claim; votes are added when your team approves it under the event's Payments tab.
          </p>
          <div className="stack">
            {manual.map((m, i) => (
              <div key={i} className="manual-method">
                <div className="grid-2 tight">
                  <Field label="Name shown to voters">
                    <input className="input" value={m.label} maxLength={60} onChange={(x) => setManual(manual.map((y, j) => (j === i ? { ...y, label: x.target.value } : y)))} />
                  </Field>
                  <label className="check">
                    <input type="checkbox" checked={m.enabled} onChange={(x) => setManual(manual.map((y, j) => (j === i ? { ...y, enabled: x.target.checked } : y)))} /> Offer this method
                  </label>
                </div>
                <Field label="Instructions (account name, number, bank…)">
                  <textarea className="input" rows={3} maxLength={1500} value={m.instructions} onChange={(x) => setManual(manual.map((y, j) => (j === i ? { ...y, instructions: x.target.value } : y)))} />
                </Field>
                <Button size="sm" kind="quiet" onClick={() => setManual(manual.filter((_, j) => j !== i))}>
                  <Trash2 size={14} /> Remove
                </Button>
              </div>
            ))}
            <div className="btn-row">
              {manual.length < 6 && (
                <Button size="sm" kind="outline" onClick={() => setManual([...manual, { label: manual.length ? "OPay transfer" : "Bank transfer", instructions: "", enabled: true }])}>
                  <Plus size={14} /> Add a manual method
                </Button>
              )}
              <Button size="sm" busy={busy === "manual"} onClick={() => send({ manual }, "manual")}>
                Save manual methods
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
