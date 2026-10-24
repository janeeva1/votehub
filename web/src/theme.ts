import { useEffect } from "react";
import { useConfig } from "./api";
import { themeCss, type Appearance } from "@shared/theme";

/** Applies the platform theme chosen by the admin (also updates live after it changes). */
export function applyTheme(a: Appearance | null | undefined) {
  let el = document.getElementById("vh-theme") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "vh-theme";
    document.head.appendChild(el);
  }
  el.textContent = themeCss(a);
}

export function useThemeSync() {
  const cfg = useConfig();
  const a = cfg.data?.appearance;
  useEffect(() => {
    if (a) applyTheme(a);
  }, [a]);
}

export function themePrimary() {
  return getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#5b2a9e";
}
