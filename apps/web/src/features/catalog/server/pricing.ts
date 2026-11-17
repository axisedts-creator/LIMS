import 'server-only';
// BFF functions for SCR-13…17 (price lists, versions + items, quote, surcharge rules, tax types + rules) and C2 listCentres.
// Each operation is re-exported from its own server/<operationId>.server.ts (02-CONVENTIONS §2.4). Input is validated here so
// tampered values never reach the API; only the known fields are forwarded (no mass assignment), and the quote body is strict
// (AB-10: client-supplied price / tenant / status / revision are rejected, not dropped).
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, bool, int, list, oneOf, opt, pick, qsOf, str, updateOf, upperCode, uuid, exactCode, type V } from './shared';
import { BULK_MAX, HS_CODE_RE, IDEMPOTENCY_KEY_RE, MAX_PRICE_PAISA, PRICE_LIST_CODE_RE, TAX_CODE_RE, type Centre, type ListQuery, type Page, type PriceItem, type PriceItemResult, type PriceList, type PriceListDetail, type PriceListVersion, type PriceQuoteResult, type SurchargeRule, type TaxRule, type TaxType } from './types';

const OWNER_KINDS = ['default', 'credit_party', 'referrer', 'centre'] as const;
const MAX_VERSION = 2_147_483_647;

