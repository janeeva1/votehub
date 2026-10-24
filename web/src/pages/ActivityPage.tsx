import { useQuery } from "@tanstack/react-query";
import { get, useCurrentOrg } from "../api";
import { ErrorState, Loading, PageHead, Panel, fmtDate } from "../ui";

const labels: Record<string, string> = {
  "org.created": "Organization created",
  "org.updated": "Organization settings updated",
  "org.payment_keys_updated": "Payment gateway keys updated",
  "event.created": "Event created",
  "event.updated": "Event settings updated",
  "event.live": "Event published / voting opened",
  "event.paused": "Voting paused",
  "event.closed": "Voting closed",
  "event.archived": "Event archived",
  "event.draft": "Event moved to draft",
  "event.deleted": "Event deleted",
  "event.duplicated": "Event duplicated",
  "category.created": "Category added",
  "category.deleted": "Category removed",
  "option.created": "Option added",
  "option.deleted": "Option removed",
  "option.approved": "Nomination approved",
  "option.rejected": "Nomination rejected",
  "voter.added": "Voter added",
  "voter.removed": "Voter removed",
  "voter.code_reset": "Voter access code regenerated",
  "voters.imported": "Voters imported",
  "voters.invited": "Voter invitations sent",
  "votes.purchased": "Votes purchased",
  "votes.manual_adjustment": "Manual vote adjustment",
  "results.published": "Results published",
  "results.unpublished": "Results unpublished",
  "nomination.submitted": "Public nomination submitted",
  "team.invited": "Team member invited",
  "team.role_changed": "Team role changed",
  "team.removed": "Team member removed",
  "plan.checkout_started": "Plan checkout started",
  "plan.payment_succeeded": "Plan payment succeeded",
  "admin.org_updated": "Platform admin changed plan/status",
};

export function describeAction(action: string, detail: any) {
  const base = labels[action] ?? action;
  const extra =
    detail?.name ?? detail?.title ?? (detail?.quantity !== undefined && detail?.option ? `${detail.quantity} → ${detail.option}` : undefined) ?? (detail?.quantity ? `${detail.quantity} votes` : undefined) ?? detail?.email ?? (detail?.added !== undefined ? `${detail.added} added` : undefined);
  return extra ? `${base}: ${extra}` : base;
}

export function ActivityList({ eventId }: { eventId?: string }) {
  const org = useCurrentOrg();
  const q = useQuery({ queryKey: ["audit", org?.id, eventId], queryFn: () => get<any[]>(`/org/audit?limit=300${eventId ? `&eventId=${eventId}` : ""}`) });
  if (q.isLoading) return <Loading rows={5} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <Panel title="Activity" subtitle="Every administrative action and payment, newest first.">
      {!q.data?.length ? (
        <p className="muted">Nothing recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                {!eventId && <th>Event</th>}
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap small">{fmtDate(a.created_at)}</td>
                  <td>
                    {describeAction(a.action, a.detail)}
                    {a.detail?.note && <small className="block muted">Note: {a.detail.note}</small>}
                  </td>
                  {!eventId && <td className="small">{a.event_title ?? "—"}</td>}
                  <td className="small">{a.actor_label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function ActivityPage() {
  return (
    <>
      <PageHead eyebrow="Activity" title="Activity log" subtitle="A record of changes made by your team and payments received." />
      <ActivityList />
    </>
  );
}
