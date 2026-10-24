import { AdSlot } from "../ads";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useRoute } from "wouter";
import { Activity, ArrowDown, ArrowUp, BadgeCheck, CalendarClock, ClipboardList, Clock3, Check, CreditCard, KeyRound, Lock, Mail, Minus, Plus, Trophy, Users, Vote } from "lucide-react";
import { ApiError, fileUrl, get, post } from "../api";
import { Badge, Bar, Button, Field, Loading, Modal, fmtDate, fmtNum, useToast } from "../ui";
import { formatMoney } from "@shared/model";
import { AgreeBox, VoterNotice } from "./Legal";

interface LiveStats {
  eligible: number | null;
  voted: number | null;
  turnoutPercent: number | null;
  ballots: number | null;
  votes: number | null;
  lastHour: number;
  lastActivityAt: string | null;
  registered: number | null;
}
interface PubRegistration {
  open: boolean;
  autoApprove: boolean;
  phone: "off" | "optional" | "required";
  ref: "off" | "optional" | "required";
  refLabel: string;
  askGroup: boolean;
  groupLabel: string;
  groupOptions: string[];
  questions: { id: string; label: string; required: boolean }[];
  message: string;
  closesAt: string | null;
}

interface PubOption {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  imageFileId: string | null;
  code: string;
}
interface PubCategory {
  id: string;
  title: string;
  description: string;
  method: "single" | "multiple" | "ranked" | "stv" | "borda" | "score" | "cumulative";
  maxChoices: number;
  points: number;
  allowWriteIn: boolean;
  voterGroups: string[];
  options: PubOption[];
}
interface PubResultOption {
  id: string;
  name: string;
  writeIn?: boolean;
  votes: number | null;
  average?: number;
  percent: number | null;
  winner: boolean;
}
export interface PubResults {
  ballots: number | null;
  quorum: { percent: number; required: number; achieved: number; met: boolean } | null;
  categories: { id: string; title: string; method: string; seats: number; totalVotes: number | null; threshold?: { percent: number; met: boolean }; quota?: number; options: PubResultOption[] }[];
}
export interface PubEvent {
  live: LiveStats | null;
  registration: PubRegistration | null;
  paymentMethods: { id: string; label: string; kind: "gateway" | "manual" | "test" }[];
  slug: string;
  title: string;
  description: string;
  coverFileId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  state: "not_started" | "open" | "paused" | "ended" | "closed";
  org: { name: string; logoFileId: string | null; primaryColor: string | null; website: string | null };
  showPlatformBranding: boolean;
  appName: string;
  mailEnabled: boolean;
  settings: {
    mode: "ballot" | "tally";
    access: "roster" | "email" | "public";
    collect: { name: "off" | "optional" | "required"; email: "off" | "optional" | "required"; phone: "off" | "optional" | "required" };
    freeVotes: { enabled: boolean; perVoter: number; period: "total" | "daily" };
    paid: { enabled: boolean; currency: string; pricePerVote: number; minVotes: number; maxVotes: number; bundles: { votes: number; price: number }[]; testMode: boolean };
    results: { visibility: string; showCounts: boolean; showPercent: boolean };
    ballot: { allowAbstain: boolean; receipts: boolean; weighted: boolean; secret: boolean; allowComments: boolean };
    security: { passwordProtected: boolean; botProtection: boolean };
    nominations: { enabled: boolean; requireApproval: boolean };
    display: { showCodes: boolean; accentColor?: string; thankYouMessage: string };
  };
  categories: PubCategory[];
  results: PubResults | null;
  locked: boolean;
}
interface Session {
  token: string;
  name?: string;
  email?: string;
  weight?: number;
  hasVoted?: boolean;
  group?: string | null;
  proxies?: number;
  proxyHolder?: string | null;
}

const ptKey = (slug: string) => `vh_pt_${slug}`;
const loadPt = (slug: string) => {
  try {
    return sessionStorage.getItem(ptKey(slug));
  } catch {
    return null;
  }
};
const savePt = (slug: string, v: string) => {
  try {
    sessionStorage.setItem(ptKey(slug), v);
  } catch {
    /* ignore */
  }
};
/** Honeypot: a field humans never see. Bots that fill every input get rejected server-side. */
function Honeypot({ onChange }: { onChange: (v: string) => void }) {
  return (
    <div className="hp" aria-hidden="true">
      <label>
        Website
        <input type="text" name="website" tabIndex={-1} autoComplete="off" onChange={(x) => onChange(x.target.value)} />
      </label>
    </div>
  );
}

const storeKey = (slug: string) => `vh_voter_${slug}`;
const loadSession = (slug: string): Session | null => {
  try {
    const raw = sessionStorage.getItem(storeKey(slug));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const saveSession = (slug: string, s: Session | null) => {
  try {
    if (s) sessionStorage.setItem(storeKey(slug), JSON.stringify(s));
    else sessionStorage.removeItem(storeKey(slug));
  } catch {
    /* ignore */
  }
};

function countdown(ms: number) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
}

function useCountdown(target: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!target) return null;
  const ms = new Date(target).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;
}

