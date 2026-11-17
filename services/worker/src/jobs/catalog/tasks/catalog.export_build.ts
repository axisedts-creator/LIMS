// catalog.export_build (02-TRD §8.7, §10, §9.1): builds the export workbook in the import-template format (so it round-trips into an import),
// stores it as catalog.files(purpose 'export') and marks the export `ready`. [CR-pending CR-C3-024] the §8.7 REPEATABLE READ snapshot and the
// §10 final-failure-in-dead-letter-tx need worker-core options (.orchestra/cr/C3.T-24.md); until then reads run on the job tx (READ COMMITTED).
// Only exports / files are written: no event, no revision bump. The XlsxWriter neutralises every text cell and writes no formula (S-9).
// Nothing read from the catalog (names, doctor contacts, notes) or any error text is logged (07 S-13). Final failed attempt -> status `failed`.
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { writeXlsx, type SheetIn } from '../xlsx/XlsxWriter.js';
import { TEMPLATE_SHEETS, TEMPLATE_VERSION, type TemplateKind } from '../xlsx/templates/index.js';

export const EXPORT_BUILD = 'catalog.export_build';

const XLSX_CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const WORKING = ['queued', 'building'];
const EXPORT_TTL_MS = 30 * 86_400_000;                                  // 02-TRD §8.7 [CONV]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[a-z_]+\.[a-z_]+$/;

type Q = (text: string, values: unknown[]) => Promise<{ rows: any[] }>;
type Rows = unknown[][];
const fail = (code: string) => Object.assign(new Error(code), { code });
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const byCode = (a: any, b: any) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/** Data rows for each sheet of the kind, keyed by sheet name; sheets not listed are exported with their header only. */
type Data = { sheets: Record<string, Rows>; priceList?: { id: string; code: string; baseVersionNo: number } };

