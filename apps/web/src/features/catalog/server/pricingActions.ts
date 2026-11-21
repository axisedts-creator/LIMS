'use server';
// Server actions for SCR-13…17. ApiError becomes { ok:false, status, code, errors? } (the message does not survive the action
// boundary; field errors travel as data so the dialogs can show them at the field). Anything else rethrows.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createPriceList } from './createPriceList.server';
import { createPriceListVersionDraft } from './createPriceListVersionDraft.server';
import { createSurchargeRule } from './createSurchargeRule.server';
import { createTaxRule } from './createTaxRule.server';
import { createTaxType } from './createTaxType.server';
import { discardPriceListVersionDraft } from './discardPriceListVersionDraft.server';
import { endSurchargeRule } from './endSurchargeRule.server';
import { endTaxRule } from './endTaxRule.server';
import { listCentres } from './listCentres.server';
import { listCreditParties } from './listCreditParties.server';
import { listPriceLists } from './listPriceLists.server';
import { publishPriceListVersion } from './publishPriceListVersion.server';
import { quotePrices } from './quotePrices.server';
import { removePriceListItems } from './removePriceListItems.server';
import { replacePriceListAssignments } from './replacePriceListAssignments.server';
import { updatePriceList } from './updatePriceList.server';
import { updateTaxType } from './updateTaxType.server';
import { upsertPriceListItems } from './upsertPriceListItems.server';
import { bulkUpdatePriceListDraft, commitPriceListImport, comparePriceLists, copyPriceList, downloadPriceListTemplate, dryRunPriceListImport, type PriceBulkResult, type PriceComparisonRow, type PriceImportDryRun } from './priceTools.server';
import type { ActionResult, Centre, FieldError, Page, PriceListVersion, PriceItemResult, PriceQuoteResult } from './types';

type Saved = { id: string; version: number };
const saved = (r: Saved): Saved => ({ id: r.id, version: r.version });

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errors = e.problem['errors'];
      const detail = e.problem.detail; // T0D-PRICETOOLS-1: the server's own text is shown verbatim (row errors, overlap refusals)
      return { ok: false, status: e.status, code: e.problem.code, ...(Array.isArray(errors) ? { errors: errors as FieldError[] } : {}), ...(typeof detail === 'string' ? { detail } : {}) };
    }
    throw e;
  }
}

export const createPriceListAction = async (input: unknown, key: string) => run(async () => saved(await createPriceList(input, key)));
export const updatePriceListAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updatePriceList(id, version, input)));
export const replaceAssignmentsAction = async (id: string, version: number, ownerIds: string[], period: { effective_from?: string; effective_to?: string } = {}) =>
  run(async () => saved(await replacePriceListAssignments(id, version, { owner_ids: ownerIds, ...period })));
export const createVersionDraftAction = async (priceListId: string, input: unknown, key: string) => run(async () => saved(await createPriceListVersionDraft(priceListId, input, key)));
export const upsertItemsAction = async (versionId: string, items: unknown, key: string): Promise<ActionResult<PriceItemResult[]>> => run(async () => (await upsertPriceListItems(versionId, { items }, key)).results ?? []);
export const removeItemsAction = async (versionId: string, ids: string[], key: string): Promise<ActionResult<PriceItemResult[]>> => run(async () => (await removePriceListItems(versionId, { ids }, key)).results ?? []);
export const publishVersionAction = async (versionId: string, version: number, body: unknown, key: string) => run(async () => saved(await publishPriceListVersion(versionId, version, body, key)));
export const discardDraftAction = async (versionId: string, version: number) => run(async () => saved(await discardPriceListVersionDraft(versionId, version)));
export const quotePricesAction = async (input: unknown): Promise<ActionResult<PriceQuoteResult[]>> => run(async () => (await quotePrices(input)).quotes ?? []);
/** Centre combobox source (needs identity.centre.read; a failure is just an empty list). */
export async function searchCentresAction(q: string): Promise<Centre[]> {
  const r = await run(() => listCentres());
  const needle = q.trim().toLowerCase();
  return r.ok ? (r.data.data ?? []).filter((c) => c.is_active && (c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle))).slice(0, 20) : [];
}

/** Credit-party combobox source (≤ 200 parties loaded, filtered here [CONV]); failures give an empty list. */
export async function searchCreditPartiesAction(q: string): Promise<{ id: string; label: string }[]> {
  const r = await run(() => listCreditParties({ limit: 200 }));
  const needle = q.trim().toLowerCase();
  return r.ok ? r.data.data.filter((p) => p.is_active && (p.party_code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))).slice(0, 20).map((p) => ({ id: p.id, label: `${p.party_code} — ${p.name}` })) : [];
}

/** Price-list combobox source / name lookup (≤ 200 lists loaded, filtered here [CONV]). */
export async function searchPriceListsAction(q: string): Promise<{ id: string; label: string }[]> {
  const r = await run(() => listPriceLists({ limit: 200 }));
  const needle = q.trim().toLowerCase();
  return r.ok ? r.data.data.filter((p) => p.is_active && (p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))).slice(0, 50).map((p) => ({ id: p.id, label: `${p.code} — ${p.name}` })) : [];
}

export const createSurchargeRuleAction = async (input: unknown, key: string) => run(async () => saved(await createSurchargeRule(input, key)));
export const endSurchargeRuleAction = async (id: string, version: number, input: unknown) => run(async () => saved(await endSurchargeRule(id, version, input)));
export const createTaxTypeAction = async (input: unknown, key: string) => run(async () => saved(await createTaxType(input, key)));
export const updateTaxTypeAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateTaxType(id, version, input)));
export const createTaxRuleAction = async (input: unknown, key: string) => run(async () => saved(await createTaxRule(input, key)));
export const endTaxRuleAction = async (id: string, version: number, input: unknown) => run(async () => saved(await endTaxRule(id, version, input)));

// ---- T0D-PRICETOOLS-1 (LD-321): price list tools. Every write lands in a DRAFT; publishing stays publishVersionAction.
const ver = (v: PriceListVersion): PriceListVersion => ({ id: v.id, price_list_id: v.price_list_id, version_no: v.version_no, status: v.status, item_count: v.item_count, version: v.version });
/** The template (no id) or this list's prices (id) as base64 xlsx; a failed download is a plain failure. */
export async function priceTemplateAction(priceListId?: string): Promise<ActionResult<string>> {
  const r = await run(() => downloadPriceListTemplate(priceListId));
  if (!r.ok) return r;
  return r.data.ok ? { ok: true, data: r.data.base64 } : { ok: false, status: r.data.status, code: 'common.internal' };
}
export const dryRunPriceImportAction = async (priceListId: string, form: FormData, key: string): Promise<ActionResult<PriceImportDryRun>> => run(() => dryRunPriceListImport(priceListId, form, key));
export const commitPriceImportAction = async (batchId: string, changeReason: string, key: string): Promise<ActionResult<PriceListVersion>> => run(async () => ver(await commitPriceListImport(batchId, changeReason, key)));
export const bulkUpdateDraftAction = async (versionId: string, body: unknown, key: string): Promise<ActionResult<PriceBulkResult>> => run(() => bulkUpdatePriceListDraft(versionId, body, key));
export const copyPriceListAction = async (targetId: string, body: unknown, key: string): Promise<ActionResult<PriceListVersion>> => run(async () => ver(await copyPriceList(targetId, body, key)));
export const comparePriceListsAction = async (a: string, b: string, cursor?: string): Promise<ActionResult<Page<PriceComparisonRow>>> => run(() => comparePriceLists(a, b, cursor));