export function PublicEvent() {
  const { slug = "" } = useParams<{ slug: string }>();
  const params = new URLSearchParams(location.search);
  const [registerMode] = useRoute("/e/:slug/register");
  const [passToken, setPassToken] = useState<string | null>(() => loadPt(slug));
  const q = useQuery({
    queryKey: ["public", slug, passToken],
    queryFn: () => get<PubEvent>(`/public/events/${slug}${passToken ? `?pt=${encodeURIComponent(passToken)}` : ""}`),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d || d.state !== "open") return false;
      if (d.live) return 8_000;
      return d.settings.results.visibility === "live" ? 15_000 : false;
    },
    retry: false,
  });
  const [session, setSession] = useState<Session | null>(() => loadSession(slug));
  const [freeUsed, setFreeUsed] = useState<Record<string, number>>({});
  const [done, setDone] = useState<{ receipt: string | null; message: string } | null>(null);
  const cancelled = params.get("payment") === "cancelled";

  const e = q.data;
  const accent = e?.settings.display.accentColor ?? e?.org.primaryColor ?? undefined;
  useEffect(() => {
    if (e) document.title = `${e.title} · ${e.org.name}`;
  }, [e]);
  useEffect(() => {
    if (!e || e.settings.mode !== "tally") return;
    if (e.settings.access !== "public" && !session) return;
    post<{ freeUsed: Record<string, number> }>(`/public/events/${slug}/free-status`, { token: session?.token })
      .then((r) => setFreeUsed(r.freeUsed))
      .catch(() => undefined);
  }, [e?.slug, session?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <div className="center-page"><Loading /></div>;
  if (q.isError || !e)
    return (
      <div className="center-page">
        <div className="panel narrow">
          <Vote />
          <h2>Voting page not found</h2>
          <p className="muted">{(q.error as Error)?.message ?? "This link may be wrong, or the event isn't published yet."}</p>
        </div>
      </div>
    );

  const setSess = (s: Session | null) => {
    setSession(s);
    saveSession(slug, s);
  };
  const needsAccess = e.settings.access !== "public" && !session;
  const ctx = { passToken };
  const open = e.state === "open";

  return (
    <div className="public" style={accent ? ({ "--accent": accent } as React.CSSProperties) : undefined}>
      <header className="public-head">
        <div className="public-org">
          {e.org.logoFileId ? <img src={fileUrl(e.org.logoFileId)!} alt="" /> : <span className="org-avatar">{e.org.name.slice(0, 1)}</span>}
          <b>{e.org.name}</b>
        </div>
        {session && (
          <div className="public-session">
            <span>{session.name ?? session.email}</span>
            <button className="text-link" onClick={() => setSess(null)}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <section className={`public-hero ${e.coverFileId ? "has-cover" : ""}`}>
        {e.coverFileId && <img className="public-cover" src={fileUrl(e.coverFileId)!} alt="" />}
        <div className="public-hero-inner">
          <StateLine e={e} />
          <h1>{e.title}</h1>
          {e.description && <p className="prewrap">{e.description}</p>}
          <div className="public-tags">
            {e.settings.mode === "tally" && e.settings.paid.enabled && (
              <Badge tone="gold">
                <CreditCard size={12} /> {formatMoney(e.settings.paid.pricePerVote, e.settings.paid.currency)} per vote
              </Badge>
            )}
            {e.settings.mode === "tally" && e.settings.freeVotes.enabled && (
              <Badge tone="green">
                {e.settings.freeVotes.perVoter} free vote{e.settings.freeVotes.perVoter > 1 ? "s" : ""} per category{e.settings.freeVotes.period === "daily" ? " daily" : ""}
              </Badge>
            )}
            {e.settings.mode === "ballot" && e.settings.ballot.secret && (
              <Badge>
                <Lock size={12} /> Secret ballot
              </Badge>
            )}
            {e.settings.paid.testMode && e.settings.paid.enabled && <Badge tone="red">Test payments</Badge>}
          </div>
        </div>
      </section>

      {e.live && !e.locked && <LiveScoreboard e={e} live={e.live} />}

      <main className="public-main">
        {cancelled && <div className="notice">Payment was cancelled — no votes were added. You can try again.</div>}
        {!e.locked && registerMode && e.registration ? (
          <RegisterForm slug={slug} e={e} reg={e.registration} />
        ) : e.locked ? (
          <PasswordGate slug={slug} onUnlock={(t) => (savePt(slug, t), setPassToken(t))} />
        ) : done ? (
          <ThankYou done={done} e={e} onBack={() => setDone(null)} />
        ) : open && needsAccess ? (
          e.settings.access === "roster" ? (
            <>
              <CodeGate slug={slug} initial={params.get("code") ?? ""} onAccess={(s, f) => (setSess(s), setFreeUsed(f))} />
              {e.registration?.open && (
                <p className="center-text register-hint">
                  Not on the voter list yet? <a href={`/e/${slug}/register`}>Register to vote</a>
                </p>
              )}
            </>
          ) : (
            <EmailGate slug={slug} mailEnabled={e.mailEnabled} onAccess={(s, f) => (setSess(s), setFreeUsed(f))} />
          )
        ) : open && e.settings.mode === "ballot" ? (
          session?.hasVoted ? (
            <div className="panel center-text">
              <BadgeCheck size={36} className="accent-icon" />
              <h2>You've already voted</h2>
              <p className="muted">Each voter can submit one ballot.</p>
            </div>
          ) : (
            <BallotForm e={e} session={session} passToken={ctx.passToken} onDone={(d) => (setDone(d), session && setSess({ ...session, hasVoted: true }), void q.refetch())} />
          )
        ) : open && e.settings.mode === "tally" ? (
          <TallyBoard e={e} session={session} passToken={ctx.passToken} freeUsed={freeUsed} setFreeUsed={setFreeUsed} onVoted={() => void q.refetch()} />
        ) : (
          <>
            <ClosedNotice e={e} />
            {e.state === "not_started" && e.registration?.open && <RegisterForm slug={slug} e={e} reg={e.registration} />}
          </>
        )}

        {e.results && <ResultsView e={e} results={e.results} />}
        {!e.locked && <AdSlot path={`/public/events/${e.slug}/ad`} queryKey={["event", e.slug]} />}
        {!e.locked && <ShareBar e={e} />}
        {e.settings.nominations.enabled && (e.state === "open" || e.state === "not_started") && <NominationForm e={e} />}
        {e.settings.mode === "ballot" && e.settings.ballot.receipts && <ReceiptCheck slug={slug} />}
      </main>
      <footer className="public-foot">
        {e.org.website && (
          <a href={e.org.website} target="_blank" rel="noreferrer">
            {e.org.name}
          </a>
        )}
        {e.showPlatformBranding && (
          <a href="/">
            Powered by <b>{e.appName}</b>
          </a>
        )}
        <a href="/terms">Terms</a>
        <a href="/privacy">Privacy</a>
      </footer>
    </div>
  );
}

function StateLine({ e }: { e: PubEvent }) {
  const toStart = useCountdown(e.state === "not_started" ? e.startsAt : null);
  const toEnd = useCountdown(e.state === "open" ? e.endsAt : null);
  if (e.state === "not_started")
    return (
      <p className="state-line">
        <CalendarClock size={14} /> Voting opens {fmtDate(e.startsAt)}
        {toStart && <b> · in {toStart}</b>}
      </p>
    );
  if (e.state === "open")
    return (
      <p className="state-line live">
        <span className="live-dot" /> Voting is open{toEnd && <b> · closes in {toEnd}</b>}
      </p>
    );
  if (e.state === "paused") return <p className="state-line">Voting is paused</p>;
  return <p className="state-line">Voting has closed</p>;
}

function ClosedNotice({ e }: { e: PubEvent }) {
  const msg =
    e.state === "not_started" ? `Voting opens ${fmtDate(e.startsAt)}. Come back then!` : e.state === "paused" ? "The organizer has paused voting for now. Please check back soon." : e.results ? "Thank you to everyone who took part." : "Thank you to everyone who took part. Results will be shared by the organizer.";
  return (
    <div className="panel center-text">
      <CalendarClock size={32} className="accent-icon" />
      <h2>{e.state === "not_started" ? "Not open yet" : e.state === "paused" ? "Voting paused" : "Voting has closed"}</h2>
      <p className="muted">{msg}</p>
      {e.state === "not_started" && e.categories.length > 0 && <p className="muted small">{e.categories.reduce((a, c) => a + c.options.length, 0)} options across {e.categories.length} categories.</p>}
    </div>
  );
}

function CodeGate({ slug, initial, onAccess }: { slug: string; initial: string; onAccess: (s: Session, freeUsed: Record<string, number>) => void }) {
  const [code, setCode] = useState(initial.toUpperCase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (ev?: FormEvent) => {
    ev?.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post<{ token: string; voter: { name: string; weight: number; hasVoted: boolean; group: string | null; proxies: number; proxyHolder: string | null }; freeUsed: Record<string, number> }>(`/public/events/${slug}/access`, { code });
      onAccess({ token: r.token, name: r.voter.name, weight: r.voter.weight, hasVoted: r.voter.hasVoted, group: r.voter.group, proxies: r.voter.proxies, proxyHolder: r.voter.proxyHolder }, r.freeUsed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initial) void submit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <form className="panel gate" onSubmit={submit}>
      <KeyRound size={30} className="accent-icon" />
      <h2>Enter your access code</h2>
      <p className="muted">You'll find it in your invitation. It can be used once.</p>
      {error && <div className="inline-error">{error}</div>}
      <input className="input code-input" value={code} onChange={(x) => setCode(x.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="ABCD2345" maxLength={20} autoFocus autoComplete="one-time-code" required />
      <Button type="submit" busy={busy} size="lg">
        Continue
      </Button>
    </form>
  );
}

function EmailGate({ slug, mailEnabled, onAccess }: { slug: string; mailEnabled: boolean; onAccess: (s: Session, freeUsed: Record<string, number>) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  return (
    <form
      className="panel gate"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        setError("");
        try {
          if (step === "email") {
            const r = await post<{ devCode?: string }>(`/public/events/${slug}/email-code`, { email });
            setDevCode(r.devCode ?? null);
            setStep("code");
          } else {
            const r = await post<{ token: string; voter: { email: string; hasVoted: boolean }; freeUsed: Record<string, number> }>(`/public/events/${slug}/email-verify`, { email, code });
            onAccess({ token: r.token, email: r.voter.email, hasVoted: r.voter.hasVoted }, r.freeUsed);
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Mail size={30} className="accent-icon" />
      <h2>{step === "email" ? "Confirm your email to vote" : "Check your inbox"}</h2>
      <p className="muted">{step === "email" ? "We'll send you a 6-digit code." : `Enter the code sent to ${email}.`}</p>
      {error && <div className="inline-error">{error}</div>}
      {step === "email" ? (
        <input className="input" type="email" value={email} onChange={(x) => setEmail(x.target.value)} placeholder="you@example.com" required autoFocus />
      ) : (
        <>
          <input className="input code-input" value={code} onChange={(x) => setCode(x.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={6} placeholder="123456" required autoFocus autoComplete="one-time-code" />
          {devCode && !mailEnabled && <p className="notice small">Development mode (email not configured): your code is <b>{devCode}</b></p>}
          <button type="button" className="text-link" onClick={() => setStep("email")}>
            Use a different email
          </button>
        </>
      )}
      <Button type="submit" busy={busy} size="lg">
        {step === "email" ? "Send code" : "Verify & continue"}
      </Button>
      <VoterNotice />
    </form>
  );
}

function DetailsFields({ e, value, onChange, requireEmail }: { e: PubEvent; value: Record<string, string>; onChange: (v: Record<string, string>) => void; requireEmail?: boolean }) {
  const c = e.settings.collect;
  const fields = [
    { k: "name", label: "Your name", type: "text", mode: c.name },
    { k: "email", label: "Email", type: "email", mode: requireEmail ? "required" : c.email },
    { k: "phone", label: "Phone", type: "tel", mode: c.phone },
  ].filter((f) => f.mode !== "off");
  if (!fields.length) return null;
  return (
    <div className="details-fields">
      {fields.map((f) => (
        <Field key={f.k} label={`${f.label}${f.mode === "optional" ? " (optional)" : ""}`}>
          <input className="input" type={f.type} required={f.mode === "required"} value={value[f.k] ?? ""} onChange={(x) => onChange({ ...value, [f.k]: x.target.value })} />
        </Field>
      ))}
    </div>
  );
}

function OptionVisual({ o }: { o: PubOption }) {
  return <div className="pub-photo">{o.imageFileId ? <img src={fileUrl(o.imageFileId)!} alt="" loading="lazy" /> : <span>{o.name.slice(0, 1)}</span>}</div>;
}

// ---------------- Ballot mode ----------------
const RANKED = new Set(["ranked", "stv", "borda"]);
const methodHint = (c: PubCategory) =>
  c.method === "single"
    ? "Choose one"
    : c.method === "multiple"
      ? `Choose up to ${c.maxChoices}`
      : c.method === "score"
        ? `Rate each option from 0 to ${c.points}`
        : c.method === "cumulative"
          ? `Share out up to ${c.points} points however you like`
          : c.method === "stv"
            ? `Rank candidates in order of preference — ${c.maxChoices} seats will be filled`
            : "Tap candidates in order of preference (1st, 2nd, …)";

type Choice = string[] | Record<string, number>;
const isEmpty = (v: Choice | undefined, writeIn?: string) => (!v || (Array.isArray(v) ? v.length === 0 : Object.values(v).every((n) => !n))) && !writeIn?.trim();

function BallotForm({ e, session, passToken, onDone }: { e: PubEvent; session: Session | null; passToken: string | null; onDone: (d: { receipt: string | null; message: string }) => void }) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [writeIns, setWriteIns] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<string, string>>({ email: session?.email ?? "" });
  const [comment, setComment] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const categories = e.categories.filter((c) => !c.voterGroups.length || (session?.group && c.voterGroups.map((g) => g.toLowerCase()).includes(session.group.toLowerCase())));
  const list = (c: PubCategory) => (Array.isArray(choices[c.id]) ? (choices[c.id] as string[]) : []);
  const values = (c: PubCategory) => (choices[c.id] && !Array.isArray(choices[c.id]) ? (choices[c.id] as Record<string, number>) : {});
  const toggle = (c: PubCategory, id: string) => {
    const cur = list(c);
    let next: string[];
    if (c.method === "single") next = cur[0] === id ? [] : [id];
    else if (cur.includes(id)) next = cur.filter((x) => x !== id);
    else if (c.method === "multiple" && cur.length + (writeIns[c.id]?.trim() ? 1 : 0) >= c.maxChoices) return;
    else next = [...cur, id];
    if (c.method === "single" && next.length) setWriteIns({ ...writeIns, [c.id]: "" });
    setChoices({ ...choices, [c.id]: next });
  };
  const setValue = (c: PubCategory, id: string, v: number) => setChoices({ ...choices, [c.id]: { ...values(c), [id]: Math.max(0, v) } });
  const moveRank = (c: PubCategory, idx: number, dir: -1 | 1) => {
    const cur = [...list(c)];
    const j = idx + dir;
    if (j < 0 || j >= cur.length) return;
    [cur[idx], cur[j]] = [cur[j]!, cur[idx]!];
    setChoices({ ...choices, [c.id]: cur });
  };
  const used = (c: PubCategory) => Object.values(values(c)).reduce((a, b) => a + (b || 0), 0);
  const overBudget = categories.find((c) => c.method === "cumulative" && used(c) > c.points);
  const missing = categories.filter((c) => isEmpty(choices[c.id], writeIns[c.id]) && !e.settings.ballot.allowAbstain);
  const describe = (c: PubCategory) => {
    const v = choices[c.id];
    const wi = writeIns[c.id]?.trim();
    if (isEmpty(v, wi)) return "Abstain";
    if (Array.isArray(v) || !v) {
      const names = (v as string[] | undefined ?? []).map((id, i) => `${RANKED.has(c.method) ? `${i + 1}. ` : ""}${c.options.find((o) => o.id === id)?.name}`);
      if (wi) names.push(`${wi} (write-in)`);
      return names.join(RANKED.has(c.method) ? "   " : ", ");
    }
    return Object.entries(v)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => `${c.options.find((o) => o.id === id)?.name}: ${n}`)
      .join(", ");
  };
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const body = {
        token: session?.token,
        passToken: passToken ?? undefined,
        website: honeypot || undefined,
        choices: Object.fromEntries(categories.map((c) => [c.id, choices[c.id] ?? (c.method === "score" || c.method === "cumulative" ? {} : [])])),
        writeIns: Object.fromEntries(Object.entries(writeIns).filter(([, v]) => v.trim())),
        comment: comment.trim() || undefined,
        ...details,
      };
      const r = await post<{ receipt: string | null; message: string }>(`/public/events/${e.slug}/ballot`, body);
      onDone(r);
    } catch (err) {
      setError((err as Error).message);
      setReviewing(false);
      if (err instanceof ApiError && err.status === 409) onDone({ receipt: null, message: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      {session?.name && (
        <div className="notice">
          Voting as <b>{session.name}</b>
          {session.group ? ` · ${session.group}` : ""}
          {e.settings.ballot.weighted && session.weight ? ` · your vote counts ×${fmtNum(session.weight)}` : ""}
          {session.proxies ? (
            <>
              {" "}
              · you also hold <b>{session.proxies} proxy vote{session.proxies > 1 ? "s" : ""}</b>, cast together with your ballot
            </>
          ) : null}
          {session.proxyHolder && <span className="block small">You appointed {session.proxyHolder} as your proxy. If you vote now, your own vote is used instead.</span>}
        </div>
      )}
      {error && <div className="inline-error">{error}</div>}
      {categories.length === 0 && <div className="panel center-text muted">There is nothing on the ballot for you in this event.</div>}
      {categories.map((c) => {
        const picked = list(c);
        const vals = values(c);
        return (
          <section key={c.id} className="panel ballot-section">
            <header>
              <h2>{c.title}</h2>
              <p className="muted small">
                {methodHint(c)}
                {e.settings.ballot.allowAbstain ? " · or leave blank to abstain" : ""}
              </p>
              {c.description && <p className="small">{c.description}</p>}
            </header>
            {c.method === "score" || c.method === "cumulative" ? (
              <div className="value-list">
                {c.options.map((o) => (
                  <div key={o.id} className="value-row">
                    <OptionVisual o={o} />
                    <span className="pub-option-text">
                      <b>{o.name}</b>
                      {o.subtitle && <small>{o.subtitle}</small>}
                    </span>
                    {c.method === "score" && c.points <= 10 ? (
                      <div className="score-buttons" role="radiogroup" aria-label={`Rating for ${o.name}`}>
                        {Array.from({ length: c.points + 1 }, (_, n) => (
                          <button key={n} type="button" role="radio" aria-checked={(vals[o.id] ?? 0) === n} className={(vals[o.id] ?? 0) === n ? "on" : ""} onClick={() => setValue(c, o.id, n)}>
                            {n}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="qty small-qty">
                        <button type="button" className="icon-btn" aria-label="Less" onClick={() => setValue(c, o.id, (vals[o.id] ?? 0) - 1)}>
                          <Minus size={14} />
                        </button>
                        <input className="input" type="number" min={0} max={c.points} value={vals[o.id] ?? 0} onChange={(x) => setValue(c, o.id, Math.min(c.points, Number(x.target.value) || 0))} aria-label={`Points for ${o.name}`} />
                        <button type="button" className="icon-btn" aria-label="More" disabled={c.method === "cumulative" && used(c) >= c.points} onClick={() => setValue(c, o.id, (vals[o.id] ?? 0) + 1)}>
                          <Plus size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {c.method === "cumulative" && (
                  <p className={`budget ${used(c) > c.points ? "over" : ""}`}>
                    {used(c)} of {c.points} points used{used(c) > c.points ? " — too many" : used(c) < c.points ? ` · ${c.points - used(c)} left` : ""}
                  </p>
                )}
              </div>
            ) : (
              <div className="pub-options">
                {c.options.map((o) => {
                  const idx = picked.indexOf(o.id);
                  const on = idx >= 0;
                  return (
                    <button key={o.id} type="button" className={`pub-option ${on ? "on" : ""}`} onClick={() => toggle(c, o.id)} aria-pressed={on}>
                      <OptionVisual o={o} />
                      <span className="pub-option-text">
                        <b>{o.name}</b>
                        {o.subtitle && <small>{o.subtitle}</small>}
                        {o.description && <span className="pub-desc">{o.description}</span>}
                      </span>
                      <span className={`pick ${c.method === "single" ? "radio" : ""}`}>{on ? RANKED.has(c.method) ? idx + 1 : <Check size={14} /> : null}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {c.allowWriteIn && (
              <Field label="Or write in another candidate">
                <input
                  className="input"
                  maxLength={120}
                  value={writeIns[c.id] ?? ""}
                  placeholder="Full name"
                  onChange={(x) => {
                    setWriteIns({ ...writeIns, [c.id]: x.target.value });
                    if (c.method === "single" && x.target.value.trim()) setChoices({ ...choices, [c.id]: [] });
                  }}
                />
              </Field>
            )}
            {RANKED.has(c.method) && picked.length > 1 && (
              <ol className="rank-order">
                {picked.map((id, i) => (
                  <li key={id}>
                    <span>
                      {i + 1}. {c.options.find((o) => o.id === id)?.name}
                    </span>
                    <span>
                      <button type="button" className="icon-btn" aria-label="Move up" onClick={() => moveRank(c, i, -1)} disabled={i === 0}>
                        <ArrowUp size={14} />
                      </button>
                      <button type="button" className="icon-btn" aria-label="Move down" onClick={() => moveRank(c, i, 1)} disabled={i === picked.length - 1}>
                        <ArrowDown size={14} />
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
      {categories.length > 0 && (
        <section className="panel">
          <DetailsFields e={e} value={details} onChange={setDetails} />
          {e.settings.ballot.allowComments && (
            <Field label="Comment (optional)">
              <textarea className="input" rows={3} maxLength={1000} value={comment} onChange={(x) => setComment(x.target.value)} placeholder="Anything you'd like the organizers to know" />
            </Field>
          )}
          {e.settings.security.botProtection && <Honeypot onChange={setHoneypot} />}
          <Button size="lg" className="wide" disabled={missing.length > 0 || Boolean(overBudget)} onClick={() => setReviewing(true)}>
            {overBudget ? `Too many points in "${overBudget.title}"` : missing.length ? `Make a choice for "${missing[0]!.title}"` : "Review my ballot"}
          </Button>
        </section>
      )}
      <Modal open={reviewing} onClose={() => setReviewing(false)} title="Review your ballot">
        <ul className="review-list">
          {categories.map((c) => (
            <li key={c.id}>
              <span className="muted small">{c.title}</span>
              <b>{describe(c)}</b>
            </li>
          ))}
        </ul>
        <p className="muted small">Once submitted, your ballot can't be changed.</p>
        <VoterNotice />
        <div className="modal-actions">
          <Button kind="outline" onClick={() => setReviewing(false)}>
            Change
          </Button>
          <Button busy={busy} onClick={submit}>
            Submit ballot
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function PasswordGate({ slug, onUnlock }: { slug: string; onUnlock: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="panel gate"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        setError("");
        try {
          const r = await post<{ passToken: string | null }>(`/public/events/${slug}/unlock`, { password });
          if (r.passToken) onUnlock(r.passToken);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Lock size={30} className="accent-icon" />
      <h2>This page is password protected</h2>
      <p className="muted">Enter the password shared by the organizer.</p>
      {error && <div className="inline-error">{error}</div>}
      <input className="input" type="password" value={password} onChange={(x) => setPassword(x.target.value)} required autoFocus />
      <Button type="submit" busy={busy} size="lg">
        Continue
      </Button>
    </form>
  );
}

function ShareBar({ e }: { e: PubEvent }) {
  const [qr, setQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/e/${e.slug}`;
  const text = `${e.title} — cast your vote`;
  return (
    <section className="share-bar">
      <span className="muted small">Share this vote</span>
      <a className="share wa" href={`https://wa.me/?text=${encodeURIComponent(`${text}: ${url}`)}`} target="_blank" rel="noreferrer">
        WhatsApp
      </a>
      <a className="share" href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">
        X
      </a>
      <a className="share" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`} target="_blank" rel="noreferrer">
        Facebook
      </a>
      <button
        className="share"
        onClick={async () => {
          try {
            if (navigator.share) await navigator.share({ title: e.title, url });
            else {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          } catch {
            /* dismissed */
          }
        }}
      >
        {copied ? "Copied!" : "Copy link"}
      </button>
      <button className="share" onClick={() => setQr(true)}>
        QR code
      </button>
      <Modal open={qr} onClose={() => setQr(false)} title="Scan to vote">
        <div className="center-text">
          <img className="qr-big" src={`/api/public/events/${e.slug}/qr.svg`} alt={`QR code for ${url}`} />
          <p className="muted small">{url}</p>
          <a className="btn btn-outline btn-sm" href={`/api/public/events/${e.slug}/qr.svg`} download={`${e.slug}-qr.svg`}>
            Download QR
          </a>
        </div>
      </Modal>
    </section>
  );
}

function ThankYou({ done, e, onBack }: { done: { receipt: string | null; message: string }; e: PubEvent; onBack: () => void }) {
  return (
    <div className="panel center-text thank-you">
      <BadgeCheck size={40} className="accent-icon" />
      <h2>{done.message}</h2>
      {done.receipt && (
        <>
          <p className="muted">Your receipt code — keep it to confirm your ballot was counted:</p>
          <code className="receipt">{done.receipt}</code>
        </>
      )}
      {e.settings.mode === "tally" && (
        <Button kind="outline" onClick={onBack}>
          Back to voting
        </Button>
      )}
    </div>
  );
}

// ---------------- Tally mode (contests/awards) ----------------
function TallyBoard({ e, session, passToken, freeUsed, setFreeUsed, onVoted }: { e: PubEvent; session: Session | null; passToken: string | null; freeUsed: Record<string, number>; setFreeUsed: (f: Record<string, number>) => void; onVoted: () => void }) {
  const toast = useToast();
  const [buying, setBuying] = useState<{ o: PubOption; c: PubCategory } | null>(null);
  const [voting, setVoting] = useState<{ o: PubOption; c: PubCategory } | null>(null);
  const [filter, setFilter] = useState("");
  const counts = useMemo(() => {
    const m = new Map<string, number | null>();
    e.results?.categories.forEach((c) => c.options.forEach((o) => m.set(o.id, o.votes)));
    return m;
  }, [e.results]);
  const needsDetails = e.settings.collect.name !== "off" || e.settings.collect.email !== "off" || e.settings.collect.phone !== "off";
  const castFree = async (o: PubOption, details: Record<string, string> = {}) => {
    try {
      const r = await post<{ freeUsed: Record<string, number>; message: string }>(`/public/events/${e.slug}/vote`, { token: session?.token, passToken: passToken ?? undefined, optionId: o.id, ...details });
      setFreeUsed(r.freeUsed);
      toast.ok(`Vote for ${o.name} recorded. ${r.message}`);
      setVoting(null);
      onVoted();
    } catch (err) {
      toast.error(err);
    }
  };
  const total = e.categories.reduce((a, c) => a + c.options.length, 0);
  return (
    <div className="stack">
      {total > 8 && <input className="input" placeholder="Search by name or code" value={filter} onChange={(x) => setFilter(x.target.value)} />}
      {e.categories.map((c) => {
        const used = freeUsed[c.id] ?? 0;
        const left = Math.max(0, e.settings.freeVotes.perVoter - used);
        const opts = c.options.filter((o) => !filter || o.name.toLowerCase().includes(filter.toLowerCase()) || o.code.toLowerCase() === filter.toLowerCase());
        if (!opts.length) return null;
        return (
          <section key={c.id} className="panel">
            <header className="tally-head">
              <div>
                <h2>{c.title}</h2>
                {c.description && <p className="muted small">{c.description}</p>}
              </div>
              {e.settings.freeVotes.enabled && (
                <Badge tone={left ? "green" : "neutral"}>
                  {left} free vote{left === 1 ? "" : "s"} left{e.settings.freeVotes.period === "daily" ? " today" : ""}
                </Badge>
              )}
            </header>
            <div className="contest-grid">
              {opts.map((o) => (
                <article key={o.id} className="contest-card">
                  <OptionVisual o={o} />
                  <div className="contest-body">
                    <b>{o.name}</b>
                    {o.subtitle && <small>{o.subtitle}</small>}
                    {e.settings.display.showCodes && <small className="code-tag">Code: {o.code}</small>}
                    {counts.get(o.id) !== undefined && counts.get(o.id) !== null && <span className="vote-count">{fmtNum(counts.get(o.id))} votes</span>}
                  </div>
                  <div className="contest-actions">
                    {e.settings.freeVotes.enabled && (
                      <Button size="sm" kind={e.settings.paid.enabled ? "outline" : "primary"} disabled={!left} onClick={() => (needsDetails ? setVoting({ o, c }) : castFree(o))}>
                        <Vote size={14} /> {left ? "Vote free" : "Free vote used"}
                      </Button>
                    )}
                    {e.settings.paid.enabled && (
                      <Button size="sm" onClick={() => setBuying({ o, c })}>
                        <CreditCard size={14} /> Buy votes
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
      <FreeVoteModal e={e} target={voting} onClose={() => setVoting(null)} onSubmit={castFree} />
      <BuyModal e={e} session={session} passToken={passToken} target={buying} onClose={() => setBuying(null)} />
    </div>
  );
}

function FreeVoteModal({ e, target, onClose, onSubmit }: { e: PubEvent; target: { o: PubOption; c: PubCategory } | null; onClose: () => void; onSubmit: (o: PubOption, d: Record<string, string>) => Promise<void> }) {
  const [details, setDetails] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `Vote for ${target.o.name}` : ""}>
      {target && (
        <form
          className="form-stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setBusy(true);
            await onSubmit(target.o, details);
            setBusy(false);
          }}
        >
          <DetailsFields e={e} value={details} onChange={setDetails} />
          <Button type="submit" busy={busy} size="lg">
            Cast free vote
          </Button>
          <VoterNotice />
        </form>
      )}
    </Modal>
  );
}

function BuyModal({ e, session, passToken, target, onClose }: { e: PubEvent; session: Session | null; passToken: string | null; target: { o: PubOption; c: PubCategory } | null; onClose: () => void }) {
  const p = e.settings.paid;
  const [qty, setQty] = useState(Math.max(1, p.minVotes));
  const [details, setDetails] = useState<Record<string, string>>({ email: session?.email ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [agree, setAgree] = useState(false);
  const methods = e.paymentMethods ?? [];
  const [method, setMethod] = useState(methods[0]?.id ?? "");
  const chosen = methods.find((m) => m.id === method);
  const bundle = p.bundles.find((b) => b.votes === qty);
  const amount = bundle ? bundle.price : qty * p.pricePerVote;
  const clamp = (n: number) => Math.min(p.maxVotes, Math.max(p.minVotes, Math.floor(n) || p.minVotes));
  return (
    <Modal open={!!target} onClose={onClose} title={target ? `Buy votes for ${target.o.name}` : ""}>
      {target && (
        <form
          className="form-stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setBusy(true);
            setError("");
            try {
              const r = await post<{ redirectUrl: string }>(`/public/events/${e.slug}/checkout`, { token: session?.token, passToken: passToken ?? undefined, website: honeypot || undefined, optionId: target.o.id, quantity: qty, method: method || undefined, acceptTerms: agree, ...details });
              location.href = r.redirectUrl;
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          {error && <div className="inline-error">{error}</div>}
          {p.bundles.length > 0 && (
            <div className="bundle-picks">
              {p.bundles.map((b) => (
                <button type="button" key={b.votes} className={qty === b.votes ? "on" : ""} onClick={() => setQty(b.votes)}>
                  <b>{fmtNum(b.votes)} votes</b>
                  <small>{formatMoney(b.price, p.currency)}</small>
                </button>
              ))}
            </div>
          )}
          <Field label="Number of votes" hint={`${formatMoney(p.pricePerVote, p.currency)} each · between ${fmtNum(p.minVotes)} and ${fmtNum(p.maxVotes)}`}>
            <div className="qty">
              <button type="button" className="icon-btn" aria-label="Fewer" onClick={() => setQty(clamp(qty - 1))}>
                <Minus size={16} />
              </button>
              <input className="input" type="number" value={qty} min={p.minVotes} max={p.maxVotes} onChange={(x) => setQty(Number(x.target.value))} onBlur={() => setQty(bundle ? qty : clamp(qty))} />
              <button type="button" className="icon-btn" aria-label="More" onClick={() => setQty(clamp(qty + 1))}>
                <Plus size={16} />
              </button>
            </div>
          </Field>
          <DetailsFields e={e} value={details} onChange={setDetails} requireEmail />
          {e.settings.security.botProtection && <Honeypot onChange={setHoneypot} />}
          {methods.length > 1 && (
            <div>
              <span className="field-label">Pay with</span>
              <div className="pay-methods">
                {methods.map((m) => (
                  <button type="button" key={m.id} className={method === m.id ? "on" : ""} onClick={() => setMethod(m.id)}>
                    <b>{m.label}</b>
                    <small>{m.kind === "manual" ? "Pay directly, then confirm" : m.kind === "test" ? "Simulated" : "Instant"}</small>
                  </button>
                ))}
              </div>
            </div>
          )}
          {methods.length === 0 && <div className="inline-error">The organizer hasn't set up a payment method yet.</div>}
          <div className="total-line">
            <span>Total</span>
            <b>{formatMoney(amount, p.currency)}</b>
          </div>
          <AgreeBox checked={agree} onChange={setAgree}>
            I agree to the{" "}
            <a href="/terms" target="_blank" rel="noreferrer">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            . I understand paid votes go to the organizer, are final once added, and refunds are the organizer's responsibility.
          </AgreeBox>
          <Button type="submit" busy={busy} size="lg" disabled={!methods.length || !agree}>
            <CreditCard size={16} /> {chosen?.kind === "manual" ? `Continue — ${formatMoney(amount, p.currency)}` : `Pay ${formatMoney(amount, p.currency)}`}
            {chosen && methods.length > 1 ? ` with ${chosen.label}` : ""}
          </Button>
          <p className="muted small center-text">{chosen?.kind === "manual" ? "You'll see payment details next. Votes are added when the organizer confirms your payment." : "Votes are added as soon as your payment is confirmed."}{p.testMode ? " This event uses TEST payments — no real money is charged." : ""}</p>
        </form>
      )}
    </Modal>
  );
}

// ---------------- Results, nominations, receipts ----------------
const unitFor = (method: string) => (method === "score" || method === "cumulative" || method === "borda" ? "pts" : "votes");

/** Shared results renderer (voting page, embed widget, presenter screen). */
export function ResultCategories({ results, live, big }: { results: PubResults; live: boolean; big?: boolean }) {
  return (
    <div className={`stack ${big ? "results-big" : ""}`}>
      {results.quorum && (
        <div className={`quorum ${results.quorum.met ? "met" : ""}`}>
          <Users size={15} /> Quorum ({results.quorum.percent}%): {fmtNum(results.quorum.achieved)} voted, {fmtNum(results.quorum.required)} needed — {results.quorum.met ? "met" : live ? "not yet reached" : "not reached"}
        </div>
      )}
      {results.categories.map((c) => (
        <div key={c.id}>
          <h3 className="result-cat">
            {c.title}
            {c.seats > 1 && <small> · {c.seats} seats</small>}
            {c.threshold && (
              <Badge tone={c.threshold.met ? "green" : "red"}>
                {c.threshold.met ? "Passed" : live ? "Below" : "Not passed"} · needs {c.threshold.percent}%
              </Badge>
            )}
          </h3>
          <ol className="result-list">
            {c.options.map((o, i) => (
              <li key={o.id} className={o.winner && !live ? "is-winner" : ""}>
                <span className="rank">{i + 1}</span>
                <div className="result-body">
                  <div className="result-line">
                    <b>
                      {o.name} {o.writeIn && <Badge>write-in</Badge>} {o.winner && <Badge tone="gold">{live ? "Leading" : c.seats > 1 ? "Elected" : "Winner"}</Badge>}
                    </b>
                    <span>
                      {o.votes !== null && `${fmtNum(o.votes)} ${unitFor(c.method)}`}
                      {o.average !== undefined && ` · avg ${o.average.toFixed(2)}`}
                      {o.votes !== null && o.percent !== null && " · "}
                      {o.percent !== null && `${o.percent.toFixed(1)}%`}
                    </span>
                  </div>
                  {o.percent !== null && <Bar percent={o.percent} winner={o.winner} />}
                </div>
              </li>
            ))}
          </ol>
          {c.method === "stv" && c.quota !== undefined && <p className="muted small">Single transferable vote · quota {fmtNum(c.quota)} · first-preference counts shown</p>}
          {c.method === "ranked" && <p className="muted small">Instant runoff · final-round counts shown</p>}
        </div>
      ))}
    </div>
  );
}

function ResultsView({ e, results }: { e: PubEvent; results: PubResults }) {
  return (
    <section className="panel">
      <header className="tally-head">
        <h2>
          <Trophy size={18} /> {e.state === "open" ? "Live results" : "Results"}
        </h2>
        {results.ballots !== null && e.settings.mode === "ballot" && <Badge>{fmtNum(results.ballots)} ballots</Badge>}
      </header>
      <ResultCategories results={results} live={e.state === "open"} />
    </section>
  );
}

function NominationForm({ e }: { e: PubEvent }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <section className="panel">
      <header className="tally-head">
        <div>
          <h2>Nominate someone</h2>
          <p className="muted small">{e.settings.nominations.requireApproval ? "Nominations are reviewed by the organizer before they appear." : "Nominations appear immediately."}</p>
        </div>
        {!open && (
          <Button kind="outline" onClick={() => setOpen(true)}>
            Submit a nomination
          </Button>
        )}
      </header>
      {open && (
        <form
          className="form-stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            setBusy(true);
            try {
              const r = await post<{ status: string }>(`/public/events/${e.slug}/nominate`, Object.fromEntries(f.entries()));
              toast.ok(r.status === "pending" ? "Thank you! Your nomination will be reviewed." : "Nomination added.");
              setOpen(false);
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Category">
            <select className="input" name="categoryId" required>
              {e.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nominee name">
            <input className="input" name="name" required minLength={2} maxLength={200} />
          </Field>
          <Field label="Short description (optional)">
            <input className="input" name="subtitle" maxLength={200} />
          </Field>
          <Field label="Why are you nominating them? (optional)">
            <textarea className="input" name="description" rows={3} maxLength={2000} />
          </Field>
          <Field label="Your email">
            <input className="input" name="email" type="email" required />
          </Field>
          <div className="modal-actions">
            <Button kind="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Submit nomination
            </Button>
          </div>
          <VoterNotice />
        </form>
      )}
    </section>
  );
}

function ReceiptCheck({ slug }: { slug: string }) {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<string | null>(null);
  return (
    <details className="receipt-check">
      <summary>Check a ballot receipt</summary>
      <form
        className="inline-form"
        onSubmit={async (ev) => {
          ev.preventDefault();
          try {
            const r = await get<{ found: boolean; recordedAt: string | null }>(`/public/events/${slug}/receipts/${encodeURIComponent(code.trim())}`);
            setResult(r.found ? `✓ Ballot recorded on ${fmtDate(r.recordedAt)}.` : "No ballot found with that receipt.");
          } catch (err) {
            setResult((err as Error).message);
          }
        }}
      >
        <input className="input" value={code} onChange={(x) => setCode(x.target.value.toUpperCase())} placeholder="Receipt code" required />
        <Button type="submit" kind="outline">
          Check
        </Button>
      </form>
      {result && <p className="small">{result}</p>}
    </details>
  );
}

// ---------------- Live scoreboard ----------------
function useCountUp(target: number) {
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (shown === target) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setShown(target);
    const from = shown;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      setShown(Math.round(from + (target - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
  return shown;
}

function ago(iso: string | null, now: number) {
  if (!iso) return "No votes yet";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
}

function LiveScoreboard({ e, live }: { e: PubEvent; live: LiveStats }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const main = live.voted ?? live.ballots ?? live.votes ?? 0;
  const shown = useCountUp(main);
  const open = e.state === "open";
  const endsIn = e.endsAt ? new Date(e.endsAt).getTime() - now : null;
  const label = live.voted !== null ? "have voted" : live.ballots !== null ? "ballots cast" : "votes so far";
  return (
    <section className={`scoreboard ${open ? "is-open" : ""}`} aria-live="polite">
      <div className="scoreboard-inner">
        <div className="sb-main">
          <span className="sb-live">{open ? <><i /> Live</> : e.state === "not_started" ? "Starting soon" : "Final"}</span>
          <b className="sb-number">{fmtNum(shown)}</b>
          <span className="sb-label">
            {live.eligible === 0 ? (live.registered ? `${label} · the voter list is being prepared` : label) : label}
            {!!live.eligible && <> out of {fmtNum(live.eligible)} eligible voters</>}
          </span>
          {live.turnoutPercent !== null && (
            <div className="sb-turnout">
              <div className="sb-track">
                <span style={{ width: `${Math.min(100, live.turnoutPercent)}%` }} />
              </div>
              <b>{live.turnoutPercent}% turnout</b>
            </div>
          )}
        </div>
        <div className="sb-facts">
          {endsIn !== null && open && endsIn > 0 && (
            <div>
              <Clock3 size={16} />
              <span>
                <b>{countdown(endsIn)}</b>
                <small>left to vote</small>
              </span>
            </div>
          )}
          <div>
            <Activity size={16} />
            <span>
              <b>{fmtNum(live.lastHour)}</b>
              <small>in the last hour</small>
            </span>
          </div>
          <div>
            <CalendarClock size={16} />
            <span>
              <b>{ago(live.lastActivityAt, now)}</b>
              <small>last vote</small>
            </span>
          </div>
          {live.registered !== null && (
            <div>
              <ClipboardList size={16} />
              <span>
                <b>{fmtNum(live.registered)}</b>
                <small>registered</small>
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------- Public registration ----------------
function RegisterForm({ slug, e, reg }: { slug: string; e: PubEvent; reg: PubRegistration }) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [honeypot, setHoneypot] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ status: string; email: string } | null>(null);
  if (!reg.open)
    return (
      <div className="panel center-text">
        <ClipboardList size={32} className="accent-icon" />
        <h2>Registration is closed</h2>
        <p className="muted">The organizer is no longer taking registrations for this event. If you already registered, watch your email for your voting code.</p>
      </div>
    );
  if (done)
    return (
      <div className="panel center-text register-done">
        <BadgeCheck size={40} className="accent-icon" />
        <h2>{done.status === "approved" ? "You're on the voter list" : "Registration received"}</h2>
        <p>
          {done.status === "approved"
            ? `Your private voting code has been sent to ${done.email}.`
            : `Thank you. The organizer will review your registration. If you're shortlisted, your private voting code will be sent to ${done.email}.`}
        </p>
        <a className="text-link" href={`/e/${slug}`}>
          Back to the voting page
        </a>
      </div>
    );
  const set = (k: string, v: string) => setForm({ ...form, [k]: v });
  const req = (m: string) => m === "required";
  return (
    <form
      className="panel register-form"
      onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        setError("");
        try {
          const r = await post<{ status: string; email: string }>(`/public/events/${slug}/register`, { ...form, answers, website: honeypot || undefined });
          setDone(r);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="register-head">
        <ClipboardList size={26} className="accent-icon" />
        <div>
          <h2>Register to vote</h2>
          <p className="muted">
            {reg.autoApprove ? "Fill in your details and you'll get your voting code by email." : "Fill in your details. The organizer checks every registration and sends a voting code to those who are eligible."}
            {reg.closesAt && ` Registration closes ${fmtDate(reg.closesAt)}.`}
          </p>
        </div>
      </div>
      {reg.message && <p className="prewrap register-message">{reg.message}</p>}
      {error && <div className="inline-error">{error}</div>}
      <div className="grid-2 tight">
        <Field label="Full name">
          <input className="input" required minLength={2} maxLength={200} autoComplete="name" value={form.name ?? ""} onChange={(x) => set("name", x.target.value)} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" required autoComplete="email" value={form.email ?? ""} onChange={(x) => set("email", x.target.value)} />
        </Field>
        {reg.ref !== "off" && (
          <Field label={`${reg.refLabel}${req(reg.ref) ? "" : " (optional)"}`}>
            <input className="input" required={req(reg.ref)} maxLength={100} value={form.ref ?? ""} onChange={(x) => set("ref", x.target.value)} />
          </Field>
        )}
        {reg.phone !== "off" && (
          <Field label={`Phone${req(reg.phone) ? "" : " (optional)"}`}>
            <input className="input" type="tel" required={req(reg.phone)} autoComplete="tel" maxLength={40} placeholder="0803 123 4567" value={form.phone ?? ""} onChange={(x) => set("phone", x.target.value)} />
          </Field>
        )}
        {reg.askGroup && (
          <Field label={reg.groupLabel}>
            {reg.groupOptions.length ? (
              <select className="input" required value={form.group ?? ""} onChange={(x) => set("group", x.target.value)}>
                <option value="" disabled>
                  Choose…
                </option>
                {reg.groupOptions.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            ) : (
              <input className="input" required maxLength={60} value={form.group ?? ""} onChange={(x) => set("group", x.target.value)} />
            )}
          </Field>
        )}
        {reg.questions.map((q) => (
          <Field key={q.id} label={`${q.label}${q.required ? "" : " (optional)"}`}>
            <input className="input" required={q.required} maxLength={1000} value={answers[q.id] ?? ""} onChange={(x) => setAnswers({ ...answers, [q.id]: x.target.value })} />
          </Field>
        ))}
      </div>
      {e.settings.security.botProtection && <Honeypot onChange={setHoneypot} />}
      <AgreeBox checked={agree} onChange={setAgree}>
        I confirm these details are true and agree to the{" "}
        <a href="/terms" target="_blank" rel="noreferrer">
          Terms
        </a>{" "}
        and{" "}
        <a href="/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        . My details are shared with {e.org.name} to check my eligibility.
      </AgreeBox>
      <Button type="submit" size="lg" busy={busy} disabled={!agree}>
        Submit registration
      </Button>
    </form>
  );
}
