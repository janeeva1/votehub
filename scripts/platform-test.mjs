// Terms acceptance, platform ads, and strict tenant isolation between organizations.
// Usage on a FRESH database: node scripts/platform-test.mjs http://localhost:3000
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
      redirect: "manual",
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
    return { status: res.status, data, headers: res.headers };
  };
}
const stamp = Date.now();

// ---------- Terms of Service & Privacy ----------
const owner = client();
let r = await owner("POST", "/api/auth/signup", { name: "Platform Owner", email: `po${stamp}@example.com`, password: "platform-pass-1" });
ok(r.status === 400 && /Terms/.test(r.data.error), "sign-up refused without accepting the terms", r.data);
r = await owner("POST", "/api/auth/signup", { name: "Platform Owner", email: `po${stamp}@example.com`, password: "platform-pass-1", acceptTerms: true });
ok(r.status === 201 && r.data.user.termsAccepted === true && r.data.user.termsAcceptedAt, "sign-up records acceptance");
r = await fetch(`${BASE}/terms`);
ok(r.status === 200, "/terms page is served");
r = await owner("GET", "/api/config");
ok(r.data.legal?.termsVersion && r.data.legal.governingLaw, "public config exposes the current legal version");

async function newOrg(email, name) {
  const c = client();
  await c("POST", "/api/auth/signup", { name: "Chair", email, password: "club-pass-123", acceptTerms: true });
  let x = await c("POST", "/api/orgs", { name, orgType: "Club or association" });
  ok(x.status === 400, `${name}: organization needs authority + terms confirmation`);
  x = await c("POST", "/api/orgs", { name, orgType: "Club or association", acceptTerms: true });
  return { c, H: { "X-Org-Id": x.data.id }, id: x.data.id };
}
const A = await newOrg(`a${stamp}@example.com`, "Alpha Club");
const B = await newOrg(`b${stamp}@example.com`, "Beta Union");

r = await owner("PUT", "/api/admin/legal", { companyName: "Example Votes Ltd", contactEmail: "legal@example.com", requireReaccept: true });
ok(r.status === 200 && r.data.companyName === "Example Votes Ltd", "admin publishes a new terms version", r.data);
const version = r.data.termsVersion;
r = await A.c("POST", "/api/org/events", { title: "Blocked", templateId: "poll" }, A.H);
ok(r.status === 428 && r.data.code === "TERMS_REQUIRED", "changes are blocked until the new terms are accepted", r);
r = await A.c("GET", "/api/org/events", undefined, A.H);
ok(r.status === 200, "reading still works (so the acceptance screen can load)");
r = await A.c("GET", "/api/auth/me");
ok(r.data.user.termsAccepted === false, "me reports terms not accepted");
r = await A.c("POST", "/api/auth/accept-terms", { version: "old" });
ok(r.status === 409, "accepting an outdated version is refused");
r = await A.c("POST", "/api/auth/accept-terms", { version });
ok(r.status === 200 && r.data.user.termsAccepted, "user accepts the new version");
await B.c("POST", "/api/auth/accept-terms", { version });
await owner("POST", "/api/auth/accept-terms", { version });
r = await owner("GET", "/api/admin/legal");
ok(r.data.accepted.n === 3 && r.data.accepted.total === 3, "admin sees acceptance count", r.data.accepted);

// ---------- Ads ----------
r = await A.c("GET", "/api/org/ad", undefined, A.H);
ok(r.status === 200 && r.data.ad === null, "no ads until the platform creates one");
r = await A.c("POST", "/api/admin/ads", { title: "Hack", linkUrl: "https://x.example" });
ok(r.status === 403, "organizations can't manage ads");
r = await owner("POST", "/api/admin/ads", { title: "Bad link", linkUrl: "javascript:alert(1)" });
ok(r.status === 400, "unsafe ad links rejected");
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
r = await owner("POST", "/api/admin/files", { dataUrl: png });
ok(r.status === 201, "admin uploads an ad image without an organization");
const img = r.data.id;
r = await owner("POST", "/api/admin/ads", { title: "Print your campaign posters", body: "20% off for clubs", linkUrl: "https://printer.example/clubs", imageFileId: img, placements: ["voting_page", "dashboard"] });
ok(r.status === 201, "admin creates an ad", r.data);
const adId = r.data.id;
r = await A.c("GET", "/api/org/ad", undefined, A.H);
ok(r.data.ad?.id === adId && r.data.ad.imageUrl === `/api/files/${img}` && !("linkUrl" in r.data.ad), "Free-plan dashboard shows the ad (click goes via tracker)", r.data);

await owner("PATCH", `/api/admin/orgs/${B.id}`, { plan: "pro", planExpiresAt: new Date(Date.now() + 30 * 864e5).toISOString() });
r = await B.c("GET", "/api/org/ad", undefined, B.H);
ok(r.data.ad === null, "Pro plan is ad-free");

