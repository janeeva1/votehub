import { useThemeSync } from "./theme";
import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Switch } from "wouter";
import { queryClient, useMe } from "./api";
import { ToastProvider, Loading } from "./ui";
import { Landing } from "./pages/Landing";
import { SignIn, SignUp, ForgotPassword, ResetPassword, AcceptInvite } from "./pages/Auth";
import { AppShell } from "./pages/AppShell";
import { Onboarding } from "./pages/Onboarding";
import { PublicEvent } from "./pages/PublicEvent";
import { PayManual, PayReturn, PayTest } from "./pages/Pay";
import { EmbedPage, PresentPage } from "./pages/Embed";
import { PrivacyPage, TermsGate, TermsPage } from "./pages/Legal";
import "./styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="center-page">
          <div className="panel narrow">
            <h2>Something went wrong</h2>
            <p className="muted">{this.state.error.message}</p>
            <button className="btn btn-primary" onClick={() => location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isLoading) return <div className="center-page"><Loading /></div>;
  if (!me.data?.user) return <Redirect to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  if (!me.data.user.termsAccepted) return <TermsGate />;
  return <>{children}</>;
}

function App() {
  useThemeSync();
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/sign-in" component={SignIn} />
      <Route path="/terms" component={TermsPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/sign-up">{() => <SignUp />}</Route>
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/invite/:token" component={AcceptInvite} />
      <Route path="/e/:slug" component={PublicEvent} />
      <Route path="/e/:slug/register" component={PublicEvent} />
      <Route path="/embed/:slug" component={EmbedPage} />
      <Route path="/present/:id">
        <RequireAuth>
          <PresentPage />
        </RequireAuth>
      </Route>
      <Route path="/pay/return" component={PayReturn} />
      <Route path="/pay/test" component={PayTest} />
      <Route path="/pay/manual" component={PayManual} />
      <Route path="/onboarding">
        <RequireAuth>
          <Onboarding />
        </RequireAuth>
      </Route>
      <Route path="/app" nest>
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      </Route>
      <Route>
        <div className="center-page">
          <div className="panel narrow">
            <p className="eyebrow">404</p>
            <h2>Page not found</h2>
            <p className="muted">The page you're looking for doesn't exist.</p>
            <a className="btn btn-primary" href="/">
              Go home
            </a>
          </div>
        </div>
      </Route>
    </Switch>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
