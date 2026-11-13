// C12.T-04 mappers: explicit field allowlists + cost allowlist (02-TRD §3.1 mappers/, §6.2, §6.3; 07-SECURITY §3 REQ-SEC-081, PE-3; PRD AC-21.9).
// Oracle: contracts/openapi/inventory.yaml (see oracle.ts), never the implementation. Without `inventory.cost.read` every key ending
// `_paisa` / `_paisa_x1e6` and `value_basis` is absent at every depth; with it the DTO has exactly the schema's keys. `basis_key`,
// `source_event_id`, `tenant_id`, `created_by` … are never returned.
//
// SEAM the writer must provide (the spec fixes the file pattern `mappers/<aggregate>.dto.ts` and the permission input, not the names):
//   every mapper is `(row, permissions: readonly string[]) => Dto`, a PURE function (no ports, no ctx, no mutation of its input);
//   `permissions` = ctx.actorProfile.permissions (§6.3), compared with exact string equality.
//   `row` carries the DTO's snake_case wire keys plus any extra DB columns; joined / derived fields (branch_name, created_by_display,
//   last_receipt_unit_cost_paisa_x1e6, invoice_total_mismatch_paisa, is_exempt …) are supplied by the service in the row.
//   mappers/lot.dto.ts            toLotDto            (Lot, nested balances[] = BalanceRow)
//   mappers/balance.dto.ts        toBalanceRowDto     (BalanceRow)
//   mappers/movement.dto.ts       toMovementDto       (Movement)
//   mappers/supplier.dto.ts       toSupplierDto, toSupplierSummaryDto, toSupplierItemDto
//   mappers/purchaseOrder.dto.ts  toPoDto, toPoSummaryDto, toPoPrintViewDto   (print view: no cost.read → throws LimsError auth.forbidden)
//   mappers/goodsReceipt.dto.ts   toGrnDto, toGrnSummaryDto
//   mappers/transfer.dto.ts       toTransferDto
//   mappers/stockDocument.dto.ts  toStockDocumentDto
//   mappers/count.dto.ts          toCountDto
//   mappers/fact.dto.ts           toFactDto
//   mappers/consumption.dto.ts    toConsumptionPreviewDto  (previewConsumption response; est_value_paisa omitted without cost)
//   mappers/report.dto.ts         toReportResultDto        (columns/rows/totals; cost_per_test without cost.read → throws auth.forbidden)
//   po / grn / transfer / count `lines` exclude soft-removed lines (removed_at set; 02-TRD §6.2, 05 §2.16–2.18). A line with
//   is_exempt: true never carries `tax_code` (not even null; D-70).
import { describe, expect, it } from 'vitest';
import { COST_READ, SCHEMAS, WITHOUT_COST, WITH_COST, NEVER_RETURNED, costPaths, deepFreeze, isCostKey, keyPaths, sampleOf, shape, stripCost, withInternals } from './oracle.js';
import { toLotDto } from '../lot.dto.js';
import { toBalanceRowDto } from '../balance.dto.js';
import { toMovementDto } from '../movement.dto.js';
import { toSupplierDto, toSupplierItemDto, toSupplierSummaryDto } from '../supplier.dto.js';
import { toPoDto, toPoPrintViewDto, toPoSummaryDto } from '../purchaseOrder.dto.js';
import { toGrnDto, toGrnSummaryDto } from '../goodsReceipt.dto.js';
import { toTransferDto } from '../transfer.dto.js';
import { toStockDocumentDto } from '../stockDocument.dto.js';
import { toCountDto } from '../count.dto.js';
import { toFactDto } from '../fact.dto.js';
import { toConsumptionPreviewDto } from '../consumption.dto.js';
import { toReportResultDto } from '../report.dto.js';

type Mapper = (row: any, permissions: readonly string[]) => any;