// public voting page of a Free organization
r = await A.c("POST", "/api/org/events", { title: "Best Coach", templateId: "poll" }, A.H);
const evA = r.data;
for (const c of (await A.c("GET", `/api/org/events/${evA.id}`, undefined, A.H)).data.categories) {
  for (const name of ["Kemi", "Femi"]) await A.c("POST", `/api/org/events/${evA.id}/options`, { categoryId: c.id, name }, A.H);
}
await A.c("PATCH", `/api/org/events/${evA.id}`, { settings: { access: "public" } }, A.H);
r = await A.c("POST", `/api/org/events/${evA.id}/status`, { status: "live" }, A.H);
ok(r.status === 200, "Alpha's poll is live", r.data);
const visitor = client();
r = await visitor("GET", `/api/public/events/${evA.slug}/ad`);
ok(r.data.ad?.id === adId, "ad on a Free organization's voting page");
r = await visitor("GET", `/api/public/ads/${adId}/click`);
ok(r.status === 302 && r.headers.get("location") === "https://printer.example/clubs", "click redirects to the advertiser", r.status);
r = await owner("GET", "/api/admin/ads");
const st = r.data.find((a) => a.id === adId);
ok(st.impressions === 2 && st.clicks === 1, "impressions and clicks counted", st);

await owner("PATCH", `/api/admin/ads/${adId}`, { title: st.title, linkUrl: st.linkUrl, placements: ["dashboard"] });
r = await visitor("GET", `/api/public/events/${evA.slug}/ad`);
ok(r.data.ad === null, "placement targeting respected");
await owner("PATCH", `/api/admin/ads/${adId}`, { title: st.title, linkUrl: st.linkUrl, endsAt: new Date(Date.now() - 1000).toISOString() });
r = await A.c("GET", "/api/org/ad", undefined, A.H);
ok(r.data.ad === null, "ended ads stop showing");

// ---------- Tenant isolation ----------
r = await B.c("POST", "/api/org/events", { title: "Beta Secret Ballot", templateId: "election" }, B.H);
const evB = r.data;
await B.c("POST", `/api/org/events/${evB.id}/voters`, { name: "Beta Member", email: "member@beta.example" }, B.H);
const Bkey = (await B.c("POST", "/api/org/api-keys", { name: "crm" }, B.H)).data.key;

// Alpha using Beta's organization id
for (const path of ["/api/org", "/api/org/events", "/api/org/team", "/api/org/billing", "/api/org/api-keys", `/api/org/events/${evB.id}`]) {
  r = await A.c("GET", path, undefined, B.H);
  ok(r.status === 403, `Alpha → Beta header on ${path} refused`, r.status);
}
// Alpha using its own organization id but Beta's records
const probes = [
  ["GET", `/api/org/events/${evB.id}`],
  ["GET", `/api/org/events/${evB.id}/voters`],
  ["GET", `/api/org/events/${evB.id}/results`],
  ["GET", `/api/org/events/${evB.id}/payments`],
  ["GET", `/api/org/events/${evB.id}/votes`],
  ["PATCH", `/api/org/events/${evB.id}`, { title: "pwned" }],
  ["POST", `/api/org/events/${evB.id}/status`, { status: "live" }],
  ["POST", `/api/org/events/${evB.id}/voters`, { name: "Intruder", email: "x@x.example" }],
  ["DELETE", `/api/org/events/${evB.id}`],
];
for (const [m, path, body] of probes) {
  r = await A.c(m, path, body, A.H);
  ok(r.status === 404, `Alpha can't ${m} ${path.replace(evB.id, ":betaEvent")}`, r.status);
}
r = await B.c("GET", `/api/org/events/${evB.id}`, undefined, B.H);
ok(r.data.title === "Beta Secret Ballot" && r.data.stats.voters === 1, "Beta's event untouched", { t: r.data.title, s: r.data.stats });
r = await A.c("GET", "/api/org/events", undefined, A.H);
ok(r.data.every((e) => e.id !== evB.id), "Alpha's event list contains only Alpha's events");

// API keys are scoped to their organization
r = await fetch(`${BASE}/api/v1/events`, { headers: { Authorization: `Bearer ${Bkey}` } }).then((x) => x.json());
const v1 = r.data ?? r.events ?? r;
ok(Array.isArray(v1) && v1.some((e) => e.id === evB.id) && !v1.some((e) => e.id === evA.id), "Beta's API key lists only Beta's events", r);
r = await fetch(`${BASE}/api/v1/events/${evA.id}/results`, { headers: { Authorization: `Bearer ${Bkey}` } });
ok(r.status === 404, "Beta's API key can't read Alpha's results", r.status);

// Team members of one organization don't see the other
r = await A.c("GET", "/api/auth/me");
ok(r.data.organizations.length === 1 && r.data.organizations[0].id === A.id, "Alpha's user belongs only to Alpha");
r = await A.c("GET", "/api/admin/orgs");
ok(r.status === 403, "organization users can't reach the platform admin");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll legal, ads & isolation checks passed");
process.exit(failures ? 1 : 0);
