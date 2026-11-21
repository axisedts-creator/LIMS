// T0B-TESTIMPORT-1 (LD-318 + follow-up, LD-325, LD-335; T0C-TESTIMPORT-1 contract): the Excel test import. downloadCatalogImportTemplate, validateCatalogImport (dry run: the
// ONLY write is the catalog.import_batch history row), commitCatalogImport (one transaction, through the existing catalog services so every row gets their own validation,
// audit trigger, revision bump and catalog.changed.v1 event; DRAFTS only, never publishes: LD-318 decision 2), listCatalogImports, getCatalogImport, downloadCatalogImportErrors.
// Every operation asserts catalog.test.manage itself (IdentityPort) before reading anything. Synthetic data only in tests; no file bytes are stored, only the normalized JSON.
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as masters from '../repo/masters.repo.js';
import * as repo from '../repo/tests.repo.js';
import { createAnalyteVersionsService } from '../service/analyteVersions.service.js';
import { fail, invalid, isObj, required, UUID, type Ctx as BaseCtx, type Deps, type Tx } from '../service/masters.service.js';
import { createPanelsService } from '../service/panels.service.js';
import { createRangesService } from '../service/ranges.service.js';
import { createTestsService, limitOf } from '../service/tests.service.js';
import { DATA_SHEETS, ERRORS_HEADER, FIELDS, SHEET, TEMPLATE_CHECKSUM, TEMPLATE_VERSION, labels, type DataSheet } from './fields.js';
import { validate, clean, type ImportError, type Masters, type Model, type Result } from './validate.js';
import { MAX_ROWS, readWorkbook, writeWorkbook, type OutSheet } from './xlsx.js';

export interface Identity { assertRole(ctx: unknown, requirement: { permission: string }): Promise<unknown> }
export type Ctx = BaseCtx & { readonly events: Deps['events'] };
const PERMISSION = 'catalog.test.manage';
const EXPIRY_MS = 24 * 3600 * 1000;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BATCH_COLS = ['id', 'file_name', 'file_sha256', 'template_version', 'mode', 'status', 'counts', 'created_by', 'created_at', 'validated_at', 'committed_at', 'committed_by', 'version'];
const MODES = ['create_only', 'update'];
const STATUSES = ['validated', 'rejected', 'committed', 'expired'];
type Batch = Record<string, any>;

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const dto = (b: Batch) => {
  const c = b.counts ?? {};
  return Object.fromEntries(Object.entries({
    id: b.id, file_name: b.file_name, file_sha256: b.file_sha256, template_version: b.template_version, mode: b.mode, status: b.status,
    counts: { tests: Number(c.tests ?? 0), analytes: Number(c.analytes ?? 0), ranges: Number(c.ranges ?? 0), panels: Number(c.panels ?? 0), errors: Number(c.errors ?? 0) },
    created_by: b.created_by, created_at: iso(b.created_at), validated_at: b.validated_at ? iso(b.validated_at) : undefined,
    committed_at: b.committed_at ? iso(b.committed_at) : undefined, committed_by: b.committed_by ?? undefined, version: Number(b.version),
  }).filter(([, v]) => v !== undefined));
};
const fileName = (v: unknown): string => {
  const base = typeof v === 'string' ? clean(v).replace(/^.*[\\/]/, '').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 255) : '';
  return base || 'upload.xlsx';
};

async function loadMasters(tx: Tx, t: string): Promise<Masters & { lists: Record<string, string[]> }> {
  const own = { tenant_id: t, is_active: true };
  const [dept, spec, meth, cu, gu, cvs, gvs, cat] = [
    await masters.selectRows(tx, 'departments', ['id', 'code'], own, 'code'), await masters.selectRows(tx, 'specimen_types', ['id', 'code'], own, 'code'),
    await masters.selectRows(tx, 'methods', ['id', 'code'], own, 'code'), await masters.selectRows(tx, 'cs_units', ['code'], own, 'code'),
    await masters.selectRows(tx, 'g_units', ['code'], { is_active: true }, 'code'), await masters.selectRows(tx, 'cs_value_sets', ['code', 'is_ordered'], own, 'code'),
    await masters.selectRows(tx, 'g_value_sets', ['code', 'is_ordered'], { is_active: true }, 'code'), await masters.selectRows(tx, 'test_categories', ['id', 'name', 'department_id'], own, 'name'),
  ];
  const valueSet = new Map<string, boolean>(gvs.map((r) => [r.code, r.is_ordered === true]));
  for (const r of cvs) valueSet.set(r.code, r.is_ordered === true);                    // the tenant's own set wins (analytes.repo.valueSetOrdered order)
  return {
    department: new Map(dept.map((r) => [r.code, r.id])), specimen: new Map(spec.map((r) => [r.code, r.id])), method: new Map(meth.map((r) => [r.code, r.id])),
    unit: new Set([...cu, ...gu].map((r) => r.code as string)), valueSet, category: cat,
    lists: {
      Departments: dept.map((r) => r.code), Categories: [...new Set(cat.map((r) => r.name as string))], 'Specimen Types': spec.map((r) => r.code), Methods: meth.map((r) => r.code),
      Units: [...new Set([...cu, ...gu].map((r) => r.code as string))], 'Value Sets': [...valueSet.keys()], Instruments: [], Laboratories: [],
    },
  };
}

