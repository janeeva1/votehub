import { useState } from "react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Activity, Building2, ChevronDown, CreditCard, LayoutDashboard, LogOut, Menu, Settings, Shield, Users, Vote, X } from "lucide-react";
import { post, queryClient, setOrgId, useCurrentOrg, useMe } from "../api";
import { Badge, Loading } from "../ui";
import { Brand } from "./Landing";
import { Dashboard } from "./Dashboard";
import { EventsPage } from "./Events";
import { EventDetailPage } from "./EventDetail";
import { TeamPage } from "./Team";
import { OrgSettingsPage } from "./OrgSettings";
import { BillingPage } from "./Billing";
import { ActivityPage } from "./ActivityPage";
import { AccountPage } from "./Account";
import { AdminPage } from "./Admin";

const nav = [
  { href: "/", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/events", label: "Events & votes", icon: Vote },
  { href: "/team", label: "Team", icon: Users },
  { href: "/activity", label: "Activity log", icon: Activity },
];
const manage = [
  { href: "/settings", label: "Organization settings", icon: Settings },
  { href: "/billing", label: "Plan & billing", icon: CreditCard },
];

export function AppShell() {
  const me = useMe();
  const org = useCurrentOrg();
  const [path, navigate] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [orgOpen, setOrgOpen] = useState(false);
  if (me.isLoading) return <div className="center-page"><Loading /></div>;
  const user = me.data?.user;
  const orgs = me.data?.organizations ?? [];
  const isPlatformAdmin = Boolean(user?.isPlatformAdmin);
  // Platform admins without an organization can still reach the admin console.
  if (!org && isPlatformAdmin && !path.startsWith("/admin") && path !== "/account") return <Redirect to="/admin" />;
  if (!org && !isPlatformAdmin) return <Redirect to="~/onboarding" />;
  const planEnds = org?.planExpiresAt ? new Date(org.planExpiresAt) : null;
  const planDaysLeft = planEnds ? Math.ceil((planEnds.getTime() - Date.now()) / 86400_000) : null;
  const storedPaid = org && org.planExpiresAt && planDaysLeft !== null;

  const active = (href: string, exact?: boolean) => (exact ? path === href : path === href || path.startsWith(`${href}/`));
  const switchOrg = (id: string) => {
    setOrgId(id);
    setOrgOpen(false);
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[0] !== "config" });
    navigate("/");
  };
  const signOut = async () => {
    await post("/auth/logout").catch(() => undefined);
    setOrgId(null);
    queryClient.clear();
    location.href = "/";
  };
  const linkTo = (n: { href: string; label: string; icon: typeof Vote; exact?: boolean }) => (
    <Link key={n.href} href={n.href} className={`nav-link ${active(n.href, n.exact) ? "active" : ""}`} onClick={() => setMenuOpen(false)}>
      <n.icon size={17} />
      <span>{n.label}</span>
    </Link>
  );

  return (
    <div className={`workspace ${menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link href="~/">
            <Brand dark />
          </Link>
          <button className="icon-btn mobile-only" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </button>
        </div>
        {org && (
          <div className="org-switch-wrap">
            <button className="org-switch" onClick={() => setOrgOpen((o) => !o)} aria-expanded={orgOpen}>
              <span className="org-avatar">{org.name.slice(0, 1).toUpperCase()}</span>
              <span className="org-switch-text">
                <small>ORGANIZATION</small>
                <b>{org.name}</b>
              </span>
              <ChevronDown size={14} />
            </button>
            {orgOpen && (
              <div className="org-menu">
                {orgs.map((o) => (
                  <button key={o.id} className={o.id === org.id ? "on" : ""} onClick={() => switchOrg(o.id)}>
                    <span className="org-avatar small">{o.name.slice(0, 1).toUpperCase()}</span>
                    <span>
                      <b>{o.name}</b>
                      <small>
                        {o.role} · {o.plan}
                      </small>
                    </span>
                  </button>
                ))}
                <Link href="~/onboarding" className="org-menu-new">
                  <Building2 size={14} /> New organization
                </Link>
              </div>
            )}
          </div>
        )}
        {org && (
          <>
            <p className="nav-label">Workspace</p>
            <nav className="nav-list">{nav.map(linkTo)}</nav>
            <p className="nav-label">Manage</p>
            <nav className="nav-list">{manage.map(linkTo)}</nav>
          </>
        )}
        {!org && isPlatformAdmin && (
          <div className="sidebar-note">
            You're signed in as the platform owner. Organizations sign up and manage themselves.
            <Link href="~/onboarding">Create your own organization</Link>
          </div>
        )}
        {isPlatformAdmin && (
          <>
            <p className="nav-label">Platform</p>
            <nav className="nav-list">{linkTo({ href: "/admin", label: "Super admin", icon: Shield })}</nav>
          </>
        )}
        <div className="sidebar-bottom">
          {org && (
            <div className="plan-chip">
              <span>Plan</span>
              <Badge tone="gold">{org.plan}</Badge>
            </div>
          )}
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <button className="icon-btn mobile-only" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">{org?.name ?? "Platform"}</div>
          <div className="topbar-user">
            <Link href="/account" className="user-link">
              <span className="avatar">{user?.name.slice(0, 1).toUpperCase()}</span>
              <span className="user-name">{user?.name}</span>
            </Link>
            <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}>
              <LogOut size={17} />
            </button>
          </div>
        </header>
        {storedPaid && planDaysLeft! <= 3 && planDaysLeft! > 0 && org?.plan !== "free" && (
          <div className="banner-soft">
            Your {org!.plan} plan ends in {planDaysLeft} day{planDaysLeft === 1 ? "" : "s"}. <Link href="/billing">Renew now</Link> — unused days carry over.
          </div>
        )}
        {storedPaid && planDaysLeft! <= 0 && org?.plan === "free" && (
          <div className="banner-soft">
            Your paid plan has ended, so Free limits apply. <Link href="/billing">Renew or choose a plan</Link>
          </div>
        )}
        {org?.suspended && <div className="banner-warn">This organization is suspended. Voting pages and changes are disabled — contact the platform administrator.</div>}
        <main className="page-content">
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/events" component={EventsPage} />
            <Route path="/events/:id/:tab?" component={EventDetailPage} />
            <Route path="/team" component={TeamPage} />
            <Route path="/settings" component={OrgSettingsPage} />
            <Route path="/billing" component={BillingPage} />
            <Route path="/activity" component={ActivityPage} />
            <Route path="/account" component={AccountPage} />
            <Route path="/admin/:tab?" component={AdminPage} />
            <Route>
              <div className="panel narrow">
                <h2>Page not found</h2>
                <Link href="/" className="btn btn-primary">
                  Back to overview
                </Link>
              </div>
            </Route>
          </Switch>
        </main>
      </div>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}
