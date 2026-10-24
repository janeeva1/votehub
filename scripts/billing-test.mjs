// Payment methods per organization (gateways + manual transfer) and automatic subscription renewal with pause/resume.
// Usage on a FRESH database (development mode, test payments allowed): node scripts/billing-test.mjs http://localhost:3000
const BASE = process.argv[2] ?? "http://localhost:3000";
let failures = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 300)}` : ""}`);
  if (!cond) failures++;
};
function client() {
  const jar = new Map();
  return async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      jar.set(k, v);
    }
    const t = await res.text();
    let data;
    try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  };
}
const days = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / 864e5);
const stamp = Date.now();
const terms = { acceptTerms: true };

const owner = client();
await owner("POST", "/api/auth/signup", { name: "Platform Owner", email: `po${stamp}@example.com`, password: "platform-pass-1", ...terms });
const cfg = (await owner("GET", "/api/admin/config")).data;
await owner("PUT", "/api/admin/config", { plans: cfg.plans, passes: cfg.passes, currency: cfg.currency, billingProvider: "test", allowSignups: true });

async function newOrg(email, name) {
  const c = client();
  await c("POST", "/api/auth/signup", { name: "Chair", email, password: "club-pass-123", ...terms });
  const r = await c("POST", "/api/orgs", { name, orgType: "Club or association", acceptTerms: true });
  return { c, H: { "X-Org-Id": r.data.id }, id: r.data.id };
}

// ---------- 1. No payments needed for a free election ----------
const club = await newOrg(`chair${stamp}@example.com`, "Ikoyi Rowing Club");
let r = await club.c("GET", "/api/org", undefined, club.H);
ok(Array.isArray(r.data.paymentMethods) && !r.data.paymentMethods.some((m) => m.kind !== "test"), "new organization has no payment methods (none required)");
r = await club.c("POST", "/api/org/events", { title: "Committee 2026", templateId: "election" }, club.H);
const el = r.data;
r = await club.c("PATCH", `/api/org/events/${el.id}`, { settings: { access: "public" } }, club.H);
for (const c of (await club.c("GET", `/api/org/events/${el.id}`, undefined, club.H)).data.categories) {
  for (const name of ["A", "B"]) await club.c("POST", `/api/org/events/${el.id}/options`, { categoryId: c.id, name }, club.H);
}
r = await club.c("POST", `/api/org/events/${el.id}/status`, { status: "live" }, club.H);
ok(r.status === 200, "free election goes live with no payment setup", r.data);

// ---------- 2. Organization adds its own mix of methods ----------
r = await club.c("PATCH", "/api/org", {
  paymentKeys: {
    monnify: { enabled: true, apiKey: "MK_TEST_ABC", secretKey: "monnify-secret", contractCode: "1234567", mode: "sandbox" },
    opay: { enabled: true, merchantId: "256000000000", publicKey: "OPAYPUB" }, // missing secret → not ready
    manual: [
      { label: "GTBank transfer", instructions: "Ikoyi Rowing Club\nGTBank 0123456789", enabled: true },
      { label: "Cash at the clubhouse", instructions: "Pay the treasurer", enabled: false },
    ],
  },
}, club.H);
ok(r.status === 200, "payment methods saved", r.data);
r = await club.c("GET", "/api/org", undefined, club.H);
const g = r.data.paymentKeys.gateways;
ok(g.monnify.ready && g.monnify.saved.secretKey && g.monnify.values.contractCode === "1234567" && !("secretKey" in g.monnify.values), "Monnify ready; secret stored encrypted, never returned");
ok(g.opay.enabled && !g.opay.ready, "OPay without its secret key isn't offered yet");
const ids = r.data.paymentMethods.map((m) => m.id);
const bankId = r.data.paymentMethods.find((m) => m.label === "GTBank transfer")?.id;
ok(ids.includes("monnify") && bankId && !ids.includes("opay") && !r.data.paymentMethods.some((m) => m.label.startsWith("Cash")), "offered: Monnify + bank transfer (disabled cash hidden)", ids);

