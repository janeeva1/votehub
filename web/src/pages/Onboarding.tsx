import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { post, queryClient, setOrgId, useMe } from "../api";
import { Button, Field } from "../ui";
import { Brand } from "./Landing";
import { AgreeBox } from "./Legal";

const TYPES = ["Alumni association", "School or university", "Club or association", "Union", "Company", "Church or faith group", "Event organizer / media", "Cooperative", "Professional body", "Other"];

export function Onboarding() {
  const [, navigate] = useLocation();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [agree, setAgree] = useState(false);
  const hasOrgs = (me.data?.organizations.length ?? 0) > 0;
  return (
    <div className="setup-wrap">
      <div className="setup-aside">
        <Brand />
        <p className="eyebrow">{hasOrgs ? "Another organization" : "The first step"}</p>
        <h1>
          Your group.
          <br />
          <em>Your own process.</em>
        </h1>
        <p>Create an organization workspace. You'll then set up elections, polls or contests and invite your team.</p>
        <div className="setup-mark">
          <ShieldCheck />
          <span>
            <b>Private by design</b>
            <small>Everything is scoped to your organization.</small>
          </span>
        </div>
      </div>
      <div className="panel setup-card">
        <p className="eyebrow">Organization details</p>
        <h2>Create your workspace</h2>
        {error && <div className="inline-error">{error}</div>}
        <form
          className="form-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              const org = await post<{ id: string }>("/orgs", { name: f.get("name"), orgType: f.get("orgType"), acceptTerms: agree });
              setOrgId(org.id);
              await queryClient.invalidateQueries();
              const plan = new URLSearchParams(location.search).get("plan");
              navigate(plan && plan !== "free" ? `/app/billing?plan=${encodeURIComponent(plan)}` : "/app/events?new=1");
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          <Field label="Organization name">
            <input className="input" name="name" required minLength={2} maxLength={120} placeholder="e.g. Northbridge Alumni Association" />
          </Field>
          <Field label="Type">
            <select className="input" name="orgType" required defaultValue="">
              <option value="" disabled>
                Select a type
              </option>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Field>
          <AgreeBox checked={agree} onChange={setAgree}>
            I'm authorized to act for this organization, and it agrees to the{" "}
            <a href="/terms" target="_blank" rel="noreferrer">
              Terms of Service
            </a>{" "}
            (including the data-processing terms in section 5) and{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>
            .
          </AgreeBox>
          <Button type="submit" busy={busy} size="lg" disabled={!agree}>
            Create organization <ArrowRight size={15} />
          </Button>
          {hasOrgs && (
            <Link href="/app" className="text-link center">
              Back to dashboard
            </Link>
          )}
        </form>
      </div>
    </div>
  );
}
