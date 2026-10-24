// Renders the product screenshots used on the landing page, once per colour theme, into web/public/landing/<theme>/.
// Needs Playwright (npm i -D playwright && npx playwright install chromium) and a FRESH database:
//   1. start the app on an empty database (npm run dev)
//   2. node scripts/landing-shots.mjs http://localhost:3000
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = path.resolve("web/public/landing");
const THEMES = ["ink", "marigold", "lagoon", "coral", "crimson", "forest"];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const api = async (method, url, data, orgId) => {
  const r = await page.request.fetch(BASE + url, { method, data, headers: { "X-Requested-With": "fetch", ...(orgId ? { "X-Org-Id": orgId } : {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${JSON.stringify(body)}`);
  return body;
};

// ---------- Seed realistic data ----------
await api("POST", "/api/auth/signup", { name: "Funmi Adeyemi", email: `shots${Date.now()}@example.com`, password: "screenshot-pass-1", acceptTerms: true });
const org = await api("POST", "/api/orgs", { name: "Lagos Alumni Association", orgType: "Alumni association", acceptTerms: true });
const O = org.id;
const me = await api("GET", "/api/auth/me");
await api("PATCH", `/api/admin/orgs/${O}`, { plan: "pro", planExpiresAt: new Date(Date.now() + 300 * 864e5).toISOString() });

await api("PATCH", "/api/org", { paymentKeys: { paystack: { enabled: true, secretKey: "sk_test_screenshot_only" }, manual: [{ label: "Bank transfer", instructions: "Lagos Alumni Association\nGTBank 0123456789", enabled: true }] } }, O);

async function event(title, templateId, cats, settings) {
  const e = await api("POST", "/api/org/events", { title, templateId }, O);
  const d = await api("GET", `/api/org/events/${e.id}`, undefined, O);
  for (const c of d.categories) await api("DELETE", `/api/org/events/${e.id}/categories/${c.id}`, undefined, O);
  for (const c of cats) {
    const cat = await api("POST", `/api/org/events/${e.id}/categories`, { title: c.title, method: c.method ?? "single", description: c.description ?? "" }, O);
    for (const [name, subtitle] of c.options) await api("POST", `/api/org/events/${e.id}/options`, { categoryId: cat.id, name, subtitle }, O);
  }
  if (settings) await api("PATCH", `/api/org/events/${e.id}`, settings, O);
  await api("POST", `/api/org/events/${e.id}/status`, { status: "live" }, O);
  return api("GET", `/api/org/events/${e.id}`, undefined, O);
}

const election = await event(
  "2026 Executive Committee Election",
  "election",
  [
    { title: "President", description: "Leads the association and chairs general meetings.", options: [["Chinedu Okeke", "Class of 2009 · Engineering"], ["Aisha Bello", "Class of 2011 · Law"], ["Tunde Martins", "Class of 2007 · Economics"]] },
    { title: "General Secretary", options: [["Ngozi Uche", "Class of 2014"], ["Segun Ajayi", "Class of 2012"]] },
  ],
  { description: "Vote for the people who will lead the association for the next two years.", settings: { access: "public", results: { visibility: "after_close" } } },
);
const contest = await event(
  "Face of Campus 2026",
  "contest",
  [{ title: "Contestants", options: [["Tolu Adebayo", "Mass Communication"], ["Ada Okafor", "Law"], ["Kemi Balogun", "Medicine"], ["Ifeanyi Eze", "Engineering"], ["Zainab Musa", "Architecture"], ["Femi Johnson", "Economics"]] }],
  { description: "Support your favourite. ₦50 per vote, results update live.", settings: { paid: { enabled: true, pricePerVote: 50, bundles: [{ votes: 10, price: 450 }, { votes: 50, price: 2000 }] }, results: { visibility: "live" } } },
);
const awards = await event(
  "Alumni Awards Night 2026",
  "awards",
  [
    { title: "Alumnus of the Year", options: [["Dr. Bola Ogunleye", ""], ["Emeka Nwosu", ""], ["Halima Yusuf", ""], ["Kunle Adeoye", ""]] },
  ],
  { settings: { results: { visibility: "live" } } },
);
const counts = { [contest.id]: [1240, 1180, 860, 655, 410, 298], [awards.id]: [184, 152, 97, 61] };
for (const e of [contest, awards]) {
  const opts = e.categories[0].options;
  for (let i = 0; i < opts.length; i++) await api("POST", `/api/org/events/${e.id}/manual-votes`, { optionId: opts[i].id, quantity: counts[e.id][i], note: "Screenshot data" }, O);
}
// a few ballots on the election so the dashboard has activity
for (let i = 0; i < 37; i++) {
  const c = await browser.newContext();
  const p = await c.newPage();
  await p.request.fetch(`${BASE}/api/public/events/${election.slug}/ballot`, {
    method: "POST",
    headers: { "X-Requested-With": "fetch" },
    data: { choices: { [election.categories[0].id]: [election.categories[0].options[i % 3].id], [election.categories[1].id]: [election.categories[1].options[i % 2].id] } },
  });
  await c.close();
}

// ---------- Capture per theme ----------
const cfg = await api("GET", "/api/admin/appearance");
async function toWebp(png, file) {
  const b64 = png.toString("base64");
  const data = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", 0.82);
  }, `data:image/png;base64,${b64}`);
  fs.writeFileSync(file, Buffer.from(data.split(",")[1], "base64"));
}
const mobile = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mp = await mobile.newPage();
const settle = (p) => p.waitForLoadState("networkidle").then(() => p.waitForTimeout(700));

for (const theme of THEMES) {
  await api("PUT", "/api/admin/appearance", { ...cfg, themeId: theme });
  const dir = path.join(OUT, theme);
  fs.mkdirSync(dir, { recursive: true });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/app`);
  await page.evaluate((id) => localStorage.setItem("vh_org", id), O);
  await page.goto(`${BASE}/app`);
  await settle(page);
  await toWebp(await page.screenshot(), path.join(dir, "dashboard.webp"));

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${BASE}/present/${awards.id}`);
  await settle(page);
  await page.waitForTimeout(1200);
  await toWebp(await page.screenshot(), path.join(dir, "present.webp"));

  await mp.goto(`${BASE}/e/${election.slug}`);
  await settle(mp);
  await mp.evaluate(() => {
    const first = document.querySelector('input[type="radio"]');
    first?.click();
  });
  await mp.evaluate(() => window.scrollTo(0, 0));
  await mp.waitForTimeout(300);
  await toWebp(await mp.screenshot(), path.join(dir, "election.webp"));

  await mp.goto(`${BASE}/e/${contest.slug}`);
  await settle(mp);
  await mp.evaluate(() => window.scrollTo(0, 0));
  await toWebp(await mp.screenshot(), path.join(dir, "contest.webp"));
  console.log("✓", theme);
}
await api("PUT", "/api/admin/appearance", cfg);
await browser.close();
console.log(`Screenshots written to ${OUT} (signed in as ${me.user.email})`);
