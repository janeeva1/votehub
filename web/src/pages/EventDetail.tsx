import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "wouter";
import { ArrowLeft, Copy, Download, ExternalLink, Pause, Play, RefreshCw, Square, Trash2, Trophy } from "lucide-react";
import { canEdit, del, get, isAdmin, post, queryClient, useCurrentOrg, type EventDetail } from "../api";
import { Badge, Bar, Button, ConfirmButton, CopyField, Empty, ErrorState, Field, Loading, PageHead, Panel, Stat, StateBadge, Tabs, fmtDate, fmtNum, useToast } from "../ui";
import { formatMoney, fromMinor } from "@shared/model";
import { BallotTab } from "./EventBallot";
import { VotersTab } from "./EventVoters";
import { SettingsTab } from "./EventSettings";
import { describeEvent } from "./Events";
import { ActivityList } from "./ActivityPage";
import { ResultCategories } from "./PublicEvent";

type Tab = "overview" | "ballot" | "voters" | "settings" | "results" | "payments" | "activity";

export function useEvent(id: string) {
  return useQuery({ queryKey: ["event", id], queryFn: () => get<EventDetail>(`/org/events/${id}`) });
}
export const refreshEvent = (id: string) => {
  void queryClient.invalidateQueries({ queryKey: ["event", id] });
  void queryClient.invalidateQueries({ queryKey: ["events"] });
  void queryClient.invalidateQueries({ queryKey: ["results", id] });
};

export function EventDetailPage() {
  const { id = "", tab = "overview" } = useParams<{ id: string; tab?: Tab }>();
  const [, navigate] = useLocation();
  const q = useEvent(id);
  if (q.isLoading) return <Loading rows={5} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const e = q.data!;
  const pending = e.stats.pending_nominations;
  const tabs: { value: Tab; label: string; badge?: number }[] = [
    { value: "overview", label: "Overview" },
    { value: "ballot", label: e.settings.mode === "tally" ? "Categories & entries" : "Ballot", badge: pending },
    ...(e.settings.access === "roster" ? [{ value: "voters" as Tab, label: "Voters" }] : []),
    { value: "settings", label: "Settings" },
    { value: "results", label: "Results" },
    ...(e.settings.mode === "tally" ? [{ value: "payments" as Tab, label: "Votes & payments" }] : []),
    { value: "activity", label: "Activity" },
  ];
  return (
    <>
      <Link href="/events" className="back-link">
        <ArrowLeft size={14} /> All events
      </Link>
      <PageHead
        eyebrow={describeEvent(e)}
        title={
          <>
            {e.title} <StateBadge value={e.status === "live" ? e.state : e.status} />
          </>
        }
        action={
          <a className="btn btn-outline" href={`/e/${e.slug}`} target="_blank" rel="noreferrer">
            Voting page <ExternalLink size={14} />
          </a>
        }
      />
      <Tabs value={tab} tabs={tabs} onChange={(t) => navigate(`/events/${id}/${t}`)} />
      <div className="tab-body">
        {tab === "overview" && <Overview e={e} />}
        {tab === "ballot" && <BallotTab e={e} />}
        {tab === "voters" && <VotersTab e={e} />}
        {tab === "settings" && <SettingsTab e={e} />}
        {tab === "results" && <ResultsTab e={e} />}
        {tab === "payments" && <PaymentsTab e={e} />}
        {tab === "activity" && <ActivityList eventId={e.id} />}
      </div>
    </>
  );
}

