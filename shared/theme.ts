/**
 * Platform colour themes. The platform admin picks one (or custom colours) in Super admin → Appearance;
 * every page — landing, dashboards, voting pages — is coloured from these CSS variables.
 */
export interface ThemeBase {
  primary: string;
  accent: string;
  bg: string;
  surface: string;
  ink: string;
  sidebar: string;
}
export interface ThemePreset extends ThemeBase {
  id: string;
  name: string;
  note: string;
}

export const THEMES: ThemePreset[] = [
  { id: "ink", name: "Violet ink", note: "Deep violet with marigold — the colour of election-day ink.", primary: "#5b2a9e", accent: "#f2711c", bg: "#f7f5fb", surface: "#ffffff", ink: "#1f1530", sidebar: "#1d1233" },
  { id: "marigold", name: "Marigold", note: "Warm orange leading, violet supporting.", primary: "#e05a0e", accent: "#5b2a9e", bg: "#fff8f3", surface: "#ffffff", ink: "#2a1a12", sidebar: "#2a140a" },
  { id: "lagoon", name: "Lagoon", note: "Clear blue with a sunny amber accent.", primary: "#1f4fd1", accent: "#f2a516", bg: "#f5f8fd", surface: "#ffffff", ink: "#111c30", sidebar: "#0e1a33" },
  { id: "coral", name: "Teal & coral", note: "Calm teal with a coral spark.", primary: "#0e7c7b", accent: "#ff6b57", bg: "#f3faf9", surface: "#ffffff", ink: "#0f2a2a", sidebar: "#0b2423" },
  { id: "crimson", name: "Crimson", note: "Bold red and gold for award nights.", primary: "#b0203a", accent: "#e3a71f", bg: "#fbf7f7", surface: "#ffffff", ink: "#2a1216", sidebar: "#2a0d13" },
  { id: "forest", name: "Forest", note: "The original green and gold.", primary: "#286352", accent: "#d9af54", bg: "#f5f3eb", surface: "#fffefa", ink: "#203930", sidebar: "#1d2f2a" },
];
export const DEFAULT_THEME_ID = "ink";

export interface Appearance {
  themeId: string; // a preset id or "custom"
  custom?: Partial<ThemeBase>;
  heroImageId?: string | null;
  galleryImageIds?: string[];
  headline?: string;
  subheadline?: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function hex([r, g, b]: number[]) {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v!))).toString(16).padStart(2, "0")).join("")}`;
}
/** Mix a towards b by t (0..1). */
export function mix(a: string, b: string, t: number) {
  const x = rgb(a), y = rgb(b);
  return hex(x.map((v, i) => v + (y[i]! - v) * t));
}
function luminance(c: string) {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** Text colour that reads on top of c. */
export function onColor(c: string, dark = "#1a1222") {
  return luminance(c) > 0.36 ? dark : "#ffffff";
}

export function resolveTheme(a: Appearance | null | undefined): ThemeBase {
  const preset = THEMES.find((t) => t.id === a?.themeId) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
  if (a?.themeId !== "custom") return preset;
  const base = THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
  const c = a.custom ?? {};
  const pick = (k: keyof ThemeBase) => (c[k] && HEX.test(c[k]!) ? c[k]! : undefined);
  const primary = pick("primary") ?? base.primary;
  return {
    primary,
    accent: pick("accent") ?? base.accent,
    bg: pick("bg") ?? mix("#ffffff", primary, 0.035),
    surface: pick("surface") ?? "#ffffff",
    ink: pick("ink") ?? mix("#141018", primary, 0.12),
    sidebar: pick("sidebar") ?? mix("#0d0a12", primary, 0.22),
  };
}

/** Every CSS variable the stylesheet uses, derived from six base colours. */
export function themeVars(t: ThemeBase): Record<string, string> {
  return {
    "--bg": t.bg,
    "--surface": t.surface,
    "--surface-2": mix(t.surface, t.primary, 0.035),
    "--ink": t.ink,
    "--ink-2": mix(t.ink, t.bg, 0.22),
    "--muted": mix(t.ink, t.bg, 0.45),
    "--line": mix(t.bg, t.ink, 0.11),
    "--line-2": mix(t.bg, t.ink, 0.06),
    "--line-strong": mix(t.bg, t.ink, 0.2),
    "--chip": mix(t.bg, t.ink, 0.075),
    "--track": mix(t.bg, t.ink, 0.07),
    "--primary": t.primary,
    "--primary-ink": onColor(t.primary),
    "--primary-hover": mix(t.primary, "#000000", 0.16),
    "--primary-soft": mix(t.primary, "#ffffff", 0.9),
    "--primary-deep": mix(t.primary, "#000000", 0.45),
    "--bar": mix(t.primary, "#ffffff", 0.35),
    "--gold": t.accent,
    "--gold-ink": luminance(t.accent) > 0.36 ? mix(t.accent, "#000000", 0.7) : "#ffffff",
    "--gold-text": mix(t.accent, "#000000", 0.55),
    "--gold-soft": mix(t.accent, "#ffffff", 0.88),
    "--gold-line": mix(t.accent, "#ffffff", 0.62),
    "--sidebar": t.sidebar,
    "--sidebar-ink": mix(t.sidebar, "#ffffff", 0.92),
    "--sidebar-muted": mix(t.sidebar, "#ffffff", 0.55),
    "--shadow": `0 1px 2px ${t.sidebar}0d, 0 8px 24px ${t.sidebar}12`,
  };
}

export function themeCss(a: Appearance | null | undefined) {
  const vars = themeVars(resolveTheme(a));
  return `html:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;
}
