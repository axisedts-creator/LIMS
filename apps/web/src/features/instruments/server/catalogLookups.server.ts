import 'server-only';
// WEB-T04 editor lookups through C3 (04-UI-UX SCR-08): #25 getTestDetail, searchOrderables (kind=test), listUnits.
// Own thin copies: a feature never imports another feature's folder (02-CONVENTIONS, REQ-ARCH-076). Only the code-map
// editor uses them, so they share its permission gate (no C3 call without catalog.instrument_code_map.manage, D-39).
import { serverFetch } from '@/core/api/server-fetch';
import { CODE_MAP_MANAGE, isUuid, type TestRef, type UnitRef } from './codeMaps';
import { badRequest, requirePermission } from './shared.server';

type Named = { id: string; code: string; name: string };

export async function getTestRef(testId: string): Promise<TestRef> {
  await requirePermission(CODE_MAP_MANAGE);
  if (!isUuid(testId)) throw badRequest();
  const t = await serverFetch<Named & { analytes?: Named[] }>(`/v1/catalog/tests/${testId}`);
  return { id: t.id, code: t.code, name: t.name, analytes: (t.analytes ?? []).map((a) => ({ id: a.id, code: a.code, name: a.name })) };
}

export async function searchTests(q: string): Promise<Named[]> {
  await requirePermission(CODE_MAP_MANAGE);
  if (typeof q !== 'string' || q.length < 1 || q.length > 64) throw badRequest();
  const r = await serverFetch<{ data: (Named & { kind: string })[] }>(`/v1/catalog/orderables?${new URLSearchParams({ q, kind: 'test', limit: '20' })}`);
  return r.data.filter((o) => o.kind === 'test').map((o) => ({ id: o.id, code: o.code, name: o.name }));
}

export async function listUnitRefs(): Promise<UnitRef[]> {
  await requirePermission(CODE_MAP_MANAGE);
  const r = await serverFetch<{ data: (UnitRef & { is_active?: boolean })[] }>('/v1/catalog/units');
  return r.data.filter((u) => u.is_active !== false).map((u) => ({ code: u.code, display: u.display }));
}
