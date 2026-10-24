// Tests the advanced features: STV, Borda, score, cumulative, write-ins, thresholds, quorum,
// voter groups, proxies, comments, password-protected pages, bot trap, QR, API keys, event passes.
// Usage (fresh database recommended): node scripts/feature-test.mjs http://localhost:3000
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
}

const admin = client();
await admin("POST", "/api/auth/signup", { name: "Feature Owner", email: `feat${Date.now()}@example.com`, password: "feature-pass-1", acceptTerms: true });
let r = await admin("POST", "/api/orgs", { name: "Feature Org", orgType: "Cooperative", acceptTerms: true });
const H = { "X-Org-Id": r.data.id };
const orgId = r.data.id;
const isAdmin = (await admin("GET", "/api/admin/orgs")).status === 200;
if (isAdmin) await admin("PATCH", `/api/admin/orgs/${orgId}`, { plan: "pro", planExpiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });

async function makeEvent(title, templateId, categories, settings) {
  const e = (await admin("POST", "/api/org/events", { title, templateId }, H)).data;
  const d = (await admin("GET", `/api/org/events/${e.id}`, undefined, H)).data;
  for (const c of d.categories) await admin("DELETE", `/api/org/events/${e.id}/categories/${c.id}`, undefined, H);
  const cats = [];
  for (const c of categories) {
    const { options, ...rest } = c;
    const cat = (await admin("POST", `/api/org/events/${e.id}/categories`, rest, H)).data;
    for (const name of options) await admin("POST", `/api/org/events/${e.id}/options`, { categoryId: cat.id, name }, H);
    cats.push(cat.id);
  }
  if (settings) {
    const p = await admin("PATCH", `/api/org/events/${e.id}`, settings, H);
    if (p.status !== 200) console.log("settings error", p.data);
  }
  const full = (await admin("GET", `/api/org/events/${e.id}`, undefined, H)).data;
  const opt = (ci, name) => full.categories[ci].options.find((o) => o.name === name).id;
  return { e: full, cats, opt };
}
const results = async (id) => (await admin("GET", `/api/org/events/${id}/results`, undefined, H)).data;

// ---------- STV: 2 seats ----------
{
  const { e, cats, opt } = await makeEvent("STV board", "custom", [{ title: "Board (2 seats)", method: "stv", maxChoices: 2, options: ["Ann", "Ben", "Cal", "Dee"] }], { settings: { access: "public", results: { visibility: "live" } } });
  r = await admin("POST", `/api/org/events/${e.id}/status`, { status: "live" }, H);
  ok(r.status === 200, "STV event live", r.data);
  const [A, B, C, D] = ["Ann", "Ben", "Cal", "Dee"].map((n) => opt(0, n));
  // 9 ballots: quota = 9/3 = 3 → Ann 5 first prefs (surplus 2 → Ben), Ben 1, Cal 2, Dee 1
  const ballots = [[A, B], [A, B], [A, B], [A, B], [A, C], [B, C], [C, D], [C, B], [D, C]];
  for (const order of ballots) await client()("POST", `/api/public/events/${e.slug}/ballot`, { choices: { [cats[0]]: order } });
  const t = await results(e.id);
  const winners = t.categories[0].options.filter((o) => o.winner).map((o) => o.name).sort();
  ok(winners.join(",") === "Ann,Cal" || winners.join(",") === "Ann,Ben", `STV elects 2 seats (${winners.join(", ")}), quota ${t.categories[0].quota}`, t.categories[0].rounds);
  ok(t.categories[0].quota === 3, "STV Droop quota = 3");
  await admin("POST", `/api/org/events/${e.id}/status`, { status: "closed" }, H);
}

