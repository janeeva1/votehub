import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Download, Mail, MessageCircle, Plus, RotateCcw, Search, Trash2, Upload, UserCheck } from "lucide-react";
import { canEdit, del, get, patch, post, useConfig, useCurrentOrg, type EventDetail } from "../api";
import { Badge, Button, ConfirmButton, Empty, Field, Loading, Modal, Panel, fmtDate, fmtNum, useToast } from "../ui";
import { refreshEvent } from "./EventDetail";

interface VoterRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  ref: string | null;
  weight: number;
  access_code: string | null;
  invited_at: string | null;
  voted_at: string | null;
  voted_by_proxy: boolean;
  group_name: string | null;
  proxy_voter_id: string | null;
  proxy_name: string | null;
  whatsapp: string | null;
}

/** Minimal CSV parser (quotes, commas, newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ";" || ch === "\t") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) rows.push(row);
  return rows;
}

function toVoters(rows: string[][]) {
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.toLowerCase());
  const hasHeader = header.includes("name") || header.includes("email");
  const idx = (k: string, fallback: number) => (hasHeader ? header.indexOf(k) : fallback);
  const map = { name: idx("name", 0), email: idx("email", 1), phone: idx("phone", 2), ref: idx("ref", 3), weight: idx("weight", 4), group: idx("group", 5) };
  return (hasHeader ? rows.slice(1) : rows)
    .map((r) => ({
      name: (map.name >= 0 ? r[map.name] : "") || (map.email >= 0 ? r[map.email] : "") || "",
      email: map.email >= 0 ? r[map.email] || null : null,
      phone: map.phone >= 0 ? r[map.phone] || null : null,
      ref: map.ref >= 0 ? r[map.ref] || null : null,
      weight: map.weight >= 0 && r[map.weight] ? Number(r[map.weight]) : undefined,
      group: map.group >= 0 ? r[map.group] || null : null,
    }))
    .filter((v) => v.name);
}

export function VotersTab({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const cfg = useConfig();
  const toast = useToast();
  const editable = canEdit(org?.role) && e.status !== "archived";
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [proxyFor, setProxyFor] = useState<VoterRow | null>(null);
  const [busy, setBusy] = useState("");
  const [useSms, setUseSms] = useState(false);
  const voters = useQuery({
    queryKey: ["voters", e.id, q, status, page],
    queryFn: () => get<{ total: number; voted: number; page: number; size: number; voters: VoterRow[] }>(`/org/events/${e.id}/voters?q=${encodeURIComponent(q)}&status=${status}&page=${page}&size=50`),
    placeholderData: (prev) => prev,
  });
  const reload = () => {
    void voters.refetch();
    refreshEvent(e.id);
  };
  const notify = async (kind: "invite" | "remind") => {
    setBusy(kind);
    try {
      const r = await post<{ processed: number; emailed: number; texted: number; loggedOnly: number }>(`/org/events/${e.id}/voters/${kind}`, kind === "invite" ? { onlyNotInvited: true, sms: useSms } : { sms: useSms });
      const what = kind === "invite" ? "invitation" : "reminder";
      toast.ok(
        r.processed === 0
          ? kind === "invite" ? "Everyone with contact details has already been invited." : "Everyone has voted — no reminders needed."
          : `${r.processed} ${what}(s): ${r.emailed} emailed${r.texted ? `, ${r.texted} by SMS` : ""}${r.loggedOnly ? `, ${r.loggedOnly} written to the server log (email not configured)` : ""}.`,
      );
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy("");
    }
  };
  const d = voters.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.size)) : 1;
  const turnout = e.stats.voters ? Math.round((e.stats.voted / e.stats.voters) * 100) : 0;
  return (
    <div className="stack">
      <Panel
        title="Voter list"
        subtitle={`${fmtNum(e.stats.voters)} voters · ${fmtNum(e.stats.voted)} have voted (${turnout}%). Each voter gets a private access code that works once.`}
        action={
          editable && (
            <div className="btn-row">
              <Button kind="outline" size="sm" onClick={() => setImporting(true)}>
                <Upload size={14} /> Import CSV
              </Button>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add voter
              </Button>
            </div>
          )
        }
      >
        <div className="turnout-bar" aria-label={`Turnout ${turnout}%`}>
          <span style={{ width: `${turnout}%` }} />
        </div>
        {editable && (
          <div className="notify-row">
            <Button kind="gold" size="sm" busy={busy === "invite"} onClick={() => notify("invite")}>
              <Mail size={14} /> Send codes to new voters
            </Button>
            <Button kind="outline" size="sm" busy={busy === "remind"} onClick={() => notify("remind")} disabled={!e.stats.voters || e.stats.voted >= e.stats.voters}>
              <BellRing size={14} /> Remind everyone who hasn't voted
            </Button>
            <label className={`check small ${e.smsAvailable ? "" : "is-disabled"}`} title={e.smsAvailable ? "" : e.plan.sms ? "SMS gateway (Termii) not configured on the server" : "SMS is included in Starter and above"}>
              <input type="checkbox" checked={useSms} disabled={!e.smsAvailable} onChange={(x) => setUseSms(x.target.checked)} /> also by SMS
            </label>
            <a className="btn btn-quiet btn-sm" href={`/api/org/events/${e.id}/voters.csv`} download>
              <Download size={14} /> Export with codes
            </a>
          </div>
        )}
        {!cfg.data?.mailEnabled && editable && <p className="muted small">Email isn't configured on this server yet. Use the WhatsApp buttons below, or export the list with codes and links.</p>}
        <div className="toolbar">
          <div className="search">
            <Search size={15} />
            <input
              placeholder="Search name, email, phone, ref, group"
              value={q}
              onChange={(x) => {
                setQ(x.target.value);
                setPage(1);
              }}
            />
          </div>
          <select className="input input-sm" value={status} onChange={(x) => (setStatus(x.target.value), setPage(1))} aria-label="Filter">
            <option value="">Everyone</option>
            <option value="voted">Voted</option>
            <option value="not_voted">Not voted yet</option>
          </select>
        </div>
        {voters.isLoading ? (
          <Loading />
        ) : !d?.voters.length ? (
          <Empty title={q || status ? "No matching voters" : "No voters yet"} detail={q || status ? undefined : "Add voters one by one or import a CSV with columns: name, email, phone, ref, weight, group."} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Contact</th>
                    {e.settings.ballot.weighted && <th>Weight</th>}
                    <th>Access code</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.voters.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <b>{v.name}</b>
                        <small className="block muted">{[v.ref, v.group_name && `Group: ${v.group_name}`].filter(Boolean).join(" · ")}</small>
                        {v.proxy_name && <small className="block proxy-note">Proxy: {v.proxy_name}</small>}
                      </td>
                      <td className="small">
                        {v.email ?? "—"}
                        {v.phone && <span className="block muted">{v.phone}</span>}
                      </td>
                      {e.settings.ballot.weighted && <td>{fmtNum(v.weight)}</td>}
                      <td>
                        <code className="code">{v.access_code ?? "••••••••"}</code>
                      </td>
                      <td>
                        {v.voted_at ? (
                          <Badge tone="green">{v.voted_by_proxy ? "Voted by proxy" : `Voted ${new Date(v.voted_at).toLocaleDateString()}`}</Badge>
                        ) : v.invited_at ? (
                          <Badge tone="blue">Invited</Badge>
                        ) : (
                          <Badge>Not invited</Badge>
                        )}
                      </td>
                      <td className="nowrap">
                        {v.whatsapp && (
                          <a className="icon-btn wa" href={v.whatsapp} target="_blank" rel="noreferrer" title="Send code on WhatsApp" aria-label="Send code on WhatsApp">
                            <MessageCircle size={15} />
                          </a>
                        )}
                        {editable && !v.voted_at && (
                          <>
                            <button className="icon-btn" title="Appoint a proxy" aria-label="Appoint a proxy" onClick={() => setProxyFor(v)}>
                              <UserCheck size={14} />
                            </button>
                            <button
                              className="icon-btn"
                              title="New access code"
                              aria-label="Generate a new access code"
                              onClick={async () => {
                                try {
                                  await post(`/org/events/${e.id}/voters/${v.id}/reset-code`);
                                  toast.ok("New code generated. The old one no longer works.");
                                  reload();
                                } catch (err) {
                                  toast.error(err);
                                }
                              }}
                            >
                              <RotateCcw size={14} />
                            </button>
                            <ConfirmButton size="sm" kind="quiet" confirm={`Remove ${v.name} from the voter list?`} onConfirm={() => del(`/org/events/${e.id}/voters/${v.id}`).then(reload, toast.error)}>
                              <Trash2 size={14} />
                            </ConfirmButton>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="pager">
                <Button kind="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span>
                  Page {page} of {pages}
                </span>
                <Button kind="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add a voter">
        <form
          className="form-stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            setBusy("add");
            try {
              await post(`/org/events/${e.id}/voters`, {
                name: f.get("name"),
                email: f.get("email") || null,
                phone: f.get("phone") || null,
                ref: f.get("ref") || null,
                group: f.get("group") || null,
                weight: e.settings.ballot.weighted ? Number(f.get("weight") || 1) : undefined,
              });
              toast.ok("Voter added.");
              (ev.target as HTMLFormElement).reset();
              reload();
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy("");
            }
          }}
        >
          <Field label="Full name">
            <input className="input" name="name" required maxLength={200} />
          </Field>
          <div className="grid-2 tight">
            <Field label="Email (for invitations)">
              <input className="input" name="email" type="email" />
            </Field>
            <Field label="Phone (SMS / WhatsApp)">
              <input className="input" name="phone" placeholder="0803 000 0000" />
            </Field>
          </div>
          <div className="grid-2 tight">
            <Field label="Member ref / ID">
              <input className="input" name="ref" />
            </Field>
            <Field label="Group (optional)" hint="Branch, chapter, faculty, class…">
              <input className="input" name="group" list="voter-groups" />
              <datalist id="voter-groups">
                {e.voterGroups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
          </div>
          {e.settings.ballot.weighted && (
            <Field label="Vote weight" hint="e.g. number of shares">
              <input className="input" name="weight" type="number" step="any" min="0.0001" defaultValue={1} />
            </Field>
          )}
          <div className="modal-actions">
            <Button kind="outline" onClick={() => setAdding(false)}>
              Done
            </Button>
            <Button type="submit" busy={busy === "add"}>
              Add voter
            </Button>
          </div>
        </form>
      </Modal>

      <ProxyModal e={e} voter={proxyFor} onClose={() => setProxyFor(null)} onDone={reload} />
      <ImportModal e={e} open={importing} onClose={() => setImporting(false)} onDone={reload} />
    </div>
  );
}

function ProxyModal({ e, voter, onClose, onDone }: { e: EventDetail; voter: VoterRow | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useQuery({
    queryKey: ["voters", e.id, "proxy-search", search],
    queryFn: () => get<{ voters: VoterRow[] }>(`/org/events/${e.id}/voters?q=${encodeURIComponent(search)}&status=not_voted&size=20`),
    enabled: Boolean(voter),
  });
  const save = async (proxyVoterId: string | null) => {
    if (!voter) return;
    setBusy(true);
    try {
      await patch(`/org/events/${e.id}/voters/${voter.id}`, { proxyVoterId });
      toast.ok(proxyVoterId ? "Proxy appointed. Their vote will be cast by the proxy holder." : "Proxy removed.");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={Boolean(voter)} onClose={onClose} title={voter ? `Proxy for ${voter.name}` : ""}>
      {voter && (
        <div className="form-stack">
          <p className="muted small">The proxy holder's ballot will also count for {voter.name}. If {voter.name} votes before the proxy holder does, their own vote is used instead.</p>
          {voter.proxy_name && (
            <div className="notice">
              Current proxy: <b>{voter.proxy_name}</b>{" "}
              <Button kind="quiet" size="sm" busy={busy} onClick={() => save(null)}>
                Remove
              </Button>
            </div>
          )}
          <input className="input" placeholder="Search for the proxy holder" value={search} onChange={(x) => setSearch(x.target.value)} autoFocus />
          <ul className="row-list pick-list">
            {(list.data?.voters ?? [])
              .filter((v) => v.id !== voter.id && !v.proxy_voter_id)
              .map((v) => (
                <li key={v.id}>
                  <button className="row-link" disabled={busy} onClick={() => save(v.id)}>
                    <span>
                      <b>{v.name}</b>
                      <small>{[v.email, v.group_name].filter(Boolean).join(" · ")}</small>
                    </span>
                    <UserCheck size={15} />
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

function ImportModal({ e, open, onClose, onDone }: { e: EventDetail; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = toVoters(parseCsv(text));
  return (
    <Modal open={open} onClose={onClose} title="Import voters" wide>
      <div className="form-stack">
        <p className="muted">
          Paste rows or choose a CSV file. Columns: <code>name, email, phone, ref, weight, group</code> (a header row is optional; only name is required). Duplicate emails are skipped.
        </p>
        <label className="btn btn-outline btn-sm fit">
          <Upload size={14} /> Choose CSV file
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            hidden
            onChange={async (x) => {
              const file = x.target.files?.[0];
              x.target.value = "";
              if (file) setText(await file.text());
            }}
          />
        </label>
        <textarea className="input mono" rows={8} value={text} onChange={(x) => setText(x.target.value)} placeholder={"name,email,phone,ref\nAda Obi,ada@example.com,+2348000000000,ALU-001\nBayo Lawal,bayo@example.com,,ALU-002"} />
        {parsed.length > 0 && (
          <p className="small">
            <b>{parsed.length}</b> voter(s) ready. First: {parsed[0]!.name}
            {parsed[0]!.email ? ` <${parsed[0]!.email}>` : ""}
          </p>
        )}
        <div className="modal-actions">
          <Button kind="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!parsed.length}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<{ added: number; skipped: number }>(`/org/events/${e.id}/voters/import`, { voters: parsed, skipDuplicates: true });
                toast.ok(`${r.added} added${r.skipped ? `, ${r.skipped} duplicate(s) skipped` : ""}.`);
                setText("");
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Import {parsed.length || ""} voters
          </Button>
        </div>
      </div>
    </Modal>
  );
}
