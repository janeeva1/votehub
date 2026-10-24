import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ClipboardList, Copy, ImagePlus, Loader2, X } from "lucide-react";
import { ApiError, post, readImage } from "./api";

// ---------- Toasts ----------
type Toast = { id: number; kind: "ok" | "error"; text: string };
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6500 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "ok" ? <Check size={16} /> : <AlertTriangle size={16} />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const push = useContext(ToastCtx);
  return {
    ok: (t: string) => push("ok", t),
    error: (e: unknown) => push("error", e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  };
}

// ---------- Basic elements ----------
export function Button({
  children,
  kind = "primary",
  size,
  busy,
  className = "",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "outline" | "quiet" | "danger" | "gold"; size?: "sm" | "lg"; busy?: boolean }) {
  return (
    <button type="button" className={`btn btn-${kind} ${size ? `btn-${size}` : ""} ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy && <Loader2 size={15} className="spin" />}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? "is-disabled" : ""}`}>
      <span className="toggle-text">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          <b>{o.label}</b>
          {o.hint && <small>{o.hint}</small>}
        </button>
      ))}
    </div>
  );
}

export function Panel({ children, className = "", title, action, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`panel ${className}`}>
      {(title || action) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHead({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {action && <div className="page-actions">{action}</div>}
    </header>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="loading-list" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="state-error" role="alert">
      <AlertTriangle size={18} />
      <span>
        <b>We couldn't load this.</b>
        <small>{error instanceof Error ? error.message : "Please try again."}</small>
      </span>
      {retry && (
        <Button kind="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Empty({ title, detail, action, icon }: { title: string; detail?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon ?? <ClipboardList />}</div>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "gold" | "red" | "blue" | "dark" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const stateTone: Record<string, "neutral" | "green" | "gold" | "red" | "blue" | "dark"> = {
  draft: "neutral",
  open: "green",
  live: "green",
  not_started: "blue",
  paused: "gold",
  ended: "dark",
  closed: "dark",
  archived: "neutral",
  success: "green",
  pending: "gold",
  failed: "red",
  approved: "green",
  rejected: "red",
};
const stateLabel: Record<string, string> = { not_started: "Scheduled", open: "Voting open", ended: "Ended" };
export function StateBadge({ value }: { value: string }) {
  return <Badge tone={stateTone[value] ?? "neutral"}>{stateLabel[value] ?? value.replaceAll("_", " ")}</Badge>;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmButton({ children, confirm, onConfirm, kind = "danger", size }: { children: ReactNode; confirm: string; onConfirm: () => Promise<unknown> | void; kind?: "danger" | "outline" | "quiet"; size?: "sm" }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button kind={kind} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Please confirm">
        <p>{confirm}</p>
        <div className="modal-actions">
          <Button kind="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            kind={kind === "danger" ? "danger" : "primary"}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                setOpen(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Confirm
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {label && <span className="field-label">{label}</span>}
      <div>
        <input readOnly value={value} onFocus={(e) => e.target.select()} />
        <button
          type="button"
          className="icon-btn"
          aria-label="Copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked */
            }
          }}
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
}

export function ImageUpload({ value, onChange, label = "Image", round, endpoint = "/org/files" }: { value: string | null; onChange: (id: string | null) => void; label?: string; round?: boolean; endpoint?: string }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <div className="image-upload">
      <span className="field-label">{label}</span>
      <div className="image-upload-row">
        <div className={`image-preview ${round ? "round" : ""}`}>{value ? <img src={`/api/files/${value}`} alt="" /> : <ImagePlus size={20} />}</div>
        <label className="btn btn-outline btn-sm">
          {busy ? <Loader2 size={14} className="spin" /> : null}
          {value ? "Replace" : "Upload"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              try {
                const dataUrl = await readImage(file);
                const r = await post<{ id: string }>(endpoint, { dataUrl });
                onChange(r.id);
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          />
        </label>
        {value && (
          <Button kind="quiet" size="sm" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

export function Stat({ label, value, note, icon, accent }: { label: string; value: ReactNode; note?: ReactNode; icon?: ReactNode; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "stat-accent" : ""}`}>
      {icon && <div className="stat-icon">{icon}</div>}
      <p>{label}</p>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string; badge?: number }[]; onChange: (v: T) => void }) {
  return (
    <nav className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? "on" : ""} onClick={() => onChange(t.value)}>
          {t.label}
          {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
        </button>
      ))}
    </nav>
  );
}

export const fmtDate = (v?: string | null) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
/** Converts an ISO date into a value for <input type="datetime-local"> in the user's timezone. */
export const toLocalInput = (v?: string | null) => {
  if (!v) return "";
  const d = new Date(v);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function Bar({ percent, winner, color }: { percent: number; winner?: boolean; color?: string }) {
  return (
    <div className="bar">
      <span style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: color }} className={winner ? "winner" : ""} />
    </div>
  );
}
