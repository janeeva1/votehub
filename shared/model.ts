/**
 * Shared voting model: used by the server for validation and by the web app for forms.
 * Everything an organizer can configure about an event lives in EventSettings.
 */
import { z } from "zod";

export const CURRENCIES = ["NGN", "GHS", "KES", "ZAR", "UGX", "RWF", "XOF", "USD", "EUR", "GBP", "CAD"] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Online payment gateways an organization can connect for paid voting. Add new gateways here + in server/payments/providers.ts. */
export const GATEWAYS = ["paystack", "flutterwave", "stripe", "monnify", "opay"] as const;
export type GatewayId = (typeof GATEWAYS)[number];
export const PROVIDERS = [...GATEWAYS, "manual", "test"] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  paystack: "Paystack",
  flutterwave: "Flutterwave",
  stripe: "Stripe",
  monnify: "Monnify",
  opay: "OPay",
  manual: "Manual payment (confirmed by organizer)",
  test: "Test mode (simulated payments)",
};

export interface GatewayField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
}
export interface GatewayInfo {
  name: string;
  tagline: string;
  fields: GatewayField[];
  /** Field that must be present for the gateway to work. */
  requiredSecret: string;
  webhookHelp: string;
}
const MODE_FIELD: GatewayField = { key: "mode", label: "Mode", options: [{ value: "live", label: "Live" }, { value: "sandbox", label: "Sandbox / test" }] };
export const GATEWAY_INFO: Record<GatewayId, GatewayInfo> = {
  paystack: {
    name: "Paystack",
    tagline: "Cards, bank transfer, USSD — Nigeria, Ghana, Kenya, South Africa.",
    fields: [
      { key: "secretKey", label: "Secret key", secret: true, required: true, placeholder: "sk_live_… or sk_test_…" },
      { key: "publicKey", label: "Public key (optional)", placeholder: "pk_live_…" },
    ],
    requiredSecret: "secretKey",
    webhookHelp: "Paystack dashboard → Settings → API Keys & Webhooks → Webhook URL.",
  },
  flutterwave: {
    name: "Flutterwave",
    tagline: "Pan-African cards, transfers and mobile money.",
    fields: [
      { key: "secretKey", label: "Secret key (v3)", secret: true, required: true, placeholder: "FLWSECK-…" },
      { key: "webhookSecret", label: "Webhook secret hash", secret: true },
    ],
    requiredSecret: "secretKey",
    webhookHelp: "Flutterwave dashboard → Settings → Webhooks. Use the same secret hash as above.",
  },
  stripe: {
    name: "Stripe",
    tagline: "International cards, Apple Pay and Google Pay.",
    fields: [
      { key: "secretKey", label: "Secret key", secret: true, required: true, placeholder: "sk_live_…" },
      { key: "webhookSecret", label: "Webhook signing secret", secret: true, placeholder: "whsec_…" },
    ],
    requiredSecret: "secretKey",
    webhookHelp: "Stripe dashboard → Developers → Webhooks → add endpoint for checkout.session.completed.",
  },
  monnify: {
    name: "Monnify",
    tagline: "Moniepoint's gateway — cards, bank transfer and USSD in Nigeria.",
    fields: [
      { key: "apiKey", label: "API key", required: true, placeholder: "MK_PROD_…" },
      { key: "secretKey", label: "Secret key", secret: true, required: true },
      { key: "contractCode", label: "Contract code", required: true },
      MODE_FIELD,
    ],
    requiredSecret: "secretKey",
    webhookHelp: "Monnify dashboard → Developer → Webhook URLs → Transaction completion.",
  },
  opay: {
    name: "OPay",
    tagline: "OPay checkout — OPay wallet, cards, bank transfer and USSD.",
    fields: [
      { key: "merchantId", label: "Merchant ID", required: true },
      { key: "publicKey", label: "Public key", required: true },
      { key: "secretKey", label: "Secret key", secret: true, required: true },
      MODE_FIELD,
    ],
    requiredSecret: "secretKey",
    webhookHelp: "Sent automatically as the callback URL with each payment.",
  },
};

/** A manual method: voter pays outside the platform (bank transfer, OPay/PalmPay transfer, POS, cash…) and the organizer confirms. */
export interface ManualMethod {
  id: string;
  label: string;
  instructions: string;
  enabled: boolean;
}
/** A payment option offered on an event: a gateway id, "manual:<id>" or "test". */
export type MethodRef = string;

