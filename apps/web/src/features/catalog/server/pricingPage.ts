import 'server-only';
// Data loading for the SCR-13…17 pages (server components only). The API has no "get orderables by id" call, so names come from
// the catalog lists, paged with a hard cap [CONV] (ponytail: 20 × 200 per kind; add a by-id lookup if a lab outgrows it).
import { serverFetch } from '@/core/api/server-fetch';
import { getDoctor } from './getDoctor.server';
import { listCentres } from './listCentres.server';
import { listCreditParties } from './listCreditParties.server';
import { listPriceListItems } from './listPriceListItems.server';
import { qsOf } from './shared';
import type { Page, PriceItem, PriceListDetail, PricedOrderable } from './types';

const PAGES = 20;
interface Row { id: string; code: string; name: string; department_id?: string; is_orderable?: boolean; is_active: boolean; panel_kind?: 'clinical' | 'package' }

export async function loadPricedOrderables(only?: ReadonlySet<string>): Promise<PricedOrderable[]> {
  const out: PricedOrderable[] = [];
  for (const [seg, kind] of [['tests', 'test'], ['panels', 'panel']] as const) {
    let cursor: string | undefined;
    for (let i = 0; i < PAGES; i++) {
      const p = await serverFetch<Page<Row>>(`/v1/catalog/${seg}${qsOf({ isActive: 'all', limit: 200, ...(cursor ? { cursor } : {}) })}`);
      for (const r of p.data) if (!only || only.has(r.id)) out.push({ id: r.id, kind, code: r.code, name: r.name, is_orderable: r.is_orderable ?? true, is_active: r.is_active, revision: 0, ...(r.department_id ? { department_id: r.department_id } : {}), ...(r.panel_kind ? { panel_kind: r.panel_kind } : {}) });
      cursor = p.page.next_cursor;
      if (!cursor) break;
    }
  }
  return out;
}

export async function loadAllItems(versionId: string): Promise<PriceItem[]> {
  const out: PriceItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < PAGES * 2; i++) {
    const p = await listPriceListItems(versionId, { limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...p.data);
    cursor = p.page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** id → label for the owners a list is assigned to; unresolved ids simply show as the id. */
export async function loadOwnerLabels(d: PriceListDetail, canCentres: boolean): Promise<Record<string, string>> {
  const ids = d.assignments.map((a) => a.owner_id);
  const labels: Record<string, string> = {};
  if (ids.length === 0) return labels;
  if (d.owner_kind === 'credit_party') {
    for (const p of (await listCreditParties({ isActive: 'all', limit: 200 })).data) labels[p.id] = `${p.party_code} — ${p.name}`;
  } else if (d.owner_kind === 'referrer') {
    const docs = await Promise.allSettled(ids.slice(0, 100).map((id) => getDoctor(id)));
    for (const r of docs) if (r.status === 'fulfilled') labels[r.value.id] = `${r.value.doctor_code} — ${r.value.display_name}`;
  } else if (d.owner_kind === 'centre' && canCentres) {
    const c = await listCentres().catch(() => undefined);
    for (const x of c?.data ?? []) labels[x.centre_id] = `${x.code} — ${x.name}`;
  }
  return labels;
}
