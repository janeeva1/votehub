import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { Award, BarChart3, CalendarClock, ListOrdered, PieChart, Plus, Scale, Search, Sparkles, Trophy, Users, Vote } from "lucide-react";
import { canEdit, get, post, useCurrentOrg, type EventSummary } from "../api";
import { Button, Empty, ErrorState, Field, Loading, Modal, PageHead, StateBadge, fmtDate, fmtNum, fromLocalInput, useToast } from "../ui";
import { TEMPLATES, formatMoney } from "@shared/model";

const templateIcon: Record<string, React.ReactNode> = {
  election: <Vote />,
  contest: <Trophy />,
  awards: <Award />,
  poll: <BarChart3 />,
  agm: <Scale />,
  ranked: <ListOrdered />,
  board: <Users />,
  budget: <PieChart />,
  meeting: <CalendarClock />,
  custom: <Sparkles />,
};

export function describeEvent(e: EventSummary) {
  const s = e.settings;
  const parts: string[] = [];
  parts.push(s.mode === "ballot" ? "Full ballot" : "Per-entry votes");
  parts.push(s.access === "roster" ? "voter list" : s.access === "email" ? "verified email" : "open to anyone");
  if (s.mode === "tally" && s.paid.enabled) parts.push(`${formatMoney(s.paid.pricePerVote, s.paid.currency)}/vote`);
  if (s.mode === "tally" && s.freeVotes.enabled) parts.push(`${s.freeVotes.perVoter} free ${s.freeVotes.period === "daily" ? "per day" : "vote(s)"}`);
  return parts.join(" · ");
}

export function EventsPage() {
  const org = useCurrentOrg();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("active");
  const events = useQuery({ queryKey: ["events", org?.id], queryFn: () => get<EventSummary[]>("/org/events") });
  const creating = new URLSearchParams(search).get("new") === "1";
  const list = (events.data ?? []).filter(
    (e) => (status === "all" || (status === "active" ? e.status !== "archived" : e.status === status)) && (!filter || e.title.toLowerCase().includes(filter.toLowerCase())),
  );
  return (
    <>
      <PageHead
        eyebrow="Events"
        title="Events & votes"
        subtitle="Elections, polls, contests and awards for your organization."
        action={
          canEdit(org?.role) && (
            <Button onClick={() => navigate("/events?new=1")}>
              <Plus size={16} /> New event
            </Button>
          )
        }
      />
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input placeholder="Search events" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <select className="input input-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="active">All except archived</option>
          <option value="draft">Drafts</option>
          <option value="live">Live</option>
          <option value="paused">Paused</option>
          <option value="closed">Closed</option>
          <option value="archived">Archived</option>
          <option value="all">Everything</option>
        </select>
      </div>
      {events.isLoading ? (
        <Loading rows={4} />
      ) : events.isError ? (
        <ErrorState error={events.error} retry={() => events.refetch()} />
      ) : list.length === 0 ? (
        <div className="panel">
          <Empty
            title={events.data?.length ? "No events match" : "Create your first event"}
            detail={events.data?.length ? "Try a different search or filter." : "Start from a template — election, contest, awards, poll, AGM or ranked choice — then adjust any setting."}
            action={canEdit(org?.role) && !events.data?.length ? <Button onClick={() => navigate("/events?new=1")}>Choose a template</Button> : undefined}
          />
        </div>
      ) : (
        <div className="event-grid">
          {list.map((e) => (
            <Link key={e.id} href={`/events/${e.id}`} className="event-card">
              <div className="event-card-top">
                <span className="event-icon">{templateIcon[e.template] ?? <Vote />}</span>
                <StateBadge value={e.status === "live" ? e.state : e.status} />
              </div>
              <h3>{e.title}</h3>
              <p className="muted small">{describeEvent(e)}</p>
              <div className="event-card-meta">
                <span>
                  <b>{e.settings.mode === "tally" ? fmtNum(e.voteTotal) : fmtNum(e.ballotCount)}</b> {e.settings.mode === "tally" ? "votes" : "ballots"}
                </span>
                {e.settings.access === "roster" && (
                  <span>
                    <b>{fmtNum(e.voterCount)}</b> voters
                  </span>
                )}
                <span>
                  <b>{fmtNum(e.optionCount)}</b> options
                </span>
              </div>
              <small className="muted">{e.endsAt ? `Ends ${fmtDate(e.endsAt)}` : `Created ${fmtDate(e.createdAt)}`}</small>
            </Link>
          ))}
        </div>
      )}
      <CreateEventModal open={creating} onClose={() => navigate("/events", { replace: true })} />
    </>
  );
}

function CreateEventModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();
  const toast = useToast();
  const template = TEMPLATES.find((t) => t.id === templateId);
  const close = () => {
    setTemplateId(null);
    onClose();
  };
  return (
    <Modal open={open} onClose={close} title={template ? `New ${template.name.toLowerCase()}` : "What are you running?"} wide>
      {!template ? (
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} className="template-card" onClick={() => setTemplateId(t.id)}>
              <span className="event-icon">{templateIcon[t.id]}</span>
              <b>{t.name}</b>
              <span>{t.tagline}</span>
              <small>{t.examples}</small>
            </button>
          ))}
        </div>
      ) : (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            try {
              const created = await post<EventSummary>("/org/events", {
                title: f.get("title"),
                description: f.get("description"),
                templateId: template.id,
                startsAt: fromLocalInput(String(f.get("startsAt") ?? "")),
                endsAt: fromLocalInput(String(f.get("endsAt") ?? "")),
              });
              toast.ok("Event created. Add your options next.");
              setTemplateId(null);
              navigate(`/events/${created.id}/ballot`);
            } catch (err) {
              toast.error(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="muted">{template.tagline} You can change every setting afterwards.</p>
          <Field label="Title">
            <input className="input" name="title" required minLength={3} maxLength={160} placeholder={template.id === "contest" ? "e.g. Miss Campus 2026" : template.id === "election" ? "e.g. Executive Committee Election 2026" : "Event title"} autoFocus />
          </Field>
          <Field label="Description (optional)">
            <textarea className="input" name="description" rows={3} maxLength={5000} placeholder="What is this vote about? Shown on the voting page." />
          </Field>
          <div className="grid-2 tight">
            <Field label="Voting opens (optional)" hint="Leave empty to open as soon as you publish.">
              <input className="input" type="datetime-local" name="startsAt" />
            </Field>
            <Field label="Voting closes (optional)" hint="Leave empty to close manually.">
              <input className="input" type="datetime-local" name="endsAt" />
            </Field>
          </div>
          <div className="modal-actions">
            <Button kind="outline" onClick={() => setTemplateId(null)}>
              Back
            </Button>
            <Button type="submit" busy={busy}>
              Create event
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