// ------------------------------------------------------------------------------------------------ workbook shapes
function instructions(): string[][] {
  const rules = [
    ['Excel test import', '', '', 'One workbook with the same fields as the Add Test, Add Test Parameter and Reference Range forms. Fill the sheets, then upload it under Test Management.'],
    ['Rules', '', '', 'xlsx only (no xlsm, no xls, no macros, no external links, no formulas). At most 5 MB and at most 5000 rows per sheet.'],
    ['Rules', '', '', 'Text cells may not start with = + - or @. Codes are unique in the file and in the catalog (mode create_only refuses an existing code).'],
    ['Rules', '', '', 'Every error is listed with its sheet, row and column (at most 1000). Nothing is written until you commit a validated upload (within 24 hours).'],
    ['Rules', '', '', 'The import creates tests and parameters with DRAFT versions and DRAFT reference ranges only: it never publishes. A pathologist publishes them as usual.'],
    ['Rules', '', '', 'Reference Ranges: one row per band; Age From < Age To; no overlapping bands of the same sex; critical limits outside the normal range (0 and 0 = none).'],
  ];
  const cols = DATA_SHEETS.flatMap((s) => FIELDS[s].map((d) => [s, d.label, d.required ? 'required' : '', d.help]));
  return [['Sheet', 'Column', 'Required', 'What to enter'], ...rules, ...cols];
}
function listsAndMeta(lists: Record<string, string[]>): { sheets: OutSheet[]; col: Map<string, string> } {
  const names = new Map<string, string[]>();
  for (const s of DATA_SHEETS) for (const d of FIELDS[s]) {
    if (d.kind.t === 'enum') names.set(d.kind.list, [...d.kind.values]);
    if (d.kind.t === 'master') names.set(d.kind.list, (lists[d.kind.list] ?? []).slice(0, MAX_ROWS));
  }
  const keys = [...names.keys()], height = Math.max(1, ...[...names.values()].map((v) => v.length));
  const rows = [keys, ...Array.from({ length: height }, (_, i) => keys.map((k) => names.get(k)![i] ?? ''))];
  const col = new Map(keys.map((k, i) => { const n = Math.max(1, names.get(k)!.length) + 1; const c = colLetter(i); return [k, `Lists!$${c}$2:$${c}$${n}`]; }));
  return {
    sheets: [{ name: SHEET.lists, rows, state: 'hidden' }, { name: SHEET.meta, rows: [['template_version', TEMPLATE_VERSION], ['checksum', TEMPLATE_CHECKSUM]], state: 'hidden' }],
    col,
  };
}
const colLetter = (i: number): string => { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
function dataSheet(s: DataSheet, col: Map<string, string>, rows: string[][] = [], protect = true): OutSheet {
  const validations = FIELDS[s].flatMap((d, i) => (d.kind.t === 'enum' || d.kind.t === 'master' ? [{ col: i, formula: col.get(d.kind.list)! }] : d.kind.t === 'bool' ? [{ col: i, formula: '"yes,no"' }] : []));
  return { name: s, rows: [labels(s), ...rows], protect, inputCols: FIELDS[s].length, validations };
}

// ------------------------------------------------------------------------------------------------ parse the upload (file-level checks)
function parseUpload(bytes: Uint8Array): Record<DataSheet, { row: number; cells: string[] }[]> {
  const wb = readWorkbook(bytes, [SHEET.instructions, ...DATA_SHEETS, SHEET.lists, SHEET.meta]);
  const meta = wb.sheets.get(SHEET.meta);
  if (!meta) throw new LimsError('catalog.import_invalid_file', 'not the test import template (no Meta sheet)');
  const kv = new Map(meta.rows.map((r) => [clean(r.cells[0] ?? ''), clean(r.cells[1] ?? '')]));
  if (kv.get('template_version') !== TEMPLATE_VERSION || kv.get('checksum') !== TEMPLATE_CHECKSUM) throw new LimsError('catalog.import_template_outdated');
  const out = {} as Record<DataSheet, { row: number; cells: string[] }[]>;
  for (const s of DATA_SHEETS) {
    const sh = wb.sheets.get(s);
    if (!sh) throw new LimsError('catalog.import_template_outdated', `sheet ${s} missing`);
    const head = (sh.rows.find((r) => r.row === 1)?.cells ?? []).map((x) => clean(x));
    const want = labels(s);
    const extra = head.slice(want.length).filter(Boolean);
    if (want.some((l, i) => head[i] !== l) || !(extra.length === 0 || (extra.length === 1 && head[want.length] === ERRORS_HEADER))) throw new LimsError('catalog.import_template_outdated', `headers of sheet ${s} differ from the template`);
    out[s] = sh.rows.filter((r) => r.row > 1);
  }
  return out;
}

/** The catalog rows the file's codes may collide with (tests, panels, members, analytes), in one statement per table. */
async function catalogFor(tx: Tx, t: string, sheets: Record<DataSheet, { cells: string[] }[]>) {
  const colOf = (s: DataSheet, label: string) => labels(s).indexOf(label);
  const take = (s: DataSheet, label: string) => sheets[s].map((r) => clean(r.cells[colOf(s, label)] ?? '').toUpperCase()).filter((x) => x && x.length <= 64);
  const codes = [...new Set([...take(SHEET.tests, 'Test Code'), ...take(SHEET.panels, 'Panel Code'), ...take(SHEET.panels, 'Member Code')])];
  const an = [...new Set(take(SHEET.params, 'Short Name'))];
  const ords = codes.length ? await repo.find(tx, 'orderables', ['id', 'kind', 'code'], t, {}, { anyOf: { col: 'code', values: codes } }) : [];
  const ans = an.length ? await repo.find(tx, 'analytes', ['id', 'code', 'test_id'], t, {}, { anyOf: { col: 'code', values: an } }) : [];
  return { orderables: new Map(ords.map((o) => [o.code as string, { id: o.id as string, kind: o.kind as string }])), analytes: new Map(ans.map((a) => [a.code as string, { id: a.id as string, test_id: a.test_id as string }])) };
}

// ------------------------------------------------------------------------------------------------ service
export function createTestImportService(deps: { identity: Identity }) {
  const assert = (ctx: Ctx) => deps.identity.assertRole(ctx, { permission: PERMISSION });
  const tx = (ctx: Ctx) => ctx.tx as Tx;
  const nowIso = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();

  async function findBatch(ctx: Ctx, id: unknown, lock = false): Promise<Batch> {
    if (!(typeof id === 'string' && UUID.test(id))) fail([invalid('/batch_id')]);
    const { rows } = await tx(ctx).query(`SELECT ${BATCH_COLS.join(', ')}, payload, errors FROM catalog.import_batch WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [ctx.tenantId, id]);
    if (!rows[0]) throw new LimsError('common.not_found');
    return rows[0];
  }

  /** Writes the validated model through the catalog services, in the caller's transaction (any throw rolls everything back). */
  async function write(ctx: Ctx, model: Model) {
    const deps = { events: ctx.events };
    const svc = { tests: createTestsService(deps), an: createAnalyteVersionsService(deps), ranges: createRangesService(deps), panels: createPanelsService(deps) };
    const t = ctx.tenantId, actor = ctx.actor.id;
    const created = { tests: 0, analytes: 0, ranges: 0, panels: 0 };
    const ids = new Map<string, string>();
    const PARITY = ['short_name', 'display_name', 'tags', 'barcode_text', 'loyalty_points', 'display_order', 'description', 'report_type', 'processing_type', 'outsource_name', 'is_outsourced',
      'is_popular', 'smart_report', 'print_category_wise', 'nabl', 'accab_logo', 'auto_approval_enabled', 'use_normal_range_for_auto_approval', 'template_test', 'font', 'alert_before_expiry_minutes',
      'category_id', 'report_order', 'is_orderable'];
    const pick = (v: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => v[k] !== undefined && v[k] !== null).map((k) => [k, v[k]]));
    for (const m of model.tests) {
      const body = { name: m.v['name'], department_id: m.v['department_id'], workflow_type: m.v['workflow_type'], ...pick(m.v, PARITY) };
      let id: string;
      if (m.action === 'create') {
        id = ((await svc.tests.createTest(ctx, { code: m.code, ...body, specimen_requirements: [{ specimen_type_id: m.v['specimen_type_id'], is_preferred: true }] })) as Record<string, unknown>)['id'] as string;
        created.tests++;
      } else {
        const [row] = await repo.find(tx(ctx), 'tests', ['id', 'version'], t, { id: m.v['id'] });
        if (!row) throw new LimsError('common.version_conflict');
        id = row.id as string;
        await svc.tests.updateTest(ctx, { id, expectedVersion: Number(row.version), patch: body });
      }
      ids.set(m.code, id);
      const stages = m.v['stage_targets'] as { stage: string; target_minutes: number }[];
      if (stages.length) await repo.upsertStageTargets(tx(ctx), stages.map((s) => ({ id: uuidv7(), tenant_id: t, test_id: id, ...s, created_by: actor, updated_by: actor })));
      // inputs before the equations that read them (validation proved there is no cycle)
      const done = new Set<string>(); const order: typeof m.analytes = [];
      while (order.length < m.analytes.length) {
        const next = m.analytes.filter((a) => !done.has(a.code) && a.refs.every((r) => done.has(r)));
        if (!next.length) throw new LimsError('common.internal');
        for (const a of next) { done.add(a.code); order.push(a); }
      }
      for (const a of order) {
        const ver = pick({ ...a.v, formula_expression: a.formula }, ['result_type', 'unit_code', 'decimals', 'method_id', 'value_set_code', 'formula_expression', 'default_value', 'long_text_value', 'high_low', 'require_verification']);
        let analyteId: string;
        if (a.action === 'create') {
          analyteId = (await svc.an.createAnalyte(ctx, { test_id: id, body: { code: a.code, name: a.v['name'], ...pick(a.v, ['print_name', 'report_subheading', 'sort_order', 'is_reportable', 'trend_name',
            'specimen_type_id', 'font', 'result_display_type', 'print_on_negative', 'print_on_worksheet', 'send_in_sms', 'nabl', 'accab_logo', 'is_trend']), initial_version: ver } })).id as string;
        } else {
          analyteId = a.v['id'] as string;
          // never a silent overwrite: a NEW draft beside the published version (or the analyte's open draft), published only through the normal publish path
          const [open] = await repo.find(tx(ctx), 'analyte_versions', ['id', 'version'], t, { analyte_id: analyteId, status: 'draft' }, { limit: 1 });
          const draft = open ?? await svc.an.createAnalyteVersionDraft(ctx, { analyte_id: analyteId });
          await svc.an.updateAnalyteVersionDraft(ctx, { id: draft.id, expectedVersion: Number(draft.version), patch: ver });
        }
        created.analytes++;
        for (const [fam, bands] of [['ref', a.bands], ['crit', a.critical]] as const) {
          if (!bands.length) continue;
          const table = fam === 'ref' ? 'reference_range_sets' : 'critical_limit_sets';
          const [open] = await repo.find(tx(ctx), table, ['id', 'version'], t, { analyte_id: analyteId, status: 'draft' }, { limit: 1 });
          if (fam === 'ref') {
            if (open) await svc.ranges.replaceReferenceRangeSetBands(ctx, { id: open.id, expectedVersion: Number(open.version), body: { bands } });
            else await svc.ranges.createReferenceRangeSetDraft(ctx, { analyte_id: analyteId, body: { bands } });
            created.ranges += bands.length;
          } else if (open) await svc.ranges.replaceCriticalLimitSetBands(ctx, { id: open.id, expectedVersion: Number(open.version), body: { bands } });
          else await svc.ranges.createCriticalLimitSetDraft(ctx, { analyte_id: analyteId, body: { bands } });
        }
      }
    }
    // panels: members that are panels of this file first
    const pending = [...model.panels];
    while (pending.length) {
      const i = pending.findIndex((p) => p.members.every((mm) => mm.kind !== 'panel' || ids.has(mm.code) || !pending.some((q) => q.code === mm.code)));
      if (i < 0) throw new LimsError('catalog.panel_cycle');
      const p = pending.splice(i, 1)[0]!;
      const missing = p.members.filter((mm) => !ids.has(mm.code)).map((mm) => mm.code);
      if (missing.length) for (const o of await repo.find(tx(ctx), 'orderables', ['id', 'code'], t, {}, { anyOf: { col: 'code', values: missing } })) ids.set(o.code, o.id);
      const members = p.members.map((mm) => { const oid = ids.get(mm.code); if (!oid) throw new LimsError('common.not_found'); return { kind: mm.kind, orderable_id: oid, sort_order: mm.sort_order }; });
      const out = await svc.panels.createPanel(ctx, { code: p.code, name: p.v['name'], panel_kind: p.v['panel_kind'], members,
        ...pick(p.v, ['sex_restriction', 'department_id', 'barcode_text', 'loyalty_points', 'display_order', 'is_popular']) });
      ids.set(p.code, out.id); created.panels++;
    }
    return created;
  }

  return {
    async downloadTemplate(ctx: Ctx) {
      await assert(ctx);
      const m = await loadMasters(tx(ctx), ctx.tenantId);
      const { sheets, col } = listsAndMeta(m.lists);
      const bytes = writeWorkbook([{ name: SHEET.instructions, rows: instructions() }, ...DATA_SHEETS.map((s) => dataSheet(s, col)), ...sheets]);
      return { fileName: 'test-import-template.xlsx', contentType: XLSX, bytes };
    },

    async validate(ctx: Ctx, body: unknown) {
      await assert(ctx);
      if (!isObj(body)) return fail([required('/file')]);
      const errs: FieldError[] = [];
      const f = isObj(body['file']) ? body['file'] : undefined;
      const raw = f ? (f['bytes'] ?? f['data']) : undefined;
      if (!(raw instanceof Uint8Array)) errs.push(body['file'] === undefined ? required('/file') : invalid('/file'));
      const mode = body['mode'] ?? 'create_only';
      if (!(typeof mode === 'string' && MODES.includes(mode))) errs.push(invalid('/mode'));
      for (const k of Object.keys(body)) if (k !== 'file' && k !== 'mode' && body[k] !== undefined) errs.push({ path: `/${k}`, code: 'common.unknown_field', message: 'Unknown field' });
      if (errs.length) fail(errs);
      const bytes = raw as Uint8Array;
      const sha = createHash('sha256').update(bytes).digest('hex');
      // idempotent per (tenant, file hash, mode): the advisory lock serialises two identical uploads, the second then finds the first batch
      await tx(ctx).query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`catalog.import:${ctx.tenantId}:${sha}:${String(mode)}`]);
      const { rows: [prior] } = await tx(ctx).query(`SELECT ${BATCH_COLS.join(', ')}, payload, errors FROM catalog.import_batch WHERE tenant_id = $1 AND file_sha256 = $2 AND mode = $3 ORDER BY created_at LIMIT 1`, [ctx.tenantId, sha, mode]);
      if (prior) return { status: 200, body: { batch: dto(prior), errors: prior.errors ?? [], preview: prior.payload?.preview ?? { tests: [] } } };

      const sheets = parseUpload(bytes);                                   // file-level refusals throw here: nothing recorded
      const m = await loadMasters(tx(ctx), ctx.tenantId);
      const r: Result = validate({ sheets, masters: m, catalog: await catalogFor(tx(ctx), ctx.tenantId, sheets), mode: mode as 'create_only' | 'update' });
      const status = r.errors.length ? 'rejected' : 'validated';
      const payload = JSON.stringify({ model: r.errors.length ? { tests: [], panels: [] } : r.model, rows: r.rows, preview: r.preview });
      // import_batch__payload__ck caps payload::text at 10 MB; jsonb text adds a space after every : and , so the JSON text is held to 8 MB
      if (Buffer.byteLength(payload) > 8 * 1024 * 1024) throw new LimsError('catalog.import_too_large', 'the normalized workbook exceeds the stored size limit');
      const { rows: [b] } = await tx(ctx).query(
        `INSERT INTO catalog.import_batch (id, tenant_id, created_by, file_name, file_sha256, template_version, mode, status, counts, errors, payload, validated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12) RETURNING ${BATCH_COLS.join(', ')}`,
        [uuidv7(), ctx.tenantId, ctx.actor.id, fileName(f!['filename'] ?? f!['name']), sha, TEMPLATE_VERSION, mode, status, JSON.stringify(r.counts), JSON.stringify(r.errors), payload, new Date(nowIso(ctx))]);
      return { status: 201, body: { batch: dto(b), errors: r.errors, preview: r.preview } };
    },

    async commit(ctx: Ctx, id: unknown, expected: number | undefined, body: unknown) {
      await assert(ctx);
      if (!(isObj(body) && body['confirm'] === true && Object.keys(body).every((k) => k === 'confirm'))) fail([isObj(body) && body['confirm'] === undefined ? required('/confirm') : invalid('/confirm')]);
      if (expected === undefined) throw new LimsError('common.precondition_required');
      if (expected === 0) fail([invalid('/if-match')]);
      const b = await findBatch(ctx, id, true);                            // row lock: a concurrent commit waits, then sees committed
      if (b.status === 'committed') throw new LimsError('catalog.import_already_committed');
      if (b.status === 'rejected') throw new LimsError('catalog.import_has_errors');
      if (b.status === 'expired' || Date.parse(nowIso(ctx)) - +new Date(b.created_at) > EXPIRY_MS) throw new LimsError('catalog.import_batch_expired');
      if (Number(b.version) !== expected) throw new LimsError('common.version_conflict');
      const created = await write(ctx, b.payload.model as Model);
      const { rows: [after] } = await tx(ctx).query(
        `UPDATE catalog.import_batch SET status = 'committed', committed_at = $3, committed_by = $4, version = version + 1 WHERE tenant_id = $1 AND id = $2 AND version = $5 RETURNING ${BATCH_COLS.join(', ')}`,
        [ctx.tenantId, b.id, new Date(nowIso(ctx)), ctx.actor.id, expected]);
      if (!after) throw new LimsError('common.version_conflict');
      return { batch: dto(after), created };
    },

    async list(ctx: Ctx, query: unknown) {
      await assert(ctx);
      const q = isObj(query) ? query : {};
      const errs: FieldError[] = [];
      for (const k of Object.keys(q)) if (q[k] !== undefined && !['status', 'mode', 'cursor', 'limit'].includes(k)) errs.push({ path: `/${k}`, code: 'common.unknown_field', message: 'Unknown field' });
      if (q['status'] !== undefined && !STATUSES.includes(q['status'] as string)) errs.push(invalid('/status'));
      if (q['mode'] !== undefined && !MODES.includes(q['mode'] as string)) errs.push(invalid('/mode'));
      const limit = limitOf(q['limit'], 50, 200, errs);
      if (errs.length) fail(errs);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (q['status'] !== undefined) where.push(`status = ${bind(q['status'])}`);
      if (q['mode'] !== undefined) where.push(`mode = ${bind(q['mode'])}`);
      if (q['cursor'] !== undefined) { const [v, cid] = decodeCursor(q['cursor'], '-created_at'); where.push(`(created_at, id) < (${bind(v)}::timestamptz, ${bind(cid)})`); }
      const { rows } = await tx(ctx).query(`SELECT ${BATCH_COLS.join(', ')} FROM catalog.import_batch WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${bind(limit + 1)}`, values);
      const data = rows.slice(0, limit), last = data[data.length - 1];
      return { data: data.map(dto), page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor('-created_at', iso(last.created_at), last.id) } : {}) } };
    },

    async get(ctx: Ctx, id: unknown) { await assert(ctx); return dto(await findBatch(ctx, id)); },

    /** The uploaded rows (normalized; refused cells blank) with an Errors column, plus Meta and Lists so the fixed file validates again. */
    async errorsFile(ctx: Ctx, id: unknown) {
      await assert(ctx);
      const b = await findBatch(ctx, id);
      const byRow = new Map<string, string[]>();
      for (const e of (b.errors ?? []) as ImportError[]) { const k = `${e.sheet}|${e.row}`; byRow.set(k, [...(byRow.get(k) ?? []), `${e.column}: ${e.code} (${e.message})`]); }
      const stored = (b.payload?.rows ?? {}) as Record<DataSheet, { row: number; cells: string[] }[]>;
      const { sheets, col } = listsAndMeta(await loadMasters(tx(ctx), ctx.tenantId).then((m) => m.lists));
      const data = DATA_SHEETS.map((s) => {
        const sh = dataSheet(s, col, (stored[s] ?? []).map((r) => [...labels(s).map((_, i) => r.cells[i] ?? ''), (byRow.get(`${s}|${r.row}`) ?? []).join('; ').slice(0, 32000)]), false);
        return { ...sh, rows: [[...labels(s), ERRORS_HEADER], ...sh.rows.slice(1)] };
      });
      return { fileName: 'test-import-errors.xlsx', contentType: XLSX, bytes: writeWorkbook([{ name: SHEET.instructions, rows: instructions() }, ...data, ...sheets]) };
    },
  };
}
