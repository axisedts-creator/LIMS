// 04-UI-UX §2 tenant-wide notice (analytics.scope.tenant_wide_only): shown only when the API reports hidden sections.
// Centre ids and section names are never rendered.
import { Banner } from '@lims/ui/components/Banner';

export interface AnalyticsScope { all_centres: boolean; centre_ids: string[]; tenant_wide_sections_hidden: string[] }

export function ScopeBanner({ scope }: { scope: AnalyticsScope }) {
  if (scope.tenant_wide_sections_hidden.length === 0) return null;
  return <Banner tone="info" title="Some figures are only available to users with access to all centres." />;
}
