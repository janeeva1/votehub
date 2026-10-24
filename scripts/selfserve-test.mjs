// Self-service SaaS flow: organizations sign up, hit plan limits, pay, switch plans and delete themselves —
// the platform admin never has to do anything for them.
// Usage on a FRESH database: node scripts/selfserve-test.mjs http://localhost:3000
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

// Platform owner: first account, needs no organization
const owner = client();
let r = await owner("POST", "/api/auth/signup", { name: "Platform Owner", email: `po${Date.now()}@example.com`, password: "platform-pass-1", acceptTerms: true });
ok(r.status === 201 && r.data.user.isPlatformAdmin && r.data.organizations.length === 0, "platform owner signs up without creating an organization");
r = await owner("GET", "/api/admin/overview");
ok(r.status === 200 && Array.isArray(r.data.checklist), "admin console works with no organization");
ok(r.data.checklist.find((c) => c.key === "billing")?.ok === false, "readiness checklist flags missing payment keys");

// A club signs up and runs itself on Free
const club = client();
await club("POST", "/api/auth/signup", { name: "Club Chair", email: `chair${Date.now()}@example.com`, password: "club-pass-123", acceptTerms: true });
r = await club("POST", "/api/orgs", { name: "Lekki Tennis Club", orgType: "Club or association", acceptTerms: true });
const H = { "X-Org-Id": r.data.id };
r = await club("GET", "/api/org/billing", undefined, H);
ok(r.data.plan.id === "free" && r.data.plan.maxTeamMembers === 2, "new organization starts on Free (2 team seats)");
ok(r.data.billingReady === false, "billing not ready until the platform adds payment keys");
r = await club("POST", "/api/org/billing/checkout", { planId: "starter" }, H);
ok(r.status === 503, "checkout politely refused while platform payments are off");
r = await club("POST", "/api/org/team/invites", { email: "sec@example.com", role: "officer" }, H);
ok(r.status === 201, "invite 1 (2 of 2 seats)");
r = await club("POST", "/api/org/team/invites", { email: "tres@example.com", role: "viewer" }, H);
ok(r.status === 402 && /2 team members/.test(r.data.error), "Free plan team limit enforced", r.data);

// Platform turns on payments (test mode here) — once, for everyone
const cfg = (await owner("GET", "/api/admin/config")).data;
await owner("PUT", "/api/admin/config", { plans: cfg.plans, passes: cfg.passes, currency: cfg.currency, billingProvider: "test", allowSignups: true });
r = await owner("GET", "/api/admin/overview");
ok(r.data.checklist.find((c) => c.key === "billing")?.ok === true, "checklist turns green once payments are configured");

// The club upgrades itself
r = await club("POST", "/api/org/billing/checkout", { planId: "starter", months: 1 }, H);
ok(r.status === 200, "club starts Starter checkout itself");
let info = (await club("GET", `/api/public/payments/${r.data.reference}/info`)).data;
ok(info.amount_minor === 750000, "monthly Starter = ₦7,500", info);
await club("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "success" });
r = await club("GET", "/api/org/billing", undefined, H);
ok(r.data.plan.id === "starter" && days(r.data.planExpiresAt) === 30, "Starter active for 30 days", { plan: r.data.plan.id, d: days(r.data.planExpiresAt) });
r = await club("POST", "/api/org/team/invites", { email: "tres@example.com", role: "viewer" }, H);
ok(r.status === 201, "Starter raises the team limit immediately");

// Renew same plan: time is added on top
r = await club("POST", "/api/org/billing/checkout", { planId: "starter", months: 1, useSavedCard: false }, H);
await club("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "success" });
r = await club("GET", "/api/org/billing", undefined, H);
ok(days(r.data.planExpiresAt) === 60, "renewing adds 30 days to what's left (60)", days(r.data.planExpiresAt));

// Upgrade to Pro yearly: unused Starter value converts to Pro days
r = await club("POST", "/api/org/billing/checkout", { planId: "pro", months: 12, useSavedCard: false }, H);
info = (await club("GET", `/api/public/payments/${r.data.reference}/info`)).data;
ok(info.amount_minor === 25000000, "Pro yearly = 10 × ₦25,000 (2 months free)", info);
await club("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "success" });
r = await club("GET", "/api/org/billing", undefined, H);
// 60 Starter days worth ₦7,500/30 each = ₦15,000 → ₦15,000 / (₦25,000/30) = 18 Pro days; 360 + 18 = 378
ok(r.data.plan.id === "pro" && days(r.data.planExpiresAt) === 378, "Pro: 360 days + 18 days credit from unused Starter", days(r.data.planExpiresAt));
r = await club("GET", "/api/org/api-keys", undefined, H);
ok(r.data.available === true, "Pro features (API) unlocked straight away");

// Admin sees revenue without touching the organization
r = await owner("GET", "/api/admin/overview");
ok(r.data.mrr === 25000 && r.data.money.some((m) => m.kind === "plan"), "admin sees MRR and plan revenue", { mrr: r.data.mrr });

// Owner deletes their own organization
r = await club("DELETE", "/api/org", { confirm: "wrong name" }, H);
ok(r.status === 400, "deletion needs the exact organization name");
r = await club("DELETE", "/api/org", { confirm: "Lekki Tennis Club" }, H);
ok(r.status === 200, "owner deletes the organization");
r = await club("GET", "/api/auth/me");
ok(r.data.organizations.length === 0, "organization gone for its members");

await owner("PUT", "/api/admin/config", { plans: cfg.plans, passes: cfg.passes, currency: cfg.currency, billingProvider: cfg.billingProvider, allowSignups: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nAll self-service checks passed");
process.exit(failures ? 1 : 0);
