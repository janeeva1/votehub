import { AdSlot } from "../ads";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity, ArrowRight, Banknote, CheckSquare, Plus, Vote } from "lucide-react";
import { get, useCurrentOrg, type EventSummary } from "../api";
import { Empty, ErrorState, Loading, PageHead, Panel, Stat, StateBadge, fmtDate, fmtNum } from "../ui";
import { formatMoney, fromMinor } from "@shared/model";
import { describeAction } from "./ActivityPage";

export function Dashboard() {
  const org = useCurrentOrg();
  const dash = useQuery({ queryKey: ["dashboard", org?.id], queryFn: () => get("/org/dashboard") });
  const events = useQuery({ queryKey: ["events", org?.id], queryFn: () => get<EventSummary[]>("/org/events") });
  const d = dash.data;
  const live = (events.data ?? []).filter((e) => e.status === "live" || e.status === "paused");
  return (
    <>
      <PageHead
        eyebrow="Overview"
        title={org?.name ?? "Overview"}
        subtitle="Everything happening across your events."
        action={
          <Link href="/events?new=1" className="btn btn-primary">
            <Plus size={16} /> New event
          </Link>
        }
      />
      {dash.isError ? (
        <ErrorState error={dash.error} retry={() => dash.refetch()} />
      ) : (
        <div className="stat-grid">
          <Stat label="Live events" value={dash.isLoading ? "…" : (d?.eventsByStatus?.live ?? 0) + (d?.eventsByStatus?.paused ?? 0)} note={`${Object.values(d?.eventsByStatus ?? {}).reduce((a: number, b: any) => a + Number(b), 0)} events in total`} icon={<Vote size={17} />} accent />
          <Stat label="Votes counted" value={dash.isLoading ? "…" : fmtNum(d?.totalVotes)} note="All events, including paid votes" icon={<CheckSquare size={17} />} />
          <Stat label="Ballots submitted" value={dash.isLoading ? "…" : fmtNum(d?.ballots)} note="Full ballots (elections, polls)" icon={<Activity size={17} />} />
          <Stat
            label="Paid-vote revenue"
            value={dash.isLoading ? "…" : d?.revenue?.length ? d.revenue.map((r: any) => formatMoney(fromMinor(r.total, r.currency), r.currency)).join(" · ") : "—"}
            note={d?.revenue?.length ? `${d.revenue.reduce((a: number, r: any) => a + r.n, 0)} successful payments` : "No paid votes yet"}
            icon={<Banknote size={17} />}
          />
        </div>
      )}
      <AdSlot path="/org/ad" queryKey={["dashboard", org?.id]} />
      <div className="grid-2">
        <Panel
          title="Live now"
          action={
            <Link href="/events" className="text-link">
              All events <ArrowRight size={14} />
            </Link>
          }
        >
          {events.isLoading ? (
            <Loading />
          ) : live.length === 0 ? (
            <Empty title="Nothing live yet" detail="Create an event from a template and publish it when it's ready." action={<Link href="/events?new=1" className="btn btn-primary btn-sm">Create an event</Link>} />
          ) : (
            <ul className="row-list">
              {live.map((e) => (
                <li key={e.id}>
                  <Link href={`/events/${e.id}`} className="row-link">
                    <span>
                      <b>{e.title}</b>
                      <small>
                        {e.settings.mode === "tally" ? `${fmtNum(e.voteTotal)} votes` : `${fmtNum(e.ballotCount)} ballots`} · {e.endsAt ? `ends ${fmtDate(e.endsAt)}` : "no end time set"}
                      </small>
                    </span>
                    <StateBadge value={e.state} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="Recent activity"
          action={
            <Link href="/activity" className="text-link">
              Full log <ArrowRight size={14} />
            </Link>
          }
        >
          {dash.isLoading ? (
            <Loading />
          ) : !d?.recent?.length ? (
            <p className="muted">No activity yet.</p>
          ) : (
            <ul className="activity-list">
              {d.recent.map((a: any, i: number) => (
                <li key={i}>
                  <span className="dot" />
                  <span>
                    <b>{describeAction(a.action, a.detail)}</b>
                    <small>
                      {a.event_title ? `${a.event_title} · ` : ""}
                      {a.actor_label} · {fmtDate(a.created_at)}
                    </small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
