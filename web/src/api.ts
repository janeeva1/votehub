import { QueryClient, useQuery } from "@tanstack/react-query";
import type { Plan, EventSettings, Role, Method, EventPass } from "@shared/model";
import type { Appearance } from "@shared/theme";

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

const ORG_KEY = "vh_org";
export const getOrgId = () => {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
};
export const setOrgId = (id: string | null) => {
  try {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  } catch {
    /* storage unavailable */
  }
};

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "fetch" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const org = getOrgId();
  if (org && !path.startsWith("/public")) headers["X-Org-Id"] = org;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    // A stale organization id (e.g. removed from team) — forget it and let the app pick another.
    if (res.status === 403 && org && /not a member/.test(data?.error ?? "")) setOrgId(null);
    // Terms changed since the user last accepted them: refresh "me" so the acceptance screen appears.
    if (res.status === 428 && data?.code === "TERMS_REQUIRED") void queryClient.invalidateQueries({ queryKey: ["me"] });
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`, data?.code);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>("PUT", p, b);
export const del = <T = any>(p: string) => api<T>("DELETE", p);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, err) => n < 1 && !(err instanceof ApiError && err.status >= 400 && err.status < 500), staleTime: 15_000, refetchOnWindowFocus: false },
  },
});

// ---------- Shared types ----------
export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  orgType: string;
  plan: string;
  planExpiresAt: string | null;
  suspended: boolean;
  role: Role;
}
export interface Me {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean; termsAccepted: boolean; termsAcceptedAt: string | null } | null;
  organizations: OrgSummary[];
}
export interface AppConfig {
  appName: string;
  allowSignups: boolean;
  testPayments: boolean;
  mailEnabled: boolean;
  plans: Plan[];
  passes: EventPass[];
  platformCurrency: string;
  legal: LegalInfo;
  appearance: Appearance;
}
export interface LegalInfo {
  companyName: string;
  tradingName: string;
  registrationNumber: string;
  address: string;
  contactEmail: string;
  privacyEmail: string;
  governingLaw: string;
  courts: string;
  arbitrationSeat: string;
  minimumAge: number;
  liabilityCapMinor: number;
  termsVersion: string;
  updatedAt: string;
}
export interface OptionItem {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  imageFileId: string | null;
  code: string;
  status?: "approved" | "pending" | "rejected";
  sortOrder?: number;
  submittedByEmail?: string | null;
}
export interface CategoryItem {
  id: string;
  title: string;
  description: string;
  method: Method;
  maxChoices: number;
  points: number;
  allowWriteIn: boolean;
  thresholdPercent: number | null;
  voterGroups: string[];
  sortOrder?: number;
  options: OptionItem[];
}
export interface EventSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  template: string;
  status: "draft" | "live" | "paused" | "closed" | "archived";
  state: string;
  startsAt: string | null;
  endsAt: string | null;
  resultsPublished: boolean;
  coverFileId: string | null;
  settings: EventSettings;
  publicUrl: string;
  passVoters: number | null;
  hasPassword: boolean;
  createdAt: string;
  voterCount?: number;
  ballotCount?: number;
  voteTotal?: number;
  optionCount?: number;
}
export interface EventDetail extends EventSummary {
  categories: CategoryItem[];
  stats: { voters: number; voted: number; ballots: number; votes: number; pending_nominations: number; revenue: { currency: string; totalMajor: number; feesMajor: number; votes: number; n: number }[] };
  locked: boolean;
  paymentMethods: { id: string; label: string; kind: "gateway" | "manual" | "test"; instructions?: string }[];
  voterGroups: string[];
  commentCount: number;
  smsAvailable: boolean;
  plan: { id: string; name: string; paidVoting: boolean; maxVotersPerEvent: number | null; maxBallotsPerEvent: number | null; platformFeePercent: number; sms: boolean; api: boolean };
}

export const fileUrl = (id: string | null | undefined) => (id ? `/api/files/${id}` : null);

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/auth/me"), staleTime: 60_000 });
}
export function useConfig() {
  return useQuery({ queryKey: ["config"], queryFn: () => get<AppConfig>("/config"), staleTime: 5 * 60_000 });
}

/** The organization currently selected (stored id if still valid, otherwise the first). */
export function useCurrentOrg(): OrgSummary | null {
  const me = useMe();
  const orgs = me.data?.organizations ?? [];
  const stored = getOrgId();
  const org = orgs.find((o) => o.id === stored) ?? orgs[0] ?? null;
  if (org && org.id !== stored) setOrgId(org.id);
  return org;
}

export const canEdit = (role?: Role | null) => role === "owner" || role === "admin" || role === "officer";
export const isAdmin = (role?: Role | null) => role === "owner" || role === "admin";

export async function readImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
  // Downscale large photos in the browser so uploads stay small.
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap || file.type === "image/gif") {
    if (file.size > 2_500_000) throw new Error("Images must be 2.5 MB or smaller.");
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Could not read the image."));
      r.readAsDataURL(file);
    });
  }
  const max = 1200;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.86);
}

export type { EventPass };
