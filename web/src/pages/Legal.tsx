import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { FileText, ShieldCheck } from "lucide-react";
import { post, queryClient, useConfig, useMe, type LegalInfo } from "../api";
import { Button, Loading } from "../ui";
import { formatMoney } from "@shared/model";
import { Brand } from "./Landing";

/*
 * Terms of Service and Privacy Policy.
 * These are strong, protective templates written for a Nigerian operator (NDPA 2023, FCCPA 2018, Arbitration and
 * Mediation Act 2023) that also follow GDPR-style practice. They are NOT a substitute for advice from a qualified
 * lawyer — have them reviewed before launch. Operator details are edited in Super admin → Legal.
 */

function useLegal(): LegalInfo | null {
  const cfg = useConfig();
  return cfg.data?.legal ?? null;
}

function LegalLayout({ title, children, legal }: { title: string; children: ReactNode; legal: LegalInfo }) {
  return (
    <div className="legal-page">
      <header className="legal-top">
        <Brand />
        <nav>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </header>
      <article className="legal-doc">
        <p className="eyebrow">Legal</p>
        <h1>{title}</h1>
        <p className="muted">
          Version {legal.termsVersion} · Last updated {legal.updatedAt}
        </p>
        {children}
      </article>
      <LegalFooter />
    </div>
  );
}

const Contact = ({ l, privacy }: { l: LegalInfo; privacy?: boolean }) => {
  const email = (privacy && l.privacyEmail) || l.contactEmail;
  return email ? <a href={`mailto:${email}`}>{email}</a> : <>the contact details published on the platform</>;
};

const Who = ({ l }: { l: LegalInfo }) => (
  <>
    <b>{l.companyName}</b>
    {l.registrationNumber ? ` (RC ${l.registrationNumber})` : ""}
    {l.address ? `, of ${l.address}` : ""}, trading as <b>{l.tradingName}</b>
  </>
);

