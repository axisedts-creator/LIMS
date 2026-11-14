// C13.T20 static offline page (US-16.2, 02-TRD §3.7): served by sw.js when a navigation fails. Public, no session, no data fetch,
// so it is safe to precache. LD-140 (2026-11-13): kit components only.
import { ErrorState } from '@lims/ui/components/ErrorState';

export default function OfflinePage() {
  return (
    <div className="lims-auth-card">
      <ErrorState title="You are offline." body="Reconnect to see your orders and reports. No patient data is stored on this device." />
      <a href="/">Try again</a>
    </div>
  );
}
