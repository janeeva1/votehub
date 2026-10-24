import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Maximize2, Vote } from "lucide-react";
import { get, type EventDetail } from "../api";
import { Badge, Loading, fmtNum } from "../ui";
import { ResultCategories, type PubEvent, type PubResults } from "./PublicEvent";

/** Compact widget for other websites: <iframe src="https://…/embed/slug">. Voting opens in a new tab. */
export function EmbedPage() {
  const { slug = "" } = useParams<{ slug: string }>();
  const q = useQuery({ queryKey: ["embed", slug], queryFn: () => get<PubEvent>(`/public/events/${slug}`), refetchInterval: 15_000, retry: false });
  if (q.isLoading) return <div className="embed"><Loading rows={2} /></div>;
  if (q.isError || !q.data) return <div className="embed muted">This vote isn't available.</div>;
  const e = q.data;
  const open = e.state === "open";
  const accent = e.settings.display.accentColor ?? e.org.primaryColor ?? undefined;
  return (
    <div className="embed" style={accent ? ({ "--accent": accent } as React.CSSProperties) : undefined}>
      <header>
        <div>
          <small className="muted">{e.org.name}</small>
          <h2>{e.title}</h2>
        </div>
        <Badge tone={open ? "green" : "dark"}>{open ? "Voting open" : e.state === "not_started" ? "Opens soon" : "Closed"}</Badge>
      </header>
      {e.results ? (
        <ResultCategories results={e.results} live={open} />
      ) : (
        <p className="muted small">{e.locked ? "This vote is password protected." : `${e.categories.length} question(s) · results will be published by the organizer.`}</p>
      )}
      {open && (
        <a className="btn btn-primary wide" href={`/e/${e.slug}`} target="_blank" rel="noopener">
          <Vote size={15} /> Vote now
        </a>
      )}
      {e.showPlatformBranding && (
        <a className="embed-brand" href="/" target="_blank" rel="noopener">
          Powered by {e.appName}
        </a>
      )}
    </div>
  );
}

/** Full-screen live results for projectors at meetings and award nights (organizers only). */
export function PresentPage() {
  const { id = "" } = useParams<{ id: string }>();
  const ev = useQuery({ queryKey: ["event", id], queryFn: () => get<EventDetail>(`/org/events/${id}`), refetchInterval: 15_000 });
  const res = useQuery({ queryKey: ["results", id, "present"], queryFn: () => get<PubResults & { turnout: { voters: number; voted: number } }>(`/org/events/${id}/results`), refetchInterval: 4_000 });
  if (ev.isLoading || res.isLoading) return <div className="center-page"><Loading /></div>;
  if (ev.isError || !ev.data) return <div className="center-page">{(ev.error as Error)?.message ?? "Not found"}</div>;
  const e = ev.data;
  const r = res.data!;
  const live = e.state === "open";
  const turnout = r.turnout?.voters ? Math.round((r.turnout.voted / r.turnout.voters) * 100) : null;
  return (
    <div className="present" style={e.settings.display.accentColor ? ({ "--accent": e.settings.display.accentColor } as React.CSSProperties) : undefined}>
      <aside>
        <p className="eyebrow">{live ? "● Live" : "Results"}</p>
        <h1>{e.title}</h1>
        <div className="present-stats">
          {e.settings.mode === "ballot" ? (
            <div>
              <strong>{fmtNum(r.ballots)}</strong>
              <span>ballots</span>
            </div>
          ) : (
            <div>
              <strong>{fmtNum(e.stats.votes)}</strong>
              <span>votes</span>
            </div>
          )}
          {turnout !== null && (
            <div>
              <strong>{turnout}%</strong>
              <span>turnout</span>
            </div>
          )}
        </div>
        {live && (
          <div className="present-qr">
            <img src={`/api/public/events/${e.slug}/qr.svg`} alt="" />
            <span>Scan to vote · {location.host}/e/{e.slug}</span>
          </div>
        )}
        <button className="btn btn-outline btn-sm present-full" onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined)}>
          <Maximize2 size={14} /> Full screen
        </button>
      </aside>
      <main>
        <ResultCategories results={r} live={live} big />
      </main>
    </div>
  );
}
