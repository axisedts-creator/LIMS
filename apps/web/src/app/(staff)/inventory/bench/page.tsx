// S12 Bench — server component (route staff.inventory.bench; needs inventory.bench.record, else the no-access state and no API call).
// ?store=<id> picks the store; bench stores are listed first and the first one is the default. Lookups for the forms (items, analysers, tests,
// reasons) are optional: a failure leaves the matching picker empty instead of breaking the page.
// LD-140 (2026-11-13): built from packages/ui components only.
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { BenchView } from '@/features/inventory/components/BenchView';
import { FORBIDDEN, guarded, listCodedSet, listContainers, listInstruments, listItems, listStores, listTests, soft } from '@/features/inventory/server/read.server';
import { UUID_RE } from '@/features/inventory/server/types';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function BenchPage({ searchParams }: { searchParams: Promise<SP> }) {
  const [session, sp] = await Promise.all([getShellSession(), searchParams]);
  const perms = session?.actor.permissions ?? [];
  if (!perms.includes('inventory.bench.record')) return <PermissionDenied />;

  const all = await guarded(() => listStores());
  if (all === FORBIDDEN) return <PermissionDenied />;
  const stores = [...all.data.filter((s) => s.store_kind === 'bench'), ...all.data.filter((s) => s.store_kind !== 'bench')];
  const asked = one(sp['store']);
  const storeId = asked && UUID_RE.test(asked) ? asked : stores[0]?.id;
  if (!storeId) return <PermissionDenied />;

  const containers = await guarded(() => listContainers(storeId));
  if (containers === FORBIDDEN) return <PermissionDenied />;
  const [items, instruments, tests, wastage, calibration] = await Promise.all([
    soft(() => listItems({ isActive: 'true', limit: 200 }).then((r) => r.data), []),
    soft(listInstruments, []),
    soft(listTests, []),
    soft(() => listCodedSet('wastage'), []),
    soft(() => listCodedSet('calibration'), []),
  ]);

  return <BenchView stores={stores} storeId={storeId} containers={containers.data} items={items} instruments={instruments} tests={tests} wastageReasons={wastage} calibrationReasons={calibration} />;
}