export const ROLES = ["owner", "admin", "officer", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  officer: "Election officer",
  viewer: "Viewer (read-only)",
};

export const EVENT_STATUSES = ["draft", "live", "paused", "closed", "archived"] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const METHODS = ["single", "multiple", "ranked", "stv", "borda", "score", "cumulative"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABELS: Record<Method, string> = {
  single: "Choose one (first past the post)",
  multiple: "Choose several (approval / multi-seat)",
  ranked: "Rank in order — instant runoff (1 winner)",
  stv: "Rank in order — single transferable vote (several seats)",
  borda: "Rank in order — Borda count (points by rank)",
  score: "Rate each option (score voting)",
  cumulative: "Share out points (cumulative voting)",
};
export const METHOD_HELP: Record<Method, string> = {
  single: "Voters pick one. Most votes wins.",
  multiple: "Voters pick up to N. The N options with the most votes win.",
  ranked: "Voters rank options. Lowest is eliminated each round until someone has a majority.",
  stv: "Proportional multi-seat election using the Droop quota with surplus transfers.",
  borda: "Ranked ballots; 1st place earns the most points. Rewards broadly-liked options.",
  score: "Voters rate every option (e.g. 0–5). Highest total wins.",
  cumulative: "Voters distribute a budget of points (e.g. 10) across options.",
};
/** Methods whose ballots are an ordered list of option ids. */
export const RANKED_METHODS = new Set<Method>(["ranked", "stv", "borda"]);
/** Methods whose ballots are a map of option id -> number. */
export const VALUE_METHODS = new Set<Method>(["score", "cumulative"]);

const fieldMode = z.enum(["off", "optional", "required"]);

export const eventSettingsSchema = z.object({
  /**
   * ballot: each voter submits one full ballot (elections, polls, AGMs, surveys).
   * tally:  voters cast votes for individual entries, optionally many times and/or paid (contests, awards, pageants).
   */
  mode: z.enum(["ballot", "tally"]).default("ballot"),
  /**
   * roster: only people on the voter list, using their access code.
   * email:  anyone, after confirming their email with a one-time code.
   * public: anyone (limits are enforced per browser + email if collected).
   */
  access: z.enum(["roster", "email", "public"]).default("roster"),
  collect: z
    .object({ name: fieldMode.default("optional"), email: fieldMode.default("optional"), phone: fieldMode.default("off") })
    .default({}),
  freeVotes: z
    .object({
      enabled: z.boolean().default(true),
      perVoter: z.number().int().min(1).max(1000).default(1),
      period: z.enum(["total", "daily"]).default("total"),
    })
    .default({}),
  paid: z
    .object({
      enabled: z.boolean().default(false),
      /** Legacy single gateway (used when `methods` is empty). */
      provider: z.enum(PROVIDERS).default("paystack"),
      /** Payment options offered to voters, e.g. ["paystack", "opay", "manual:bank"]. Empty = all methods the organization has enabled. */
      methods: z.array(z.string().max(60)).max(12).default([]),
      currency: z.enum(CURRENCIES).default("NGN"),
      /** Price of one vote in major units (e.g. 50 = ₦50.00). */
      pricePerVote: z.number().min(0).max(10_000_000).default(50),
      minVotes: z.number().int().min(1).default(1),
      maxVotes: z.number().int().min(1).max(1_000_000).default(10_000),
      /** Optional fixed bundles, e.g. [{votes: 10, price: 450}] — shown as quick picks. */
      bundles: z.array(z.object({ votes: z.number().int().min(1), price: z.number().min(0) })).max(8).default([]),
    })
    .default({}),
  results: z
    .object({
      visibility: z.enum(["live", "after_close", "manual"]).default("after_close"),
      showCounts: z.boolean().default(true),
      showPercent: z.boolean().default(true),
    })
    .default({}),
  ballot: z
    .object({
      /** Secret: ballots are stored without any link to the voter. */
      secret: z.boolean().default(true),
      /** Weighted voting, e.g. shares or delegate votes (roster only). */
      weighted: z.boolean().default(false),
      receipts: z.boolean().default(true),
      allowAbstain: z.boolean().default(true),
      /** Let voters leave a comment with their ballot. */
      allowComments: z.boolean().default(false),
      /** Minimum turnout (percent of the voter list / weight) for the result to be valid. 0 = no quorum. */
      quorumPercent: z.number().min(0).max(100).default(0),
    })
    .default({}),
  reminders: z
    .object({
      /** Automatically remind voters who haven't voted this many hours before closing (0 = off). */
      hoursBeforeClose: z.number().int().min(0).max(720).default(0),
      sms: z.boolean().default(false),
    })
    .default({}),
  security: z
    .object({
      /** Require a shared password before the voting page can be used (set via the password field). */
      passwordProtected: z.boolean().default(false),
      /** Hidden honeypot field + timing check to block simple bots. */
      botProtection: z.boolean().default(true),
    })
    .default({}),
  nominations: z
    .object({ enabled: z.boolean().default(false), requireApproval: z.boolean().default(true) })
    .default({}),
  display: z
    .object({
      showCodes: z.boolean().default(false),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      thankYouMessage: z.string().max(500).default("Thank you — your vote has been recorded."),
    })
    .default({}),
});
export type EventSettings = z.infer<typeof eventSettingsSchema>;
export const defaultSettings = (): EventSettings => eventSettingsSchema.parse({});

/** Deep-merge partial settings over a base and re-validate. */
export function mergeSettings(base: unknown, patch: unknown): EventSettings {
  const merge = (a: any, b: any): any => {
    if (Array.isArray(b)) return b;
    if (b && typeof b === "object") {
      const out: any = { ...(a && typeof a === "object" && !Array.isArray(a) ? a : {}) };
      for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
      return out;
    }
    return b === undefined ? a : b;
  };
  return eventSettingsSchema.parse(merge(base ?? {}, patch ?? {}));
}

export interface TemplateCategory {
  title: string;
  method?: Method;
  maxChoices?: number;
  points?: number;
  thresholdPercent?: number;
  options?: string[];
}
export interface EventTemplate {
  id: string;
  name: string;
  tagline: string;
  examples: string;
  settings: Partial<Record<keyof EventSettings, unknown>>;
  categories: TemplateCategory[];
}

export const TEMPLATES: EventTemplate[] = [
  {
    id: "election",
    name: "Secret-ballot election",
    tagline: "One ballot per eligible voter, private access codes, results after close.",
    examples: "Alumni executives, union officers, student government, club boards",
    settings: {
      mode: "ballot",
      access: "roster",
      collect: { name: "off", email: "off", phone: "off" },
      ballot: { secret: true, weighted: false, receipts: true, allowAbstain: true },
      results: { visibility: "after_close", showCounts: true, showPercent: true },
    },
    categories: [{ title: "President", method: "single" }, { title: "Secretary", method: "single" }],
  },
  {
    id: "contest",
    name: "Paid voting contest",
    tagline: "Public votes bought per vote via Paystack. Live leaderboard.",
    examples: "Pageants, talent shows, campus personalities, fan votes",
    settings: {
      mode: "tally",
      access: "public",
      collect: { name: "optional", email: "required", phone: "optional" },
      freeVotes: { enabled: false, perVoter: 1, period: "total" },
      paid: { enabled: true, provider: "paystack", currency: "NGN", pricePerVote: 50, minVotes: 1, maxVotes: 10000, bundles: [] },
      results: { visibility: "live", showCounts: true, showPercent: true },
      display: { showCodes: true },
    },
    categories: [{ title: "Contestants" }],
  },
  {
    id: "awards",
    name: "Awards & nominations",
    tagline: "Many categories, free daily votes, optional paid boosts and public nominations.",
    examples: "Industry awards, school awards, community honours",
    settings: {
      mode: "tally",
      access: "email",
      collect: { name: "optional", email: "required", phone: "off" },
      freeVotes: { enabled: true, perVoter: 1, period: "daily" },
      paid: { enabled: false },
      nominations: { enabled: true, requireApproval: true },
      results: { visibility: "manual", showCounts: true, showPercent: true },
    },
    categories: [{ title: "Best Newcomer" }, { title: "Leader of the Year" }],
  },
  {
    id: "poll",
    name: "Quick public poll",
    tagline: "Anyone with the link answers once. Live results.",
    examples: "Opinion polls, event feedback, team decisions",
    settings: {
      mode: "ballot",
      access: "public",
      collect: { name: "off", email: "off", phone: "off" },
      ballot: { secret: true, weighted: false, receipts: false, allowAbstain: false },
      results: { visibility: "live", showCounts: true, showPercent: true },
    },
    categories: [{ title: "Your question here", method: "single", options: ["Option A", "Option B", "Option C"] }],
  },
  {
    id: "agm",
    name: "AGM / weighted resolutions",
    tagline: "Members or shareholders vote For / Against / Abstain with weighted votes.",
    examples: "Cooperative AGMs, shareholder meetings, delegate conferences",
    settings: {
      mode: "ballot",
      access: "roster",
      collect: { name: "off", email: "off", phone: "off" },
      ballot: { secret: false, weighted: true, receipts: true, allowAbstain: false },
      results: { visibility: "after_close", showCounts: true, showPercent: true },
    },
    categories: [
      { title: "Resolution 1: Approve the audited accounts", method: "single", thresholdPercent: 50, options: ["For", "Against", "Abstain"] },
      { title: "Special resolution: Amend the constitution (two-thirds)", method: "single", thresholdPercent: 66.67, options: ["For", "Against", "Abstain"] },
    ],
  },
  {
    id: "ranked",
    name: "Ranked-choice vote",
    tagline: "Voters rank candidates; winner decided by instant runoff.",
    examples: "Committee picks, preferential elections, product priorities",
    settings: {
      mode: "ballot",
      access: "roster",
      collect: { name: "off", email: "off", phone: "off" },
      ballot: { secret: true, weighted: false, receipts: true, allowAbstain: true },
      results: { visibility: "after_close", showCounts: true, showPercent: true },
    },
    categories: [{ title: "Chairperson", method: "ranked" }],
  },
  {
    id: "board",
    name: "Multi-seat board (STV)",
    tagline: "Fill several seats proportionally with single transferable vote.",
    examples: "Boards of trustees, councils, committees with 3–9 seats",
    settings: {
      mode: "ballot",
      access: "roster",
      collect: { name: "off", email: "off", phone: "off" },
      ballot: { secret: true, weighted: false, receipts: true, allowAbstain: true, quorumPercent: 0 },
      results: { visibility: "after_close", showCounts: true, showPercent: true },
    },
    categories: [{ title: "Board of Trustees (3 seats)", method: "stv", maxChoices: 3 }],
  },
  {
    id: "budget",
    name: "Budget / priorities (points)",
    tagline: "Members share out points across projects or rate each idea.",
    examples: "Participatory budgets, product roadmaps, project selection",
    settings: {
      mode: "ballot",
      access: "email",
      collect: { name: "off", email: "off", phone: "off" },
      ballot: { secret: true, weighted: false, receipts: false, allowAbstain: true, allowComments: true },
      results: { visibility: "after_close", showCounts: true, showPercent: true },
    },
    categories: [
      { title: "Share 10 points across these projects", method: "cumulative", points: 10, options: ["New library", "Scholarship fund", "Sports facilities"] },
      { title: "Rate each idea from 0 to 5", method: "score", points: 5, options: ["Monthly meetups", "Mentorship programme", "Online newsletter"] },
    ],
  },
  {
    id: "meeting",
    name: "Find a meeting time",
    tagline: "Everyone ticks every slot that works; the most popular time wins.",
    examples: "Scheduling meetings, reunions, events",
    settings: {
      mode: "ballot",
      access: "public",
      collect: { name: "required", email: "off", phone: "off" },
      ballot: { secret: false, weighted: false, receipts: false, allowAbstain: false, allowComments: true },
      results: { visibility: "live", showCounts: true, showPercent: false },
    },
    categories: [{ title: "Which times work for you?", method: "multiple", maxChoices: 10, options: ["Sat 10:00", "Sat 14:00", "Sun 16:00"] }],
  },
  {
    id: "custom",
    name: "Start from scratch",
    tagline: "Blank event — configure everything yourself.",
    examples: "Anything else",
    settings: {},
    categories: [],
  },
];

export interface Plan {
  id: string;
  name: string;
  /** Monthly price in the platform currency (major units). 0 = free. */
  price: number;
  /** null = unlimited */
  maxLiveEvents: number | null;
  maxVotersPerEvent: number | null;
  maxBallotsPerEvent: number | null;
  paidVoting: boolean;
  removeBranding: boolean;
  /** Percentage the platform keeps from paid votes (reported, used for settlement). */
  platformFeePercent: number;
  /** SMS invitations & reminders (sent through the platform's SMS gateway). */
  sms: boolean;
  /** REST API keys and outgoing webhooks. */
  api: boolean;
  /** Team members (owners, admins, officers, viewers) incl. pending invitations. null = unlimited. */
  maxTeamMembers: number | null;
  /** Show platform ads on this plan's dashboards and voting pages (the Free plan is ad-supported). */
  showAds: boolean;
  features: string[];
}

export const AD_PLACEMENTS = ["voting_page", "dashboard"] as const;
export type AdPlacement = (typeof AD_PLACEMENTS)[number];
export const AD_PLACEMENT_LABELS: Record<AdPlacement, string> = { voting_page: "Public voting pages", dashboard: "Organizer dashboards" };

/** Paying yearly costs this many months (e.g. 10 = two months free). */
export const ANNUAL_MONTHS_CHARGED = 10;
export const PERIOD_DAYS = 30;

/** One-off upgrade for a single event — for organizations that vote once a year. */
export interface EventPass {
  id: string;
  name: string;
  voters: number;
  price: number;
}
export const DEFAULT_PASSES: EventPass[] = [
  { id: "pass-350", name: "Up to 350 voters", voters: 350, price: 9900 },
  { id: "pass-1000", name: "Up to 1,000 voters", voters: 1000, price: 24900 },
  { id: "pass-5000", name: "Up to 5,000 voters", voters: 5000, price: 79900 },
  { id: "pass-20000", name: "Up to 20,000 voters", voters: 20000, price: 199900 },
];
/** Fee on paid votes for events upgraded with a pass (when the plan itself has a higher fee). */
export const PASS_FEE_PERCENT = 5;

export const DEFAULT_PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    maxLiveEvents: 2,
    maxVotersPerEvent: 50,
    maxBallotsPerEvent: 500,
    paidVoting: true,
    removeBranding: false,
    platformFeePercent: 10,
    sms: false,
    api: false,
    maxTeamMembers: 2,
    showAds: true,
    features: [
      "2 live events, 2 team members (ad-supported)",
      "50 voters per election · 500 poll votes",
      "All 7 voting methods, quorum & thresholds",
      "Paid voting via Paystack (10% fee)",
      "Results kept forever",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    price: 7500,
    maxLiveEvents: 5,
    maxVotersPerEvent: 1000,
    maxBallotsPerEvent: null,
    paidVoting: true,
    removeBranding: false,
    platformFeePercent: 6,
    sms: true,
    api: false,
    maxTeamMembers: 5,
    showAds: false,
    features: ["5 live events, 5 team members, no ads", "1,000 voters per event, unlimited poll votes", "SMS + email invites and reminders", "Proxy voting, voter groups", "Paid voting (6% fee)"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 25000,
    maxLiveEvents: null,
    maxVotersPerEvent: 10000,
    maxBallotsPerEvent: null,
    paidVoting: true,
    removeBranding: true,
    platformFeePercent: 3.5,
    sms: true,
    api: true,
    maxTeamMembers: 20,
    showAds: false,
    features: ["Unlimited live events, 20 team members", "10,000 voters per event", "Your branding only (no platform logo)", "API keys & webhooks", "Paid voting (3.5% fee)"],
  },
  {
    id: "business",
    name: "Business",
    price: 75000,
    maxLiveEvents: null,
    maxVotersPerEvent: 100000,
    maxBallotsPerEvent: null,
    paidVoting: true,
    removeBranding: true,
    platformFeePercent: 2,
    sms: true,
    api: true,
    maxTeamMembers: null,
    showAds: false,
    features: ["Everything in Pro, unlimited team", "100,000 voters per event", "Paid voting (2% fee)", "Priority support"],
  },
];

export const ZERO_DECIMAL = new Set<string>(["UGX", "RWF", "XOF"]);
export const toMinor = (amount: number, currency: string) =>
  Math.round(amount * (ZERO_DECIMAL.has(currency) ? 1 : 100));
export const fromMinor = (minor: number, currency: string) => minor / (ZERO_DECIMAL.has(currency) ? 1 : 100);
export function formatMoney(amountMajor: number, currency: string) {
  try {
    const whole = ZERO_DECIMAL.has(currency) || Number.isInteger(amountMajor);
    return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amountMajor);
  } catch {
    return `${currency} ${amountMajor.toFixed(2)}`;
  }
}
