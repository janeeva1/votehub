import { AgreeBox } from "./Legal";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { get, post, queryClient, setOrgId, useConfig, useMe, type Me } from "../api";
import { Button, Field, Loading } from "../ui";
import { Brand } from "./Landing";

function AuthLayout({ title, subtitle, children, side }: { title: string; subtitle: string; children: ReactNode; side?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-copy">
        <Link href="/">
          <Brand />
        </Link>
        {side ?? (
          <>
            <p className="eyebrow">Elections · polls · contests · awards</p>
            <h1>Good decisions start with a clear process.</h1>
            <p>One workspace for the people who organize, and a simple ballot for everyone who votes.</p>
          </>
        )}
      </div>
      <div className="auth-card">
        <h2>{title}</h2>
        <p className="muted">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

const nextParam = () => {
  const n = new URLSearchParams(location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") ? n : null;
};

async function afterAuth(me: Me, navigate: (to: string) => void, preferOrg?: string) {
  queryClient.clear();
  queryClient.setQueryData(["me"], me);
  if (preferOrg) setOrgId(preferOrg);
  const next = nextParam();
  if (next) return navigate(next);
  const plan = new URLSearchParams(location.search).get("plan");
  if (me.organizations.length) return navigate("/app");
  // The platform owner runs the platform; they don't need an organization of their own.
  if (me.user?.isPlatformAdmin && !plan) return navigate("/app/admin");
  navigate(plan ? `/onboarding?plan=${encodeURIComponent(plan)}` : "/onboarding");
}

export function SignIn() {
  const [, navigate] = useLocation();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const me = useMe();
  if (me.data?.user && !busy) {
    navigate(nextParam() ?? "/app", { replace: true });
    return null;
  }
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await post<Me>("/auth/login", { email: f.get("email"), password: f.get("password") });
      await afterAuth(result, navigate);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your organization workspace.">
      {error && <div className="inline-error">{error}</div>}
      <form onSubmit={submit} className="form-stack">
        <Field label="Email">
          <input className="input" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password">
          <input className="input" name="password" type="password" autoComplete="current-password" required />
        </Field>
        <Button type="submit" busy={busy} size="lg">
          Sign in
        </Button>
      </form>
      <p className="auth-foot">
        <Link href="/forgot-password">Forgot password?</Link> · New here? <Link href={`/sign-up${location.search}`}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}

export function SignUp({ inviteToken, inviteEmail }: { inviteToken?: string; inviteEmail?: string }) {
  const [, navigate] = useLocation();
  const cfg = useConfig();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await post<Me>("/auth/signup", { name: f.get("name"), email: f.get("email"), password: f.get("password"), inviteToken, acceptTerms: agree });
      await afterAuth(result, navigate, inviteToken ? result.organizations[result.organizations.length - 1]?.id : undefined);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  if (cfg.data && !cfg.data.allowSignups && !inviteToken)
    return (
      <AuthLayout title="Sign-ups are closed" subtitle="New accounts are currently by invitation only.">
        <Link href="/sign-in" className="btn btn-primary">
          Sign in instead
        </Link>
      </AuthLayout>
    );
  return (
    <AuthLayout title={inviteToken ? "Create your account" : "Create your workspace"} subtitle={inviteToken ? "Then you'll join the team that invited you." : "Free to start. No card needed."}>
      {error && <div className="inline-error">{error}</div>}
      <form onSubmit={submit} className="form-stack">
        <Field label="Your name">
          <input className="input" name="name" required minLength={2} autoComplete="name" />
        </Field>
        <Field label="Email">
          <input className="input" name="email" type="email" required autoComplete="email" defaultValue={inviteEmail} readOnly={Boolean(inviteEmail)} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <input className="input" name="password" type="password" minLength={8} required autoComplete="new-password" />
        </Field>
        <AgreeBox checked={agree} onChange={setAgree} />
        <Button type="submit" busy={busy} size="lg" disabled={!agree}>
          Create account
        </Button>
      </form>
      <p className="auth-foot">
        Already have an account? <Link href={inviteToken ? `/sign-in?next=${encodeURIComponent(`/invite/${inviteToken}`)}` : `/sign-in${location.search}`}>Sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");
  const [mail, setMail] = useState(true);
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to choose a new password.">
      {state === "sent" ? (
        <div className="notice">
          <p>If an account exists for that email, a reset link is on its way.{!mail && " (Email isn't configured on this server yet — the link was written to the server log.)"}</p>
        </div>
      ) : (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setState("busy");
            setError("");
            try {
              const r = await post<{ mailEnabled: boolean }>("/auth/forgot", { email: new FormData(e.currentTarget).get("email") });
              setMail(r.mailEnabled);
              setState("sent");
            } catch (err) {
              setError((err as Error).message);
              setState("idle");
            }
          }}
        >
          {error && <div className="inline-error">{error}</div>}
          <Field label="Email">
            <input className="input" name="email" type="email" required />
          </Field>
          <Button type="submit" busy={state === "busy"}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="auth-foot">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPassword() {
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <AuthLayout title="Choose a new password" subtitle="You'll be signed out of other devices.">
      {done ? (
        <>
          <div className="notice">
            <p>Your password has been changed.</p>
          </div>
          <Link href="/sign-in" className="btn btn-primary">
            Sign in
          </Link>
        </>
      ) : (
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await post("/auth/reset", { token, password: new FormData(e.currentTarget).get("password") });
              setDone(true);
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {error && <div className="inline-error">{error}</div>}
          <Field label="New password" hint="At least 8 characters.">
            <input className="input" name="password" type="password" minLength={8} required autoComplete="new-password" />
          </Field>
          <Button type="submit" busy={busy}>
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function AcceptInvite() {
  const { token = "" } = useParams<{ token: string }>();
  const [, navigate] = useLocation();
  const me = useMe();
  const invite = useQuery({ queryKey: ["invite", token], queryFn: () => get<{ email: string; role: string; organization: string }>(`/auth/invite/${token}`), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (invite.isLoading || me.isLoading) return <div className="center-page"><Loading /></div>;
  if (invite.isError)
    return (
      <AuthLayout title="Invitation not found" subtitle={(invite.error as Error).message}>
        <Link href="/" className="btn btn-outline">
          Go home
        </Link>
      </AuthLayout>
    );
  const inv = invite.data!;
  const side = (
    <>
      <p className="eyebrow">Team invitation</p>
      <h1>Join {inv.organization}.</h1>
      <p>
        You've been invited as <b>{inv.role}</b> using <b>{inv.email}</b>.
      </p>
    </>
  );
  if (me.data?.user) {
    return (
      <AuthLayout title={`Join ${inv.organization}`} subtitle={`Signed in as ${me.data.user.email}`} side={side}>
        {error && <div className="inline-error">{error}</div>}
        <Button
          size="lg"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const r = await post<Me & { orgId: string }>("/auth/accept-invite", { token });
              setOrgId(r.orgId);
              queryClient.clear();
              navigate("/app");
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          Accept invitation
        </Button>
      </AuthLayout>
    );
  }
  return (
    <>
      <SignUp inviteToken={token} inviteEmail={inv.email} />
    </>
  );
}
