import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { canEdit, del, fileUrl, patch, post, useCurrentOrg, type CategoryItem, type EventDetail, type OptionItem } from "../api";
import { Badge, Button, ConfirmButton, Empty, Field, ImageUpload, Modal, Panel, useToast } from "../ui";
import { METHOD_HELP, METHOD_LABELS, METHODS, type Method } from "@shared/model";
import { refreshEvent } from "./EventDetail";

export function BallotTab({ e }: { e: EventDetail }) {
  const org = useCurrentOrg();
  const editable = canEdit(org?.role) && e.status !== "archived";
  const structureLocked = e.settings.mode === "ballot" && e.locked;
  const [catModal, setCatModal] = useState<CategoryItem | "new" | null>(null);
  const [optModal, setOptModal] = useState<{ category: CategoryItem; option?: OptionItem } | null>(null);
  const toast = useToast();
  const pending = e.categories.flatMap((c) => c.options.filter((o) => o.status === "pending").map((o) => ({ ...o, cat: c.title })));
  const isTally = e.settings.mode === "tally";
  const labels = isTally ? { cat: "category", opt: "entry", opts: "entries" } : { cat: "position / question", opt: "option", opts: "options" };

  const move = async (c: CategoryItem, dir: -1 | 1) => {
    const idx = e.categories.findIndex((x) => x.id === c.id);
    const other = e.categories[idx + dir];
    if (!other) return;
    try {
      await patch(`/org/events/${e.id}/categories/${c.id}`, { sortOrder: other.sortOrder ?? idx + dir });
      await patch(`/org/events/${e.id}/categories/${other.id}`, { sortOrder: c.sortOrder ?? idx });
      refreshEvent(e.id);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="stack">
      {structureLocked && <div className="notice">Ballots have been cast, so positions and options can't be added or removed. You can still fix names, descriptions and photos.</div>}
      {pending.length > 0 && (
        <Panel title={`Nominations awaiting review (${pending.length})`} subtitle="Approve to add them to the voting page.">
          <ul className="row-list">
            {pending.map((o) => (
              <li key={o.id} className="row-item">
                <span>
                  <b>{o.name}</b>
                  <small>
                    {o.cat}
                    {o.subtitle ? ` · ${o.subtitle}` : ""} · nominated by {o.submittedByEmail}
                  </small>
                  {o.description && <small className="block">{o.description}</small>}
                </span>
                {editable && (
                  <span className="btn-row">
                    <Button size="sm" onClick={() => patch(`/org/events/${e.id}/options/${o.id}`, { status: "approved" }).then(() => refreshEvent(e.id), toast.error)}>
                      <Check size={14} /> Approve
                    </Button>
                    <Button size="sm" kind="outline" onClick={() => patch(`/org/events/${e.id}/options/${o.id}`, { status: "rejected" }).then(() => refreshEvent(e.id), toast.error)}>
                      <X size={14} /> Reject
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {e.categories.length === 0 && (
        <div className="panel">
          <Empty
            title={`Add your first ${labels.cat}`}
            detail={isTally ? "e.g. “Contestants”, “Best Dressed”, “Artist of the Year”." : "e.g. “President”, or a poll question."}
            action={editable && !structureLocked ? <Button onClick={() => setCatModal("new")}><Plus size={15} /> Add {labels.cat}</Button> : undefined}
          />
        </div>
      )}
      {e.categories.map((c, i) => {
        const approved = c.options.filter((o) => o.status === "approved");
        return (
          <Panel
            key={c.id}
            title={c.title}
            subtitle={[
              isTally ? "Votes per entry" : METHOD_LABELS[c.method],
              c.method === "multiple" ? `up to ${c.maxChoices}` : c.method === "stv" ? `${c.maxChoices} seats` : null,
              c.method === "score" ? `rate 0–${c.points}` : c.method === "cumulative" ? `${c.points} points each` : null,
              c.thresholdPercent ? `needs ${c.thresholdPercent}%` : null,
              c.allowWriteIn ? "write-ins allowed" : null,
              c.voterGroups?.length ? `only: ${c.voterGroups.join(", ")}` : null,
              `${approved.length} ${labels.opts}`,
            ].filter(Boolean).join(" · ")}
            action={
              editable && (
                <div className="btn-row">
                  <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => move(c, -1)}>
                    <ArrowUp size={15} />
                  </button>
                  <button className="icon-btn" aria-label="Move down" disabled={i === e.categories.length - 1} onClick={() => move(c, 1)}>
                    <ArrowDown size={15} />
                  </button>
                  <Button kind="outline" size="sm" onClick={() => setCatModal(c)}>
                    <Pencil size={14} /> Edit
                  </Button>
                  {!structureLocked && (
                    <ConfirmButton size="sm" kind="quiet" confirm={`Remove "${c.title}" and its ${labels.opts}?`} onConfirm={() => del(`/org/events/${e.id}/categories/${c.id}`).then(() => refreshEvent(e.id), toast.error)}>
                      <Trash2 size={14} />
                    </ConfirmButton>
                  )}
                </div>
              )
            }
          >
            {c.description && <p className="muted small">{c.description}</p>}
            <div className="option-grid">
              {approved.map((o) => (
                <div key={o.id} className="option-card">
                  <div className="option-photo">{o.imageFileId ? <img src={fileUrl(o.imageFileId)!} alt="" /> : <span>{o.name.slice(0, 1)}</span>}</div>
                  <div className="option-text">
                    <b>{o.name}</b>
                    {o.subtitle && <small>{o.subtitle}</small>}
                    {e.settings.display.showCodes && <Badge>Code {o.code}</Badge>}
                  </div>
                  {editable && (
                    <div className="option-actions">
                      <button className="icon-btn" aria-label={`Edit ${o.name}`} onClick={() => setOptModal({ category: c, option: o })}>
                        <Pencil size={14} />
                      </button>
                      {!structureLocked && (
                        <ConfirmButton size="sm" kind="quiet" confirm={`Remove ${o.name}?`} onConfirm={() => del(`/org/events/${e.id}/options/${o.id}`).then(() => refreshEvent(e.id), toast.error)}>
                          <Trash2 size={14} />
                        </ConfirmButton>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {editable && !structureLocked && (
                <button className="option-card add" onClick={() => setOptModal({ category: c })}>
                  <Plus size={18} /> Add {labels.opt}
                </button>
              )}
            </div>
          </Panel>
        );
      })}
      {editable && !structureLocked && e.categories.length > 0 && (
        <Button kind="outline" onClick={() => setCatModal("new")}>
          <Plus size={15} /> Add another {labels.cat}
        </Button>
      )}
      <CategoryModal key={catModal === null ? "closed" : catModal === "new" ? "new" : catModal.id} e={e} value={catModal} onClose={() => setCatModal(null)} />
      <OptionModal e={e} value={optModal} onClose={() => setOptModal(null)} />
    </div>
  );
}

const THRESHOLDS = [
  { value: "", label: "No threshold — most votes wins" },
  { value: "50", label: "Simple majority (more than 50%)" },
  { value: "60", label: "60%" },
  { value: "66.67", label: "Two-thirds (66.67%)" },
  { value: "75", label: "Three-quarters (75%)" },
];

function CategoryModal({ e, value, onClose }: { e: EventDetail; value: CategoryItem | "new" | null; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const isNew = value === "new";
  const cat = value && value !== "new" ? value : null;
  const [method, setMethod] = useState<Method>(cat?.method ?? "single");
  const [groups, setGroups] = useState<string[]>(cat?.voterGroups ?? []);
  const isTally = e.settings.mode === "tally";
  const seatsLabel = method === "multiple" ? "Maximum choices per voter (= seats / winners)" : method === "stv" ? "Number of seats to fill" : "Number of winners";
  const showSeats = ["multiple", "stv", "borda", "score", "cumulative"].includes(method);
  const showPoints = method === "score" || method === "cumulative";
  const knownGroups = Array.from(new Set([...(e.voterGroups ?? []), ...groups]));
  return (
    <Modal open={value !== null} onClose={onClose} title={isNew ? (isTally ? "New category" : "New position / question") : "Edit"}>
      {value !== null && (
        <form
          className="form-stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            const body: Record<string, unknown> = { title: f.get("title"), description: f.get("description") };
            if (!isTally) {
              body.method = method;
              body.maxChoices = showSeats ? Number(f.get("maxChoices") || 1) : 1;
              if (showPoints) body.points = Number(f.get("points") || (method === "score" ? 5 : 10));
              body.allowWriteIn = (method === "single" || method === "multiple") && f.get("allowWriteIn") === "on";
              const th = String(f.get("threshold") ?? "");
              body.thresholdPercent = th ? Number(th) : null;
              if (e.settings.access === "roster") body.voterGroups = groups;
            }
            setBusy(true);
            try {
              if (isNew) await post(`/org/events/${e.id}/categories`, body);
              else await patch(`/org/events/${e.id}/categories/${cat!.id}`, body);
              refreshEvent(e.id);
              onClose();
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={isTally ? "Category name" : "Position or question"}>
            <input className="input" name="title" required defaultValue={cat?.title} maxLength={200} />
          </Field>
          <Field label="Description (optional)">
            <textarea className="input" name="description" rows={2} defaultValue={cat?.description} maxLength={2000} />
          </Field>
          {!isTally && (
            <>
              <Field label="Voting method" hint={METHOD_HELP[method]}>
                <select className="input" value={method} onChange={(x) => setMethod(x.target.value as Method)} disabled={e.locked}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="grid-2 tight">
                {showSeats && (
                  <Field label={seatsLabel}>
                    <input className="input" type="number" name="maxChoices" min={1} max={100} defaultValue={cat?.maxChoices ?? (method === "stv" ? 3 : method === "multiple" ? 2 : 1)} disabled={e.locked} />
                  </Field>
                )}
                {showPoints && (
                  <Field label={method === "score" ? "Highest rating (0 to …)" : "Points each voter shares out"}>
                    <input className="input" type="number" name="points" min={1} max={1000} defaultValue={cat?.points ?? (method === "score" ? 5 : 10)} disabled={e.locked} />
                  </Field>
                )}
              </div>
              {(method === "single" || method === "multiple") && (
                <label className="check">
                  <input type="checkbox" name="allowWriteIn" defaultChecked={cat?.allowWriteIn} disabled={e.locked} /> Allow write-in candidates (voters can type a name)
                </label>
              )}
              {method !== "ranked" && method !== "stv" && (
                <Field label="Winning threshold" hint="If the leading option doesn't reach it, no winner is declared (useful for motions and constitutional changes).">
                  <select className="input" name="threshold" defaultValue={cat?.thresholdPercent ? String(cat.thresholdPercent) : ""}>
                    {THRESHOLDS.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                    {cat?.thresholdPercent && !THRESHOLDS.some((t) => t.value === String(cat.thresholdPercent)) && <option value={String(cat.thresholdPercent)}>{cat.thresholdPercent}%</option>}
                  </select>
                </Field>
              )}
              {e.settings.access === "roster" && (
                <Field label="Who can vote on this? (voter groups)" hint="Leave empty for everyone. Otherwise only voters in these groups see it — e.g. a branch, chapter, faculty or class.">
                  <div className="chips">
                    {knownGroups.map((g) => (
                      <button key={g} type="button" className={groups.includes(g) ? "chip on" : "chip"} onClick={() => setGroups(groups.includes(g) ? groups.filter((x) => x !== g) : [...groups, g])} disabled={e.locked}>
                        {g}
                      </button>
                    ))}
                    <input
                      className="input input-sm"
                      placeholder="+ add group"
                      disabled={e.locked}
                      onKeyDown={(x) => {
                        if (x.key === "Enter") {
                          x.preventDefault();
                          const v = (x.target as HTMLInputElement).value.trim();
                          if (v && !groups.includes(v)) setGroups([...groups, v]);
                          (x.target as HTMLInputElement).value = "";
                        }
                      }}
                    />
                  </div>
                </Field>
              )}
            </>
          )}
          <div className="modal-actions">
            <Button kind="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function OptionModal({ e, value, onClose }: { e: EventDetail; value: { category: CategoryItem; option?: OptionItem } | null; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [lastKey, setLastKey] = useState("");
  const key = value ? `${value.category.id}:${value.option?.id ?? "new"}` : "";
  if (key !== lastKey) {
    setLastKey(key);
    setImage(value?.option?.imageFileId ?? null);
  }
  const o = value?.option;
  const isTally = e.settings.mode === "tally";
  return (
    <Modal open={value !== null} onClose={onClose} title={o ? `Edit ${o.name}` : `Add to ${value?.category.title ?? ""}`}>
      {value && (
        <form
          key={key}
          className="form-stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const f = new FormData(ev.currentTarget);
            const body: Record<string, unknown> = {
              categoryId: value.category.id,
              name: f.get("name"),
              subtitle: f.get("subtitle"),
              description: f.get("description"),
              imageFileId: image,
            };
            const code = String(f.get("code") ?? "").trim();
            if (code) body.code = code;
            setBusy(true);
            try {
              if (o) await patch(`/org/events/${e.id}/options/${o.id}`, body);
              else await post(`/org/events/${e.id}/options`, body);
              refreshEvent(e.id);
              onClose();
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={isTally ? "Name" : "Candidate / option"}>
            <input className="input" name="name" required maxLength={200} defaultValue={o?.name} autoFocus />
          </Field>
          <Field label="Subtitle (optional)" hint={isTally ? "e.g. department, stage name, state" : "e.g. class of 2012, party, short tagline"}>
            <input className="input" name="subtitle" maxLength={200} defaultValue={o?.subtitle} />
          </Field>
          <Field label="Bio / manifesto (optional)">
            <textarea className="input" name="description" rows={4} maxLength={5000} defaultValue={o?.description} />
          </Field>
          <ImageUpload label="Photo (optional)" value={image} onChange={setImage} round />
          <Field label="Vote code (optional)" hint="Short code shown to voters, e.g. for SMS/WhatsApp campaigns. Generated automatically if empty.">
            <input className="input" name="code" maxLength={12} defaultValue={o?.code} pattern="[A-Za-z0-9]{2,12}" />
          </Field>
          <div className="modal-actions">
            <Button kind="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
