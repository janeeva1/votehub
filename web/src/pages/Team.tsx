import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Trash2, UserPlus } from "lucide-react";
import { del, get, isAdmin, patch, post, queryClient, useCurrentOrg, useMe } from "../api";
import { Badge, Button, ConfirmButton, CopyField, Field, Loading, Modal, PageHead, Panel, fmtDate, useToast } from "../ui";
import { ROLE_LABELS, ROLES, type Role } from "@shared/model";

const roleHelp: Record<Role, string> = {
  owner: "Everything, including billing, admins and deleting the organization's data.",
  admin: "Manage events, team, payment keys, publish results and manual adjustments.",
  officer: "Create and run events, manage ballots and voter lists.",
  viewer: "Read-only access to events, results and activity.",
};

export function TeamPage() {
  const org = useCurrentOrg();
  const me = useMe();
  const toast = useToast();
  const team = useQuery({ queryKey: ["team", org?.id], queryFn: () => get<{ members: any[]; invites: any[] }>("/org/team") });
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const admin = isAdmin(org?.role);
  const reload = () => void team.refetch();
  const orgInfo = useQuery({ queryKey: ["org", org?.id], queryFn: () => get("/org") });
  const maxSeats: number | null = orgInfo.data?.plan?.maxTeamMembers ?? null;
  const usedSeats = (team.data?.members.length ?? 0) + (team.data?.invites.length ?? 0);
  return (
    <>
      <PageHead
        eyebrow="Team"
        title="People who manage voting"
        subtitle="Invite colleagues and choose what they can do."
        action={
          admin && (
            <Button onClick={() => (setInviting(true), setInviteUrl(null))}>
              <UserPlus size={16} /> Invite
            </Button>
          )
        }
      />
      <Panel title="Members" subtitle={maxSeats !== null ? `${usedSeats} of ${maxSeats} seats used on the ${orgInfo.data?.plan?.name} plan (pending invitations included).` : undefined}>
        {maxSeats !== null && usedSeats >= maxSeats && admin && (
          <div className="notice">
            Your team is full. <a href="/app/billing">Upgrade your plan</a> to invite more people.
          </div>
        )}
        {team.isLoading ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {team.data?.members.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.name}</b> {m.id === me.data?.user?.id && <Badge>You</Badge>}
                      <small className="block muted">{m.email}</small>
                    </td>
                    <td>
                      {admin && m.id !== me.data?.user?.id ? (
                        <select
                          className="input input-sm"
                          value={m.role}
                          onChange={async (x) => {
                            try {
                              await patch(`/org/team/${m.id}`, { role: x.target.value });
                              toast.ok("Role updated.");
                              reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r} disabled={(r === "owner" || r === "admin") && org?.role !== "owner"}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge tone={m.role === "owner" ? "gold" : "neutral"}>{ROLE_LABELS[m.role as Role]}</Badge>
                      )}
                    </td>
                    <td className="small">{fmtDate(m.created_at)}</td>
                    <td>
                      {(admin || m.id === me.data?.user?.id) && (
                        <ConfirmButton
                          size="sm"
                          kind="quiet"
                          confirm={m.id === me.data?.user?.id ? "Leave this organization?" : `Remove ${m.name} from the team?`}
                          onConfirm={async () => {
                            try {
                              await del(`/org/team/${m.id}`);
                              if (m.id === me.data?.user?.id) {
                                await queryClient.invalidateQueries();
                                location.href = "/app";
                              } else reload();
                            } catch (err) {
                              toast.error(err);
                            }
                          }}
                        >
                          <Trash2 size={14} />
                        </ConfirmButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {!!team.data?.invites.length && (
        <Panel title="Pending invitations">
          <ul className="row-list">
            {team.data.invites.map((i) => (
              <li key={i.id} className="row-item">
                <span>
                  <b>{i.email}</b>
                  <small>
                    {ROLE_LABELS[i.role as Role]} · invited {fmtDate(i.created_at)}
                  </small>
                </span>
                {admin && (
                  <Button kind="quiet" size="sm" onClick={() => del(`/org/team/invites/${i.id}`).then(reload, toast.error)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel title="What each role can do">
        <ul className="kv">
          {ROLES.map((r) => (
            <li key={r}>
              <span>{ROLE_LABELS[r]}</span>
              <b className="normal">{roleHelp[r]}</b>
            </li>
          ))}
        </ul>
      </Panel>
      <Modal open={inviting} onClose={() => setInviting(false)} title="Invite a team member">
        {inviteUrl ? (
          <div className="form-stack">
            <p>Invitation created. If email isn't configured, share this link with them directly:</p>
            <CopyField value={inviteUrl} />
            <Button onClick={() => setInviting(false)}>Done</Button>
          </div>
        ) : (
          <form
            className="form-stack"
            onSubmit={async (ev) => {
              ev.preventDefault();
              const f = new FormData(ev.currentTarget);
              setBusy(true);
              try {
                const r = await post<{ inviteUrl: string; emailed: boolean }>("/org/team/invites", { email: f.get("email"), role: f.get("role") });
                toast.ok(r.emailed ? "Invitation emailed." : "Invitation created.");
                setInviteUrl(r.inviteUrl);
                reload();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Email">
              <input className="input" type="email" name="email" required />
            </Field>
            <Field label="Role">
              <select className="input" name="role" defaultValue="officer">
                {(["admin", "officer", "viewer"] as Role[]).map((r) => (
                  <option key={r} value={r} disabled={r === "admin" && org?.role !== "owner"}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="modal-actions">
              <Button kind="outline" onClick={() => setInviting(false)}>
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                Send invitation
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
