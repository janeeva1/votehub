# VoteHub — voting platform (SaaS)

One app, one command. Organizations sign up, create **elections, polls, contests, awards, AGMs or ranked-choice votes**, and configure every rule — including **paid voting** through **Paystack**.

---

## Run it (Windows, Mac or Linux)

You need **Node.js 20+** (https://nodejs.org) and **PostgreSQL 13+** running on your computer (https://www.postgresql.org/download/windows/).

1. Open the `.env` file and replace `YOUR_PASSWORD` in `DATABASE_URL` with your PostgreSQL password:
   ```
   DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/votehub
   ```
   The `votehub` database and all tables are created automatically on first start.
2. Run:
   ```bash
   npm install
   npm run dev
   ```
3. Open **http://localhost:3000** and click **Start free**. The **first account you create becomes the platform super-admin**.

On Windows you can also just double-click **`start-windows.bat`**.

If it can't start, the window tells you why (PostgreSQL service not running, wrong password, …). To start over with empty data, drop the database: `psql -U postgres -c "DROP DATABASE votehub;"`.

### Production

```bash
npm install
npm run build
npm start          # serves the site + API on PORT (default 3000)
```

Set `DATABASE_URL`, `APP_SECRET` and `PUBLIC_URL` (see `.env.example`). Any PostgreSQL works (local, Neon, Supabase, Render…); tables are created automatically on start. A `Dockerfile` is included.

Check it works on a fresh database: `node scripts/smoke-test.mjs http://localhost:3000` (41 checks: elections, ranked choice, free + paid votes, roles, security) `node scripts/selfserve-test.mjs http://localhost:3000` (21 checks: sign-up, limits, payments, plan switching with credit, deletion) `node scripts/feature-test.mjs http://localhost:3000` (45 checks: STV, Borda, score, cumulative, write-ins, thresholds, quorum, groups, proxies, passwords, QR, embeds, API keys, event passes), `node scripts/billing-test.mjs` (40 checks: payment methods, manual transfers, automatic renewal, pause/resume, declined cards) and `node scripts/platform-test.mjs` (33 checks: terms acceptance, ads, isolation between organizations). Each expects a fresh, empty database.

---

## What organizers can configure (per event)

| Setting | Options |
|---|---|
| **Templates** | Secret-ballot election · Paid voting contest · Awards & nominations · Quick poll · AGM / weighted resolutions · Ranked choice · Multi-seat board (STV) · Budget / priorities (points) · Find a meeting time · Blank |
| **7 counting methods** | First past the post · approval / multi-seat · instant runoff · **single transferable vote** (proportional, several seats) · **Borda count** · **score voting** (rate 0–N) · **cumulative voting** (share out N points) |
| **Who can vote** | Voter list with private one-time codes · anyone with a verified email · anyone with the link · optional shared **page password** |
| **Ballot rules** | Secret or recorded · weighted votes · **proxies** · **voter groups** (branch/chapter-only questions) · **write-in candidates** · abstain · **comments** · receipts |
| **Results rules** | **Quorum** (minimum turnout) · **majority / two-thirds thresholds** per question · live / after close / when published · show or hide counts & percentages |
| **Free & paid votes** | Free votes per category (once or daily) · paid votes through Paystack (price per vote, min/max, bundles, currency) |
| **Reaching voters** | Email invitations · **SMS** (Termii) · one-tap **WhatsApp** links · **automatic reminders** N hours before closing · manual "remind non-voters" |
| **Sharing** | QR code (download for posters) · WhatsApp / X / Facebook share · **embed widget** for your website · **presenter screen** for live meetings |
| **Protection** | Bot trap · rate limits · one-vote enforcement in database transactions · audit log |

## How the SaaS runs (who does what)

**Organizations run themselves.** A club, school, union or company:
1. signs up and creates its organization (starts on **Free** — or picks a plan on the pricing page and goes straight to checkout),
2. upgrades or switches plan in **Plan & billing** — monthly or yearly (2 months free), charged through the platform's Paystack. Paying by card turns on **automatic renewal**; the organization can **pause** it any time (nothing is charged while paused), resume, switch monthly/yearly, or remove the card. Declined renewals are retried daily up to 3 times, with emails,
3. invites its own team, turns on whatever payment methods it wants for paid voting (or none — free events need nothing), sets branding, runs its events,
4. can delete its organization and all data from **Organization settings**.

Limits are enforced automatically from the plan they paid for: live events, voters per event, ballots, team members, paid-vote fee, SMS, API, branding. Renewing adds time; switching plans converts unused days into credit on the new plan; if a paid plan isn't renewed it falls back to Free automatically (nothing is deleted). Owners get reminder emails 3 days before and when a plan ends. Each organization's users, events, voters, payments, files and API keys are isolated from every other organization (covered by `scripts/platform-test.mjs`).

**The platform owner runs the platform.** The first account created is the super-admin and needs no organization. The **Super admin** console shows a readiness checklist (Paystack keys, email, SMS, HTTPS), revenue (MRR), renewals to watch and newest sign-ups, and lets you set plans, prices, limits, event passes, the platform Paystack key and sign-up policy. **Ads** tab: create sponsored cards (image, text, link, placement on voting pages and/or dashboards, plan targeting, schedule, weight) shown only on plans with “Show ads” on (Free by default) — with impression and click counts. **Legal** tab: your company details for the Terms and Privacy Policy, and “Publish new version”, which makes every user accept again. Organization controls there (complimentary upgrades, extensions, suspension) are for support only — you never have to set organizations up.

## Pricing (defaults — the super-admin can change everything)

| Plan | Price | Highlights |
|---|---|---|
| Free | ₦0 | 2 live events, 2 team members, 50 voters per election, 500 poll votes, all 7 methods, paid voting at 10% fee, no ads |
| Starter | ₦7,500 / month (₦75,000 / year) | 5 live events, 5 team members, 1,000 voters, SMS invites & reminders, proxies & groups, 6% fee |
| Pro | ₦25,000 / month (₦250,000 / year) | Unlimited events, 20 team members, 10,000 voters, your branding only, API & webhooks, 3.5% fee |
| Business | ₦75,000 / month (₦750,000 / year) | Unlimited team, 100,000 voters, 2% fee, priority support |

**Event passes** (one event, no subscription): 350 voters ₦9,900 · 1,000 voters ₦24,900 · 5,000 voters ₦79,900 · 20,000 voters ₦199,900. Bought from the event's Overview page.

## Developer API & webhooks (Pro and above)

Create keys in **Organization settings → Developers**. Send `Authorization: Bearer vh_live_…`.

- `GET /api/v1/events` · `GET /api/v1/events/:id/results` · `GET /api/v1/events/:id/turnout`
- `GET /api/v1/events/:id/voters` · `POST /api/v1/events/:id/voters` (`{ "voters": [{ "name", "email", "phone", "ref", "group", "weight" }] }` → returns access codes)

Outgoing webhooks (`ballot.cast`, `vote.cast`, `payment.succeeded`, `event.status_changed`) are signed with `X-VoteHub-Signature: sha256=<HMAC of body>`. Voter choices are never sent.

## SaaS features

- Self-serve sign-up, organizations (multi-tenant), switch between several organizations
- Team roles: Owner, Admin, Election officer, Viewer — with email invitations
- Plans and event passes with limits — fully editable by the super-admin
- Each organization can connect **its own** Paystack account (keys encrypted at rest); otherwise payments go through the platform's account and the platform fee is recorded for settlement
- **Super admin** console: organizations (plan, expiry, suspend), users, plans & passes, platform payment keys, all payments and revenue
- Activity/audit log · CSV exports (results with thresholds & quorum, voter list with codes, links and proxy status)
- Password reset, invitations and email verification over SMTP (printed to the console if SMTP isn't configured)

## Payment methods

**Subscriptions** (plans and event passes) are always collected by the platform's own Paystack account — set it in **Super admin → Plans & settings** or with `PAYSTACK_SECRET_KEY` in `.env`.

**Paid voting** is optional and per organization. In **Organization settings → Payment methods** each organization turns on any mix of:

- **Paystack, Flutterwave, Stripe, Monnify, OPay** — paste that gateway's keys (secrets are encrypted and never shown again) and add the webhook URL shown in the app to the gateway's dashboard. Money goes straight to the organization's account. If it connects nothing, Paystack through the platform's account is still offered (settled to the organization minus the platform fee).
- **Manual methods** (up to 6) — bank transfer, OPay/PalmPay transfer, POS, cash… with your own instructions. Voters see the instructions, pay, and tap “I've paid”; the team gets an email and approves or rejects it on the event's **Votes & payments** tab, and votes are added on approval.
- **Test mode** — simulated checkout (automatic in development; `ALLOW_TEST_PAYMENTS=true` in production).

Each event then ticks which of those methods to offer, and voters pick one at checkout. To add another gateway later, add it to `GATEWAYS`/`GATEWAY_INFO` in `shared/model.ts` and implement it in `server/payments/providers.ts`.

## Look and feel

**Super admin → Appearance** switches the colours of the whole platform: landing page, dashboards and every voting page. Choose from six themes (Violet ink — the default purple with marigold orange — Marigold, Lagoon, Teal & coral, Crimson, Forest) or pick your own main, accent, dark and background colours. Clicking a theme previews it immediately; it goes live for everyone when you save. On the same tab you can change the landing-page headline, upload a hero background photo and up to six event photos for the photo strip. Organizations can still give their own voting pages their own colour.

The product screenshots on the landing page live in `web/public/landing/<theme>/` and are taken from the real app. To regenerate them after design changes, start the app on an empty database and run `node scripts/landing-shots.mjs http://localhost:3000` (needs `npm i -D playwright`).

## Terms, privacy and consent

`/terms` and `/privacy` hold a strong Terms of Service (organizer responsibility, processor/controller split and data-processing terms, auto-renewal, non-refundable paid votes, acceptable use, disclaimers, liability cap, indemnity, arbitration under the Arbitration and Mediation Act 2023) and an NDPA 2023 Privacy Policy. Everyone must tick acceptance to sign up; whoever creates an organization confirms authority and accepts on its behalf; buying votes needs a ticked box; voting forms show a notice. Acceptance (version, time, IP, browser) is logged, and after you publish a new version nobody can change anything until they accept it. **These are templates, not legal advice — have a Nigerian lawyer review them and fill in your company details in Super admin → Legal before launch.**

`PUBLIC_URL` must be the address payers return to (e.g. `https://vote.yourdomain.com`). Note: Paystack can't send webhooks to `localhost`; locally, payments are confirmed when the payer returns to the site (or with *Re-check* on the payments tab). Webhooks start working once the site is online.

## Project layout

```
server/     Express API (auth, orgs, events, voting, payments, admin) + serves the web app
shared/     Voting model shared by server and web (settings schema, templates, plans)
web/        React app (landing, dashboard, event builder, public voting pages)
scripts/    build-server.mjs, smoke-test.mjs
```

### Old files you can delete

The previous Replit monorepo is fully replaced. These are no longer used and can be deleted:
`artifacts/`, `lib/`, `scripts/src/`, `scripts/package.json`, `scripts/tsconfig.json`, `scripts/tsconfig.tsbuildinfo`, `scripts/post-merge.sh`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `.npmrc`, `.replitignore`, `.agents/`.

## Security notes

Passwords are hashed with scrypt; sessions are HTTP-only cookies; state-changing requests require JSON/a custom header (CSRF protection); rate limits on sign-in, codes and voting; security headers via Helmet; payment-provider secrets are encrypted with AES-256-GCM; webhooks are signature-verified; one-vote rules are enforced in database transactions.

This platform is designed for private organizations, competitions and events. It is **not certified for public or government elections**. Secret ballots are stored without a link to the voter (privacy from other users and admins), which is not the same as cryptographic end-to-end verifiability. Public "anyone with the link" voting limits are per browser and per network, so use the voter-list or verified-email modes when one-person-one-vote really matters.