async function readPriceList(q: Q, tenantId: string, versionId: string): Promise<Data> {
  const v = (await q('SELECT id, price_list_id, version_no FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2', [tenantId, versionId])).rows[0];
  if (!v) throw fail('common.not_found');                                 // unknown, or another tenant's version
  const pl = (await q('SELECT id, code FROM catalog.price_lists WHERE tenant_id = $1 AND id = $2', [tenantId, v.price_list_id])).rows[0];
  if (!pl) throw fail('common.not_found');
  const items = (await q('SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [tenantId, v.id])).rows;
  const ids = items.map((i) => i.orderable_id);
  const orderables = ids.length ? (await q('SELECT id, code, kind, name, department_id FROM catalog.orderables WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids])).rows : [];
  const depts = new Map((await q('SELECT id, code FROM catalog.departments WHERE tenant_id = $1', [tenantId])).rows.map((d) => [d.id, d.code]));
  const price = new Map(items.map((i) => [i.orderable_id, Number(i.unit_price_paisa) / 100]));   // bigint arrives as string
  return {
    sheets: { Prices: orderables.sort(byCode).map((o) => [o.code, o.kind, o.name, depts.get(o.department_id) ?? null, price.get(o.id)]) },
    priceList: { id: pl.id, code: pl.code, baseVersionNo: Number(v.version_no) },
  };
}

async function readReferrers(q: Q, tenantId: string): Promise<Data> {
  const { rows } = await q(
    'SELECT doctor_code, display_name, qualification, registration_council, registration_no, phone_e164, email, is_verified FROM catalog.doctors WHERE tenant_id = $1 AND merged_into_id IS NULL ORDER BY doctor_code ASC', [tenantId]);
  return { sheets: { Doctors: rows.map((r) => TEMPLATE_SHEETS.referrers.Doctors!.map((c) => r[c] ?? null)) } };
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));          // numeric / bigint arrive as string
const list = (v: unknown) => (Array.isArray(v) && v.length ? v.join(';') : null);       // 02-TRD §8.2 `;`-separated lists

// Every TEMPLATE_SHEETS.catalog_master sheet, columns per 02-TRD §8.2 from the 05-SCHEMA §10 tables. Joins are done here (code maps by id).
// [CONV] analyte rows / range + limit bands come from the `published` analyte_version / set only (the import needs result_type etc.); TAT = open row
// (effective_to IS NULL), target_minutes = target_seconds / 60; Tests.container_code = container of the preferred specimen type (listed first).
async function readCatalogMaster(q: Q, tenantId: string): Promise<Data> {
  const sel = async (cols: string, table: string, where = '', order = 'code ASC') =>
    (await q(`SELECT ${cols} FROM catalog.${table} WHERE tenant_id = $1${where} ORDER BY ${order}`, [tenantId])).rows;
  const codeOf = (rows: any[]) => new Map<string, string>(rows.map((r) => [r.id, r.code]));
  const depts = await sel('id, code, name, report_order, report_heading', 'departments');
  const specimens = await sel('id, code, name, report_label', 'specimen_types');
  const containers = await sel('id, code, name, additive, cap_colour_display, default_specimen_type_id', 'containers');
  const methods = await sel('id, code, name', 'methods');
  const deptCode = codeOf(depts), specCode = codeOf(specimens), contCode = codeOf(containers), methodCode = codeOf(methods);
  const at = (m: Map<string, string>, id: unknown) => (id ? m.get(id as string) ?? null : null);

  const valueSets = await sel('id, code, is_ordered', 'cs_value_sets');
  const vsById = new Map(valueSets.map((v) => [v.id, v]));
  const vsValues = (await sel('value_set_id, code, display, sort_order', 'cs_value_set_values', '', 'sort_order ASC, code ASC'))
    .filter((v) => vsById.has(v.value_set_id))
    .sort((a, b) => byCode(vsById.get(a.value_set_id), vsById.get(b.value_set_id)));        // stable: keeps sort_order within a set

  const orderables = await sel('id, code, kind, name, department_id, sex_restriction, is_orderable', 'orderables');
  const ordById = new Map(orderables.map((o) => [o.id, o]));
  const ordCode = codeOf(orderables);
  const tests = new Map((await sel('id, workflow_type, report_order', 'tests', '', 'id ASC')).map((t) => [t.id, t]));
  const panels = new Map((await sel('id, panel_kind', 'panels', '', 'id ASC')).map((p) => [p.id, p]));
  const tst = await sel('test_id, specimen_type_id, container_id, is_preferred', 'test_specimen_types', '', 'test_id ASC');
  const specsOf = (testId: string) => tst.filter((s) => s.test_id === testId)
    .sort((a, b) => (a.is_preferred === b.is_preferred ? byCode({ code: at(specCode, a.specimen_type_id) }, { code: at(specCode, b.specimen_type_id) }) : a.is_preferred ? -1 : 1));

  const analytes = await sel('id, test_id, code, name, print_name, report_subheading, sort_order, is_reportable', 'analytes');
  const anCode = codeOf(analytes);
  const versions = new Map((await sel('analyte_id, result_type, unit_code, decimals, method_id, value_set_code, formula_expression', 'analyte_versions',
    " AND status = 'published'", 'analyte_id ASC')).map((v) => [v.analyte_id, v]));

  const bands = async (setTable: string, bandTable: string, cols: string) => {
    const sets = new Map((await sel('id, analyte_id', setTable, " AND status = 'published'", 'id ASC')).map((s) => [s.id, s.analyte_id]));
    return (await sel(`set_id, sex, age_low_value, age_low_unit, age_high_value, age_high_unit, specimen_type_id, ${cols}, sort_order`, bandTable, '', 'sort_order ASC'))
      .filter((b) => sets.has(b.set_id)).map((b) => ({ ...b, code: at(anCode, sets.get(b.set_id)) })).filter((b) => b.code).sort(byCode);
  };
  const ageCols = (b: any) => [b.sex, num(b.age_low_value), b.age_low_unit ?? null, num(b.age_high_value), b.age_high_unit ?? null, at(specCode, b.specimen_type_id)];

  const testRows = orderables.filter((o) => o.kind === 'test' && tests.has(o.id));
  const panelRows = orderables.filter((o) => o.kind === 'panel' && panels.has(o.id));
  const members = (await sel('panel_id, member_orderable_id, sort_order', 'panel_members', '', 'sort_order ASC'))
    .filter((m) => ordById.has(m.panel_id) && ordById.has(m.member_orderable_id))
    .sort((a, b) => byCode(ordById.get(a.panel_id), ordById.get(b.panel_id)));

  return {
    sheets: {
      Departments: depts.map((r) => [r.code, r.name, num(r.report_order), r.report_heading ?? null]),
      SpecimenTypes: specimens.map((r) => [r.code, r.name, r.report_label]),
      Containers: containers.map((r) => [r.code, r.name, r.additive ?? null, r.cap_colour_display ?? null, at(specCode, r.default_specimen_type_id)]),
      Methods: methods.map((r) => [r.code, r.name]),
      Units: (await sel('code, display', 'cs_units')).map((r) => [r.code, r.display]),
      ValueSets: vsValues.map((v) => { const s = vsById.get(v.value_set_id)!; return [s.code, s.is_ordered, v.code, v.display, num(v.sort_order)]; }),
      Tests: testRows.map((o) => {
        const t = tests.get(o.id)!, specs = specsOf(o.id);
        return [o.code, o.name, at(deptCode, o.department_id), t.workflow_type, num(t.report_order), o.is_orderable,
          list(specs.map((s) => at(specCode, s.specimen_type_id))), at(contCode, specs[0]?.container_id)];
      }),
      Analytes: analytes.filter((a) => versions.has(a.id)).map((a) => {
        const v = versions.get(a.id)!;
        return [ordCode.get(a.test_id) ?? null, a.code, a.name, a.print_name ?? null, a.report_subheading ?? null, num(a.sort_order), a.is_reportable,
          v.result_type, v.unit_code ?? null, num(v.decimals), at(methodCode, v.method_id), v.value_set_code ?? null, v.formula_expression ?? null];
      }),
      ReferenceRanges: (await bands('reference_range_sets', 'reference_ranges', 'kind, low, high, normal_codes, display_text'))
        .map((b) => [b.code, ...ageCols(b), b.kind, num(b.low), num(b.high), list(b.normal_codes), b.display_text ?? null]),
      CriticalLimits: (await bands('critical_limit_sets', 'critical_limits', 'low, high, abnormal_codes'))
        .map((b) => [b.code, ...ageCols(b), num(b.low), num(b.high), list(b.abnormal_codes)]),
      Panels: panelRows.map((o) => [o.code, o.name, panels.get(o.id)!.panel_kind, o.sex_restriction ?? null, at(deptCode, o.department_id)]),
      PanelMembers: members.map((m) => [ordCode.get(m.panel_id), ordCode.get(m.member_orderable_id), num(m.sort_order)]),
      CommentCodes: (await sel('code, department_id, text', 'comment_codes')).map((r) => [r.code, at(deptCode, r.department_id), r.text]),
      TatTargets: (await sel('test_id, priority, segment, target_seconds', 'tat_targets', ' AND effective_to IS NULL', 'priority ASC'))
        .filter((r) => ordCode.has(r.test_id)).map((r) => ({ ...r, code: ordCode.get(r.test_id) })).sort(byCode)
        .map((r) => [r.code, r.priority, r.segment, Number(r.target_seconds) / 60]),
    },
  };
}

async function buildWorkbook(kind: TemplateKind, data: Data, revision: number, exportedAt: string): Promise<Uint8Array> {
  const meta: Rows = [['template_kind', kind], ['template_version', TEMPLATE_VERSION], ['tenant_catalog_revision', revision], ['exported_at', exportedAt]];
  if (data.priceList) meta.push(['price_list_id', data.priceList.id], ['price_list_code', data.priceList.code], ['base_version_no', data.priceList.baseVersionNo]);
  const sheets: SheetIn[] = [
    { name: 'Instructions', rows: [
      [`Export: ${kind} (template version ${TEMPLATE_VERSION}), exported ${exportedAt}`],
      ['Row 1 of each data sheet holds the column keys. This file can be edited and imported back.'],
      ['Do not edit the hidden _meta sheet.'],
    ] },
    ...Object.entries(TEMPLATE_SHEETS[kind]).map(([name, cols]) => ({ name, rows: [cols, ...(data.sheets[name] ?? [])] })),
    { name: '_meta', rows: meta, hidden: true },
  ];
  return writeXlsx(sheets);
}

export const exportBuild: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId: string = ctx.tenantId;
  const exportId = payload?.export_id;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof exportId !== 'string' || !UUID.test(exportId)) {
    ctx.log?.warn?.({ event: 'export_build_skipped', reason: 'bad_payload' });
    return;
  }
  const q: Q = (text, values) => ctx.tx.query(text, values);
  const nowIso: string = ctx.now();
  const actor: string = ctx.actor.id;

  // Idempotency + duplicate-delivery guard: the row lock is held until this transaction ends, so a concurrent duplicate waits and then sees `ready`.
  const exp = (await q('SELECT id, kind, params, status FROM catalog.exports WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, exportId])).rows[0];
  if (!exp || !WORKING.includes(exp.status)) return;
  const kind: TemplateKind = exp.kind;

  try {
    // [CR-pending CR-C3-024 item 1] reads run on the job tx (READ COMMITTED): the core opens it and runs set_config first, so a mid-tx
    // `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ` is rejected (25001) and ctx.db.tx reuses the same tx. The §8.7 snapshot needs a core option.
    let data: Data;
    if (kind === 'price_list') {
      const versionId = exp.params?.price_list_version_id;
      if (typeof versionId !== 'string' || !UUID.test(versionId)) throw fail('common.validation_failed');
      data = await readPriceList(q, tenantId, versionId);
    } else if (kind === 'referrers') data = await readReferrers(q, tenantId);
    else if (kind === 'catalog_master') data = await readCatalogMaster(q, tenantId);
    else throw fail('common.validation_failed');
    const rev = (await q('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1', [tenantId])).rows[0];
    const bytes = await buildWorkbook(kind, data, Number(rev?.catalog_revision ?? 0), nowIso);

    const expires = new Date(Date.parse(nowIso) + EXPORT_TTL_MS);
    const fileId = uuidv7();
    await q(
      'INSERT INTO catalog.files (id, tenant_id, purpose, file_name, content_type, byte_size, sha256, content, expires_at, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [fileId, tenantId, 'export', `${kind}-export-${nowIso.slice(0, 10)}.xlsx`, XLSX_CT, bytes.length, sha256(bytes), Buffer.from(bytes), expires, nowIso, actor]);
    await q(
      "UPDATE catalog.exports SET status = 'ready', file_id = $3, expires_at = $4, last_error_code = NULL, version = version + 1, updated_at = $5, updated_by = $6 WHERE tenant_id = $1 AND id = $2",
      [tenantId, exportId, fileId, expires, nowIso, actor]);
    ctx.metrics?.inc?.('lims_catalog_exports_total', { kind, outcome: 'ready' });          // 02-TRD §12
  } catch (e) {
    if (ctx.attempt < ctx.maxAttempts) throw e;                                             // retries remain: the tx rolls back
    // [CR-pending CR-C3-024 item 2] 02-TRD §10 wants `failed` in the dead-letter tx; core capture() has no per-task hook yet. Until then the
    // final attempt writes `failed` on the job tx and RESOLVES (a rethrow would roll the write back). Ceiling: a Postgres error leaves the tx
    // aborted (25P02), this UPDATE then throws and the export stays queued — the onFinalFailure hook removes that.
    const code = typeof (e as any)?.code === 'string' && ERROR_CODE.test((e as any).code) ? (e as any).code : 'common.internal';
    await q(
      "UPDATE catalog.exports SET status = 'failed', last_error_code = $3, version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'building')",
      [tenantId, exportId, code, nowIso, actor]);
    ctx.metrics?.inc?.('lims_catalog_exports_total', { kind, outcome: 'failed' });
    ctx.log?.error?.({ event: 'export_failed', export_id: exportId, kind, code });
  }
};
