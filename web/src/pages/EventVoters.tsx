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
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\ufeff/, "");
  // Excel in some regions saves with ";" — use whichever separator the first line uses most.
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].sort((a, b) => first.split(b).length - first.split(a).length)[0]!;
  return parseWith(text, sep);
}

function parseWith(text: string, sep: string): string[][] {
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
    else if (ch === sep) {
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Header names people actually use in their spreadsheets → our fields. */
const ALIASES: Record<string, string[]> = {
  name: ["name", "full name", "fullname", "voter name", "member name", "names"],
  email: ["email", "email address", "e-mail", "mail"],
  phone: ["phone", "phone number", "mobile", "mobile number", "whatsapp", "tel", "telephone"],
  ref: ["ref", "member id", "membership id", "matric", "matric number", "matric no", "staff id", "id", "reg number", "reference"],
  weight: ["weight", "shares", "units", "votes"],
  group: ["group", "voter group", "branch", "chapter", "department", "class", "set"],
};

export interface ImportRow {
  line: number;
  name: string;
  email: string | null;
  phone: string | null;
  ref: string | null;
  weight?: number;
  group: string | null;
  problem?: string;
  warning?: string;
}

/** Turns spreadsheet rows into voters, flagging rows that can't be imported instead of failing the whole file. */
export function toVoters(rows: string[][], opts: { weighted?: boolean; groups?: string[] } = {}): ImportRow[] {
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.toLowerCase().replace(/^﻿/, "").replace(/[*_]/g, " ").replace(/\s+/g, " ").trim());
  const find = (k: string) => header.findIndex((h) => ALIASES[k]!.includes(h));
  const hasHeader = find("name") >= 0 || find("email") >= 0;
  const map = hasHeader
    ? { name: find("name"), email: find("email"), phone: find("phone"), ref: find("ref"), weight: find("weight"), group: find("group") }
    : { name: 0, email: 1, phone: 2, ref: 3, weight: 4, group: 5 };
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const groupsLower = new Map((opts.groups ?? []).map((g) => [g.toLowerCase(), g]));
  return (hasHeader ? rows.slice(1) : rows).map((r, i) => {
    const email = cell(r, map.email).toLowerCase() || null;
    const name = cell(r, map.name) || email || "";
    let phone = cell(r, map.phone).replace(/[\s()-]/g, "") || null;
    // Excel turns 08031234567 into 8031234567 — put the leading 0 back.
    if (phone && /^[789]\d{9}$/.test(phone)) phone = `0${phone}`;
    const weightRaw = cell(r, map.weight);
    const groupRaw = cell(r, map.group);
    const v: ImportRow = {
      line: i + (hasHeader ? 2 : 1),
      name,
      email,
      phone,
      ref: cell(r, map.ref) || null,
      weight: weightRaw ? Number(weightRaw.replace(/,/g, "")) : undefined,
      group: groupRaw ? groupsLower.get(groupRaw.toLowerCase()) ?? groupRaw : null,
    };
    if (!name) v.problem = "No name or email";
    else if (email && !EMAIL_RE.test(email)) v.problem = `"${email}" isn't a valid email`;
    else if (weightRaw && (!Number.isFinite(v.weight) || v.weight! <= 0)) v.problem = `Weight "${weightRaw}" must be a positive number`;
    else if (!email && !phone) v.warning = "No email or phone — share this voter's code yourself";
    else if (v.group && opts.groups?.length && !groupsLower.has(v.group.toLowerCase())) v.warning = `Group "${v.group}" isn't used by any question`;
    if (!opts.weighted) delete v.weight;
    return v;
  });
}

/** A ready-to-fill CSV with the columns this event uses, plus example rows. */
export function voterTemplate(e: { title: string; settings: { ballot: { weighted: boolean } }; voterGroups: string[] }) {
  const cols = ["name", "email", "phone", "ref", ...(e.settings.ballot.weighted ? ["weight"] : []), ...(e.voterGroups.length ? ["group"] : [])];
  const g = e.voterGroups.length ? e.voterGroups : ["Lagos"];
  const examples = [
    { name: "Adaeze Obi", email: "adaeze.obi@example.com", phone: "08031234567", ref: "MEM-0001", weight: "1", group: g[0] },
    { name: "Bayo Lawal", email: "bayo.lawal@example.com", phone: "", ref: "MEM-0002", weight: "2", group: g[1 % g.length] },
    { name: "Chioma Eze", email: "", phone: "+2348091234567", ref: "MEM-0003", weight: "1", group: g[0] },
  ];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [cols.join(","), ...examples.map((x) => cols.map((c) => q((x as any)[c] ?? "")).join(","))];
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${e.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "voters"}-voter-template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
              <Button kind="quiet" size="sm" onClick={() => voterTemplate(e)} title="Download a CSV template for this event">
                <Download size={14} /> Template
              </Button>
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
          <>
            <Empty title={q || status ? "No matching voters" : "No voters yet"} detail={q || status ? undefined : "Only people on this list can vote. Add them one by one, or download the template, fill it in and import it."} />
            {!q && !status && editable && (
              <div className="btn-row center">
                <Button kind="outline" size="sm" onClick={() => voterTemplate(e)}>
                  <Download size={14} /> Download CSV template
                </Button>
                <Button size="sm" onClick={() => setImporting(true)}>
                  <Upload size={14} /> Import voters
                </Button>
              </div>
            )}
          </>
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
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = toVoters(parseCsv(text), { weighted: e.settings.ballot.weighted, groups: e.voterGroups });
  const good = rows.filter((r) => !r.problem);
  const bad = rows.filter((r) => r.problem);
  const warned = good.filter((r) => r.warning);
  const cols: [string, string, string][] = [
    ["name", "Required", "Full name as it should appear on the voter list. If empty, the email is used."],
    ["email", "Recommended", "Where the private voting code is sent. Each email can appear once per event."],
    ["phone", "Optional", "For SMS and WhatsApp codes, e.g. 08031234567 or +2348031234567."],
    ["ref", "Optional", "Your own member ID, matric or staff number, to tell people with the same name apart."],
    ...(e.settings.ballot.weighted ? ([["weight", "Optional", "How much this voter's ballot counts (shares, units). Defaults to 1."]] as [string, string, string][]) : []),
    ...(e.voterGroups.length ? ([["group", "Optional", `Which branch/group they belong to: ${e.voterGroups.join(", ")}. Controls which questions they see.`]] as [string, string, string][]) : []),
  ];
  return (
    <Modal open={open} onClose={onClose} title="Import voters" wide>
      <div className="form-stack">
        <div className="import-steps">
          <div>
            <b>1. Download the template</b>
            <p className="muted small">It has the right columns for this event and three example rows. Open it in Excel or Google Sheets, replace the examples with your members and save as CSV.</p>
            <Button kind="outline" size="sm" onClick={() => voterTemplate(e)}>
              <Download size={14} /> Download CSV template
            </Button>
          </div>
          <div>
            <b>2. Upload your file</b>
            <p className="muted small">Or paste rows straight from your spreadsheet below. Common headings like "Full name", "Email address", "Phone number" or "Member ID" are recognised.</p>
            <label className="btn btn-primary btn-sm fit">
              <Upload size={14} /> {fileName ? "Choose another file" : "Choose CSV file"}
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                hidden
                onChange={async (x) => {
                  const file = x.target.files?.[0];
                  x.target.value = "";
                  if (!file) return;
                  if (/\.xlsx?$/i.test(file.name)) return toast.error(new Error("That's an Excel file. In Excel choose File → Save As → CSV (Comma delimited), then upload the .csv file."));
                  setFileName(file.name);
                  setText(await file.text());
                }}
              />
            </label>
          </div>
        </div>
        <details className="col-guide">
          <summary>What goes in each column</summary>
          <table className="table">
            <tbody>
              {cols.map(([c, need, help]) => (
                <tr key={c}>
                  <td>
                    <code>{c}</code>
                  </td>
                  <td>{need === "Required" ? <Badge tone="gold">{need}</Badge> : <span className="muted small">{need}</span>}</td>
                  <td className="small">{help}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Keep the first row as headings. Each voter gets a one-time access code automatically; you don't need to make codes. Voters already on the list (same email) are skipped.</p>
        </details>
        <textarea
          className="input mono"
          rows={6}
          value={text}
          onChange={(x) => (setText(x.target.value), setFileName(""))}
          placeholder={"name,email,phone,ref\nAdaeze Obi,adaeze.obi@example.com,08031234567,MEM-0001\nBayo Lawal,bayo.lawal@example.com,,MEM-0002"}
        />
        {rows.length > 0 && (
          <div className="import-preview">
            <p className="small">
              {fileName && <span className="muted">{fileName}: </span>}
              <b>{good.length}</b> voter(s) ready to import
              {bad.length > 0 && (
                <>
                  , <b className="red-text">{bad.length} row(s) will be skipped</b>
                </>
              )}
              {warned.length > 0 && <>, {warned.length} with a note</>}.
            </p>
            <div className="table-wrap preview-table">
              <table className="table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Ref</th>
                    {e.settings.ballot.weighted && <th>Weight</th>}
                    {e.voterGroups.length > 0 && <th>Group</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...bad, ...good.filter((r) => r.warning), ...good.filter((r) => !r.warning)].slice(0, 50).map((r) => (
                    <tr key={r.line} className={r.problem ? "row-bad" : r.warning ? "row-warn" : ""}>
                      <td className="muted">{r.line}</td>
                      <td>{r.name}</td>
                      <td>{r.email}</td>
                      <td>{r.phone}</td>
                      <td>{r.ref}</td>
                      {e.settings.ballot.weighted && <td>{r.weight ?? 1}</td>}
                      {e.voterGroups.length > 0 && <td>{r.group}</td>}
                      <td className="small">{r.problem ?? r.warning ?? "OK"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 50 && <p className="muted small">Showing problems first, then the first rows. All {good.length} valid rows will be imported.</p>}
          </div>
        )}
        <div className="modal-actions">
          <Button kind="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={busy}
            disabled={!good.length}
            onClick={async () => {
              setBusy(true);
              try {
                const voters = good.map(({ line, problem, warning, ...v }) => v);
                const r = await post<{ added: number; skipped: number }>(`/org/events/${e.id}/voters/import`, { voters, skipDuplicates: true });
                toast.ok(`${r.added} added${r.skipped ? `, ${r.skipped} already on the list` : ""}${bad.length ? `, ${bad.length} row(s) with problems skipped` : ""}.`);
                setText("");
                setFileName("");
                onDone();
                onClose();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Import {good.length || ""} voters
          </Button>
        </div>
      </div>
    </Modal>
  );
}
