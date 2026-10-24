import { themePrimary } from "../theme";
import { useState } from "react";
import { Link } from "wouter";
import { Plus, Save, Trash2 } from "lucide-react";
import { canEdit, patch, useConfig, useCurrentOrg, type EventDetail } from "../api";
import { Button, Field, ImageUpload, Panel, Segmented, Toggle, fromLocalInput, toLocalInput, useToast } from "../ui";
import { CURRENCIES, formatMoney, type EventSettings } from "@shared/model";
import { refreshEvent } from "./EventDetail";

type Fm = "off" | "optional" | "required";

export function SettingsTab({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const cfg = useConfig();
  const toast = useToast();
  const editable = canEdit(org?.role) && e.status !== "archived";
  const [s, setS] = useState<EventSettings>(structuredClone(e.settings));
  const [general, setGeneral] = useState({
    title: e.title,
    description: e.description,
    slug: e.slug,
    startsAt: toLocalInput(e.startsAt),
    endsAt: toLocalInput(e.endsAt),
    coverFileId: e.coverFileId,
  });
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const locked = e.locked;
  const set = <K extends keyof EventSettings>(k: K, v: Partial<EventSettings[K]>) => setS((prev) => ({ ...prev, [k]: { ...(prev[k] as object), ...(v as object) } as EventSettings[K] }));

  const save = async () => {
    setBusy(true);
    try {
      await patch(`/org/events/${e.id}`, {
        title: general.title,
        description: general.description,
        slug: general.slug,
        startsAt: fromLocalInput(general.startsAt),
        endsAt: fromLocalInput(general.endsAt),
        coverFileId: general.coverFileId,
        settings: s,
        ...(password.trim() ? { accessPassword: password.trim() } : !s.security.passwordProtected && e.hasPassword ? { accessPassword: null } : {}),
      });
      setPassword("");
      toast.ok("Settings saved.");
      refreshEvent(e.id);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const isTally = s.mode === "tally";
  const price = s.paid.pricePerVote;
  return (
    <div className="settings-layout">
      <fieldset disabled={!editable} className="stack">
        <Panel title="Basics">
          <div className="form-stack">
            <Field label="Title">
              <input className="input" value={general.title} onChange={(x) => setGeneral({ ...general, title: x.target.value })} maxLength={160} />
            </Field>
            <Field label="Description">
              <textarea className="input" rows={4} value={general.description} onChange={(x) => setGeneral({ ...general, description: x.target.value })} maxLength={5000} />
            </Field>
            <Field label="Page link" hint={`${location.origin}/e/${general.slug}`}>
              <input className="input" value={general.slug} onChange={(x) => setGeneral({ ...general, slug: x.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
            </Field>
            <div className="grid-2 tight">
              <Field label="Voting opens" hint="Empty = as soon as published">
                <input className="input" type="datetime-local" value={general.startsAt} onChange={(x) => setGeneral({ ...general, startsAt: x.target.value })} />
              </Field>
              <Field label="Voting closes" hint="Empty = close manually">
                <input className="input" type="datetime-local" value={general.endsAt} onChange={(x) => setGeneral({ ...general, endsAt: x.target.value })} />
              </Field>
            </div>
            <ImageUpload label="Cover image" value={general.coverFileId} onChange={(id) => setGeneral({ ...general, coverFileId: id })} />
          </div>
        </Panel>

        <Panel title="Voting style" subtitle={locked ? "Locked because votes have been cast." : undefined}>
          <Segmented
            value={s.mode}
            disabled={locked}
            onChange={(mode) => setS({ ...s, mode, ...(mode === "ballot" ? { paid: { ...s.paid, enabled: false } } : {}) })}
            options={[
              { value: "ballot", label: "Full ballot", hint: "Each voter submits one ballot covering every position (elections, polls, AGMs)." },
              { value: "tally", label: "Per-entry votes", hint: "People vote for individual entries, possibly many times or paid (contests, awards)." },
            ]}
          />
        </Panel>

        <Panel title="Who can vote" subtitle={locked ? "Locked because votes have been cast." : undefined}>
          <Segmented
            value={s.access}
            disabled={locked}
            onChange={(access) => setS({ ...s, access })}
            options={[
              { value: "roster", label: "Voter list", hint: "Only people you add. Each gets a private access code." },
              { value: "email", label: "Verified email", hint: "Anyone, after confirming their email with a one-time code." },
              { value: "public", label: "Anyone with the link", hint: "No sign-in. Limits apply per browser." },
            ]}
          />
          {s.access === "email" && !cfg.data?.mailEnabled && <p className="warn-text">Email isn't configured on this server, so voters won't receive codes. Configure SMTP or choose another option.</p>}
        </Panel>

        {!isTally && (
          <Panel title="Ballot rules">
            <div className="toggle-list">
              <Toggle label="Secret ballot" hint="Ballots are stored with no link to the voter. Turn off for recorded votes (e.g. board resolutions)." checked={s.ballot.secret} disabled={locked} onChange={(v) => set("ballot", { secret: v })} />
              <Toggle label="Weighted votes" hint="Use each voter's weight (shares, delegates). Voter list only." checked={s.ballot.weighted} disabled={locked || s.access !== "roster"} onChange={(v) => set("ballot", { weighted: v })} />
              <Toggle label="Allow abstaining" hint="Voters may skip a position." checked={s.ballot.allowAbstain} onChange={(v) => set("ballot", { allowAbstain: v })} />
              <Toggle label="Give voters a receipt code" hint="Lets a voter confirm their ballot was recorded." checked={s.ballot.receipts} onChange={(v) => set("ballot", { receipts: v })} />
              <Toggle label="Allow comments" hint="Voters can add a note with their ballot (shown to organizers only, never linked to the voter in a secret ballot)." checked={s.ballot.allowComments} onChange={(v) => set("ballot", { allowComments: v })} />
            </div>
            {s.access === "roster" && (
              <Field label="Quorum (minimum turnout)" hint={s.ballot.weighted ? "Percent of total voting weight that must vote for the result to be valid. 0 = no quorum." : "Percent of the voter list that must vote for the result to be valid. 0 = no quorum."}>
                <div className="suffix-input">
                  <input className="input" type="number" min={0} max={100} step="any" value={s.ballot.quorumPercent} onChange={(x) => set("ballot", { quorumPercent: Math.min(100, Math.max(0, Number(x.target.value) || 0)) })} />
                  <span>%</span>
                </div>
              </Field>
            )}
          </Panel>
        )}

        {isTally && (
          <Panel title="Free votes">
            <div className="toggle-list">
              <Toggle label="Allow free votes" hint="Each voter gets a number of free votes per category." checked={s.freeVotes.enabled} onChange={(v) => set("freeVotes", { enabled: v })} />
            </div>
            {s.freeVotes.enabled && (
              <div className="grid-2 tight">
                <Field label="Free votes per category">
                  <input className="input" type="number" min={1} max={1000} value={s.freeVotes.perVoter} onChange={(x) => set("freeVotes", { perVoter: Math.max(1, Number(x.target.value) || 1) })} />
                </Field>
                <Field label="Allowance resets">
                  <select className="input" value={s.freeVotes.period} onChange={(x) => set("freeVotes", { period: x.target.value as "total" | "daily" })}>
                    <option value="total">Never (for the whole event)</option>
                    <option value="daily">Every day</option>
                  </select>
                </Field>
              </div>
            )}
          </Panel>
        )}

        {isTally && (
          <Panel title="Paid votes" subtitle={!e.plan.paidVoting ? undefined : `Platform fee on your plan: ${e.plan.platformFeePercent}%`}>
            {!e.plan.paidVoting ? (
              <div className="notice">
                Paid voting isn't included in the {e.plan.name} plan. <Link href="/billing">Upgrade your plan</Link> to sell votes.
              </div>
            ) : (
              <>
                <div className="toggle-list">
                  <Toggle label="Sell votes" hint="Voters pay per vote through your payment gateway. Votes are counted only after the payment is verified." checked={s.paid.enabled} onChange={(v) => set("paid", { enabled: v })} />
                </div>
                {s.paid.enabled && (
                  <div className="form-stack">
                    <div>
                      <span className="field-label">How voters can pay</span>
                      {e.paymentMethods.length === 0 ? (
                        <div className="notice">
                          Your organization has no payment methods yet. Add a gateway (Paystack, Flutterwave, Stripe, Monnify, OPay) or a manual method like bank transfer in <Link href="/settings">Settings → Payment methods</Link>.
                        </div>
                      ) : (
                        <>
                          <div className="method-picks">
                            {e.paymentMethods.map((m) => {
                              const chosen = s.paid.methods.length ? s.paid.methods.includes(m.id) : m.kind !== "test";
                              return (
                                <label key={m.id} className="check">
                                  <input
                                    type="checkbox"
                                    checked={chosen}
                                    onChange={(x) => {
                                      const base = s.paid.methods.length ? s.paid.methods : e.paymentMethods.filter((y) => y.kind !== "test").map((y) => y.id);
                                      set("paid", { methods: x.target.checked ? [...new Set([...base, m.id])] : base.filter((id) => id !== m.id) });
                                    }}
                                  />
                                  {m.label}
                                  {m.kind === "manual" && <small className="muted"> · you approve each payment</small>}
                                  {m.kind === "test" && <small className="muted"> · no real money</small>}
                                </label>
                              );
                            })}
                          </div>
                          <small className="muted">Voters choose one at checkout. Manage methods in <Link href="/settings">Settings → Payment methods</Link>.</small>
                        </>
                      )}
                    </div>
                    <div className="grid-2 tight">
                      <Field label="Currency">
                        <select className="input" value={s.paid.currency} disabled={locked} onChange={(x) => set("paid", { currency: x.target.value as EventSettings["paid"]["currency"] })}>
                          {CURRENCIES.map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="grid-3 tight">
                      <Field label="Price per vote">
                        <input className="input" type="number" min={0} step="any" value={price} onChange={(x) => set("paid", { pricePerVote: Math.max(0, Number(x.target.value)) })} />
                      </Field>
                      <Field label="Minimum per purchase">
                        <input className="input" type="number" min={1} value={s.paid.minVotes} onChange={(x) => set("paid", { minVotes: Math.max(1, Number(x.target.value) || 1) })} />
                      </Field>
                      <Field label="Maximum per purchase">
                        <input className="input" type="number" min={1} value={s.paid.maxVotes} onChange={(x) => set("paid", { maxVotes: Math.max(1, Number(x.target.value) || 1) })} />
                      </Field>
                    </div>
                    <div>
                      <span className="field-label">Bundles (optional quick picks with their own price)</span>
                      {s.paid.bundles.map((b, i) => (
                        <div key={i} className="bundle-row">
                          <input className="input" type="number" min={1} value={b.votes} aria-label="Votes" onChange={(x) => set("paid", { bundles: s.paid.bundles.map((y, j) => (j === i ? { ...y, votes: Math.max(1, Number(x.target.value) || 1) } : y)) })} />
                          <span>votes for</span>
                          <input className="input" type="number" min={0} step="any" value={b.price} aria-label="Price" onChange={(x) => set("paid", { bundles: s.paid.bundles.map((y, j) => (j === i ? { ...y, price: Math.max(0, Number(x.target.value)) } : y)) })} />
                          <span className="muted small">{s.paid.currency}</span>
                          <button type="button" className="icon-btn" aria-label="Remove bundle" onClick={() => set("paid", { bundles: s.paid.bundles.filter((_, j) => j !== i) })}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {s.paid.bundles.length < 8 && (
                        <Button kind="quiet" size="sm" onClick={() => set("paid", { bundles: [...s.paid.bundles, { votes: 10, price: Math.round(price * 10 * 0.9 * 100) / 100 }] })}>
                          <Plus size={14} /> Add bundle
                        </Button>
                      )}
                    </div>
                    <p className="muted small">
                      Example: 10 votes cost {formatMoney((s.paid.bundles.find((b) => b.votes === 10)?.price ?? price * 10), s.paid.currency)}.
                    </p>
                  </div>
                )}
              </>
            )}
          </Panel>
        )}

        {s.access === "roster" && (
          <Panel title="Automatic reminders" subtitle="Nudges voters on the list who haven't voted yet. You can also send reminders any time from the Voters tab.">
            <div className="grid-2 tight">
              <Field label="Send a reminder before voting closes" hint={general.endsAt ? undefined : "Set a closing time above for automatic reminders."}>
                <select className="input" value={s.reminders.hoursBeforeClose} onChange={(x) => set("reminders", { hoursBeforeClose: Number(x.target.value) })}>
                  <option value={0}>Off</option>
                  <option value={2}>2 hours before</option>
                  <option value={6}>6 hours before</option>
                  <option value={12}>12 hours before</option>
                  <option value={24}>24 hours before</option>
                  <option value={48}>2 days before</option>
                  <option value={72}>3 days before</option>
                </select>
              </Field>
              <div className="toggle-list">
                <Toggle label="Also send by SMS" hint={e.smsAvailable ? "To voters with a phone number." : e.plan.sms ? "SMS isn't configured on this server yet (Termii key)." : "SMS is included in the Starter plan and above."} checked={s.reminders.sms} disabled={!e.smsAvailable} onChange={(v) => set("reminders", { sms: v })} />
              </div>
            </div>
          </Panel>
        )}

        <Panel title="Protection">
          <div className="toggle-list">
            <Toggle label="Password-protect the voting page" hint="Everyone needs a shared password before they can see or use the page (on top of the access rules above)." checked={s.security.passwordProtected} onChange={(v) => set("security", { passwordProtected: v })} />
            <Toggle label="Bot protection" hint="Invisible trap that blocks simple automated voting scripts." checked={s.security.botProtection} onChange={(v) => set("security", { botProtection: v })} />
          </div>
          {s.security.passwordProtected && (
            <Field label={e.hasPassword ? "Change the page password (leave empty to keep it)" : "Page password"}>
              <input className="input" type="text" value={password} onChange={(x) => setPassword(x.target.value)} placeholder={e.hasPassword ? "••••••" : "e.g. agm2026"} autoComplete="off" />
            </Field>
          )}
        </Panel>

        <Panel title="Information collected from voters">
          <div className="grid-3 tight">
            {(["name", "email", "phone"] as const).map((k) => (
              <Field key={k} label={k === "name" ? "Name" : k === "email" ? "Email" : "Phone"}>
                <select className="input" value={s.collect[k]} onChange={(x) => set("collect", { [k]: x.target.value as Fm })}>
                  <option value="off">Don't ask</option>
                  <option value="optional">Optional</option>
                  <option value="required">Required</option>
                </select>
              </Field>
            ))}
          </div>
          {!isTally && s.ballot.secret && <p className="muted small">With a secret ballot, these details are never stored with the ballot.</p>}
        </Panel>

        <Panel title="Results">
          <Segmented
            value={s.results.visibility}
            onChange={(visibility) => set("results", { visibility })}
            options={[
              { value: "live", label: "Live", hint: "Public sees results while voting runs." },
              { value: "after_close", label: "After voting closes", hint: "Revealed automatically at the end." },
              { value: "manual", label: "When I publish", hint: "Stay private until you click Publish." },
            ]}
          />
          <div className="toggle-list">
            <Toggle label="Show vote counts publicly" checked={s.results.showCounts} onChange={(v) => set("results", { showCounts: v })} />
            <Toggle label="Show percentages publicly" checked={s.results.showPercent} onChange={(v) => set("results", { showPercent: v })} />
          </div>
        </Panel>

        {isTally && (
          <Panel title="Public nominations">
            <div className="toggle-list">
              <Toggle label="Let the public nominate entries" checked={s.nominations.enabled} onChange={(v) => set("nominations", { enabled: v })} />
              <Toggle label="Review nominations before they appear" checked={s.nominations.requireApproval} disabled={!s.nominations.enabled} onChange={(v) => set("nominations", { requireApproval: v })} />
            </div>
          </Panel>
        )}

        <Panel title="Voting page">
          <div className="toggle-list">
            <Toggle label="Show entry codes" hint="Display each option's short code (useful for SMS/WhatsApp promotion)." checked={s.display.showCodes} onChange={(v) => set("display", { showCodes: v })} />
          </div>
          <div className="grid-2 tight">
            <Field label="Accent colour">
              <div className="color-row">
                <input className="input color" type="color" value={s.display.accentColor ?? themePrimary()} onChange={(x) => set("display", { accentColor: x.target.value })} />
                {s.display.accentColor ? (
                  <button type="button" className="text-link small" onClick={() => set("display", { accentColor: undefined })}>
                    Use organization colour
                  </button>
                ) : (
                  <small className="muted">Organization colour</small>
                )}
              </div>
            </Field>
            <Field label="Thank-you message">
              <input className="input" maxLength={500} value={s.display.thankYouMessage} onChange={(x) => set("display", { thankYouMessage: x.target.value })} />
            </Field>
          </div>
        </Panel>
      </fieldset>
      {editable && (
        <div className="save-bar">
          <span className="muted small">Changes apply to the voting page immediately after saving.</span>
          <Button busy={busy} onClick={save}>
            <Save size={15} /> Save settings
          </Button>
        </div>
      )}
    </div>
  );
}