// ---------- Borda, score, cumulative, write-in, threshold, comments ----------
{
  const { e, cats, opt } = await makeEvent(
    "Mixed methods",
    "custom",
    [
      { title: "Borda pick", method: "borda", options: ["X", "Y", "Z"] },
      { title: "Rate ideas", method: "score", points: 5, options: ["I1", "I2"] },
      { title: "Budget", method: "cumulative", points: 10, options: ["B1", "B2", "B3"] },
      { title: "Treasurer", method: "single", allowWriteIn: true, options: ["Tom"] },
      { title: "Motion (2/3)", method: "single", thresholdPercent: 66.67, options: ["For", "Against"] },
    ],
    { settings: { access: "public", results: { visibility: "live" }, ballot: { allowComments: true, allowAbstain: true } } },
  );
  r = await admin("POST", `/api/org/events/${e.id}/status`, { status: "live" }, H);
  ok(r.status === 200, "mixed-method event live", r.data);
  const v = client();
  r = await v("POST", `/api/public/events/${e.slug}/ballot`, { choices: { [cats[2]]: { [opt(2, "B1")]: 8, [opt(2, "B2")]: 5 } } });
  ok(r.status === 400 && /at most 10/.test(r.data.error), "cumulative over budget rejected", r.data);
  r = await v("POST", `/api/public/events/${e.slug}/ballot`, { choices: { [cats[1]]: { [opt(1, "I1")]: 9 } } });
  ok(r.status === 400, "score above max rejected");
  r = await v("POST", `/api/public/events/${e.slug}/ballot`, { choices: {}, website: "http://spam" });
  ok(r.status === 400, "honeypot field blocks bots");
  const cast = async (borda, score, cum, treas, writeIn, motion, comment) =>
    (await client()("POST", `/api/public/events/${e.slug}/ballot`, {
      choices: { [cats[0]]: borda, [cats[1]]: score, [cats[2]]: cum, [cats[3]]: treas, [cats[4]]: motion },
      writeIns: writeIn ? { [cats[3]]: writeIn } : undefined,
      comment,
    })).status;
  const X = opt(0, "X"), Y = opt(0, "Y"), Z = opt(0, "Z");
  const statuses = [
    await cast([Y, X, Z], { [opt(1, "I1")]: 5, [opt(1, "I2")]: 2 }, { [opt(2, "B1")]: 6, [opt(2, "B2")]: 4 }, [], "Grace Write", [opt(4, "For")], "Great work"),
    await cast([Y, Z, X], { [opt(1, "I1")]: 3, [opt(1, "I2")]: 4 }, { [opt(2, "B3")]: 10 }, [], "grace write", [opt(4, "For")]),
    await cast([X, Y, Z], { [opt(1, "I1")]: 4 }, { [opt(2, "B1")]: 10 }, [opt(3, "Tom")], null, [opt(4, "Against")]),
  ];
  ok(statuses.every((s) => s === 201), "3 mixed ballots accepted", statuses);
  const t = await results(e.id);
  const cat = (i) => t.categories[i];
  ok(cat(0).options.find((o) => o.winner)?.name === "Y" && cat(0).options.find((o) => o.name === "Y").votes === 5, "Borda: Y wins with 5 points");
  ok(cat(1).options.find((o) => o.name === "I1").votes === 12 && cat(1).options.find((o) => o.name === "I1").average === 4, "Score: I1 total 12, average 4");
  ok(cat(2).options.find((o) => o.winner)?.name === "B1" && cat(2).options.find((o) => o.name === "B1").votes === 16, "Cumulative: B1 wins with 16 points");
  const wi = cat(3).options.find((o) => o.writeIn);
  ok(wi && wi.votes === 2 && wi.winner, "Write-ins merged case-insensitively and win (2 votes)", cat(3).options);
  ok(cat(4).threshold?.percent === 66.67 && cat(4).threshold.met === true && cat(4).options.find((o) => o.name === "For").winner, "2/3 threshold met (66.7%)", cat(4));
  r = await admin("GET", `/api/org/events/${e.id}/comments`, undefined, H);
  ok(r.data.length === 1 && r.data[0].comment === "Great work", "ballot comment stored");
  r = await admin("GET", `/api/org/events/${e.id}/results.csv`, undefined, H);
  ok(typeof r.data === "string" && r.data.includes("threshold_met"), "results CSV includes thresholds");
  await admin("POST", `/api/org/events/${e.id}/status`, { status: "closed" }, H);
}

