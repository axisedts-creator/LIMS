// Quote engine `quotePrices` #82 (02-TRD §5.2 row 82, §7.4 precedence, §7.5 surcharge, §7.6 tax; PRD AC-13.1–13.3, AC-07.6, AC-14.1–14.4, AC-15.1, AC-15.3, AC-15.5;
// 07-SECURITY REQ-SEC-046 server-side prices, S-1 tenant, S-5 closed bodies, S-6 binds only, AB-10). READ-ONLY: no write, no event, no revision bump.
// Every statement is single-table, tenant-scoped, bind-only; a request costs a fixed number of statements (no per-item queries).
// [CONV] a bad context id (unknown / foreign party, referrer, centre, explicit list; INACTIVE explicit list) fails the WHOLE request with 404 common.not_found (AB-3: unknown and foreign look the same).
// [CONV] per-item answers `{orderable_id, error_code}`: common.not_found (unknown / foreign orderable), catalog.no_price, catalog.tax_config_missing — checked in that order.
// [CONV] `at` omitted = ctx.now(). A merged referrer resolves to its canonical doctor before the assignment lookup. The surcharge is computed on the WINNING list price.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { priceMatch, type PriceListInput, type PriceSource } from '../domain/priceMatch.js';
import { pickSurchargeRule, surchargeAmountPaisa } from '../domain/surcharge.js';
import { isTaxTypeUsable, pickTaxRule, taxTypeVersionAt, vatRateBp } from '../domain/tax.js';
import { UUID, fail, invalid, isObj, required, unknown, type Ctx, type Tx } from './masters.service.js';

type R = Record<string, any>;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/;
const MAX_ITEMS = 50;
const MAX_HOPS = 8;                                         // merged-referrer chain bound (a cycle can never loop)
const CONTEXT_KEYS = ['price_list_id', 'credit_party_id', 'referrer_id', 'centre_id'] as const;
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });

interface QuoteItem { orderable_id: string; priority: 'routine' | 'urgent' }
interface QuoteRequest { items: QuoteItem[]; context: Partial<Record<(typeof CONTEXT_KEYS)[number], string>>; at: string | undefined }

/** Declared keys only (S-5); errors carry paths, never a submitted value (AB-20). */
function parse(body: unknown): QuoteRequest {
  if (!isObj(body)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  if (Object.keys(body).some((k) => k !== 'items' && k !== 'context' && k !== 'at' && body[k] !== undefined)) errors.push(unknown(''));
  const items: QuoteItem[] = [];
  const raw = body['items'];
  if (raw === undefined) errors.push(required('/items'));
  else if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) errors.push(invalid('/items'));
  else {
    raw.forEach((it: unknown, i: number) => {
      if (!isObj(it)) { errors.push(invalid(`/items/${i}`)); return; }
      if (Object.keys(it).some((k) => k !== 'orderable_id' && k !== 'priority' && it[k] !== undefined)) errors.push(unknown(`/items/${i}`));
      const id = it['orderable_id']; const pr = it['priority'];
      if (id === undefined) errors.push(required(`/items/${i}/orderable_id`));
      else if (typeof id !== 'string' || !UUID.test(id)) errors.push(invalid(`/items/${i}/orderable_id`));
      if (pr === undefined) errors.push(required(`/items/${i}/priority`));
      else if (pr !== 'routine' && pr !== 'urgent') errors.push(invalid(`/items/${i}/priority`));
      items.push({ orderable_id: id as string, priority: pr as QuoteItem['priority'] });
    });
  }
  const context: QuoteRequest['context'] = {};
  const c = body['context'];
  if (c === undefined) errors.push(required('/context'));
  else if (!isObj(c)) errors.push(invalid('/context'));
  else {
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      if (!(CONTEXT_KEYS as readonly string[]).includes(k)) errors.push(unknown('/context'));
      else if (typeof v === 'string' && UUID.test(v)) context[k as (typeof CONTEXT_KEYS)[number]] = v;
      else errors.push(invalid(`/context/${k}`));
    }
  }
  let at: string | undefined;
  if (body['at'] !== undefined) {
    const a = body['at'];
    if (typeof a === 'string' && ISO.test(a) && !Number.isNaN(Date.parse(a))) at = new Date(a).toISOString(); else errors.push(invalid('/at'));
  }
  if (errors.length) fail(errors);
  return { items, context, at };
}

