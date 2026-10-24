import { z } from "zod";
import { db } from "../db";
import { THEMES, themeCss, type Appearance } from "../../shared/theme";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a colour like #5b2a9e");
export const appearanceSchema = z.object({
  themeId: z.enum([...THEMES.map((t) => t.id), "custom"] as unknown as [string, ...string[]]).default("ink"),
  custom: z.object({ primary: hex.optional(), accent: hex.optional(), bg: hex.optional(), surface: hex.optional(), ink: hex.optional(), sidebar: hex.optional() }).default({}),
  heroImageId: z.string().uuid().nullable().default(null),
  galleryImageIds: z.array(z.string().uuid()).max(6).default([]),
  headline: z.string().trim().max(90).default(""),
  subheadline: z.string().trim().max(260).default(""),
});

let cache: { at: number; value: Appearance } | null = null;

export async function getAppearance(): Promise<Appearance> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const row = await db.one("SELECT value FROM platform_settings WHERE key = 'appearance'");
  const parsed = appearanceSchema.safeParse(row?.value ?? {});
  const value = parsed.success ? parsed.data : appearanceSchema.parse({});
  cache = { at: Date.now(), value };
  return value;
}

export async function setAppearance(value: z.infer<typeof appearanceSchema>) {
  await db.query(
    `INSERT INTO platform_settings (key, value) VALUES ('appearance', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)],
  );
  cache = null;
  return getAppearance();
}

/** Puts the chosen colours into the page before it renders, so there is no flash of the default theme. */
export async function injectTheme(html: string) {
  const a = await getAppearance().catch(() => null);
  const css = themeCss(a);
  const color = /--primary:(#[0-9a-f]{6})/.exec(css)?.[1] ?? "#5b2a9e";
  return html.replace("</head>", `<style id="vh-theme">${css}</style><meta name="theme-color" content="${color}" /></head>`);
}
