// SCR-09 Panels & packages — list. Server component via the BFF; 403 → no-access page, other failures → error.tsx.
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PanelsList } from '@/features/catalog/components/PanelsList';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listPanels } from '@/features/catalog/server/listPanels.server';
import { orForbidden } from '@/features/catalog/server/shared';

export default async function PanelsPage() {
  const session = await getShellSession();
  const r = await orForbidden(() => Promise.all([listPanels({ isActive: 'all', limit: 200 }), listDepartments({ isActive: 'all', limit: 200 })]));
  if (!r) return <CatalogForbidden />;
  return <PanelsList panels={r[0].data} departments={r[1].data} permissions={session?.actor.permissions ?? []} />;
}