export interface QuoteDeps { events?: unknown; identity?: unknown }      // accepted for symmetry with the other catalog services; the engine publishes nothing

export function createQuoteService(_deps: QuoteDeps = {}) {
  return {
    async quotePrices(ctx: Ctx, body?: unknown): Promise<{ quotes: R[] }> {
      const req = parse(body);
      const tx = ctx.tx as Tx;
      const T = ctx.tenantId;
      const q = async (text: string, values: unknown[]): Promise<any[]> => (await tx.query(text, values)).rows;
      const at = req.at ?? new Date(ctx.now?.() ?? Date.now()).toISOString();
      const notFound = (): never => { throw new LimsError('common.not_found'); };

      // ---- context ids: tenant-scoped existence (S-1), whole-request 404 otherwise
      const LIST = 'SELECT id, falls_through, is_active FROM catalog.price_lists WHERE tenant_id = $1 AND ';
      let explicitList: R | undefined;
      if (req.context.price_list_id !== undefined) {
        explicitList = (await q(`${LIST}id = $2`, [T, req.context.price_list_id]))[0];
        if (!explicitList || explicitList.is_active !== true) notFound();                       // inactive explicit list: not_found (02-TRD §7.4)
      }
      if (req.context.credit_party_id !== undefined && (await q('SELECT id FROM catalog.credit_parties WHERE tenant_id = $1 AND id = $2', [T, req.context.credit_party_id])).length === 0) notFound();
      if (req.context.centre_id !== undefined && (await q('SELECT id FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [T, req.context.centre_id])).length === 0) notFound();
      let referrerId: string | undefined;
      if (req.context.referrer_id !== undefined) {
        let id = req.context.referrer_id;
        for (let hop = 0; ; hop++) {
          const d = (await q('SELECT id, merged_into_id FROM catalog.doctors WHERE tenant_id = $1 AND id = $2', [T, id]))[0];
          if (!d || hop >= MAX_HOPS) notFound();
          if (d!.merged_into_id == null) break;
          id = d!.merged_into_id as string;
        }
        referrerId = id;
      }

      // ---- the list assigned to each owner, and the tenant default
      const assigned = async (col: string, owner: string | undefined): Promise<string | undefined> =>
        owner === undefined ? undefined : (await q(`SELECT price_list_id FROM catalog.price_list_assignments WHERE tenant_id = $1 AND ${col} = $2`, [T, owner]))[0]?.price_list_id;
      const ids: Partial<Record<PriceSource, string | undefined>> = {
        explicit: explicitList?.id, credit_party: await assigned('credit_party_id', req.context.credit_party_id),
        referrer: await assigned('doctor_id', referrerId), centre: await assigned('centre_id', req.context.centre_id),
      };
      const defaultList = (await q(`${LIST}owner_kind = $2`, [T, 'default']))[0];
      ids.tenant_default = defaultList?.id;
      const listIds = [...new Set(Object.values(ids).filter((x): x is string => typeof x === 'string'))];
      const listRows = new Map<string, R>();
      if (explicitList) listRows.set(explicitList.id, explicitList);
      if (defaultList) listRows.set(defaultList.id, defaultList);
      const missing = listIds.filter((id) => !listRows.has(id));
      if (missing.length) for (const r of await q(`${LIST}id = ANY($2)`, [T, missing])) listRows.set(r.id, r);

      // ---- versions effective at `at`, then only their items for the requested orderables (a draft / ended / future version is never read)
      const versions = listIds.length
        ? await q('SELECT id, price_list_id, version_no, status, effective_from, effective_to FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = ANY($2)', [T, listIds])
        : [];
      const wanted = [...new Set(req.items.map((i) => i.orderable_id))];
      const live = versions.filter((v) => v.status === 'published' || v.status === 'superseded');
      const itemRows = live.length
        ? await q('SELECT price_list_version_id, orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = ANY($2) AND orderable_id = ANY($3)',
          [T, live.map((v) => v.id), wanted])
        : [];
      const prices = new Map<string, Map<string, number>>();
      for (const r of itemRows) {
        const m = prices.get(r.price_list_version_id) ?? new Map<string, number>();
        m.set(r.orderable_id, Number(r.unit_price_paisa)); prices.set(r.price_list_version_id, m);
      }
      const lists: Partial<Record<PriceSource, PriceListInput>> = {};
      for (const [source, id] of Object.entries(ids) as Array<[PriceSource, string | undefined]>) {
        const row = id === undefined ? undefined : listRows.get(id);
        if (!row) continue;
        lists[source] = {
          id: row.id, falls_through: row.falls_through === true, is_active: row.is_active === true,
          versions: versions.filter((v) => v.price_list_id === row.id).map((v) => ({
            version_no: Number(v.version_no), status: v.status, effective_from: v.effective_from, effective_to: v.effective_to, items: prices.get(v.id) ?? new Map<string, number>(),
          })),
        };
      }

      // ---- orderables (tenant-scoped: another tenant's id is "unknown"), rules read once per request
      const ords = new Map((await q('SELECT id, department_id FROM catalog.orderables WHERE tenant_id = $1 AND id = ANY($2)', [T, wanted])).map((o) => [o.id as string, o]));
      const surcharges = req.items.some((i) => i.priority === 'urgent' && ords.has(i.orderable_id))
        ? await q('SELECT id, scope, department_id, orderable_id, price_list_id, amount_kind, amount_paisa, percent_bp, effective_from, effective_to, is_active FROM catalog.surcharge_rules WHERE tenant_id = $1', [T])
        : [];
      const taxRules = await q('SELECT id, scope, department_id, orderable_id, vat_treatment, other_tax_code, hs_code, effective_from, effective_to, is_active FROM catalog.tax_rules WHERE tenant_id = $1', [T]);
      const needs = (f: (r: R) => boolean) => taxRules.some(f);
      const vat = needs((r) => r.vat_treatment === 'taxable')
        ? (await q('SELECT id, code, rate_bp, is_active FROM catalog.g_tax_types WHERE code = $1', ['VAT']))[0] : undefined;
      const vatRate = vat && vat.is_active === true && vat.rate_bp != null ? Number(vat.rate_bp) : undefined;
      const otherTypes = needs((r) => r.other_tax_code != null)
        ? await q('SELECT id, code, rate_bp, effective_from, effective_to, is_active FROM catalog.cs_tax_types WHERE tenant_id = $1', [T]) : [];

      const quotes = req.items.map((item): R => {
        const o = ords.get(item.orderable_id);
        if (!o) return { orderable_id: item.orderable_id, error_code: 'common.not_found' };
        const m = priceMatch({ lists, orderableId: item.orderable_id, at });
        if (!m.found) return { orderable_id: item.orderable_id, error_code: 'catalog.no_price' };
        const rule = pickTaxRule(taxRules, { orderableId: item.orderable_id, departmentId: o.department_id, at });
        if (!rule) return { orderable_id: item.orderable_id, error_code: 'catalog.tax_config_missing' };     // AC-15.3: never an assumed "exempt"
        const tax: R = { vat: rule.vat_treatment };
        if (rule.vat_treatment === 'taxable') {
          if (vatRate === undefined) return { orderable_id: item.orderable_id, error_code: 'catalog.tax_config_missing' };
          tax['vat_rate_bp'] = vatRateBp('taxable', vatRate);
        }
        if (rule.other_tax_code != null) {
          const t = taxTypeVersionAt(otherTypes, rule.other_tax_code, at);
          if (!isTaxTypeUsable(t)) return { orderable_id: item.orderable_id, error_code: 'catalog.tax_config_missing' };
          tax['other_tax_code'] = rule.other_tax_code; tax['other_tax_rate_bp'] = Number(t!.rate_bp);
        }
        if (rule.hs_code != null) tax['hs_code'] = rule.hs_code;
        const out: R = {
          orderable_id: item.orderable_id, price_list_id: m.priceListId, price_list_version: m.priceListVersion, source: m.source, unit_price: money(m.unitPricePaisa),
        };
        if (item.priority === 'urgent') {
          const s = pickSurchargeRule(surcharges, { orderableId: item.orderable_id, departmentId: o.department_id, priceListId: m.priceListId, at });
          if (s) out['urgent_surcharge'] = money(surchargeAmountPaisa(s, m.unitPricePaisa));
        }
        out['tax'] = tax;
        return out;
      });
      return { quotes };
    },
  };
}
