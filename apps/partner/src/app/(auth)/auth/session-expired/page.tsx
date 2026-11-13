// Session ended (public). The guard normally lands on /auth/login?reason=session; this page is the plain fallback.
import { Banner } from '@lims/ui/components/Banner';

export default function SessionExpiredPage() {
  return (
    <div className="lims-auth-card">
      <h1>Session ended</h1>
      <Banner tone="info" title="You were signed out because your session ended." />
      <a href="/auth/login">Sign in again</a>
    </div>
  );
}
