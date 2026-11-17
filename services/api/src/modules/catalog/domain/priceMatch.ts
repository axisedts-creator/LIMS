// Price-list precedence, fall-through and effective windows (02-TRD §7.4; PRD AC-13.1, AC-13.2, AC-13.3, AC-07.6). PURE: no I/O, no clock.
// Source order (03-IC §4.2 [CONV default]): explicit > credit_party > referrer > centre > tenant_default. `found:false` is the domain's "catalog.no_price".
type D = Date | string;
export type PriceSource = 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
export const SOURCE_ORDER: readonly PriceSource[] = Object.freeze(['explicit', 'credit_party', 'referrer', 'centre', 'tenant_default'] as const);

interface Windowed { status: string; effective_from?: D | null; effective_to?: D | null }
const ms = (v: D): number => new Date(v).getTime();

/** The published|superseded version whose half-open window [from, to) contains `at` (null end = open); drafts and discarded versions never. Newest start wins if data overlaps. */
export function effectiveVersion<V extends Windowed & { version_no?: number }>(versions: readonly V[], at: D): V | undefined {
  const now = ms(at);
  let best: V | undefined; let bestFrom = -Infinity;
  for (const v of versions) {
    if (v.status !== 'published' && v.status !== 'superseded') continue;
    if (v.effective_from == null) continue;
    const from = ms(v.effective_from);
    if (!(from <= now) || (v.effective_to != null && !(now < ms(v.effective_to)))) continue;     // NaN-safe: a bad date is never effective
    if (best === undefined || from > bestFrom || (from === bestFrom && (v.version_no ?? 0) > (best.version_no ?? 0))) { best = v; bestFrom = from; }
  }
  return best;
}

/** List-level status from its version statuses (02-TRD §7.4a step 3): any published > open draft > discarded. Never 'superseded'. Effectiveness is not part of it. */
export function listStatus(statuses: readonly string[]): 'published' | 'draft' | 'discarded' {
  return statuses.includes('published') ? 'published' : statuses.includes('draft') ? 'draft' : 'discarded';   // ponytail: a list with zero / superseded-only versions reads 'discarded' (unreachable via V5)
}

export interface PriceListInput {
  id: string; falls_through: boolean; is_active: boolean;
  versions: ReadonlyArray<{ version_no: number; status: string; effective_from?: D | null; effective_to?: D | null; items: ReadonlyMap<string, number> }>;
}
export type PriceMatch = { found: true; source: PriceSource; priceListId: string; priceListVersion: number; unitPricePaisa: number } | { found: false };

/**
 * First source in SOURCE_ORDER with an active list that has a version effective at `at`. A list without such a version (or inactive, or unassigned) is absent.
 * Item missing from the effective version: falls_through=true continues down the chain, false ends it (no_price). Package prices are never summed from components (AC-07.6).
 */
export function priceMatch(q: { lists: Partial<Record<PriceSource, PriceListInput | undefined>>; orderableId: string; at: D }): PriceMatch {
  for (const source of SOURCE_ORDER) {
    const list = q.lists[source];
    if (!list || !list.is_active) continue;
    const ver = effectiveVersion(list.versions, q.at);
    if (!ver) continue;
    const price = ver.items.get(q.orderableId);
    if (price !== undefined) return { found: true, source, priceListId: list.id, priceListVersion: ver.version_no, unitPricePaisa: price };
    if (!list.falls_through) return { found: false };
  }
  return { found: false };
}