const iso: V = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) || Number.isNaN(Date.parse(v))) throw bad();
  return v;
};
const money: V = (v) => pick(v, { amount_paisa: int(0, MAX_PRICE_PAISA), currency: oneOf('NPR') }, ['amount_paisa', 'currency']);
/** Like `pick`, but any key outside `spec` is an error. */
function strict(input: unknown, spec: Record<string, V>, required: readonly string[] = []): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Object.keys(input).some((k) => !(k in spec))) throw bad();
  return pick(input, spec, required);
}
const nonEmpty = (max: number, item: V): V => (v) => {
  const r = list(max, item)(v) as unknown[];
  if (r.length < 1) throw bad();
  return r;
};
const owner: V = (v) => pick(v, { owner_id: uuid }, ['owner_id']);
const keyOf = (k: unknown) => {
  if (k !== undefined && !(typeof k === 'string' && IDEMPOTENCY_KEY_RE.test(k))) throw bad();
  return (k as string | undefined) ?? randomUUID();
};
const send = <T>(path: string, method: 'POST' | 'PUT', body: unknown, headers: Record<string, string>) =>
  serverFetch<T>(`/v1/catalog/${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const match = (version: number) => ({ 'if-match': `"${int(1, Number.MAX_SAFE_INTEGER)(version)}"` });
const idem = (k: unknown) => ({ 'idempotency-key': keyOf(k) });
const scoped = (b: Record<string, unknown>, idKeys: Record<string, string>): Record<string, unknown> => {
  // scope → its id is required; ids of other scopes are dropped
  for (const [scope, k] of Object.entries(idKeys)) {
    if (b['scope'] === scope) {
      if (b[k] === undefined) throw bad();
    } else delete b[k];
  }
  return b;
};

// ---- price lists (SCR-13)
export const listPriceLists = async (q: ListQuery & { ownerKind?: unknown; ownerId?: unknown } = {}) =>
  serverFetch<Page<PriceList>>(`/v1/catalog/price-lists${qsOf(q, { owner_kind: opt(oneOf(...OWNER_KINDS), q.ownerKind), owner_id: opt(uuid, q.ownerId) })}`);
export const getPriceListDetail = async (id: string) => serverFetch<PriceListDetail>(`/v1/catalog/price-lists/${uuid(id)}`);
export const createPriceList = async (input: unknown, idempotencyKey?: string) => {
  const body = pick(input, { code: upperCode(PRICE_LIST_CODE_RE), name: str(1, 120), owner_kind: oneOf(...OWNER_KINDS), falls_through: bool, assignments: list(500, owner) }, ['code', 'name', 'owner_kind', 'assignments']);
  return send<PriceList>('price-lists', 'POST', body, idem(idempotencyKey));
};
export const updatePriceList = updateOf<PriceList>('price-lists', { name: str(1, 120), falls_through: bool, is_active: bool });
export const replacePriceListAssignments = async (id: string, version: number, input: unknown) => {
  uuid(id);
  const h = match(version);
  return send<PriceList>(`price-lists/${id}/assignments`, 'PUT', pick(input, { owner_ids: list(500, uuid) }, ['owner_ids']), h);
};

// ---- versions + items (SCR-14)
export const createPriceListVersionDraft = async (priceListId: string, input: unknown = {}, idempotencyKey?: string) => {
  uuid(priceListId);
  return send<PriceListVersion>(`price-lists/${priceListId}/versions`, 'POST', pick(input, { copy_from_version_no: int(1, MAX_VERSION) }), idem(idempotencyKey));
};
export const listPriceListItems = async (versionId: string, q: ListQuery & { orderableKind?: unknown; departmentId?: unknown; sort?: unknown } = {}) =>
  serverFetch<Page<PriceItem>>(`/v1/catalog/price-list-versions/${uuid(versionId)}/items${qsOf(q, { orderable_kind: opt(oneOf('test', 'panel'), q.orderableKind), department_id: opt(uuid, q.departmentId), sort: opt(oneOf('orderable_code', '-orderable_code'), q.sort) })}`);
export const upsertPriceListItems = async (versionId: string, input: unknown, idempotencyKey?: string) => {
  uuid(versionId);
  const body = pick(input, { items: nonEmpty(BULK_MAX, (v) => pick(v, { orderable_id: uuid, unit_price: money }, ['orderable_id', 'unit_price'])) }, ['items']);
  return send<{ results: PriceItemResult[] }>(`price-list-versions/${versionId}/items/bulk-upsert`, 'POST', body, idem(idempotencyKey));
};
export const removePriceListItems = async (versionId: string, input: unknown, idempotencyKey?: string) => {
  uuid(versionId);
  return send<{ results: PriceItemResult[] }>(`price-list-versions/${versionId}/items/bulk-remove`, 'POST', pick(input, { ids: nonEmpty(BULK_MAX, uuid) }, ['ids']), idem(idempotencyKey));
};
/** Privileged: If-Match + Idempotency-Key; 403 auth.mfa_required passes through so the UI can retry with the SAME key. */
export const publishPriceListVersion = async (versionId: string, version: number, input: unknown, idempotencyKey?: string) => {
  uuid(versionId);
  const body = pick(input, { effective_from: iso, change_reason: str(1, 500) }, ['change_reason']);
  return send<PriceListVersion>(`price-list-versions/${versionId}/publish`, 'POST', body, { ...match(version), ...idem(idempotencyKey) });
};
export const discardPriceListVersionDraft = async (versionId: string, version: number) => {
  uuid(versionId);
  return send<PriceListVersion>(`price-list-versions/${versionId}/discard`, 'POST', undefined, match(version));
};

// ---- quote (SCR-15)
export const quotePrices = async (input: unknown) => {
  const item: V = (v) => strict(v, { orderable_id: uuid, priority: oneOf('routine', 'urgent') }, ['orderable_id', 'priority']);
  const context: V = (v) => strict(v, { price_list_id: uuid, credit_party_id: uuid, referrer_id: uuid, centre_id: uuid });
  const body = strict(input, { items: nonEmpty(50, item), context, at: iso }, ['items', 'context']);
  return send<{ quotes: PriceQuoteResult[] }>('prices/quote', 'POST', body, {});
};
/** C2 listCentres via the BFF (08 A13 D-16). */
export const listCentres = async () => serverFetch<{ data: Centre[] }>('/v1/identity/centres');

// ---- surcharge rules (SCR-16)
export const listSurchargeRules = async (q: { scope?: unknown; activeAt?: unknown } = {}) =>
  serverFetch<{ data: SurchargeRule[] }>(`/v1/catalog/surcharge-rules${qsOf({}, { scope: opt(oneOf('all', 'department', 'orderable'), q.scope), active_at: opt(iso, q.activeAt) })}`);
export const createSurchargeRule = async (input: unknown, idempotencyKey?: string) => {
  const b = pick(input, { scope: oneOf('all', 'department', 'orderable'), department_id: uuid, orderable_id: uuid, price_list_id: uuid, amount_kind: oneOf('flat', 'percent'), amount: money, percent_bp: int(1, 100000), effective_from: iso, effective_to: iso }, ['scope', 'amount_kind', 'effective_from']);
  scoped(b, { department: 'department_id', orderable: 'orderable_id' });
  if (b['amount_kind'] === 'flat') {
    if (b['amount'] === undefined) throw bad();
    delete b['percent_bp'];
  } else {
    if (b['percent_bp'] === undefined) throw bad();
    delete b['amount'];
  }
  return send<SurchargeRule>('surcharge-rules', 'POST', b, idem(idempotencyKey));
};
export const endSurchargeRule = async (id: string, version: number, input: unknown = {}) => {
  uuid(id);
  const h = match(version);
  return send<SurchargeRule>(`surcharge-rules/${id}/end`, 'POST', pick(input, { effective_to: iso }), h);
};

// ---- tax types + rules (SCR-17)
export const listTaxTypes = async (q: { allVersions?: unknown; activeAt?: unknown } = {}) =>
  serverFetch<{ data: TaxType[] }>(`/v1/catalog/tax-types${qsOf({}, { all_versions: opt(bool, q.allVersions), active_at: opt(iso, q.activeAt) })}`);
export const createTaxType = async (input: unknown, idempotencyKey?: string) =>
  send<TaxType>('tax-types', 'POST', pick(input, { code: upperCode(TAX_CODE_RE), display: str(1, 60), rate_bp: int(0, 10000), effective_from: iso }, ['code', 'display']), idem(idempotencyKey));
export const updateTaxType = updateOf<TaxType>('tax-types', { display: str(1, 60), rate_bp: int(0, 10000), effective_from: iso, is_active: bool });
export const listTaxRules = async (q: { scope?: unknown; activeAt?: unknown } = {}) =>
  serverFetch<{ data: TaxRule[] }>(`/v1/catalog/tax-rules${qsOf({}, { scope: opt(oneOf('tenant_default', 'department', 'orderable'), q.scope), active_at: opt(iso, q.activeAt) })}`);
export const createTaxRule = async (input: unknown, idempotencyKey?: string) => {
  // D-C3-04: vat_treatment is required — there is no default and no third value.
  const b = pick(input, { scope: oneOf('tenant_default', 'department', 'orderable'), department_id: uuid, orderable_id: uuid, vat_treatment: oneOf('exempt', 'taxable'), other_tax_code: exactCode(TAX_CODE_RE), hs_code: exactCode(HS_CODE_RE), effective_from: iso, effective_to: iso }, ['scope', 'vat_treatment', 'effective_from']);
  return send<TaxRule>('tax-rules', 'POST', scoped(b, { department: 'department_id', orderable: 'orderable_id' }), idem(idempotencyKey));
};
export const endTaxRule = async (id: string, version: number, input: unknown = {}) => {
  uuid(id);
  const h = match(version);
  return send<TaxRule>(`tax-rules/${id}/end`, 'POST', pick(input, { effective_to: iso }), h);
};