// ---------- 3. Contest offering only the bank transfer ----------
r = await club.c("POST", "/api/org/events", { title: "Rower of the Year", templateId: "contest" }, club.H);
const ct = r.data;
r = await club.c("PATCH", `/api/org/events/${ct.id}`, { settings: { paid: { enabled: true, methods: ["flutterwave"] } } }, club.H);
ok(r.status === 400, "can't offer a method the organization hasn't set up");
r = await club.c("PATCH", `/api/org/events/${ct.id}`, { settings: { paid: { enabled: true, methods: [bankId], pricePerVote: 100 } } }, club.H);
ok(r.status === 200, "event offers bank transfer only", r.data);
const cat = (await club.c("GET", `/api/org/events/${ct.id}`, undefined, club.H)).data.categories[0];
await club.c("POST", `/api/org/events/${ct.id}/options`, { categoryId: cat.id, name: "Tolu" }, club.H);
const tolu = (await club.c("GET", `/api/org/events/${ct.id}`, undefined, club.H)).data.categories[0].options[0];
r = await club.c("POST", `/api/org/events/${ct.id}/status`, { status: "live" }, club.H);
ok(r.status === 200, "contest live");

const fan = client();
r = await fan("GET", `/api/public/events/${ct.slug}`);
ok(r.data.paymentMethods.length === 1 && r.data.paymentMethods[0].label === "GTBank transfer" && !("instructions" in r.data.paymentMethods[0]), "voting page lists only the chosen method", r.data.paymentMethods);
r = await fan("POST", `/api/public/events/${ct.slug}/checkout`, { optionId: tolu.id, quantity: 5, email: "fan@example.com", acceptTerms: true, method: "monnify" });
ok(r.status === 400, "checkout refuses a method the event doesn't offer");
r = await fan("POST", `/api/public/events/${ct.slug}/checkout`, { optionId: tolu.id, quantity: 5, email: "fan@example.com", acceptTerms: true, method: bankId });
ok(r.status === 200 && r.data.redirectUrl.includes("/pay/manual"), "manual checkout → instructions page", r.data);
const ref1 = r.data.reference;
r = await fan("GET", `/api/public/payments/${ref1}/info`);
ok(r.data.instructions.includes("0123456789") && r.data.amount_minor === 50000 && !r.data.claimed, "instructions and amount shown (₦500)");
r = await fan("GET", `/api/public/payments/${ref1}`);
ok(r.data.status === "pending", "unconfirmed manual payment stays pending");
r = await fan("POST", `/api/public/payments/${ref1}/claim`, { senderName: "Ada Fan", note: "GTB ****4421" });
ok(r.status === 200, "voter submits 'I've paid'");
r = await club.c("GET", `/api/org/events/${ct.id}/payments`, undefined, club.H);
ok(r.data[0].claim?.senderName === "Ada Fan" && r.data[0].manual_label === "GTBank transfer", "organizer sees the claim");

// another organization can't approve it
const other = await newOrg(`other${stamp}@example.com`, "Other Club");
r = await other.c("POST", `/api/org/payments/${ref1}/approve`, undefined, other.H);
ok(r.status === 404, "another organization can't approve this payment");
r = await other.c("POST", `/api/org/payments/${ref1}/approve`, undefined, club.H);
ok(r.status === 403, "X-Org-Id spoofing is refused for non-members", r.status);

r = await club.c("POST", `/api/org/payments/${ref1}/approve`, undefined, club.H);
ok(r.status === 200 && r.data.status === "success", "organizer approves", r.data);
r = await club.c("POST", `/api/org/payments/${ref1}/approve`, undefined, club.H);
ok(r.status === 409, "can't approve twice");
r = await fan("GET", `/api/public/events/${ct.slug}`);
ok(r.data.results.categories[0].options[0].votes === 5, "5 paid votes counted after approval", r.data.results?.categories?.[0]);

r = await fan("POST", `/api/public/events/${ct.slug}/checkout`, { optionId: tolu.id, quantity: 3, email: "fan@example.com", acceptTerms: true, method: bankId });
const ref2 = r.data.reference;
r = await club.c("POST", `/api/org/payments/${ref2}/reject`, undefined, club.H);
ok(r.status === 200 && r.data.status === "failed", "organizer rejects an unpaid claim");
r = await fan("GET", `/api/public/events/${ct.slug}`);
ok(r.data.results.categories[0].options[0].votes === 5, "rejected payment adds no votes");