/** DTO schema -> mapper. `cost` = the schema (at any depth) declares cost keys; those are the DTOs PE-3 / §6.3 require tested both ways. */
const DTOS: { schema: string; map: Mapper; cost: boolean }[] = [
  { schema: 'Lot', map: toLotDto, cost: true },
  { schema: 'BalanceRow', map: toBalanceRowDto, cost: true },
  { schema: 'Movement', map: toMovementDto, cost: true },
  { schema: 'Supplier', map: toSupplierDto, cost: false },
  { schema: 'SupplierSummary', map: toSupplierSummaryDto, cost: false },
  { schema: 'SupplierItem', map: toSupplierItemDto, cost: true },
  { schema: 'Po', map: toPoDto, cost: true },
  { schema: 'PoSummary', map: toPoSummaryDto, cost: true },
  { schema: 'Grn', map: toGrnDto, cost: true },
  { schema: 'GrnSummary', map: toGrnSummaryDto, cost: true },
  { schema: 'Transfer', map: toTransferDto, cost: true }, // lines[].dispatched_value_paisa
  { schema: 'StockDocument', map: toStockDocumentDto, cost: true }, // lines[].value_paisa, movements[]
  { schema: 'Count', map: toCountDto, cost: true },
  { schema: 'Fact', map: toFactDto, cost: true },
];

const sample = (schema: string): any => sampleOf({ $ref: `#/components/schemas/${schema}` });

describe('the contract itself carries cost fields on the DTOs the matrix expects (guards the oracle)', () => {
  it.each(DTOS.filter((d) => d.cost))('$schema has cost paths in its sample', ({ schema }) => {
    expect(costPaths(sample(schema)).length).toBeGreaterThan(0);
  });
  it('cost DTO list is complete: every schema with a cost key at any depth is covered (or is PoPrintView / ReportRow / the preview, tested below)', () => {
    const covered = new Set([...DTOS.map((d) => d.schema), 'PoPrintView', 'ReportRow', 'ReportResult', 'GrnDraft', 'CountLine']);
    const missing = Object.keys(SCHEMAS).filter((n) => !covered.has(n) && costPaths(sample(n)).length > 0);
    expect(missing).toEqual([]);
  });
});

describe.each(DTOS)('$schema mapper', ({ schema, map, cost }) => {
  const dbRow = (): any => withInternals(sample(schema));

  it('with inventory.cost.read: exactly the schema keys (allowlist), nothing internal, cost keys present', () => {
    const out = map(dbRow(), WITH_COST);
    expect(shape(out)).toEqual(shape(sample(schema)));
    expect(stripCost(out)).toEqual(stripCost(sample(schema)));
    expect(costPaths(out).sort()).toEqual(costPaths(sample(schema)).sort());
    for (const k of NEVER_RETURNED) expect(keyPaths(out).filter((p) => p.endsWith(k))).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('INTERNAL-');
  });

  it('without inventory.cost.read: same DTO minus every cost key at every depth', () => {
    const out = map(dbRow(), WITHOUT_COST);
    expect(out).toEqual(stripCost(sample(schema)));
    expect(keyPaths(out).filter((p) => isCostKey(p.split('.').pop()!))).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('INTERNAL-');
    if (cost) expect(shape(out)).not.toEqual(shape(map(dbRow(), WITH_COST)));
  });

  it.each([
    ['empty permissions', []],
    ['look-alike codes', ['inventory.cost.readx', 'xinventory.cost.read', 'inventory.cost', 'cost.read', 'INVENTORY.COST.READ', 'inventory.cost.read ', 'inventory.report.export', 'inventory.po.approve']],
  ] as [string, string[]][])('%s: no cost key (exact match on the permission code)', (_n, perms) => {
    expect(keyPaths(map(dbRow(), perms)).filter((p) => isCostKey(p.split('.').pop()!))).toEqual([]);
  });

  it('fails closed on a missing permission list: throws or omits cost, never returns cost', () => {
    let out: unknown;
    try { out = map(dbRow(), undefined as never); } catch { return; }
    expect(keyPaths(out).filter((p) => isCostKey(p.split('.').pop()!))).toEqual([]);
  });

  it('is pure: a deep-frozen input is not mutated and the same input maps the same twice', () => {
    const row = deepFreeze(dbRow());
    const a = map(row, WITHOUT_COST);
    const b = map(row, WITH_COST);
    expect(map(row, WITHOUT_COST)).toEqual(a);
    expect(map(row, WITH_COST)).toEqual(b);
    expect(row).toEqual(dbRow()); // nothing deleted from the shared row (mapping for a cost user after a non-cost user still has cost)
    if (cost) expect(costPaths(b).length).toBeGreaterThan(0);
  });
});

