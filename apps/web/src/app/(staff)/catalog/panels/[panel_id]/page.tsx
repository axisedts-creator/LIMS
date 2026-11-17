// SCR-09 panel detail. Member names: tests come from the resolve preview (`tests`), nested panels from the panel list — the API has no
// "get orderables by id" call [CONV]; an inactive member makes the preview 422, then only panel names resolve and the grid shows "—".
// T0D-TESTMGMT-1 (LD-318): members are edited with the two-list picker (Available tests | In this profile); the active orderable tests
// are its left list (one bounded list read, same as the Tests page).
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CatalogForbidden } from '@/features/catalog/components/CatalogForbidden';
import { PanelDetail } from '@/features/catalog/components/PanelDetail';
import { PanelPicker } from '@/features/catalog/components/PanelPicker';
import { getPanelDetail } from '@/features/catalog/server/getPanelDetail.server';
import { listDepartments } from '@/features/catalog/server/listDepartments.server';
import { listPanels } from '@/features/catalog/server/listPanels.server';
import { listAllTests } from '@/features/catalog/server/listTests.server';
import { resolveOrderablesPreview } from '@/features/catalog/server/resolveOrderablesPreview.server';
import { orForbidden, orMissing } from '@/features/catalog/server/shared';
import type { OrderableSummary } from '@/features/catalog/server/types';

export default async function PanelPage({ params }: { params: Promise<{ panel_id: string }> }) {
  const [{ panel_id }, session] = await Promise.all([params, getShellSession()]);
  const r = await orForbidden(async () => {
    const panel = await orMissing(() => getPanelDetail(panel_id));
    if (!panel) return undefined;
    const [depts, panels, all] = await Promise.all([listDepartments({ isActive: 'all', limit: 200 }), listPanels({ isActive: 'all', limit: 200 }), listAllTests({ isActive: 'all' })]);
    const known = new Set(all.map((t) => t.id));
    const ids = panel.members.map((m) => m.orderable_id).filter((id) => !known.has(id));
    const tests: OrderableSummary[] = all.map((t) => ({ id: t.id, kind: 'test', code: t.code, name: t.name, is_orderable: t.is_orderable ?? true, is_active: t.is_active, revision: 0 }));
    for (let i = 0; i < ids.length; i += 50) {
      const res = await orMissing(() => resolveOrderablesPreview({ orderable_ids: ids.slice(i, i + 50) })).catch(() => undefined);
      for (const t of res?.tests ?? []) tests.push({ id: t.id, kind: 'test', code: t.code, name: t.name, is_orderable: true, is_active: t.is_active ?? true, revision: 0 });
    }
    return { panel, depts: depts.data, orderables: [...tests, ...panels.data] as OrderableSummary[] };
  });
  if (r === null) return <CatalogForbidden />;
  if (!r) notFound();
  const permissions = session?.actor.permissions ?? [];
  const pickable = r.orderables.filter((o) => o.kind === 'test' && o.is_active && o.is_orderable).map((o) => ({ id: o.id, code: o.code, name: o.name }));
  const names = new Map(r.orderables.map((o) => [o.id, { id: o.id, code: o.code, name: o.name }]));
  return (
    <PanelDetail panel={r.panel} departments={r.depts} orderables={r.orderables} permissions={permissions}
      picker={<PanelPicker panel={r.panel} tests={pickable} names={names} manage={permissions.includes('catalog.test.manage')} />} />
  );
}
