// S13 Consumption rules — server component (route staff.inventory.rules; needs inventory.item.read).
// Filters live in the URL: ?kind=&test=&analyser=&item=&history=1. Names (tests, analytes, analysers, items) are joined from the C3/C7/C12 lists; those lookups are optional.
// LD-140 (2026-11-13): built from packages/ui components only.
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { RulesView } from '@/features/inventory/components/RulesView';
import { listAnalytes, listInstruments, listItems, listRules, listStores, listTests, soft } from '@/features/inventory/server/read.server';
import { settle } from '@/features/inventory/server/reports.server';
import { RULE_KINDS, UUID_RE, type Analyte } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const id = (v: string | string[] | undefined) => {
  const s = one(v);
  return s && UUID_RE.test(s) ? s : undefined;
};

export default async function RulesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.item.read')) return <PermissionDenied />;

  const kind = one(sp['kind']);
  const filters = {
    kind: (RULE_KINDS as readonly string[]).includes(kind ?? '') ? kind : undefined,
    test: id(sp['test']),
    analyser: id(sp['analyser']),
    item: id(sp['item']),
    history: one(sp['history']) === '1',
  };
  const res = await settle(() => listRules(filters));
  if (!res.ok) {
    return res.status === 403 ? (
      <PermissionDenied />
    ) : (
      <div role="alert">
        <ErrorState title={res.title || 'Consumption rules could not be loaded'} {...(res.requestId ? { requestId: res.requestId } : {})} />
      </div>
    );
  }
  const rules = res.data.data;
  const testIds = [...new Set(rules.filter((r) => r.analyte_id && r.test_id).map((r) => r.test_id as string))].slice(0, 20);
  const [tests, instruments, items, stores, analytes] = await Promise.all([
    soft(listTests, []),
    soft(listInstruments, []),
    soft(() => listItems({ limit: 200 }).then((r) => r.data), []),
    soft(() => listStores().then((r) => r.data), []),
    Promise.all(testIds.map((t) => soft(() => listAnalytes(t), [] as Analyte[]))).then((a) => a.flat()),
  ]);

  return (
    <RulesView
      rules={rules}
      tests={tests}
      analytes={analytes}
      instruments={instruments}
      items={items}
      stores={stores}
      filters={filters}
      canManage={perms.includes('inventory.master.manage')}
      canCost={perms.includes('inventory.cost.read')}
    />
  );
}
