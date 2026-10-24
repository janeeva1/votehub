// Public voter registration (apply → shortlist → code) and the live scoreboard.
// Usage on a FRESH database: node scripts/registration-test.mjs http://localhost:3000
const BASE = process.argv[2] ?? "http://localhost:3000";
let failures = 0;
const ok = (cond, msg, extra) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}${!cond && extra !== undefined ? `  → ${JSON.stringify(extra).slice(0, 300)}` : ""}`);
  if (!cond) failures++;
};
function client() {
  const jar = new Map();
  return async (method, path, body, headers = {}) => {
    const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) { const [pair] = c.split(";"); const [k, v] = pair.split("="); jar.set(k, v); }
    const t = await res.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
    return { status: res.status, data };
  };
}
const admin = client();
await admin("POST", "/api/auth/signup", { name: "Alumni Sec", email: `sec${Date.now()}@example.com`, password: "alumni-pass-1", acceptTerms: true });
const org = (await admin("POST", "/api/orgs", { name: "Unilag Alumni Lagos", orgType: "Alumni association", acceptTerms: true })).data;
const H = { "X-Org-Id": org.id };
let r = await admin("POST", "/api/org/events", { title: "Alumni Exco Election", templateId: "election" }, H);
const ev = r.data;
const d = (await admin("GET", `/api/org/events/${ev.id}`, undefined, H)).data;
for (const c of d.categories) for (const n of ["Ade", "Bisi"]) await admin("POST", `/api/org/events/${ev.id}/options`, { categoryId: c.id, name: n }, H);
r = await admin("PATCH", `/api/org/events/${ev.id}`, {
  startsAt: new Date(Date.now() + 864e5).toISOString(),
  settings: { ...d.settings, display: { ...d.settings.display, liveStats: true }, registration: { enabled: true, refLabel: "Matric number", ref: "required", phone: "optional", askGroup: true, groupLabel: "Set", groupOptions: ["2010", "2011"], questions: [{ id: "q1", label: "Year of graduation", required: true }] } },
}, H);
ok(r.status === 200, "registration settings saved", r.data);
r = await admin("POST", `/api/org/events/${ev.id}/status`, { status: "live" }, H);
ok(r.status === 200, "event published with no voters because registration is on", r.data);

const pub = client();
r = await pub("GET", `/api/public/events/${ev.slug}`);
ok(r.data.state === "not_started" && r.data.registration?.open && r.data.registration.refLabel === "Matric number", "public page offers registration before voting opens", r.data.registration);
ok(r.data.live && r.data.live.eligible === 0 && r.data.live.registered === 0, "live scoreboard is on", r.data.live);
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Chidi Okafor", email: "chidi@example.com", answers: { q1: "2010" }, group: "2010" });
ok(r.status === 400, "matric number required", r.data);
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Chidi Okafor", email: "chidi@example.com", ref: "100401234", group: "2010", answers: {} });
ok(r.status === 400 && /Year of graduation/.test(r.data.error), "required extra question enforced", r.data);
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Chidi Okafor", email: "Chidi@Example.com", ref: "100401234", group: "2010", answers: { q1: "2010" } });
ok(r.status === 201 && r.data.status === "pending", "registration received, waiting for shortlist", r.data);
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Chidi Again", email: "chidi@example.com", ref: "999", answers: { q1: "2010" } });
ok(r.status === 409, "same email can't register twice", r.data);
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Imposter", email: "imp@example.com", ref: "100401234", answers: { q1: "2010" } });
ok(r.status === 409 && /Matric number/i.test(r.data.error), "same matric number can't register twice", r.data);
await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Ngozi Eze", email: "ngozi@example.com", ref: "100409999", answers: { q1: "2011" } });
await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Not Eligible", email: "no@example.com", ref: "200000001", answers: { q1: "2020" } });

r = await admin("GET", `/api/org/events/${ev.id}/registrations?status=pending`, undefined, H);
ok(r.data.counts.pending === 3 && r.data.registrations[0].answers.q1, "organizer sees 3 waiting with their answers", r.data.counts);
const byName = Object.fromEntries(r.data.registrations.map((x) => [x.name, x.id]));
r = await admin("POST", `/api/org/events/${ev.id}/registrations/decide`, { ids: [byName["Chidi Okafor"], byName["Ngozi Eze"]], decision: "approve" }, H);
ok(r.status === 200 && r.data.changed === 2, "two shortlisted", r.data);
r = await admin("POST", `/api/org/events/${ev.id}/registrations/decide`, { ids: [byName["Not Eligible"]], decision: "reject" }, H);
ok(r.data.changed === 1, "one rejected");
const voters = (await admin("GET", `/api/org/events/${ev.id}/voters`, undefined, H)).data.voters;
ok(voters.length === 2 && voters.some((v) => v.ref === "100401234" && (v.group ?? v.group_name ?? v.groupName) === "2010"), "approved people are on the voter list with matric and set", voters.map((v) => [v.name, v.ref, v]));
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Chidi", email: "chidi@example.com", ref: "1", answers: { q1: "x" } });
ok(r.status === 409, "approved person told they're already on the list");
r = await admin("POST", `/api/org/events/${ev.id}/registrations/decide`, { ids: [byName["Ngozi Eze"]], decision: "reject" }, H);
const after = (await admin("GET", `/api/org/events/${ev.id}/voters`, undefined, H)).data.voters;
ok(r.data.changed === 1 && after.length === 1, "un-shortlisting removes a voter who hasn't voted");
r = await admin("GET", `/api/org/events/${ev.id}/registrations.csv`, undefined, H);
ok(typeof r.data === "string" && r.data.includes("Matric number") && r.data.includes("Year of graduation"), "registrations export as CSV");

// voting opens: the approved alumnus votes and the scoreboard moves
await admin("PATCH", `/api/org/events/${ev.id}`, { startsAt: null }, H);
const code = after[0].accessCode ?? after[0].access_code;
const voter = client();
r = await voter("POST", `/api/public/events/${ev.slug}/access`, { code });
ok(r.status === 200, "shortlisted voter's code works", r.data);
const cats = (await voter("GET", `/api/public/events/${ev.slug}`)).data.categories;
r = await voter("POST", `/api/public/events/${ev.slug}/ballot`, { token: r.data.token, choices: Object.fromEntries(cats.map((c) => [c.id, [c.options[0].id]])) });
ok(r.status === 201 || r.status === 200, "ballot cast", r.data);
r = await pub("GET", `/api/public/events/${ev.slug}/live`);
ok(r.data.live.voted === 1 && r.data.live.eligible === 1 && r.data.live.turnoutPercent === 100 && r.data.live.lastActivityAt, "scoreboard: 1 of 1 voted, 100% turnout", r.data.live);

// organizer switches the scoreboard off
const cur = (await admin("GET", `/api/org/events/${ev.id}`, undefined, H)).data.settings;
await admin("PATCH", `/api/org/events/${ev.id}`, { settings: { ...cur, display: { ...cur.display, liveStats: false } } }, H);
r = await pub("GET", `/api/public/events/${ev.slug}`);
ok(r.data.live === null, "scoreboard hidden when switched off");

// closing registration
await admin("PATCH", `/api/org/events/${ev.id}`, { settings: { ...cur, registration: { ...cur.registration, closesAt: new Date(Date.now() - 1000).toISOString() } } }, H);
r = await pub("POST", `/api/public/events/${ev.slug}/register`, { name: "Late", email: "late@example.com", ref: "5", answers: { q1: "2010" } });
ok(r.status === 409, "registration closed after the deadline", r.data);

// other organizations can't see or decide registrations
const other = client();
await other("POST", "/api/auth/signup", { name: "Other", email: `o${Date.now()}@example.com`, password: "other-pass-12", acceptTerms: true });
const o2 = (await other("POST", "/api/orgs", { name: "Other Org", orgType: "Club", acceptTerms: true })).data;
r = await other("GET", `/api/org/events/${ev.id}/registrations`, undefined, { "X-Org-Id": o2.id });
ok(r.status === 404, "other organizations can't see registrations");

console.log(failures ? `\n${failures} check(s) failed` : "\nAll registration & scoreboard checks passed");
process.exit(failures ? 1 : 0);