describe('cost values are passed through unchanged for a cost reader (no rounding, no unit change)', () => {
  it('Movement', () => {
    const out = toMovementDto({ ...sample('Movement'), value_paisa: 1234567, value_basis: 'average' }, WITH_COST);
    expect(out.value_paisa).toBe(1234567);
    expect(out.value_basis).toBe('average');
  });
  it('Po totals', () => {
    const out = toPoDto({ ...sample('Po'), subtotal_paisa: 100, discount_paisa: 10, net_paisa: 90, vat_paisa: 11, total_paisa: 101 }, WITH_COST);
    expect([out.subtotal_paisa, out.discount_paisa, out.net_paisa, out.vat_paisa, out.total_paisa]).toEqual([100, 10, 90, 11, 101]);
  });
  it('BalanceRow', () => {
    const out = toBalanceRowDto({ ...sample('BalanceRow'), value_paisa: 5000, avg_unit_cost_paisa_x1e6: 1234567 }, WITH_COST);
    expect([out.value_paisa, out.avg_unit_cost_paisa_x1e6]).toEqual([5000, 1234567]);
  });
});

describe('lines: soft-removed lines never appear; exempt lines carry no tax_code', () => {
  it.each([
    ['Po', toPoDto], ['Grn', toGrnDto], ['Transfer', toTransferDto], ['Count', toCountDto],
  ] as [string, Mapper][])('%s drops removed_at lines (02-TRD §6.2: non-removed only)', (schema, map) => {
    const row = withInternals(sample(schema));
    const live = { ...row.lines[0], id: 'live' };
    const gone = { ...row.lines[0], id: 'gone', removed_at: '2026-11-05T04:15:00.000Z', removed_by: 'u' };
    for (const perms of [WITH_COST, WITHOUT_COST]) {
      const out = map({ ...row, lines: [gone, live, { ...gone, id: 'gone2' }] }, perms);
      expect(out.lines.map((l: any) => l.id)).toEqual(['live']);
      expect(keyPaths(out)).not.toContain('lines.removed_at');
      expect(keyPaths(out)).not.toContain('lines.removed_by');
    }
  });

  it.each([['Po', toPoDto], ['Grn', toGrnDto]] as [string, Mapper][])('%s: an exempt line has is_exempt true and no tax_code key (never null on the wire, D-70)', (schema, map) => {
    const row = withInternals(sample(schema));
    const line = { ...row.lines[0], is_exempt: true, tax_code: null };
    for (const perms of [WITH_COST, WITHOUT_COST]) {
      const out = map({ ...row, lines: [line] }, perms);
      expect(out.lines[0].is_exempt).toBe(true);
      expect('tax_code' in out.lines[0]).toBe(false);
    }
    const taxed = map({ ...row, lines: [{ ...row.lines[0], is_exempt: false, tax_code: 'VAT' }] }, WITHOUT_COST);
    expect(taxed.lines[0].tax_code).toBe('VAT');
  });
});

describe('supplier contact fields only in supplier endpoints (07-SECURITY row 081)', () => {
  const contact = ['pan_text', 'contact_name', 'phone_display', 'email', 'address_text'];
  it('Supplier keeps them (no cost involved)', () => {
    const out = toSupplierDto(withInternals(sample('Supplier')), WITHOUT_COST);
    for (const k of contact) expect(out).toHaveProperty(k);
  });
  it.each([['SupplierSummary', toSupplierSummaryDto]] as [string, Mapper][])('%s drops them even when the row carries them', (_n, map) => {
    const out = map(withInternals(sample('Supplier')), WITH_COST);
    for (const k of contact) expect(out).not.toHaveProperty(k);
    expect(shape(out)).toEqual(shape(sample('SupplierSummary')));
  });
  it('the price a supplier item carries is cost: last_unit_price_paisa follows the permission', () => {
    const row = withInternals(sample('SupplierItem'));
    expect(toSupplierItemDto(row, WITH_COST)).toHaveProperty('last_unit_price_paisa');
    expect(toSupplierItemDto(row, WITHOUT_COST)).not.toHaveProperty('last_unit_price_paisa');
  });
});