// ---------- Voter groups, proxy, quorum ----------
{
  const { e, cats, opt } = await makeEvent(
    "AGM with groups",
    "custom",
    [
      { title: "Chair", method: "single", options: ["Kay", "Lou"] },
      { title: "Lagos branch rep", method: "single", voterGroups: ["Lagos"], options: ["Mo", "Ned"] },
    ],
    { settings: { access: "roster", ballot: { quorumPercent: 60, allowAbstain: true }, results: { visibility: "live" } } },
  );
  await admin("POST", `/api/org/events/${e.id}/voters/import`, { voters: [
    { name: "P1", email: "p1@x.com", group: "Lagos" }, { name: "P2", email: "p2@x.com", group: "Abuja" },
    { name: "P3", email: "p3@x.com", group: "Lagos" }, { name: "P4", email: "p4@x.com" }, { name: "P5", email: "p5@x.com" },
  ] }, H);
  const list = (await admin("GET", `/api/org/events/${e.id}/voters`, undefined, H)).data.voters;
  const by = (n) => list.find((x) => x.name === n);
  r = await admin("PATCH", `/api/org/events/${e.id}/voters/${by("P4").id}`, { proxyVoterId: by("P1").id }, H);
  ok(r.status === 200, "proxy assigned (P4 → P1)");
  r = await admin("PATCH", `/api/org/events/${e.id}/voters/${by("P5").id}`, { proxyVoterId: by("P5").id }, H);
  ok(r.status === 400, "self-proxy rejected");
  await admin("POST", `/api/org/events/${e.id}/status`, { status: "live" }, H);
  const login = async (code) => {
    const c = client();
    const a = await c("POST", `/api/public/events/${e.slug}/access`, { code });
    return { c, a };
  };
  const p2 = await login(by("P2").access_code);
  r = await p2.c("POST", `/api/public/events/${e.slug}/ballot`, { token: p2.a.data.token, choices: { [cats[0]]: [opt(0, "Kay")], [cats[1]]: [opt(1, "Mo")] } });
  ok(r.status === 403, "Abuja voter can't vote on the Lagos-only question", r.data);
  r = await p2.c("POST", `/api/public/events/${e.slug}/ballot`, { token: p2.a.data.token, choices: { [cats[0]]: [opt(0, "Lou")] } });
  ok(r.status === 201, "Abuja voter votes on the general question");
  const p1 = await login(by("P1").access_code);
  ok(p1.a.data.voter.proxies === 1 && p1.a.data.voter.group === "Lagos", "P1 sees 1 proxy and Lagos group", p1.a.data.voter);
  r = await p1.c("POST", `/api/public/events/${e.slug}/ballot`, { token: p1.a.data.token, choices: { [cats[0]]: [opt(0, "Kay")], [cats[1]]: [opt(1, "Mo")] } });
  ok(r.status === 201 && r.data.proxied === 1, "P1 votes for self + 1 proxy", r.data);
  const t = await results(e.id);
  ok(t.categories[0].options.find((o) => o.name === "Kay").votes === 2, "proxy doubles P1's vote (Kay 2)");
  ok(t.quorum && t.quorum.achieved === 3 && t.quorum.required === 3 && t.quorum.met, "quorum 60% of 5 met with 3 (incl. proxy)", t.quorum);
  const p4 = await login(by("P4").access_code);
  ok(p4.a.data.voter.hasVoted === true, "P4 shows as already voted via proxy");
  r = await admin("POST", `/api/org/events/${e.id}/voters/remind`, {}, H);
  ok(r.status === 200 && r.data.processed === 2, "reminder goes to the 2 non-voters only", r.data);
  r = await admin("GET", `/api/org/events/${e.id}/voters?status=not_voted`, undefined, H);
  ok(r.data.total === 2, "filter voters who haven't voted");
}

