// C13.T19 PK-2 Request pickup — /pickups/new (04-UI-UX PK-2). M2 listManifests?state=submitted,partially_received; eligible = not already on an open pickup. ?manifest_id= (from PM-3) preselects one eligible manifest.
// Only a fixed query is sent to the API; the page's own query string is read for the one uuid and never forwarded.
import { getList, isUuid, type Search } from '@/features/common/api';
import type { ManifestSummary } from '@/features/common/types';
import { PickupForm } from '@/features/pickups/PickupForm';

export default async function NewPickupPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const list = await getList<ManifestSummary>('/v1/partners/manifests?state=submitted%2Cpartially_received&limit=200');
  const eligible = list.data
    .filter((m) => (m.state === 'submitted' || m.state === 'partially_received') && !m.pickup_request_id)
    .map((m) => ({ id: m.id, manifest_no: m.manifest_no, centre_id: m.receiving_centre?.id, centre_name: m.receiving_centre?.name }));
  const raw = Array.isArray(search['manifest_id']) ? search['manifest_id'][0] : search['manifest_id'];
  const pre = isUuid(raw) && eligible.some((m) => m.id === raw) ? raw : undefined;
  return <PickupForm manifests={eligible} preselected={pre} />;
}
