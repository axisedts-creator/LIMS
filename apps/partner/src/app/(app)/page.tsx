// C13.T18 PH-1 Home (dashboard) at "/" (02-TRD §3.6, 04-UI-UX PH-1). Server component: reads via the BFF only
// (A2 /dashboard, A1 /me for the lab name, PM-1 /manifests?limit=5); the access token never leaves partnerApi.
// LD-140 (2026-11-13): kit components only, no hex / inline styles.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { partnerApi } from '../../core/api';
import { DashboardView, type DashboardCounts, type RecentManifest } from '../../features/dashboard/DashboardView';

interface PartnerContext { tenant?: { display_name?: string } }
interface ManifestList { data?: RecentManifest[] }

export default async function HomePage(_props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const [dash, me, list] = await Promise.all([
    partnerApi<DashboardCounts>('/v1/partners/dashboard'),
    partnerApi<PartnerContext>('/v1/partners/me'),
    partnerApi<ManifestList>('/v1/partners/manifests?limit=5'),
  ]);
  // No tiles with made-up zeros when the counts cannot be read; upstream detail is never shown.
  if (!dash.ok || !dash.data) return <ErrorState title="Could not load the dashboard." body="Try again in a moment." />;

  const labName = (me.ok && typeof me.data?.tenant?.display_name === 'string' && me.data.tenant.display_name) || 'the lab'; // [CONV] fallback
  const manifests = list.ok && Array.isArray(list.data?.data) ? list.data.data.slice(0, 5) : [];
  return <DashboardView counts={dash.data} manifests={manifests} manifestsFailed={!list.ok} labName={labName} />;
}