// ---------- Password-protected poll, QR ----------
{
  const { e, cats, opt } = await makeEvent("Secret poll", "custom", [{ title: "Q", method: "single", options: ["Yes", "No"] }], {
    settings: { access: "public", security: { passwordProtected: true } },
    accessPassword: "letmein",
  });
  await admin("POST", `/api/org/events/${e.id}/status`, { status: "live" }, H);
  const v = client();
  r = await v("GET", `/api/public/events/${e.slug}`);
  ok(r.data.locked === true && r.data.categories.length === 0, "locked page hides the ballot");
  r = await v("POST", `/api/public/events/${e.slug}/ballot`, { choices: { [cats[0]]: [opt(0, "Yes")] } });
  ok(r.status === 401, "voting needs the password");
  r = await v("POST", `/api/public/events/${e.slug}/unlock`, { password: "wrong" });
  ok(r.status === 401, "wrong password rejected");
  r = await v("POST", `/api/public/events/${e.slug}/unlock`, { password: "letmein" });
  const pt = r.data.passToken;
  r = await v("GET", `/api/public/events/${e.slug}?pt=${pt}`);
  ok(r.data.locked === false && r.data.categories.length === 1, "unlocked page shows the ballot");
  r = await v("POST", `/api/public/events/${e.slug}/ballot`, { passToken: pt, choices: { [cats[0]]: [opt(0, "Yes")] } });
  ok(r.status === 201, "vote accepted after unlocking");
  r = await fetch(`${BASE}/api/public/events/${e.slug}/qr.svg`);
  ok(r.status === 200 && (await r.text()).startsWith("<svg"), "QR code SVG served");
  r = await fetch(`${BASE}/embed/${e.slug}`);
  ok(r.status === 200 && !r.headers.get("x-frame-options"), "embed page can be framed");
  r = await fetch(`${BASE}/e/${e.slug}`);
  ok(r.headers.get("x-frame-options") === "SAMEORIGIN", "normal pages refuse framing");
}

// ---------- API keys ----------
if (isAdmin) {
  r = await admin("POST", "/api/org/api-keys", { name: "CRM sync" }, H);
  ok(r.status === 201 && r.data.key.startsWith("vh_live_"), "API key created");
  const key = r.data.key;
  r = await fetch(`${BASE}/api/v1/events`, { headers: { Authorization: `Bearer ${key}` } });
  const evs = await r.json();
  ok(r.status === 200 && evs.data.length >= 4, "API lists events");
  r = await fetch(`${BASE}/api/v1/events`, { headers: { Authorization: "Bearer vh_live_nope" } });
  ok(r.status === 401, "bad API key rejected");
  r = await fetch(`${BASE}/api/v1/events/${evs.data[0].id}/results`, { headers: { Authorization: `Bearer ${key}` } });
  ok(r.status === 200, "API returns results");
  r = await admin("PATCH", "/api/org", { webhook: { url: "https://example.com/hook", secret: "whsec_test" } }, H);
  ok(r.status === 200, "outgoing webhook saved");
  r = await admin("GET", "/api/org", undefined, H);
  ok(r.data.webhook.url === "https://example.com/hook" && r.data.webhook.hasSecret, "webhook visible (secret hidden)");
}

// ---------- Event pass (one-off) via test payments ----------
if (isAdmin) {
  const cfg = (await admin("GET", "/api/admin/config")).data;
  r = await admin("PUT", "/api/admin/config", { plans: cfg.plans, passes: cfg.passes, currency: cfg.currency, billingProvider: "test", allowSignups: true });
  ok(r.status === 200, "platform billing switched to test provider", r.data);
  await admin("PATCH", `/api/admin/orgs/${orgId}`, { plan: "free", planExpiresAt: null });
  const e = (await admin("POST", "/api/org/events", { title: "Big annual election", templateId: "election" }, H)).data;
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `Member ${i}`, email: `m${i}@x.com` }));
  r = await admin("POST", `/api/org/events/${e.id}/voters/import`, { voters: many }, H);
  ok(r.status === 402, "free plan: 60 voters exceeds the 50 limit");
  r = await admin("POST", `/api/org/events/${e.id}/pass/checkout`, { passId: "pass-350" }, H);
  ok(r.status === 200 && r.data.redirectUrl.includes("/pay/test"), "pass checkout started", r.data);
  await admin("POST", `/api/public/payments/${r.data.reference}/test-complete`, { result: "success" });
  r = await admin("GET", `/api/org/events/${e.id}`, undefined, H);
  ok(r.data.passVoters === 350 && r.data.plan.maxVotersPerEvent === 350, "pass applied: 350 voters on this event", r.data.plan);
  r = await admin("POST", `/api/org/events/${e.id}/voters/import`, { voters: many }, H);
  ok(r.status === 200 && r.data.added === 60, "60 voters imported after pass");
  await admin("PUT", "/api/admin/config", { plans: cfg.plans, passes: cfg.passes, currency: cfg.currency, billingProvider: cfg.billingProvider, allowSignups: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll feature checks passed");
process.exit(failures ? 1 : 0);
