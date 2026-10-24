import { useState } from "react";
import { patch, queryClient, useMe } from "../api";
import { Button, Field, PageHead, Panel, useToast } from "../ui";

export function AccountPage() {
  const me = useMe();
  const toast = useToast();
  const [busy, setBusy] = useState("");
  const user = me.data?.user;
  if (!user) return null;
  return (
    <>
      <PageHead eyebrow="Account" title="Your account" subtitle={user.email} />
      <div className="grid-2">
        <Panel title="Profile">
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy("profile");
              try {
                const r = await patch("/auth/profile", { name: new FormData(e.currentTarget).get("name") });
                queryClient.setQueryData(["me"], r);
                toast.ok("Profile updated.");
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy("");
              }
            }}
          >
            <Field label="Name">
              <input className="input" name="name" defaultValue={user.name} required minLength={2} />
            </Field>
            <Field label="Email">
              <input className="input" value={user.email} readOnly />
            </Field>
            <Button type="submit" busy={busy === "profile"}>
              Save
            </Button>
          </form>
        </Panel>
        <Panel title="Change password">
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setBusy("pw");
              try {
                await patch("/auth/profile", { currentPassword: f.get("current"), newPassword: f.get("next") });
                toast.ok("Password changed.");
                (e.target as HTMLFormElement).reset();
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy("");
              }
            }}
          >
            <Field label="Current password">
              <input className="input" type="password" name="current" required autoComplete="current-password" />
            </Field>
            <Field label="New password" hint="At least 8 characters.">
              <input className="input" type="password" name="next" required minLength={8} autoComplete="new-password" />
            </Field>
            <Button type="submit" busy={busy === "pw"}>
              Change password
            </Button>
          </form>
        </Panel>
      </div>
    </>
  );
}
