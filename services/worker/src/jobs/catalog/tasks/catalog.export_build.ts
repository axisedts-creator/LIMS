// catalog.export_build (02-TRD §8.7, §10, §9.1): builds the export workbook from ONE consistent snapshot (REPEATABLE READ read transaction) in the
// import-template format (so it round-trips into an import), stores it as catalog.files(purpose 'export') and marks the export `ready`.
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

// ponytail: only the master tables whose columns are fixed by 05-SCHEMA §3 are exported; the other TEMPLATE_SHEETS.catalog_master sheets keep their header row only.
async function readCatalogMaster(q: Q, tenantId: string): Promise<Data> {
  const all = async (cols: string, table: string) =>
    (await q(`SELECT ${cols} FROM catalog.${table} WHERE tenant_id = $1 ORDER BY code ASC`, [tenantId])).rows;
  const specimens = await all('id, code, name, report_label', 'specimen_types');
  const specCode = new Map(specimens.map((s) => [s.id, s.code]));
  return {
    sheets: {
      Departments: (await all('code, name, report_order, report_heading', 'departments')).map((r) => [r.code, r.name, Number(r.report_order), r.report_heading ?? null]),
      SpecimenTypes: specimens.map((r) => [r.code, r.name, r.report_label]),
      Containers: (await all('code, name, additive, cap_colour_display, default_specimen_type_id', 'containers'))
        .map((r) => [r.code, r.name, r.additive ?? null, r.cap_colour_display ?? null, specCode.get(r.default_specimen_type_id) ?? null]),
      Methods: (await all('code, name', 'methods')).map((r) => [r.code, r.name]),
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
    // One consistent snapshot of every catalog read (REPEATABLE READ; SET TRANSACTION must be the first statement of its transaction).
    const { bytes } = await ctx.db.tx(async (c: any) => {
      const r: Q = (text, values) => c.tx.query(text, values);
      await c.tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ', []);
      let data: Data;
      if (kind === 'price_list') {
        const versionId = exp.params?.price_list_version_id;
        if (typeof versionId !== 'string' || !UUID.test(versionId)) throw fail('common.validation_failed');
        data = await readPriceList(r, tenantId, versionId);
      } else if (kind === 'referrers') data = await readReferrers(r, tenantId);
      else if (kind === 'catalog_master') data = await readCatalogMaster(r, tenantId);
      else throw fail('common.validation_failed');
      const rev = (await r('SELECT catalog_revision FROM catalog.catalog_state WHERE tenant_id = $1', [tenantId])).rows[0];
      return { bytes: await buildWorkbook(kind, data, Number(rev?.catalog_revision ?? 0), nowIso) };
    });

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
    if (ctx.attempt >= ctx.maxAttempts) {
      const code = typeof (e as any)?.code === 'string' && ERROR_CODE.test((e as any).code) ? (e as any).code : 'common.internal';
      // Own transaction: ctx.tx is rolled back by the rethrow below.
      await ctx.db.tx((c: any) => c.tx.query(
        "UPDATE catalog.exports SET status = 'failed', last_error_code = $3, version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'building')",
        [tenantId, exportId, code, nowIso, actor]));
      ctx.metrics?.inc?.('lims_catalog_exports_total', { kind, outcome: 'failed' });
      ctx.log?.error?.({ event: 'export_failed', export_id: exportId, kind, code });
    }
    throw e;
  }
};