function Overview({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const toast = useToast();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState("");
  const editable = canEdit(org?.role);
  const setStatus = async (status: string, msg: string) => {
    setBusy(status);
    try {
      await post(`/org/events/${e.id}/status`, { status });
      toast.ok(msg);
      refreshEvent(e.id);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy("");
    }
  };
  const optionCount = e.categories.reduce((a, c) => a + c.options.filter((o) => o.status === "approved").length, 0);
  const checklist = [
    { done: e.categories.length > 0 && e.categories.every((c) => c.options.some((o) => o.status === "approved")), label: "Every category has at least one option", tab: "ballot" },
    ...(e.settings.access === "roster" ? [{ done: e.stats.voters > 0, label: "Voter list added", tab: "voters" }] : []),
    ...(e.settings.mode === "tally" && e.settings.paid.enabled ? [{ done: true, label: `Paid voting (${(e.settings.paid.methods.length ? e.paymentMethods.filter((m) => e.settings.paid.methods.includes(m.id)) : e.paymentMethods.filter((m) => m.kind !== "test")).map((m) => m.label).join(", ") || "no payment method yet"}) at ${formatMoney(e.settings.paid.pricePerVote, e.settings.paid.currency)}/vote`, tab: "settings" }] : []),
    { done: Boolean(e.endsAt), label: e.endsAt ? `Closes ${fmtDate(e.endsAt)}` : "No closing time — you'll close voting manually", tab: "settings", optional: true },
  ];
  const revenue = e.stats.revenue;
  return (
    <div className="grid-main">
      <div className="stack">
        <Panel title="Status" subtitle={statusHelp(e)}>
          <div className="btn-row">
            {e.status === "draft" && editable && (
              <Button busy={busy === "live"} onClick={() => setStatus("live", "Published — voting page is live.")}>
                <Play size={15} /> Publish & open voting
              </Button>
            )}
            {e.status === "live" && editable && (
              <>
                <Button kind="outline" busy={busy === "paused"} onClick={() => setStatus("paused", "Voting paused.")}>
                  <Pause size={15} /> Pause
                </Button>
                <ConfirmButton kind="outline" confirm="Close voting now? Voters won't be able to vote unless you reopen it." onConfirm={() => setStatus("closed", "Voting closed.")}>
                  <Square size={15} /> Close voting
                </ConfirmButton>
              </>
            )}
            {e.status === "paused" && editable && (
              <>
                <Button busy={busy === "live"} onClick={() => setStatus("live", "Voting resumed.")}>
                  <Play size={15} /> Resume
                </Button>
                <ConfirmButton kind="outline" confirm="Close voting now?" onConfirm={() => setStatus("closed", "Voting closed.")}>
                  <Square size={15} /> Close voting
                </ConfirmButton>
              </>
            )}
            {e.status === "closed" && editable && (
              <>
                <Button kind="outline" busy={busy === "live"} onClick={() => setStatus("live", "Voting reopened.")}>
                  <Play size={15} /> Reopen
                </Button>
                {isAdmin(org?.role) && (
                  <Button kind="quiet" busy={busy === "archived"} onClick={() => setStatus("archived", "Event archived.")}>
                    Archive
                  </Button>
                )}
              </>
            )}
            {e.status === "archived" && isAdmin(org?.role) && (
              <Button kind="outline" onClick={() => setStatus("closed", "Event restored.")}>
                Restore from archive
              </Button>
            )}
          </div>
          {e.status === "draft" && (
            <ul className="checklist">
              {checklist.map((c) => (
                <li key={c.label} className={c.done ? "done" : c.optional ? "optional" : ""}>
                  <span className="check-dot" />
                  <Link href={`/events/${e.id}/${c.tab}`}>{c.label}</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="stat-grid three">
          {e.settings.mode === "ballot" ? (
            <Stat label="Ballots cast" value={fmtNum(e.stats.ballots)} note={e.settings.access === "roster" ? `${e.stats.voters ? Math.round((e.stats.voted / e.stats.voters) * 100) : 0}% turnout of ${fmtNum(e.stats.voters)} voters` : "One per person"} accent />
          ) : (
            <Stat label="Total votes" value={fmtNum(e.stats.votes)} note="Free + paid + manual" accent />
          )}
          <Stat label="Options" value={optionCount} note={`${e.categories.length} categor${e.categories.length === 1 ? "y" : "ies"}`} />
          {e.settings.mode === "tally" && e.settings.paid.enabled ? (
            <Stat label="Revenue" value={revenue.length ? revenue.map((r) => formatMoney(r.totalMajor, r.currency)).join(" · ") : "—"} note={revenue.length ? `${revenue.reduce((a, r) => a + r.n, 0)} payments · fee ${revenue.map((r) => formatMoney(r.feesMajor, r.currency)).join(" · ")}` : "No payments yet"} />
          ) : (
            <Stat label="Schedule" value={e.endsAt ? new Date(e.endsAt).toLocaleDateString() : "Open-ended"} note={e.startsAt ? `Opens ${fmtDate(e.startsAt)}` : "Opens when published"} />
          )}
        </div>
        {e.description && (
          <Panel title="Description">
            <p className="prewrap">{e.description}</p>
          </Panel>
        )}
      </div>
      <div className="stack">
        <Panel title="Share">
          <CopyField label="Voting page" value={e.publicUrl} />
          <p className="muted small">
            {e.settings.access === "roster"
              ? "Voters also need their personal access code. Send invitations from the Voters tab, or share links that include the code."
              : e.settings.access === "email"
                ? "Voters confirm their email with a one-time code before voting."
                : "Anyone with this link can vote."}
          </p>
          {e.status === "draft" && <Badge tone="gold">The page goes live when you publish</Badge>}
          <div className="share-tools">
            <img className="qr-small" src={`/api/public/events/${e.slug}/qr.svg`} alt="QR code for the voting page" />
            <div className="btn-col">
              <a className="btn btn-outline btn-sm" href={`/api/public/events/${e.slug}/qr.svg`} download={`${e.slug}-qr.svg`}>
                Download QR (for posters)
              </a>
              <a className="btn btn-outline btn-sm" href={`https://wa.me/?text=${encodeURIComponent(`${e.title} — vote here: ${e.publicUrl}`)}`} target="_blank" rel="noreferrer">
                Share on WhatsApp
              </a>
              <a className="btn btn-outline btn-sm" href={`/present/${e.id}`} target="_blank" rel="noreferrer">
                Presenter screen (live)
              </a>
            </div>
          </div>
          <CopyField label="Embed on your website" value={`<iframe src="${e.publicUrl.replace("/e/", "/embed/")}" width="100%" height="460" style="border:0;border-radius:12px" title="${e.title.replace(/"/g, "")}"></iframe>`} />
        </Panel>
        <PassPanel e={e} />
        {editable && (
          <Panel title="More">
            <div className="btn-row">
              <Button
                kind="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const r = await post<{ id: string }>(`/org/events/${e.id}/duplicate`);
                    refreshEvent(e.id);
                    toast.ok("Event duplicated as a draft.");
                    navigate(`/events/${r.id}`);
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                <Copy size={14} /> Duplicate
              </Button>
              {isAdmin(org?.role) && (e.status === "draft" || !e.locked) && (
                <ConfirmButton
                  size="sm"
                  confirm={`Delete "${e.title}" permanently? This can't be undone.`}
                  onConfirm={async () => {
                    try {
                      await del(`/org/events/${e.id}`);
                      void queryClient.invalidateQueries({ queryKey: ["events"] });
                      navigate("/events");
                    } catch (err) {
                      toast.error(err);
                    }
                  }}
                >
                  <Trash2 size={14} /> Delete
                </ConfirmButton>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

function statusHelp(e: EventDetail) {
  switch (e.status) {
    case "draft":
      return "Only your team can see this event. Publish it to open the voting page.";
    case "live":
      return e.state === "not_started" ? `Published. Voting opens ${fmtDate(e.startsAt)}.` : e.state === "ended" ? "The closing time has passed — voting has ended." : "Voting is open.";
    case "paused":
      return "Voting is temporarily paused. The page stays visible.";
    case "closed":
      return "Voting is closed.";
    default:
      return "Archived events are read-only.";
  }
}

function ResultsTab({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const toast = useToast();
  const live = e.state === "open";
  const r = useQuery({ queryKey: ["results", e.id], queryFn: () => get(`/org/events/${e.id}/results`), refetchInterval: live ? 10_000 : false });
  if (r.isLoading) return <Loading rows={4} />;
  if (r.isError) return <ErrorState error={r.error} retry={() => r.refetch()} />;
  const d = r.data;
  const visibility = e.settings.results.visibility;
  return (
    <div className="stack">
      <Panel
        title="Results"
        subtitle={
          (visibility === "live" ? "Public can see results live." : visibility === "after_close" ? "Public sees results after voting closes." : "Public sees results only when you publish them.") +
          (e.resultsPublished ? " Results are published." : "")
        }
        action={
          <div className="btn-row">
            <Button kind="quiet" size="sm" onClick={() => r.refetch()}>
              <RefreshCw size={14} /> Refresh
            </Button>
            <a className="btn btn-outline btn-sm" href={`/api/org/events/${e.id}/results.csv`} download>
              <Download size={14} /> CSV
            </a>
            {isAdmin(org?.role) && (
              <Button
                size="sm"
                kind={e.resultsPublished ? "outline" : "gold"}
                onClick={async () => {
                  try {
                    await post(`/org/events/${e.id}/results-published`, { published: !e.resultsPublished });
                    toast.ok(e.resultsPublished ? "Results hidden from the public." : "Results published.");
                    refreshEvent(e.id);
                  } catch (err) {
                    toast.error(err);
                  }
                }}
              >
                <Trophy size={14} /> {e.resultsPublished ? "Unpublish" : "Publish results"}
              </Button>
            )}
          </div>
        }
      >
        <div className="stat-grid three compact">
          {e.settings.mode === "ballot" ? <Stat label="Ballots" value={fmtNum(d.ballots)} /> : <Stat label="Paid votes" value={fmtNum(d.paidVotes)} />}
          {e.settings.access === "roster" ? (
            <Stat label="Turnout" value={`${d.turnout.voters ? Math.round((d.turnout.voted / d.turnout.voters) * 100) : 0}%`} note={`${fmtNum(d.turnout.voted)} of ${fmtNum(d.turnout.voters)} voters${e.settings.ballot.weighted ? ` · weight ${fmtNum(d.turnout.weight_voted)} of ${fmtNum(d.turnout.weight_total)}` : ""}`} />
          ) : (
            <Stat label="Free votes" value={fmtNum(d.freeVotes)} />
          )}
          <Stat label="Status" value={<StateBadge value={d.state} />} note={live ? "Auto-refreshing every 10s" : undefined} />
        </div>
      </Panel>
      {d.categories.length === 0 ? (
        <div className="panel">
          <Empty title="No categories yet" />
        </div>
      ) : (
        <Panel title="By position / question" subtitle={live ? "Live — winners are provisional until voting closes." : undefined}>
          <ResultCategories results={d} live={live} />
        </Panel>
      )}
      {d.categories
        .filter((c: any) => c.rounds && c.rounds.length > 1)
        .map((c: any) => (
          <Panel key={c.id} title={`${c.title} — counting rounds`} subtitle={c.method === "stv" ? `Single transferable vote · quota ${fmtNum(c.quota)} · ${c.seats} seats` : "Instant runoff"}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Round</th>
                    {c.options.map((o: any) => (
                      <th key={o.id}>{o.name}</th>
                    ))}
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {c.rounds.map((rd: any) => (
                    <tr key={rd.round}>
                      <td>{rd.round}</td>
                      {c.options.map((o: any) => (
                        <td key={o.id}>{rd.counts[o.id] === undefined ? "—" : fmtNum(rd.counts[o.id])}</td>
                      ))}
                      <td className="small">
                        {[
                          rd.elected?.length ? `Elected: ${rd.elected.map((id: string) => c.options.find((o: any) => o.id === id)?.name).join(", ")}` : "",
                          rd.eliminated?.length ? `Eliminated: ${rd.eliminated.map((id: string) => c.options.find((o: any) => o.id === id)?.name).join(", ")}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      {e.settings.ballot.allowComments && <CommentsPanel e={e} />}
    </div>
  );
}

function PaymentsTab({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const toast = useToast();
  const payments = useQuery({ queryKey: ["payments", e.id], queryFn: () => get<any[]>(`/org/events/${e.id}/payments`) });
  const votes = useQuery({ queryKey: ["votes", e.id], queryFn: () => get<any[]>(`/org/events/${e.id}/votes`) });
  const [manual, setManual] = useState({ optionId: "", quantity: "", note: "" });
  const [busy, setBusy] = useState(false);
  const allOptions = e.categories.flatMap((c) => c.options.filter((o) => o.status === "approved").map((o) => ({ ...o, cat: c.title })));
  return (
    <div className="stack">
      {!!payments.data?.some((p) => p.provider === "manual" && p.status === "pending" && p.claim) && (
        <div className="notice">
          <b>{payments.data.filter((p) => p.provider === "manual" && p.status === "pending" && p.claim).length} manual payment(s) waiting for you.</b> Check your account for each transfer, then approve (votes are added) or reject.
        </div>
      )}
      <Panel title="Payments" subtitle={e.settings.paid.enabled ? `${formatMoney(e.settings.paid.pricePerVote, e.settings.paid.currency)} per vote` : "Paid voting is off for this event."}>
        {payments.isLoading ? (
          <Loading />
        ) : !payments.data?.length ? (
          <p className="muted">No payments yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Payer</th>
                  <th>For</th>
                  <th>Votes</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {payments.data.map((p) => (
                  <tr key={p.reference}>
                    <td>{fmtDate(p.created_at)}</td>
                    <td>
                      {p.payer_name || "—"}
                      <small className="block muted">{p.payer_email}</small>
                    </td>
                    <td>{p.option_name}</td>
                    <td>{fmtNum(p.quantity)}</td>
                    <td>{formatMoney(fromMinor(p.amount_minor, p.currency), p.currency)}</td>
                    <td>
                      <StateBadge value={p.status} />
                      <small className="block muted">{p.provider === "manual" ? p.manual_label || "Manual" : p.provider}</small>
                      {p.claim && (
                        <small className="block claim-note">
                          Paid by {p.claim.senderName}
                          {p.claim.paidAt ? ` · ${p.claim.paidAt}` : ""}
                          {p.claim.note ? ` · “${p.claim.note}”` : ""}
                        </small>
                      )}
                    </td>
                    <td>
                      {p.status === "pending" && p.provider === "manual" && canEdit(org?.role) && (
                        <div className="btn-row nowrap">
                          {(["approve", "reject"] as const).map((d) => (
                            <Button
                              key={d}
                              kind={d === "approve" ? "primary" : "quiet"}
                              size="sm"
                              onClick={async () => {
                                try {
                                  await post(`/org/payments/${p.reference}/${d}`);
                                  toast.ok(d === "approve" ? `Approved — ${p.quantity} vote(s) added.` : "Payment rejected.");
                                  void payments.refetch();
                                  refreshEvent(e.id);
                                } catch (err) {
                                  toast.error(err);
                                }
                              }}
                            >
                              {d === "approve" ? "Approve" : "Reject"}
                            </Button>
                          ))}
                        </div>
                      )}
                      {p.status === "pending" && p.provider !== "manual" && canEdit(org?.role) && (
                        <Button
                          kind="quiet"
                          size="sm"
                          onClick={async () => {
                            try {
                              const r = await post(`/org/payments/${p.reference}/verify`);
                              toast.ok(`Payment is ${r.status}.`);
                              void payments.refetch();
                              refreshEvent(e.id);
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          Re-check
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {isAdmin(org?.role) && (
        <Panel title="Manual adjustment" subtitle="Record offline/cash votes or correct a count. Every adjustment is logged with your name and note.">
          <form
            className="inline-form"
            onSubmit={async (ev) => {
              ev.preventDefault();
              setBusy(true);
              try {
                await post(`/org/events/${e.id}/manual-votes`, { optionId: manual.optionId, quantity: Number(manual.quantity), note: manual.note });
                toast.ok("Adjustment recorded.");
                setManual({ optionId: "", quantity: "", note: "" });
                refreshEvent(e.id);
                void votes.refetch();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Entry">
              <select className="input" required value={manual.optionId} onChange={(ev) => setManual({ ...manual, optionId: ev.target.value })}>
                <option value="">Choose…</option>
                {allOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.cat})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Votes (+/-)">
              <input className="input" type="number" required value={manual.quantity} onChange={(ev) => setManual({ ...manual, quantity: ev.target.value })} />
            </Field>
            <Field label="Note">
              <input className="input" required minLength={3} value={manual.note} onChange={(ev) => setManual({ ...manual, note: ev.target.value })} placeholder="e.g. Cash votes at venue" />
            </Field>
            <Button type="submit" busy={busy}>
              Record
            </Button>
          </form>
        </Panel>
      )}
      <Panel title="Recent votes" subtitle="Latest 500 free, paid and manual votes.">
        {votes.isLoading ? (
          <Loading />
        ) : !votes.data?.length ? (
          <p className="muted">No votes yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Entry</th>
                  <th>Votes</th>
                  <th>Type</th>
                  <th>Voter</th>
                </tr>
              </thead>
              <tbody>
                {votes.data.map((v) => (
                  <tr key={v.id}>
                    <td>{fmtDate(v.created_at)}</td>
                    <td>
                      {v.option_name}
                      <small className="block muted">{v.category_title}</small>
                    </td>
                    <td>{fmtNum(v.quantity)}</td>
                    <td>
                      <Badge tone={v.source === "paid" ? "green" : v.source === "manual" ? "gold" : "neutral"}>{v.source}</Badge>
                    </td>
                    <td className="small">{v.source === "manual" ? `${v.voter_info?.by ?? ""} — ${v.voter_info?.note ?? ""}` : [v.voter_info?.name, v.voter_info?.email, v.voter_info?.phone].filter(Boolean).join(" · ") || v.reference || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function CommentsPanel({ e }: { e: EventDetail }) {
  const q = useQuery({ queryKey: ["comments", e.id], queryFn: () => get<{ comment: string; created_at: string }[]>(`/org/events/${e.id}/comments`) });
  return (
    <Panel title={`Voter comments (${q.data?.length ?? 0})`} subtitle={e.settings.ballot.secret ? "Anonymous — comments are stored with the secret ballot, not the voter." : undefined}>
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <p className="muted">No comments yet.</p>
      ) : (
        <ul className="comment-list">
          {q.data.map((c, i) => (
            <li key={i}>
              <p>{c.comment}</p>
              <small className="muted">{fmtDate(c.created_at)}</small>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PassPanel({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const billing = useQuery({ queryKey: ["billing", org?.id], queryFn: () => get("/org/billing") });
  const passes = (billing.data?.passes ?? []) as { id: string; name: string; voters: number; price: number }[];
  const currency = billing.data?.currency ?? "NGN";
  // Only offer passes that would actually raise this event's voter limit.
  const options = e.plan.maxVotersPerEvent === null ? [] : passes.filter((p) => p.voters > (e.plan.maxVotersPerEvent ?? 0));
  return (
    <Panel title="Plan limits" subtitle={e.passVoters ? `Event pass active: up to ${fmtNum(e.passVoters)} voters for this event.` : undefined}>
      <ul className="kv">
        <li>
          <span>Plan</span>
          <b>
            {e.plan.name}
            {e.passVoters ? " + event pass" : ""}
          </b>
        </li>
        <li>
          <span>Voters for this event</span>
          <b>{e.plan.maxVotersPerEvent === null ? "Unlimited" : fmtNum(e.plan.maxVotersPerEvent)}</b>
        </li>
        <li>
          <span>Ballots / free votes</span>
          <b>{e.plan.maxBallotsPerEvent === null ? "Unlimited" : fmtNum(e.plan.maxBallotsPerEvent)}</b>
        </li>
        <li>
          <span>Paid voting</span>
          <b>{e.plan.paidVoting ? `Yes · ${e.plan.platformFeePercent}% fee` : "Not included"}</b>
        </li>
      </ul>
      {isAdmin(org?.role) && options.length > 0 && e.status !== "archived" && (
        <div className="pass-box">
          <p className="small">
            <b>Only voting once a year?</b> Upgrade just this event — no subscription.
          </p>
          <div className="pass-grid">
            {options.slice(0, 4).map((p) => (
              <button
                key={p.id}
                className="pass-option"
                disabled={busy !== ""}
                onClick={async () => {
                  setBusy(p.id);
                  try {
                    const r = await post<{ redirectUrl: string }>(`/org/events/${e.id}/pass/checkout`, { passId: p.id });
                    location.href = r.redirectUrl;
                  } catch (err) {
                    toast.error(err);
                    setBusy("");
                  }
                }}
              >
                <b>{p.name}</b>
                <span>{formatMoney(p.price, currency)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