describe('Transfer / StockDocument: money inside nested lines and movements follows the permission too (07 §3: all *_paisa)', () => {
  it('a Transfer row whose lines carry dispatched_value_paisa (05 §2.18) never returns it without cost.read', () => {
    const row = withInternals(sample('Transfer'));
    row.lines = [{ ...row.lines[0], dispatched_value_paisa: 777 }];
    expect(keyPaths(toTransferDto(row, WITHOUT_COST)).filter(isCostPath)).toEqual([]);
  });
  it('a StockDocument row whose lines carry value_paisa (05 §2.19) never returns it without cost.read', () => {
    const row = withInternals(sample('StockDocument'));
    row.lines = [{ ...row.lines[0], value_paisa: 777 }];
    row.movements = [{ ...sample('Movement'), value_paisa: 5, value_basis: 'average' }];
    const out = toStockDocumentDto(row, WITHOUT_COST);
    expect(keyPaths(out).filter(isCostPath)).toEqual([]);
    expect(out.movements).toHaveLength(1);
  });
});
const isCostPath = (p: string): boolean => isCostKey(p.split('.').pop()!);

describe('previewConsumption (#74): est_value_paisa omitted without cost.read', () => {
  const resp = { store_id: 'S', store_resolution_step: 1, lines: [{ rule_id: 'R', item_id: 'I', qty_base: '10', lot_id: 'L', est_value_paisa: 125000 }, { rule_id: 'R2', item_id: 'I2', qty_base: '1', est_value_paisa: 0 }] };
  it('with cost', () => expect(toConsumptionPreviewDto(resp, WITH_COST)).toEqual(resp));
  it('without cost: lines keep rule_id/item_id/qty_base/lot_id, lose est_value_paisa (also when it is 0)', () => {
    expect(toConsumptionPreviewDto(resp, WITHOUT_COST)).toEqual({
      store_id: 'S', store_resolution_step: 1,
      lines: [{ rule_id: 'R', item_id: 'I', qty_base: '10', lot_id: 'L' }, { rule_id: 'R2', item_id: 'I2', qty_base: '1' }],
    });
  });
});

describe('PO print view: money-only (02-TRD §6.3, #89)', () => {
  it('without cost.read: throws auth.forbidden, nothing returned', () => {
    let code: unknown = '<no throw>';
    try { toPoPrintViewDto(sample('PoPrintView'), WITHOUT_COST); } catch (e) { code = (e as { code?: unknown }).code; }
    expect(code).toBe('auth.forbidden');
  });
  it('with cost.read: exactly the PoPrintView keys', () => {
    expect(shape(toPoPrintViewDto(withInternals(sample('PoPrintView')), WITH_COST))).toEqual(shape(sample('PoPrintView')));
  });
});

// ---- reports (#92): columns drop † columns; rows and totals lose those keys; cost_per_test is money-only (PRD AC-21.9, PE-3)
const col = (key: string, is_cost = false) => ({ key, label: key, is_cost });
const REPORTS: { code: string; cols: ReturnType<typeof col>[]; row: Record<string, unknown> }[] = [
  { code: 'daily_consumption', cols: [col('business_date'), col('store_id'), col('store_code'), col('item_id'), col('item_code'), col('item_name'), col('base_uom_code'), col('movement_kind'), col('qty_consumed'), col('value_consumed_paisa', true), col('movements')],
    row: { business_date: '2026-11-05', store_id: 's', store_code: 'MAIN', item_id: 'i', item_code: 'I1', item_name: 'n', base_uom_code: 'mL', movement_kind: 'consume_test', qty_consumed: '5', value_consumed_paisa: 4200, movements: 3 } },
  { code: 'analyser_consumption', cols: [col('instrument_id'), col('instrument_label'), col('item_id'), col('item_code'), col('movement_kind'), col('qty_consumed'), col('value_consumed_paisa', true), col('tests')],
    row: { instrument_id: 'x', instrument_label: 'A', item_id: 'i', item_code: 'I1', movement_kind: 'consume_test', qty_consumed: '5', value_consumed_paisa: 4200, tests: [{ test_id: 't', test_code: 'T', tests_counted: 4, rerun_events: 0, qc_events: 1 }] } },
  { code: 'wastage', cols: [col('store_id'), col('item_id'), col('item_code'), col('category'), col('qty'), col('value_paisa', true)],
    row: { store_id: 's', item_id: 'i', item_code: 'I1', category: 'expiry_writeoff', qty: '2', value_paisa: 900 } },
  { code: 'expiry', cols: [col('store_id'), col('item_id'), col('item_code'), col('lot_id'), col('lot_no'), col('expiry_on'), col('days_to_expiry'), col('qty_base'), col('value_paisa', true), col('lot_status'), col('has_open_container')],
    row: { store_id: 's', item_id: 'i', item_code: 'I1', lot_id: 'l', lot_no: 'L1', expiry_on: '2026-12-01', days_to_expiry: 26, qty_base: '3', value_paisa: 900, lot_status: 'available', has_open_container: false } },
  { code: 'stock_valuation', cols: [col('store_id'), col('item_id'), col('item_code'), col('lot_id'), col('lot_no'), col('qty_base'), col('value_paisa', true), col('avg_unit_cost_paisa_x1e6', true)],
    row: { store_id: 's', item_id: 'i', item_code: 'I1', lot_id: 'l', lot_no: 'L1', qty_base: '3', value_paisa: 900, avg_unit_cost_paisa_x1e6: 300000000 } },
];
const result = (code: string, cols: unknown[], row: Record<string, unknown>) => ({
  report_code: code, params: { business_date_from: '2026-11-01', business_date_to: '2026-11-06' }, columns: cols, rows: [row, { ...row }],
  totals: Object.fromEntries(Object.entries(row).filter(([k]) => /_paisa|qty/.test(k))), generated_at: '2026-11-05T04:15:00.000Z', truncated: false,
});

