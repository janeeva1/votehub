import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

interface Ad {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  cta: string;
  clickUrl: string;
}

/** A clearly labelled sponsored card. Renders nothing on ad-free plans. */
export function AdSlot({ path, queryKey, compact }: { path: string; queryKey: unknown[]; compact?: boolean }) {
  const q = useQuery({ queryKey: ["ad", ...queryKey], queryFn: () => get<{ ad: Ad | null }>(path), staleTime: 5 * 60_000, retry: false });
  const ad = q.data?.ad;
  if (!ad) return null;
  return (
    <aside className={`ad-slot ${compact ? "compact" : ""}`} aria-label="Sponsored">
      <span className="ad-label">Sponsored</span>
      <a href={ad.clickUrl} target="_blank" rel="sponsored noopener noreferrer" className="ad-body">
        {ad.imageUrl && <img src={ad.imageUrl} alt="" loading="lazy" />}
        <span className="ad-text">
          <b>{ad.title}</b>
          {ad.body && <small>{ad.body}</small>}
        </span>
        <span className="btn btn-outline btn-sm ad-cta">{ad.cta}</span>
      </a>
    </aside>
  );
}
