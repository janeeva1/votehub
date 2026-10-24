// End-to-end API check. Usage: node scripts/smoke-test.mjs http://localhost:3000
// Creates a throwaway account, runs an election, a ranked vote, a free+paid contest (test payments) and checks results.
const BASE = process.argv[2] ?? "http://localhost:3000";
let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};

function client() {
  const jar = new Map();
  return async function call(method, path, body, headers = {}) {
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const admin = client();
const email = `owner${Date.now()}@example.com`;
let r = await admin("POST", "/api/auth/signup", { name: "Test Owner", email, password: "correct-horse-1", acceptTerms: true });
ok(r.status === 201, `signup (${r.status})`);
r = await admin("GET", "/api/org");
ok(r.status === 409, "no org yet → 409");
r = await admin("POST", "/api/orgs", { name: "Northbridge Alumni", orgType: "Alumni group", acceptTerms: true });
ok(r.status === 201, "create organization");
const orgId = r.data.id;
const H = { "X-Org-Id": orgId };

// ---------- Election (roster, secret ballot) ----------
r = await admin("POST", "/api/org/events", { title: "Executive Election 2026", templateId: "election" }, H);
ok(r.status === 201, "create election from template");
const elec = r.data;
r = await admin("GET", `/api/org/events/${elec.id}`, undefined, H);
const [pres, sec] = r.data.categories;
for (const name of ["Ada Obi", "Bayo Lawal"]) await admin("POST", `/api/org/events/${elec.id}/options`, { categoryId: pres.id, name }, H);
for (const name of ["Chi Eze", "Dami Ade"]) await admin("POST", `/api/org/events/${elec.id}/options`, { categoryId: sec.id, name }, H);
r = await admin("POST", `/api/org/events/${elec.id}/status`, { status: "live" }, H);
ok(r.status === 409, "can't go live without voters");
r = await admin("POST", `/api/org/events/${elec.id}/voters/import`, { voters: [{ name: "V One", email: "v1@example.com" }, { name: "V Two", email: "v2@example.com" }, { name: "Dup", email: "v1@example.com" }] }, H);
ok(r.data.added === 2 && r.data.skipped === 1, "import voters, skip duplicate");
r = await admin("POST", `/api/org/events/${elec.id}/status`, { status: "live" }, H);
ok(r.status === 200 && r.data.state === "open", "election live");
r = await admin("GET", `/api/org/events/${elec.id}/voters`, undefined, H);
const codes = r.data.voters.map((v) => v.access_code);
r = await admin("GET", `/api/org/events/${elec.id}`, undefined, H);
const presOpts = r.data.categories[0].options;
const secOpts = r.data.categories[1].options;

const voter = client();
r = await voter("POST", `/api/public/events/${elec.slug}/access`, { code: "WRONG123" });
ok(r.status === 401, "wrong access code rejected");
r = await voter("POST", `/api/public/events/${elec.slug}/access`, { code: codes[0] });
ok(r.status === 200 && r.data.token, "access code accepted");
const tok = r.data.token;
r = await voter("POST", `/api/public/events/${elec.slug}/ballot`, { token: tok, choices: { [pres.id]: [presOpts[0].id, presOpts[1].id] } });
ok(r.status === 400, "two picks on single-choice rejected");
r = await voter("POST", `/api/public/events/${elec.slug}/ballot`, { token: tok, choices: { [pres.id]: [presOpts[0].id], [sec.id]: [secOpts[1].id] } });
ok(r.status === 201 && r.data.receipt, `ballot accepted, receipt ${r.data.receipt}`);
const receipt = r.data.receipt;
r = await voter("POST", `/api/public/events/${elec.slug}/ballot`, { token: tok, choices: { [pres.id]: [presOpts[1].id], [sec.id]: [] } });
ok(r.status === 409, "double vote rejected");
r = await voter("GET", `/api/public/events/${elec.slug}/receipts/${receipt}`);
ok(r.data.found === true, "receipt verifiable");
r = await voter("GET", `/api/public/events/${elec.slug}`);
ok(r.status === 200 && r.data.results === null, "results hidden while open (after_close)");
const v2 = client();
r = await v2("POST", `/api/public/events/${elec.slug}/access`, { code: codes[1] });
r = await v2("POST", `/api/public/events/${elec.slug}/ballot`, { token: r.data.token, choices: { [pres.id]: [presOpts[0].id], [sec.id]: [] } });
ok(r.status === 201, "second voter (abstains on secretary)");
await admin("POST", `/api/org/events/${elec.id}/status`, { status: "closed" }, H);
r = await voter("GET", `/api/public/events/${elec.slug}`);
const presRes = r.data.results?.categories?.[0];
ok(presRes?.options?.[0]?.votes === 2 && presRes.options[0].winner, "public results after close: Ada 2 votes, winner");
ok(r.data.results.categories[1].options.find((o) => o.name === "Dami Ade")?.votes === 1, "secretary tally correct");

// ---------- Ranked choice ----------
r = await admin("POST", "/api/org/events", { title: "Chair ranked vote", templateId: "ranked" }, H);
const rk = r.data;
r = await admin("GET", `/api/org/events/${rk.id}`, undefined, H);
const chair = r.data.categories[0];
for (const n of ["A", "B", "C"]) await admin("POST", `/api/org/events/${rk.id}/options`, { categoryId: chair.id, name: n }, H);
await admin("PATCH", `/api/org/events/${rk.id}`, { settings: { access: "public", results: { visibility: "live" } } }, H);
r = await admin("GET", `/api/org/events/${rk.id}`, undefined, H);
const [A, B, C] = r.data.categories[0].options.map((o) => o.id);
await admin("POST", `/api/org/events/${rk.id}/status`, { status: "closed" }, H).then((x) => ok(x.status === 409, "draft→closed not allowed"));
r = await admin("POST", `/api/org/events/${rk.id}/status`, { status: "live" }, H);
// Free plan allows 1 live event; election is closed so this should pass.
ok(r.status === 200, `ranked event live (${r.data.error ?? "ok"})`);
const prefs = [[A, B], [A, C], [B, C], [B, A], [C, B]];
for (const p of prefs) {
  const c = client();
  const x = await c("POST", `/api/public/events/${rk.slug}/ballot`, { choices: { [chair.id]: p } });
  if (x.status !== 201) console.log(x);
}
r = await admin("GET", `/api/org/events/${rk.id}/results`, undefined, H);
const rc = r.data.categories[0];
ok(rc.rounds.length === 2 && rc.options.find((o) => o.winner)?.name === "B", "IRV: C eliminated, B wins 3–2");
await admin("POST", `/api/org/events/${rk.id}/status`, { status: "closed" }, H);

// ---------- Contest with free + paid votes ----------
r = await admin("POST", "/api/org/events", { title: "Campus Face 2026", templateId: "contest" }, H);
const ct = r.data;
ok(ct.settings.paid.enabled === true, "free plan: paid voting available (10% fee)");
r = await admin("PATCH", `/api/org/events/${ct.id}`, { settings: { paid: { enabled: true, provider: "test" } } }, H);
ok(r.status === 200, "free plan can switch to test payments");
r = await admin("GET", "/api/admin/orgs");
if (r.status === 403) {
  console.log("! This account is not the platform admin (run against a fresh database to test paid voting).");
  process.exit(failures ? 1 : 0);
}
ok(r.status === 200, "first user is platform admin");
await admin("PATCH", `/api/admin/orgs/${orgId}`, { plan: "pro", planExpiresAt: new Date(Date.now() + 30 * 86400e3).toISOString() });
r = await admin("PATCH", `/api/org/events/${ct.id}`, { settings: { paid: { enabled: true, provider: "test", pricePerVote: 100, currency: "NGN", bundles: [{ votes: 10, price: 900 }] }, freeVotes: { enabled: true, perVoter: 1 } } }, H);
ok(r.status === 200, "pro plan: paid voting enabled (test provider)");
r = await admin("GET", `/api/org/events/${ct.id}`, undefined, H);
const cat = r.data.categories[0];
await admin("POST", `/api/org/events/${ct.id}/options`, { categoryId: cat.id, name: "Zara", code: "ZR1" }, H);
await admin("POST", `/api/org/events/${ct.id}/options`, { categoryId: cat.id, name: "Yemi" }, H);
r = await admin("GET", `/api/org/events/${ct.id}`, undefined, H);
const [zara, yemi] = r.data.categories[0].options;
r = await admin("POST", `/api/org/events/${ct.id}/status`, { status: "live" }, H);
ok(r.status === 200, "contest live");
const fan = client();
r = await fan("GET", `/api/public/events/${ct.slug}`);
ok(r.status === 200 && r.data.settings.paid.enabled, "public contest page loads");
r = await fan("POST", `/api/public/events/${ct.slug}/vote`, { optionId: zara.id, email: "fan@example.com" });
ok(r.status === 201, "free vote");
r = await fan("POST", `/api/public/events/${ct.slug}/vote`, { optionId: yemi.id, email: "fan@example.com" });
ok(r.status === 409, "second free vote in same category rejected");
r = await fan("POST", `/api/public/events/${ct.slug}/checkout`, { optionId: yemi.id, quantity: 10, email: "fan@example.com", acceptTerms: true });
ok(r.status === 200 && r.data.redirectUrl.includes("/pay/test"), "paid checkout started (bundle 10 for 900)");
const ref = r.data.reference;
r = await fan("GET", `/api/public/payments/${ref}/info`);
ok(r.data.amount_minor === 90000, "bundle price applied (₦900 = 90000 kobo)");
r = await fan("POST", `/api/public/payments/${ref}/test-complete`, { result: "success" });
ok(r.data.status === "success", "test payment completed");
r = await fan("GET", `/api/public/payments/${ref}`);
ok(r.data.status === "success", "re-verify is idempotent");
r = await fan("POST", `/api/public/events/${ct.slug}/checkout`, { optionId: zara.id, quantity: 3, email: "fan@example.com", acceptTerms: true });
await fan("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "failed" });
r = await fan("GET", `/api/public/events/${ct.slug}`);
const lb = r.data.results.categories[0].options;
ok(lb[0].name === "Yemi" && lb[0].votes === 10 && lb[1].votes === 1, "live leaderboard: Yemi 10 (paid), Zara 1 (free); failed payment not counted");
r = await admin("GET", `/api/org/events/${ct.id}`, undefined, H);
ok(r.data.stats.revenue[0]?.totalMajor === 900 && r.data.stats.revenue[0]?.feesMajor === 31.5, "revenue ₦900, Pro platform fee 3.5% = ₦31.50");
r = await admin("POST", `/api/org/events/${ct.id}/manual-votes`, { optionId: zara.id, quantity: 5, note: "Cash votes at venue" }, H);
ok(r.status === 201, "manual adjustment recorded");

// ---------- Team ----------
const officerEmail = `officer${Date.now()}@example.com`;
r = await admin("POST", "/api/org/team/invites", { email: officerEmail, role: "officer" }, H);
ok(r.status === 201 && r.data.inviteUrl, "team invite created");
const token = r.data.inviteUrl.split("/invite/")[1];
const officer = client();
r = await officer("POST", "/api/auth/signup", { name: "Officer", email: officerEmail, password: "officer-pass-1", inviteToken: token, acceptTerms: true });
ok(r.status === 201 && r.data.organizations.length === 1 && r.data.organizations[0].role === "officer", "invitee joins as officer");
r = await officer("DELETE", `/api/org/events/${ct.id}`, undefined, H);
ok(r.status === 403, "officer can't delete events");
r = await officer("GET", "/api/admin/orgs");
ok(r.status === 403, "officer isn't platform admin");

// ---------- Security basics ----------
r = await fetch(BASE + "/api/auth/logout", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
ok(r.status === 415, "non-JSON state-changing request rejected (CSRF guard)");
const stranger = client();
await stranger("POST", "/api/auth/signup", { name: "Stranger", email: `s${Date.now()}@example.com`, password: "stranger-pass", acceptTerms: true });
r = await stranger("GET", `/api/org/events/${ct.id}`, undefined, H);
ok(r.status === 403, "other users can't access this organization");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