describe.each(REPORTS)('report $code', ({ code, cols, row }) => {
  it('with cost.read: unchanged', () => {
    const r = result(code, cols, row);
    expect(toReportResultDto(structuredClone(r), WITH_COST)).toEqual(r);
  });
  it('without cost.read: the same report with every cost column, row key and total removed (AC-21.9)', () => {
    const out = toReportResultDto(structuredClone(result(code, cols, row)), WITHOUT_COST);
    expect(out.columns.every((c: any) => !c.is_cost && !isCostKey(c.key))).toBe(true);
    expect(out.columns.map((c: any) => c.key)).toEqual(cols.filter((c) => !c.is_cost).map((c) => c.key));
    expect(keyPaths(out.rows).filter(isCostPath)).toEqual([]);
    expect(keyPaths(out.totals).filter(isCostPath)).toEqual([]);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toEqual(stripCost(row));
    expect(out.report_code).toBe(code);
    expect(out.truncated).toBe(false);
    expect(out.generated_at).toBe('2026-11-05T04:15:00.000Z');
  });
  it('without cost.read, look-alike permission: still removed', () => {
    const out = toReportResultDto(structuredClone(result(code, cols, row)), ['inventory.cost.readx', 'inventory.report.export']);
    expect(keyPaths(out.rows).filter(isCostPath)).toEqual([]);
  });
});

describe('report cost_per_test and consumption_reconciliation', () => {
  const cpt = result('cost_per_test',
    [col('test_id'), col('test_code'), col('tests_counted'), col('direct_value_paisa', true), col('cpt_loaded_paisa', true), col('standard_is_complete', true)],
    { test_id: 't', test_code: 'T', tests_counted: 9, direct_value_paisa: 100, cpt_loaded_paisa: 12, standard_is_complete: true });
  it('cost_per_test without cost.read: throws auth.forbidden (money-only report), nothing returned', () => {
    let code: unknown = '<no throw>';
    try { toReportResultDto(structuredClone(cpt), WITHOUT_COST); } catch (e) { code = (e as { code?: unknown }).code; }
    expect(code).toBe('auth.forbidden');
  });
  it('cost_per_test with cost.read: unchanged (breakdown included)', () => {
    const r = structuredClone(cpt);
    (r.rows[0] as any).breakdown = { consume_test: 1, consume_analyte: 2, consume_rerun: 3, consume_qc: 4, consume_calibration: 5 };
    expect(toReportResultDto(structuredClone(r), [COST_READ])).toEqual(r);
  });
  it('consumption_reconciliation has no cost column: identical with and without', () => {
    const r = result('consumption_reconciliation', [col('business_date'), col('instrument_id'), col('c12_verified_result_events'), col('lab_results_verified'), col('diff'), col('diff_bp')],
      { business_date: '2026-11-05', instrument_id: 'x', c12_verified_result_events: 10, lab_results_verified: 9, diff: 1, diff_bp: 1000 });
    expect(toReportResultDto(structuredClone(r), WITHOUT_COST)).toEqual(r);
  });
});
