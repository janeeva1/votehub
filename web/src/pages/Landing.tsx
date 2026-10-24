import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, BadgeCheck, Check, CreditCard, Fingerprint, KeyRound, Landmark, ListChecks, Lock, QrCode, ScrollText, Smartphone, Vote } from "lucide-react";
import { useConfig, useMe } from "../api";
import { formatMoney } from "@shared/model";
import { THEMES } from "@shared/theme";

export function Brand({ name, dark }: { name?: string; dark?: boolean }) {
  const cfg = useConfig();
  return (
    <span className={`brand ${dark ? "brand-dark" : ""}`}>
      <span className="brand-mark">
        <Vote size={18} />
      </span>
      <span>
        <b>{name ?? cfg.data?.appName ?? "VoteHub"}</b>
        <small>Voting platform</small>
      </span>
    </span>
  );
}

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Screenshots of the real product, rendered per colour theme by scripts/landing-shots.mjs. */
function useShot() {
  const cfg = useConfig();
  const id = cfg.data?.appearance?.themeId;
  const theme = THEMES.some((t) => t.id === id) ? id! : "ink";
  return (name: string) => `/landing/${theme}/${name}.webp`;
}

// ---------- Hero art: ink thumbprint ridges ----------
function Thumbprint() {
  const paths = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 22; i++) {
      const pts: string[] = [];
      const rx = 22 + i * 10.5;
      const ry = 30 + i * 12.5;
      const start = 0.35 + (i % 3) * 0.12;
      const end = Math.PI * 2 - (i % 4 === 0 ? 0.9 : 0.25);
      for (let k = 0; k <= 64; k++) {
        const t = start + ((end - start) * k) / 64;
        const wob = Math.sin(t * 3 + i * 0.7) * (2 + i * 0.18);
        const x = 300 + (rx + wob) * Math.cos(t) + Math.sin(i * 0.5) * 6;
        const y = 300 + (ry + wob) * Math.sin(t) * (1 - 0.08 * Math.cos(t));
        pts.push(`${k ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
      }
      out.push(pts.join(""));
    }
    return out;
  }, []);
  return (
    <svg className="thumbprint" viewBox="0 0 600 600" aria-hidden>
      {paths.map((d, i) => (
        <path key={i} d={d} pathLength={1} style={{ animationDelay: `${0.15 + i * 0.045}s` }} />
      ))}
    </svg>
  );
}

// ---------- Hero demo: a live paid-vote leaderboard on a phone ----------
const CONTESTANTS = [
  { name: "Tolu Adebayo", dept: "Mass Comm", hue: 0 },
  { name: "Ada Okafor", dept: "Law", hue: 1 },
  { name: "Kemi Balogun", dept: "Medicine", hue: 2 },
  { name: "Ifeanyi Eze", dept: "Engineering", hue: 3 },
];
const PAY = ["Paystack", "OPay", "Bank transfer", "Monnify", "Flutterwave"];

function LiveBoard() {
  const [votes, setVotes] = useState([412, 388, 251, 197]);
  const [toast, setToast] = useState<{ n: number; who: number; via: string; key: number } | null>(null);
  useEffect(() => {
    if (reduceMotion()) return;
    const t = setInterval(() => {
      const who = Math.random() < 0.55 ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);
      const n = [1, 5, 10, 20][Math.floor(Math.random() * 4)]!;
      setVotes((v) => v.map((x, i) => (i === who ? x + n : x)));
      setToast({ n, who, via: PAY[Math.floor(Math.random() * PAY.length)]!, key: Date.now() });
    }, 2200);
    return () => clearInterval(t);
  }, []);
  const total = votes.reduce((a, b) => a + b, 0);
  const order = votes.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const rank = new Map(order.map((o, r) => [o.i, r]));
  return (
    <div className="phone">
      <div className="phone-notch" />
      <div className="phone-screen">
        <div className="pb-head">
          <span className="pb-live">
            <i /> Voting is open
          </span>
          <b>Face of Campus 2026</b>
          <small>₦50 per vote · closes Friday 9pm</small>
        </div>
        <div className="pb-list" style={{ height: CONTESTANTS.length * 62 }}>
          {CONTESTANTS.map((c, i) => {
            const r = rank.get(i)!;
            const pct = (votes[i]! / total) * 100;
            return (
              <div key={c.name} className={`pb-row ${r === 0 ? "lead" : ""}`} style={{ transform: `translateY(${r * 62}px)` }}>
                <span className={`pb-avatar h${c.hue}`}>{c.name.split(" ").map((p) => p[0]).join("")}</span>
                <span className="pb-main">
                  <span className="pb-line">
                    <b>{c.name}</b>
                    <span className="pb-count">{votes[i]!.toLocaleString()}</span>
                  </span>
                  <span className="pb-bar">
                    <i style={{ width: `${pct * 2.2}%` }} />
                  </span>
                </span>
              </div>
            );
          })}
        </div>
        <div className="pb-buy">
          <CreditCard size={14} /> Buy votes
        </div>
      </div>
      {toast && (
        <div key={toast.key} className="pay-toast" role="status">
          <BadgeCheck size={16} />
          <span>
            <b>+{toast.n} for {CONTESTANTS[toast.who]!.name.split(" ")[0]}</b>
            <small>Paid with {toast.via}</small>
          </span>
        </div>
      )}
    </div>
  );
}

// ---------- "How your group votes" switcher ----------
const KINDS = [
  {
    id: "election",
    label: "Elections",
    title: "A secret ballot with one code per member",
    text: "Upload your member list, send codes by email, SMS or WhatsApp, and each member votes once. Results stay hidden until you close the poll.",
    points: ["Single choice, ranked choice and multi-seat (STV)", "Proxies, weighted votes, quorum", "Receipts voters can check"],
    shot: "election",
    mobile: true,
  },
  {
    id: "contest",
    label: "Paid contests",
    title: "Pageants and campus personalities that pay for themselves",
    text: "Set a price per vote or sell bundles. Fans pay with Paystack, OPay, Monnify, Flutterwave, Stripe or a plain bank transfer, and the leaderboard moves the moment payment is confirmed.",
    points: ["Free daily votes alongside paid ones", "Codes for SMS and WhatsApp promotion", "Revenue and fees on one screen"],
    shot: "contest",
    mobile: true,
  },
  {
    id: "awards",
    label: "Award nights",
    title: "Nominations first, then the vote, then the big screen",
    text: "Let the public nominate, approve the shortlist, run every category at once and put live results on the projector with a QR code people can scan from their seats.",
    points: ["Public nominations with approval", "Many categories in one event", "Presenter screen for the hall"],
    shot: "present",
    mobile: false,
  },
  {
    id: "agm",
    label: "AGMs & boards",
    title: "Motions and board seats that stand up to scrutiny",
    text: "Count shares instead of heads, require two-thirds for special resolutions, accept proxies and keep an activity log of every change your officers make.",
    points: ["Thresholds and quorum checks", "Voter groups for branch-only questions", "Exportable audit trail"],
    shot: "dashboard",
    mobile: false,
  },
];

function Kinds() {
  const [active, setActive] = useState(0);
  const shot = useShot();
  const k = KINDS[active]!;
  return (
    <section className="kinds" id="features">
      <div className="kinds-head">
        <h2>Whatever your group is deciding</h2>
        <p>Start from a template that already has the right rules, then change anything you need.</p>
      </div>
      <div className="kinds-body">
        <div className="kinds-tabs" role="tablist">
          {KINDS.map((x, i) => (
            <button key={x.id} role="tab" aria-selected={i === active} className={i === active ? "on" : ""} onClick={() => setActive(i)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="kinds-panel" key={k.id}>
          <div className="kinds-copy">
            <h3>{k.title}</h3>
            <p>{k.text}</p>
            <ul>
              {k.points.map((p) => (
                <li key={p}>
                  <Check size={15} /> {p}
                </li>
              ))}
            </ul>
          </div>
          <div className={`kinds-shot ${k.mobile ? "is-mobile" : ""}`}>
            {k.mobile ? (
              <div className="phone small-phone">
                <div className="phone-notch" />
                <img className="phone-img" src={shot(k.shot)} alt={`${k.label} on a phone`} loading="lazy" />
              </div>
            ) : (
              <div className="browser">
                <div className="browser-bar">
                  <i />
                  <i />
                  <i />
                </div>
                <img src={shot(k.shot)} alt={`${k.label} screen`} loading="lazy" />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- Ballot receipt that prints when scrolled into view ----------
function Receipt() {
  const ref = useRef<HTMLDivElement>(null);
  const [printed, setPrinted] = useState(false);
  useEffect(() => {
    if (reduceMotion() || !("IntersectionObserver" in window)) return setPrinted(true);
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && (setPrinted(true), io.disconnect()), { threshold: 0.35 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  const rows: [React.ReactNode, string, string][] = [
    [<KeyRound size={15} />, "One-time access code", "Used once, then dead"],
    [<Fingerprint size={15} />, "One vote per voter", "Codes, verified email or device checks"],
    [<Lock size={15} />, "Secret ballot", "Choices stored apart from names"],
    [<CreditCard size={15} />, "Payment verified", "Checked with the gateway before counting"],
    [<ScrollText size={15} />, "Activity log", "Who changed what, and when"],
  ];
  return (
    <div className="receipt-slot" ref={ref}>
      <div className="receipt-mouth" />
      <div className={`paper-receipt ${printed ? "printed" : ""}`}>
        <div className="receipt-top">
          <b>BALLOT RECEIPT</b>
          <span>7KQ2-M9XA</span>
        </div>
        {rows.map(([icon, a, b]) => (
          <div className="receipt-row" key={a}>
            {icon}
            <span>
              <b>{a}</b>
              <small>{b}</small>
            </span>
            <Check size={15} className="tick" />
          </div>
        ))}
        <div className="receipt-foot">Counted · Thank you for voting</div>
      </div>
    </div>
  );
}

const ROOMS = ["Alumni AGM", "Face of Campus", "Church council election", "Staff awards night", "Cooperative dividend vote", "Estate residents' poll", "Union executive election", "Talent show finals", "Student union election", "Board of trustees", "Best dressed at the dinner", "Departmental week awards"];

export function Landing() {
  const me = useMe();
  const cfg = useConfig();
  const shot = useShot();
  const signedIn = Boolean(me.data?.user);
  const plans = cfg.data?.plans ?? [];
  const look = cfg.data?.appearance;
  const hero = look?.heroImageId ? `/api/files/${look.heroImageId}` : null;
  const gallery = look?.galleryImageIds ?? [];
  const currency = cfg.data?.platformCurrency ?? "NGN";
  const start = signedIn ? "/app" : "/sign-up";
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Brand />
          <nav>
            <a href="#features">Features</a>
            <a href="#payments">Payments</a>
            <a href="#pricing">Pricing</a>
            {signedIn ? (
              <Link href="/app" className="btn btn-primary">
                Open dashboard
              </Link>
            ) : (
              <>
                <Link href="/sign-in" className="btn btn-quiet">
                  Sign in
                </Link>
                <Link href="/sign-up" className="btn btn-primary">
                  Start free
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main>
        <section className={`hero2 ${hero ? "has-photo" : ""}`} style={hero ? ({ "--hero-img": `url(${hero})` } as React.CSSProperties) : undefined}>
          {!hero && <Thumbprint />}
          <div className="hero2-inner">
            <div className="hero2-copy">
              <h1>{look?.headline || "Every vote counted. Every result trusted."}</h1>
              <p className="hero2-sub">
                {look?.subheadline ||
                  "Elections, polls, paid contests and award nights for clubs, schools, alumni groups, unions and churches. Free to start, priced in naira, live in ten minutes."}
              </p>
              <div className="hero2-actions">
                <Link href={start} className="btn btn-primary btn-lg">
                  {signedIn ? "Go to your dashboard" : "Create your free workspace"} <ArrowRight size={16} />
                </Link>
                <a href="#features" className="btn btn-ghost btn-lg">
                  See how it works
                </a>
              </div>
              <p className="hero2-note">Free for up to 50 voters. No card needed.</p>
            </div>
            <div className="hero2-art">
              <div className="browser hero-browser">
                <div className="browser-bar">
                  <i />
                  <i />
                  <i />
                </div>
                <img src={shot("dashboard")} alt="Organizer dashboard" />
              </div>
              <LiveBoard />
            </div>
          </div>
        </section>

        <div className="rooms" aria-label="Used for">
          <div className="rooms-track">
            {[...ROOMS, ...ROOMS].map((r, i) => (
              <span key={i} aria-hidden={i >= ROOMS.length}>
                {r}
              </span>
            ))}
          </div>
        </div>

        <Kinds />

        <section className="paybands" id="payments">
          <div className="paybands-inner">
            <div className="paybands-copy">
              <h2>Take money your way, or none at all</h2>
              <p>Most elections are free and need no payment setup. When you do sell votes, connect the gateway you already use, or list your bank account and confirm transfers yourself.</p>
            </div>
            <div className="gateways">
              {["Paystack", "Flutterwave", "Monnify", "OPay", "Stripe"].map((g) => (
                <span key={g} className="gateway-mark">
                  {g}
                </span>
              ))}
              <span className="gateway-mark alt">
                <Landmark size={16} /> Bank transfer
              </span>
              <span className="gateway-mark alt">POS &amp; cash</span>
            </div>
            <div className="payfacts">
              <div>
                <b>Money goes to you</b>
                <p>Payments land in your own gateway or bank account. Votes count only after the payment is confirmed.</p>
              </div>
              <div>
                <b>Bank transfers welcome</b>
                <p>Voters see your account details, pay, and tap "I've paid". You approve it and the votes appear.</p>
              </div>
              <div>
                <b>Each event chooses</b>
                <p>Offer Paystack on the pageant, transfer only for the dinner raffle, nothing at all for the AGM.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="room">
          <div className="room-copy">
            <h2>Made for the room where it happens</h2>
            <p>Put the presenter screen on the projector. People scan the QR code from their seats, vote on their phones, and the bars move on the wall as ballots arrive.</p>
            <ul className="room-points">
              <li>
                <QrCode size={18} /> Scan to vote, no app to install
              </li>
              <li>
                <Smartphone size={18} /> Works on any phone, even on slow data
              </li>
              <li>
                <ListChecks size={18} /> Results update every few seconds
              </li>
            </ul>
          </div>
          <div className="room-screen">
            <div className="projector">
              <img src={shot("present")} alt="Live results on a projector screen" loading="lazy" />
            </div>
          </div>
          {gallery.length > 0 && (
            <div className={`photo-strip n${Math.min(gallery.length, 6)}`}>
              {gallery.map((id) => (
                <img key={id} src={`/api/files/${id}`} alt="" loading="lazy" />
              ))}
            </div>
          )}
        </section>

        <section className="trust">
          <div className="trust-copy">
            <h2>Results people won't argue about</h2>
            <p>Every safeguard is switched on by default and explained to voters in plain words, so the losing side can see the count was fair.</p>
            <p className="trust-fine">
              Built for private organizations, competitions and events, not public or government elections. Secret ballots are kept apart from voter names; this protects privacy from other users, though it is not cryptographic end-to-end verification.
            </p>
          </div>
          <Receipt />
        </section>

        <section className="pricing2" id="pricing">
          <div className="pricing2-head">
            <h2>Start free. Pay in naira when you grow.</h2>
            <p>Plans renew monthly or yearly and you can pause any time. Voting once a year? Buy a single-event pass instead.</p>
          </div>
          <div className="plan-grid">
            {plans.map((p) => (
              <article key={p.id} className={`plan-card ${p.id === "starter" ? "featured" : ""}`}>
                {p.id === "starter" && <span className="plan-flag">Most clubs pick this</span>}
                <h3>{p.name}</h3>
                <p className="plan-price">
                  {p.price === 0 ? "Free" : formatMoney(p.price, currency)}
                  {p.price > 0 && <small>/month</small>}
                </p>
                <ul>
                  {p.features.map((f) => (
                    <li key={f}>
                      <Check size={14} /> {f}
                    </li>
                  ))}
                </ul>
                <Link href={signedIn ? `/app/billing?plan=${p.id}` : `/sign-up?plan=${p.id}`} className={`btn ${p.id === "starter" ? "btn-primary" : "btn-outline"}`}>
                  {p.price === 0 ? "Start free" : `Choose ${p.name}`}
                </Link>
              </article>
            ))}
          </div>
          {(cfg.data?.passes?.length ?? 0) > 0 && (
            <div className="passes-line">
              <b>Single-event passes</b>
              {cfg.data!.passes.map((p) => (
                <span key={p.id}>
                  {p.name}: <b>{formatMoney(p.price, currency)}</b>
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="finale">
          <div className="finale-inner">
            <h2>Your next election can be live before lunch</h2>
            <Link href={start} className="btn btn-lg finale-btn">
              {signedIn ? "Go to your dashboard" : "Create your free workspace"} <ArrowRight size={16} />
            </Link>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="landing-foot-inner">
          <Brand dark />
          <nav>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/sign-in">Sign in</Link>
          </nav>
          <small>
            © {new Date().getFullYear()} {cfg.data?.legal?.companyName && !cfg.data.legal.companyName.startsWith("the operator") ? cfg.data.legal.companyName : cfg.data?.appName ?? "VoteHub"}
          </small>
        </div>
      </footer>
    </div>
  );
}