export function TermsPage() {
  const l = useLegal();
  if (!l) return <Loading />;
  const cap = formatMoney(l.liabilityCapMinor / 100, "NGN");
  return (
    <LegalLayout title="Terms of Service" legal={l}>
      <div className="legal-summary">
        <b>The short version (not a substitute for the full terms):</b> {l.tradingName} is a software tool. Organizations that run votes on it are responsible for their events, voters, results, money they collect and the law that applies to them. Paid plans renew automatically until you pause or cancel. We provide the service "as is", our liability is limited, and disputes go to arbitration in {l.arbitrationSeat}.
      </div>

      <h2>1. Agreement</h2>
      <p>
        These Terms of Service ("Terms") are a binding agreement between you and <Who l={l} /> ("we", "us", "the Platform"). They apply to every website, application, API, widget and service we provide (the "Service"). By creating an account, ticking the acceptance box, creating an organization, casting a vote, buying votes or otherwise using the Service you confirm that you have read, understood and agree to these Terms and to our <Link href="/privacy">Privacy Policy</Link>, which forms part of them. If you do not agree, do not use the Service.
      </p>
      <p>
        If you use the Service for an organization, you confirm that you have authority to bind that organization, and "you" includes the organization. If you do not have that authority, you personally accept these Terms and are responsible for the organization's use.
      </p>

      <h2>2. Definitions</h2>
      <ul>
        <li>
          <b>Organization</b>: a club, association, school, company, union, church, cooperative or other body with a workspace on the Service.
        </li>
        <li>
          <b>Organizer</b>: an Organization and its team members who create and run Events.
        </li>
        <li>
          <b>Event</b>: an election, poll, contest, award, nomination or any other vote created on the Service.
        </li>
        <li>
          <b>Voter</b>: anyone who views an Event, casts a vote, nominates, or buys votes.
        </li>
        <li>
          <b>Organization Data</b>: everything an Organizer uploads or collects through the Service, including voter lists, candidate content and ballots.
        </li>
      </ul>

      <h2>3. Eligibility and accounts</h2>
      <p>
        You must be at least {l.minimumAge} years old (or the age of majority where you live, if higher) to create an account or buy votes. Voters under that age may only take part in Events run by an Organizer that has obtained any parental or guardian consent the law requires; the Organizer, not us, is responsible for that consent. You must give accurate information, keep your password secret, and tell us immediately at <Contact l={l} /> about any unauthorized use. You are responsible for everything done through your account. We may refuse, suspend or close accounts at our discretion where we reasonably believe these Terms or the law are being breached.
      </p>

      <h2>4. What the Service is — and is not</h2>
      <p>
        The Service is a software tool that lets Organizers configure and run votes. <b>We are not an election authority, returning officer, auditor, payment collector, gaming operator or party to any Event.</b> We do not choose candidates, verify voter eligibility, supervise Events, certify results or decide disputes about them. Results shown are the computation of the votes recorded under the rules the Organizer configured. Organizers are solely responsible for:
      </p>
      <ul>
        <li>their Event rules, constitution or bylaws, eligibility, notices, timing and conduct, and the accuracy of voter lists;</li>
        <li>announcing, accepting, challenging or acting on results, and any dispute between them and their members, candidates or voters;</li>
        <li>obtaining every licence, permit, approval and consent needed for their Event (including for promotions, competitions, lotteries or fundraising) and complying with all laws that apply to them;</li>
        <li>the content they publish and the money they collect, including refunds, taxes and receipts owed to voters.</li>
      </ul>
      <p>
        The Service must not be used for statutory public elections (for example general, governorship or local government elections) unless we have agreed to it in a separate signed contract.
      </p>

      <h2>5. Organizations, roles and data processing</h2>
      <p>
        Each Organization's workspace, users and data are kept separate from other Organizations. The Organization controls who joins its team and what role they have, and is responsible for its team members' actions. For personal data in Organization Data, the Organization is the <b>data controller</b> and we act as its <b>data processor</b>. We will: process it only to provide the Service and on the Organization's documented instructions (these Terms and its use of the Service); keep it confidential and require the same of our staff; apply appropriate technical and organisational security measures; use only sub-processors bound by equivalent obligations (hosting, email, SMS and payment providers); help the Organization respond to data-subject requests and meet its obligations under the Nigeria Data Protection Act 2023 ("NDPA") and similar laws; notify it without undue delay after becoming aware of a personal-data breach affecting its data; and delete or return Organization Data when it deletes its Organization, except where the law requires us to keep it. The Organization confirms it has a lawful basis and has given every notice needed to upload and process its voters' and candidates' personal data.
      </p>

      <h2>6. Plans, subscriptions and automatic renewal</h2>
      <ul>
        <li>Plans, prices, limits and features are shown on the pricing and billing pages and may change. Price changes apply from your next billing period after notice.</li>
        <li>
          <b>Automatic renewal.</b> When you pay for a plan by card you authorize us (through our payment processor, Paystack) to charge that card automatically at the start of each monthly or yearly period, at the then-current price, until you pause automatic renewal, remove your card or delete your Organization. You can pause at any time in Plan &amp; billing; nothing is charged while paused, and your plan runs until the end of the period already paid.
        </li>
        <li>If a renewal charge fails we may retry it, and the Organization moves to the Free plan when the paid period ends. Downgrades may disable features or make data that exceeds the new plan's limits read-only; we do not delete it because of a downgrade.</li>
        <li>
          <b>Fees are non-refundable</b> except where these Terms say otherwise or where a refund is required by law (including the Federal Competition and Consumer Protection Act 2018). Unused time on a plan you switch away from is converted into credit on the new plan, not refunded. Event passes are single-event, one-time purchases.
        </li>
        <li>Prices exclude taxes unless stated. You are responsible for all taxes, levies and bank charges applicable to your purchases.</li>
      </ul>

      <h2>7. Paid voting and money collected by Organizers</h2>
      <p>
        Organizers may sell votes through their own payment gateways (such as Paystack, Flutterwave, Stripe, Monnify or OPay), through manual methods such as bank transfer, or through the Platform's account. In every case <b>the sale is between the Organizer and the Voter</b>. The Organizer sets the price, decides what a vote buys, and is solely responsible for its Event's legality, fulfilment, refunds, chargebacks, complaints and taxes. Where the Platform's account collects money on an Organizer's behalf, we act only as a limited collection agent: we pay out the amount received less the platform fee and any processor fees, refunds or chargebacks, and we may hold or set off funds where we reasonably suspect fraud, a chargeback, a breach of these Terms or a legal requirement. Manual payments are made directly to the Organizer; we never receive them and are not responsible for them.
      </p>
      <p>
        <b>For Voters:</b> buying votes is a payment to the Organizer to support an entry under that Event's rules. It is not a bet, wager, investment or purchase of any prize. Paid votes are final once credited and are non-refundable by us; any refund request must go to the Organizer. Votes are credited only after the payment is verified. We may refuse, reverse or remove votes linked to fraud, stolen cards, automation or abuse.
      </p>

      <h2>8. Acceptable use</h2>
      <p>You must not, and must not help anyone to:</p>
      <ul>
        <li>break any law, or infringe anyone's rights, including intellectual-property, privacy and data-protection rights;</li>
        <li>run illegal gambling, lotteries, pyramid or Ponzi schemes, or misleading competitions; buy or sell votes in any public election; or pay or pressure voters in breach of an Event's rules;</li>
        <li>impersonate anyone, publish false or defamatory content, hate speech, harassment, sexual content involving minors, or content that incites violence;</li>
        <li>rig, manipulate or interfere with an Event, including by fake accounts, scripts, bots, multiple identities, vote farms, stolen cards or exploiting bugs;</li>
        <li>send spam or unsolicited messages through our email or SMS features, or upload contact lists you have no right to use;</li>
        <li>probe, scan, overload or breach the Service's security, reverse engineer it, or access it other than through our interfaces and published API;</li>
        <li>resell, sublicense or white-label the Service without our written permission.</li>
      </ul>
      <p>
        We may investigate suspected breaches, remove content, void affected votes, suspend Events, Organizations or accounts, withhold payouts, and report matters to the authorities — with or without notice where we consider it reasonable.
      </p>

      <h2>9. Content and intellectual property</h2>
      <p>
        You keep ownership of content you upload. You grant us a worldwide, non-exclusive, royalty-free licence to host, copy, process, display and transmit it as needed to run, secure and improve the Service and to display Events as you configure them. You confirm you have every right needed to grant that licence, including from the people shown in candidate photos and profiles. The Service, its software, design, trademarks and documentation are owned by us or our licensors and are licensed to you, not sold, for use under these Terms only. Feedback you give us may be used freely without obligation to you.
      </p>

      <h2>10. Advertising</h2>
      <p>
        Some plans (including the Free plan) display advertisements, including on dashboards and on public voting pages. We choose and place ads; Organizers on those plans may not remove or obscure them. We do not give advertisers personal data of Organizers or Voters. Ads are provided by third parties who are solely responsible for them; we do not endorse advertised products and are not responsible for any dealings with advertisers.
      </p>

      <h2>11. Third-party services</h2>
      <p>
        The Service relies on third parties such as payment processors, banks, email and SMS providers, hosting and messaging apps. Their services are governed by their own terms, and we are not responsible for their acts, omissions, downtime, fees, delays, declined payments or message delivery.
      </p>

      <h2>12. Availability, changes and security</h2>
      <p>
        We work to keep the Service available and secure but do not promise that it will be uninterrupted, error-free, or free from loss of data. We may change, suspend or discontinue features, and carry out maintenance, at any time. You are responsible for keeping your own exports of results and data you need, and for checking your Event's configuration before it goes live.
      </p>

      <h2>13. Disclaimers</h2>
      <p className="caps">
        To the fullest extent permitted by law, the Service is provided "as is" and "as available", without warranties of any kind, express or implied, including warranties of merchantability, fitness for a particular purpose, accuracy, title, non-infringement, or that results will meet your requirements or be accepted by any person or authority.
      </p>

      <h2>14. Limitation of liability</h2>
      <p className="caps">
        To the fullest extent permitted by law: (a) we will not be liable for any indirect, incidental, special, consequential, exemplary or punitive damages, or for loss of profits, revenue, goodwill, data, votes, office, reputation or opportunity, or the outcome or validity of any event, however caused, even if advised of the possibility; and (b) our total liability arising out of or relating to the Service or these Terms in any twelve-month period is limited to the greater of the fees you paid us for the Service in that period and {cap}.
      </p>
      <p>Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited, including for death or personal injury caused by negligence, for fraud, or your statutory rights as a consumer.</p>

      <h2>15. Indemnity</h2>
      <p>
        You will defend, indemnify and hold harmless us, our affiliates, directors, employees and agents from and against all claims, demands, losses, liabilities, penalties, costs and expenses (including reasonable legal fees) arising from: your Events or their results; Organization Data and content you upload; money you collect and your dealings with Voters, candidates or members; your breach of these Terms or of any law; or any dispute between you and a third party.
      </p>

      <h2>16. Suspension and termination</h2>
      <p>
        You may stop using the Service at any time; an owner may delete an Organization from its settings. We may suspend or terminate access immediately where we reasonably believe there is a breach of these Terms, a legal risk, fraud, non-payment, or a threat to the Service or other users, and otherwise on 30 days' notice. On termination your right to use the Service ends; amounts owed remain payable; and sections that by their nature should survive (including 4, 5, 7, 9 and 13–21) survive.
      </p>

      <h2>17. Force majeure</h2>
      <p>
        We are not liable for any failure or delay caused by events beyond our reasonable control, including power or internet failures, failures of banks, payment processors or telecoms providers, strikes, civil unrest, epidemics, acts of government, cyber-attacks or natural events.
      </p>

      <h2>18. Disputes, governing law and arbitration</h2>
      <p>
        These Terms and any dispute or claim arising out of or relating to them or the Service (including non-contractual disputes) are governed by the laws of {l.governingLaw}. Before starting any proceedings, you agree to contact us at <Contact l={l} /> and try in good faith to resolve the dispute for at least 30 days. Any dispute not resolved in that time shall be finally resolved by confidential arbitration by a sole arbitrator under the Arbitration and Mediation Act 2023, seated in {l.arbitrationSeat}, in English. Either party may seek urgent injunctive relief from the courts of {l.courts}, which also have exclusive jurisdiction to enforce any award and over any matter that cannot be arbitrated. To the extent permitted by law, claims may only be brought individually and not as a class or representative action, and must be brought within one year after the claim arose.
      </p>

      <h2>19. Changes to these Terms</h2>
      <p>
        We may update these Terms. When we make material changes we will update the version date and ask you to accept the new Terms before you continue using the Service. Changes do not apply retrospectively. If you do not accept them, you must stop using the Service; paid periods already started are not affected.
      </p>

      <h2>20. General</h2>
      <p>
        These Terms (with the Privacy Policy and any order or plan description) are the entire agreement about the Service and replace prior understandings. If any provision is held invalid, the rest remains in force and the invalid provision is replaced by a valid one closest to its intent. Our failure to enforce a provision is not a waiver. You may not assign these Terms without our written consent; we may assign them to an affiliate or a successor to our business. Nothing creates a partnership, agency or employment relationship, except the limited collection agency in section 7. Notices to you may be given by email or in the Service; notices to us must go to <Contact l={l} />. Electronic acceptance of these Terms is valid and binding and our records of it are evidence of your agreement.
      </p>

      <h2>21. Contact</h2>
      <p>
        <Who l={l} />. Email: <Contact l={l} />.
      </p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  const l = useLegal();
  if (!l) return <Loading />;
  return (
    <LegalLayout title="Privacy Policy" legal={l}>
      <div className="legal-summary">
        <b>The short version:</b> we collect only what's needed to run votes securely. Organizations decide what they collect from their voters and control that data; we process it for them. Secret ballots are not linked to who cast them. We never sell personal data and never share it with advertisers. You can ask for a copy, correction or deletion at any time.
      </div>

      <h2>1. Who we are</h2>
      <p>
        This policy explains how <Who l={l} /> ("we", "us") handles personal data when you use {l.tradingName} (the "Service"). We follow the Nigeria Data Protection Act 2023 ("NDPA") and the regulations and guidance of the Nigeria Data Protection Commission ("NDPC"), and apply equivalent protections to people elsewhere, including under the EU/UK GDPR where it applies. Privacy contact: <Contact l={l} privacy />.
      </p>

      <h2>2. Our two roles</h2>
      <ul>
        <li>
          <b>Controller</b> — for account holders (Organizers and team members), billing, platform security, and visitors to our own pages.
        </li>
        <li>
          <b>Processor</b> — for Organization Data: voter lists, candidate content, ballots and information collected from voters on an Organization's Events. The Organization is the controller and decides what is collected and why. If you are a voter, please contact the Organization running the Event first; we will help them answer you.
        </li>
      </ul>

      <h2>3. What we collect</h2>
      <ul>
        <li>
          <b>Account data</b>: name, email, password (stored only as a salted hash), organization details, team roles, and your acceptance of these policies (version, date, IP address and browser).
        </li>
        <li>
          <b>Voter data</b> (on behalf of Organizations): what the Organizer chose to collect — for example name, email, phone, member ID, voter group — plus access codes, participation status, receipts and, for public events, a device cookie and hashed network information used to enforce one-vote rules and stop fraud.
        </li>
        <li>
          <b>Ballots and votes</b>: the choices made. For secret ballots, choices are stored separately from voter identity and cannot be linked back to a voter by Organizers; only the fact that a voter has voted is recorded.
        </li>
        <li>
          <b>Payment data</b>: amount, reference, status, payer name/email/phone and, for subscriptions, a reusable token and the last four digits, brand and expiry of the card. Card numbers and PINs are entered directly with the payment processor and never reach or stay on our servers.
        </li>
        <li>
          <b>Technical data</b>: IP address, browser and device type, timestamps, security and audit logs.
        </li>
      </ul>

      <h2>4. Why we use it and our lawful bases</h2>
      <ul>
        <li>To provide the Service and perform our contract with you (accounts, events, billing, automatic renewals, support).</li>
        <li>For legitimate interests: securing the Service, preventing fraud and vote manipulation, keeping audit trails, improving features, and enforcing our Terms — balanced against your rights.</li>
        <li>To comply with legal obligations, such as tax, accounting, and lawful requests from authorities.</li>
        <li>With consent where required, which you can withdraw at any time without affecting earlier processing.</li>
        <li>For Organization Data, on the Organization's instructions — the Organization is responsible for having its own lawful basis.</li>
      </ul>

      <h2>5. Who we share it with</h2>
      <p>We never sell personal data. We share it only with:</p>
      <ul>
        <li>the Organization running an Event you take part in (subject to ballot secrecy settings);</li>
        <li>service providers acting for us under contract — hosting and database providers, email and SMS providers (such as Termii), and payment processors (such as Paystack, Flutterwave, Stripe, Monnify or OPay, depending on what the Organization uses);</li>
        <li>professional advisers, auditors and insurers, under confidentiality;</li>
        <li>authorities, courts or others where the law requires it or to protect rights, safety and property, including to investigate fraud;</li>
        <li>a buyer or successor if our business is reorganized or sold, under this policy's protections.</li>
      </ul>
      <p>
        <b>Advertising:</b> ads shown on some plans are selected by placement and plan only. We count anonymous impressions and clicks; we do not give advertisers your personal data or let them place tracking cookies through our pages.
      </p>

      <h2>6. International transfers</h2>
      <p>
        Some providers may process data outside Nigeria. Where they do, we rely on the transfer grounds allowed by the NDPA (such as adequacy decisions, appropriate safeguards or contractual clauses) and require equivalent protection.
      </p>

      <h2>7. How long we keep it</h2>
      <p>
        Account data is kept while your account is active and for up to 6 years after for legal and accounting purposes, unless the law requires otherwise. Organization Data is kept until the Organization deletes the Event or the Organization; deleted data is removed from live systems promptly and from backups within 90 days. Payment and audit records are kept as long as the law requires.
      </p>

      <h2>8. Security</h2>
      <p>
        We use encryption in transit (HTTPS), encryption of payment credentials and API secrets at rest, hashed passwords and session tokens, role-based access, isolation between Organizations, rate limiting, bot protection and audit logs. No system is perfectly secure; if a breach affects your personal data we will notify the NDPC within 72 hours where required and tell affected people without undue delay where there is a high risk to them.
      </p>

      <h2>9. Your rights</h2>
      <p>
        Subject to the law, you can ask to access your data, get a copy in a portable format, correct it, erase it, restrict or object to processing, withdraw consent, and not be subject to decisions based solely on automated processing that significantly affect you. Contact <Contact l={l} privacy />. We will respond within the time the law allows (usually 30 days) and may need to verify your identity. You may also complain to the Nigeria Data Protection Commission (ndpc.gov.ng) or your local data-protection authority.
      </p>

      <h2>10. Cookies</h2>
      <p>
        We use only cookies needed for the Service to work: a secure session cookie when you sign in, and on public voting pages a device cookie used to enforce voting limits and prevent fraud. We do not use third-party advertising or analytics cookies. Blocking cookies may stop sign-in or voting from working.
      </p>

      <h2>11. Children</h2>
      <p>
        The Service is not directed at children. Accounts require users to be at least {l.minimumAge}. Where an Organization runs an Event for under-18s (for example a school), the Organization is responsible for obtaining any consent required from parents or guardians and for collecting only the minimum data needed.
      </p>

      <h2>12. Changes</h2>
      <p>We may update this policy. Material changes will be highlighted and, where required, you will be asked to accept them before you continue.</p>

      <h2>13. Contact</h2>
      <p>
        <Who l={l} />. Privacy questions and requests: <Contact l={l} privacy />.
      </p>
    </LegalLayout>
  );
}

export function LegalFooter() {
  return (
    <footer className="legal-footer">
      <Link href="/terms">Terms of Service</Link>
      <Link href="/privacy">Privacy Policy</Link>
    </footer>
  );
}

/** Notice placed next to the submit button on voting and payment forms. */
export function VoterNotice({ paid }: { paid?: boolean }) {
  return (
    <p className="voter-notice">
      By continuing you agree to the{" "}
      <a href="/terms" target="_blank" rel="noreferrer">
        Terms of Service
      </a>{" "}
      and{" "}
      <a href="/privacy" target="_blank" rel="noreferrer">
        Privacy Policy
      </a>
      .{paid ? " Paid votes go to the organizer and are final; refunds are handled by the organizer." : ""}
    </p>
  );
}

/** Checkbox used on sign-up, organization creation and paid checkout. */
export function AgreeBox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode }) {
  return (
    <label className="agree-box">
      <input type="checkbox" required checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {children ?? (
          <>
            I have read and agree to the{" "}
            <a href="/terms" target="_blank" rel="noreferrer">
              Terms of Service
            </a>{" "}
            and{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </>
        )}
      </span>
    </label>
  );
}

/** Full-screen gate shown to signed-in users who haven't accepted the current version. */
export function TermsGate() {
  const me = useMe();
  const cfg = useConfig();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const legal = cfg.data?.legal;
  return (
    <div className="center-page">
      <div className="panel narrow terms-gate">
        <ShieldCheck size={36} className="accent-icon" />
        <h2>{me.data?.user?.termsAcceptedAt ? "We've updated our terms" : "Please review our terms"}</h2>
        <p className="muted">
          To keep using {cfg.data?.appName ?? "the platform"}, please read and accept the current Terms of Service and Privacy Policy{legal ? ` (version ${legal.termsVersion})` : ""}.
        </p>
        <div className="btn-row">
          <a className="btn btn-outline" href="/terms" target="_blank" rel="noreferrer">
            <FileText size={15} /> Terms of Service
          </a>
          <a className="btn btn-outline" href="/privacy" target="_blank" rel="noreferrer">
            <FileText size={15} /> Privacy Policy
          </a>
        </div>
        {error && <div className="inline-error">{error}</div>}
        <AgreeBox checked={agree} onChange={setAgree} />
        <Button
          disabled={!agree || !legal}
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await post("/auth/accept-terms", { version: legal!.termsVersion });
              await queryClient.invalidateQueries({ queryKey: ["me"] });
            } catch (err) {
              setError((err as Error).message);
              void cfg.refetch();
            } finally {
              setBusy(false);
            }
          }}
        >
          Accept and continue
        </Button>
        <button
          type="button"
          className="text-link center"
          onClick={async () => {
            await post("/auth/logout").catch(() => undefined);
            location.href = "/";
          }}
        >
          Sign out instead
        </button>
      </div>
    </div>
  );
}