// ---------- 4. Subscription: automatic renewal, pause, resume ----------
r = await club.c("POST", "/api/org/billing/checkout", { planId: "starter", months: 1 }, club.H);
ok(r.status === 200 && r.data.redirectUrl, "first payment goes through checkout");
await club.c("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "success" });
r = await club.c("GET", "/api/org/billing", undefined, club.H);
ok(r.data.subscription?.autoRenew === true && r.data.subscription.card.last4 === "4081", "card saved → automatic renewal on", r.data.subscription);

const pastDue = new Date(Date.now() - 60_000).toISOString();
await owner("PATCH", `/api/admin/orgs/${club.id}`, { planExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
await owner("POST", "/api/admin/jobs/run");
r = await club.c("GET", "/api/org/billing", undefined, club.H);
ok(r.data.plan.id === "starter" && days(r.data.planExpiresAt) === 30, "renewal job charges the saved card when the period ends", { d: days(r.data.planExpiresAt), h: r.data.history.length });
ok(r.data.history.filter((h) => h.status === "success").length === 2, "renewal recorded in history");
await owner("POST", "/api/admin/jobs/run");
r = await club.c("GET", "/api/org/billing", undefined, club.H);
ok(r.data.history.length === 2, "nothing charged again before the next period");

r = await club.c("POST", "/api/org/billing/pause", undefined, club.H);
ok(r.status === 200 && r.data.status === "paused" && r.data.autoRenew === false, "owner pauses renewal");
await owner("PATCH", `/api/admin/orgs/${club.id}`, { planExpiresAt: pastDue });
await owner("POST", "/api/admin/jobs/run");
r = await club.c("GET", "/api/org/billing", undefined, club.H);
ok(r.data.history.length === 2 && r.data.plan.id === "free", "paused: no charge, plan falls back to Free limits", { h: r.data.history.length, plan: r.data.plan.id });

r = await club.c("POST", "/api/org/billing/resume", undefined, club.H);
ok(r.status === 200 && r.data.status === "active", "resume", r.data);
r = await club.c("GET", "/api/org/billing", undefined, club.H);
ok(r.data.plan.id === "starter" && days(r.data.planExpiresAt) === 30 && r.data.history.length === 3, "resuming after expiry charges right away and restores Starter", { d: days(r.data.planExpiresAt), plan: r.data.plan.id });

r = await club.c("POST", "/api/org/billing/checkout", { planId: "pro", months: 1 }, club.H);
ok(r.status === 200 && r.data.charged === true, "upgrade charges the saved card instantly (no redirect)", r.data);
r = await club.c("GET", "/api/org/billing", undefined, club.H);
ok(r.data.plan.id === "pro" && r.data.subscription.planId === "pro", "Pro active and renews as Pro");

r = await club.c("POST", "/api/org/billing/frequency", { months: 12 }, club.H);
ok(r.data.months === 12, "switch next renewal to yearly");
r = await club.c("DELETE", "/api/org/billing/card", undefined, club.H);
ok(r.data.card === null && r.data.autoRenew === false, "remove card turns off automatic renewal");
r = await club.c("POST", "/api/org/billing/resume", undefined, club.H);
ok(r.status === 409, "can't resume without a card");

// Declined card: 3 daily attempts, then past due
const failer = await newOrg(`failcard${stamp}@example.com`, "Declined Card FC");
r = await failer.c("POST", "/api/org/billing/checkout", { planId: "starter", months: 1 }, failer.H);
await failer.c("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "success" });
await owner("PATCH", `/api/admin/orgs/${failer.id}`, { planExpiresAt: pastDue });
await owner("POST", "/api/admin/jobs/run");
r = await failer.c("GET", "/api/org/billing", undefined, failer.H);
ok(r.data.subscription.failedAttempts === 1 && r.data.subscription.status === "active" && r.data.subscription.nextAttemptAt, "declined renewal → retry scheduled tomorrow", r.data.subscription);
await owner("POST", "/api/admin/jobs/run");
r = await failer.c("GET", "/api/org/billing", undefined, failer.H);
ok(r.data.subscription.failedAttempts === 1, "no retry before 24 hours");

// Members of an organization only see their own billing
r = await other.c("GET", "/api/org/billing", undefined, other.H);
ok(r.data.subscription === null && r.data.history.length === 0, "other organization sees none of this billing");

await owner("PUT", "/api/admin/config", { plans: cfg.plans, passes: cfg.passes, currency: cfg.currency, billingProvider: cfg.billingProvider, allowSignups: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll billing & payment-method checks passed");
process.exit(failures ? 1 : 0);
