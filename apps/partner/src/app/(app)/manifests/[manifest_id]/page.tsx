// C13.T19 PM-2 / PM-3 — /manifests/{manifest_id} (04-UI-UX PM-2, PM-3; routes.yaml partner.manifest). Draft -> editor, anything else -> read-only detail.
// M3 getManifest + A1 /me (conversion mode, lab name). Another partner's id is a 404 from the API -> notFound() with nothing of the body rendered (US-15.1).
import { notFound } from 'next/navigation';
import { can, get, getMe, isUuid } from '@/features/common/api';
import type { Manifest } from '@/features/common/types';
import { ManifestDetail } from '@/features/manifests/ManifestDetail';
import { ManifestEditor } from '@/features/manifests/ManifestEditor';

export default async function ManifestPage({ params }: { params: Promise<{ manifest_id: string }> }) {
  const { manifest_id: id } = await params;
  if (!isUuid(id)) notFound();
  const [m, me] = await Promise.all([get<Manifest>(`/v1/partners/manifests/${id}`), getMe()]);
  if (!Array.isArray(m.lines)) throw new Error('partner_api_failed');
  if (m.state === 'draft') return <ManifestEditor manifest={m} labName={me.tenant.display_name} />;
  return <ManifestDetail manifest={m} conversionMode={me.features.conversion_mode} canSubmit={can(me, 'partners.manifest.submit')} canPickup={can(me, 'partners.pickup.request')} />;
}
