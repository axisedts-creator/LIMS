// C13.T19 PM-4 Print view — /manifests/{manifest_id}/print (04-UI-UX PM-4; US-05.1/05.2). M11 getManifestPrintView (writes the manifest.print access-log row server-side) + /me for the lab name.
// Draft / discarded (409) and another partner's manifest (404) render nothing of the manifest. Cache-Control: no-store is set by the BFF fetch (cache: 'no-store') and the page is dynamic.
import { notFound } from 'next/navigation';
import { partnerApi } from '@/core/api';
import { getMe, isUuid } from '@/features/common/api';
import type { Manifest } from '@/features/common/types';
import { PrintView } from '@/features/manifests/PrintView';

interface PrintViewDto { manifest: Manifest; partner: { name: string; partner_code: string }; receiving_centre?: { name: string; code?: string }; printed_at?: string }

export default async function ManifestPrintPage({ params }: { params: Promise<{ manifest_id: string }> }) {
  const { manifest_id: id } = await params;
  if (!isUuid(id)) notFound();
  const [r, me] = await Promise.all([partnerApi<PrintViewDto>(`/v1/partners/manifests/${id}/print-view`), getMe()]);
  if (!r.ok && (r.status === 404 || r.status === 409)) notFound(); // 409 partners.manifest_invalid_transition: a draft or discarded manifest has no print view
  if (!r.ok || !r.data || !Array.isArray(r.data.manifest?.lines)) throw new Error('partner_api_failed');
  return <PrintView labName={me.tenant.display_name} manifest={r.data.manifest} partner={r.data.partner} centre={r.data.receiving_centre} />;
}
