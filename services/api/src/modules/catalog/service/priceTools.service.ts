// T0B-PRICETOOLS-1 (LD-321, LD-325(b); T0C-PRICETOOLS-1 contract): the seven price list tool operations. downloadPriceListTemplate, dryRunPriceListImport (writes NO price: only the
// batch row and its error rows), commitPriceListImport (one transaction, a DRAFT version only, idempotent), bulkUpdatePriceListDraft and copyPriceList (integer paisa, half up, results in a
// DRAFT only), comparePriceLists (one paged SQL query), listPriceListImportBatches. Publishing stays publishPriceListVersion (LD-321). Every operation asserts its contract permission
// through IdentityPort before it reads anything; unknown and foreign ids look the same (404, S-1). Every write is audited by the row triggers (app.tg_row_audit). Nothing is logged.
// [CONV] no storage bucket is owned by catalog (core/storage BUCKET_OWNERS), so the workbook bytes are not stored (as T0B-TESTIMPORT-1): the batch keeps the validated rows and a seal
//   sha256(file_sha256 | rows); commit re-computes the seal, so a batch whose stored hash or rows changed is refused. file_ref = "sha256:<hex>" (content address). CR: .orchestra/cr/T0B-PRICETOOLS-1.md.
// [CONV] refusals of a bulk update / copy (missing percent_bp, amount_paisa, department_id or orderable_ids; a result below 0 or above 999999999 paisa) are 422 catalog.formula_invalid:
//   the contract demands 422 and registers no dedicated code (CR above).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import { clean } from '../import/validate.js';
import { MAX_FILE_BYTES, readWorkbook, writeWorkbook } from '../import/xlsx.js';
import { isValidCode, normaliseCode } from '../domain/codes.js';
import {
  HEADERS, ROUNDINGS, SHEET, applyChange, inRange, paisaText, percentBpOf, safeText, validateRows, type Change, type RowError, type Rounding,
} from '../domain/priceTools.js';
import { fail, invalid, isObj, required, unknown, UUID, type Ctx, type Tx } from './masters.service.js';
import { VER_COLS, versionDto } from './pricing.service.js';
import { limitOf } from './tests.service.js';

export interface Identity { assertRole(ctx: unknown, requirement: { permission: string }): Promise<unknown> }
type R = Record<string, any>;
const MANAGE = 'catalog.price_list.manage';
const READ = 'catalog.price_list.read';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BATCH_COLS = ['id', 'price_list_id', 'status', 'row_count', 'error_count', 'file_sha256', 'summary', 'result_price_list_version_id', 'created_at', 'created_by'];
const STATUSES = ['dry_run', 'committed', 'failed', 'cancelled'];
const KINDS = `kind IN ('test', 'panel')`;

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const ms = (v: unknown) => new Date(v as string).getTime();
const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const refuse = (detail: string): never => { throw new LimsError('catalog.formula_invalid', detail); };
const notFound = (): never => { throw new LimsError('common.not_found'); };
const uuidArg = (v: unknown, path: string): string => (typeof v === 'string' && UUID.test(v) ? v : fail([invalid(path)]));
/** declared keys only; errors never echo a submitted key or value */
function keys(v: unknown, allowed: readonly string[], requiredKeys: readonly string[] = []): R {
  if (v !== undefined && !isObj(v)) fail([invalid('')]);
  const o = (v ?? {}) as R; const errs: FieldError[] = [];
  for (const k of Object.keys(o)) if (o[k] !== undefined && !allowed.includes(k)) errs.push(unknown(''));
  for (const k of requiredKeys) if (o[k] === undefined) errs.push(required(`/${k}`));
  if (errs.length) fail(errs);
  return o;
}
const SUMMARY_KEYS = ['rows', 'added', 'changed', 'unchanged', 'errors'];
const batchDto = (b: R) => Object.fromEntries(Object.entries({
  id: b.id, price_list_id: b.price_list_id, status: b.status, row_count: Number(b.row_count), error_count: Number(b.error_count), file_sha256: b.file_sha256,
  summary: Object.fromEntries(SUMMARY_KEYS.filter((k) => typeof b.summary?.[k] === 'number').map((k) => [k, b.summary[k]])),
  result_price_list_version_id: b.result_price_list_version_id ?? undefined, created_at: iso(b.created_at), created_by: b.created_by,
}).filter(([, v]) => v !== undefined));
/** the seal binds the stored rows to the file hash (commit re-computes it) */
const sealOf = (fileSha: string, items: unknown) => sha256(`${fileSha}|${JSON.stringify(items)}`);

export function createPriceToolsService(deps: { identity: Identity }) {
  const assert = (ctx: Ctx, permission: string) => deps.identity.assertRole(ctx, { permission });
  const tx = (ctx: Ctx) => ctx.tx as Tx;
  const q = async (ctx: Ctx, text: string, values: unknown[]) => (await tx(ctx).query(text, values)).rows;
  const nowMs = (ctx: Ctx) => ms(ctx.now?.() ?? new Date().toISOString());

  async function findList(ctx: Ctx, id: string, lock = false): Promise<R> {
    const [row] = await q(ctx, `SELECT id, owner_kind FROM catalog.price_lists WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [ctx.tenantId, id]);
    return row ?? notFound();
  }
  const versionsOf = (ctx: Ctx, listId: string) =>
    q(ctx, `SELECT ${VER_COLS.join(', ')} FROM catalog.price_list_versions WHERE tenant_id = $1 AND price_list_id = $2 ORDER BY version_no DESC`, [ctx.tenantId, listId]);
  /** the version in force now (published or superseded whose window holds now), as getPriceListDetail's current_version */
  const currentOf = (vs: R[], now: number) => vs.filter((v) => (v.status === 'published' || v.status === 'superseded') && ms(v.effective_from) <= now && (v.effective_to == null || now < ms(v.effective_to)))
    .sort((a, b) => ms(b.effective_from) - ms(a.effective_from))[0];
  async function itemsOf(ctx: Ctx, versionId: string | undefined): Promise<Map<string, number>> {
    if (!versionId) return new Map();
    const rows = await q(ctx, 'SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [ctx.tenantId, versionId]);
    return new Map(rows.map((r) => [r.orderable_id as string, Number(r.unit_price_paisa)]));
  }
  /** [CONV] createPriceList always makes an EMPTY draft version 1 (contract): an empty draft is filled in place; a draft that holds items is someone's work: 409 (V1). */
  async function openDraft(ctx: Ctx, versions: R[]): Promise<R | undefined> {
    const d = versions.find((v) => v.status === 'draft');
    if (!d) return undefined;
    const [{ n }] = await q(ctx, 'SELECT count(*)::int AS n FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [ctx.tenantId, d.id]);
    if (n > 0) throw new LimsError('common.version_conflict');
    return d;
  }
  /** the DRAFT of a locked list (a new version, or the empty draft): ONE insert statement for every item (no per row round trip). 23505 = the one-draft index (V1). */
  async function insertDraft(ctx: Ctx, listId: string, versions: R[], items: Map<string, number>, extra: { source_import_id?: string; change_reason?: string } = {}) {
    const empty = await openDraft(ctx, versions);
    const pg = (e: unknown): never => {
      const c = (e as { code?: unknown })?.code;
      if (c === '23505') throw new LimsError('common.version_conflict');
      if (c === 'P0001') throw new LimsError('catalog.version_in_use');
      if (c === '23503') throw new LimsError('common.not_found');
      if (c === '23514') refuse('a price is outside 0 .. 999999999 paisa');
      throw e;
    };
    const [v] = empty
      ? await tx(ctx).query(
        `UPDATE catalog.price_list_versions SET item_count = $3, source_import_id = $4, change_reason = $5, version = version + 1, updated_at = now(), updated_by = $6
         WHERE tenant_id = $1 AND id = $2 AND status = 'draft' RETURNING ${VER_COLS.join(', ')}`,
        [ctx.tenantId, empty.id, items.size, extra.source_import_id ?? null, extra.change_reason ?? null, ctx.actor.id]).then((r) => r.rows, pg)
      : await tx(ctx).query(
        `INSERT INTO catalog.price_list_versions (id, tenant_id, price_list_id, version_no, status, item_count, source_import_id, change_reason, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $8) RETURNING ${VER_COLS.join(', ')}`,
        [uuidv7(), ctx.tenantId, listId, Number(versions[0]?.version_no ?? 0) + 1, items.size, extra.source_import_id ?? null, extra.change_reason ?? null, ctx.actor.id]).then((r) => r.rows, pg);
    if (!v) throw new LimsError('common.version_conflict');
    if (items.size) {
      const ids = [...items.keys()];
      await tx(ctx).query(
        `INSERT INTO catalog.price_list_items (id, tenant_id, price_list_version_id, orderable_id, unit_price_paisa, created_by, updated_by)
         SELECT u.id, $1, $2, u.o, u.p, $3, $3 FROM unnest($4::uuid[], $5::uuid[], $6::bigint[]) AS u(id, o, p)`,
        [ctx.tenantId, v.id, ctx.actor.id, ids.map(() => uuidv7()), ids, ids.map((o) => String(items.get(o)))]).catch(pg);
    }
    return v as R;
  }
  /** the change of a bulk update / copy applied to every price; ANY result out of range refuses the whole request (nothing is written yet) */
  function applyAll(prices: Map<string, number>, change: Change): Map<string, number> {
    const out = new Map<string, number>();
    for (const [o, p] of prices) {
      const v = applyChange(p, change);
      if (!inRange(v)) refuse('a resulting price would be below 0 or above 9999999.99 rupees; nothing was changed');
      out.set(o, Number(v));
    }
    return out;
  }
  const rounding = (v: unknown): Rounding => (v === undefined ? 'none' : typeof v === 'string' && (ROUNDINGS as string[]).includes(v) ? v as Rounding : fail([invalid('/rounding')]));
  const bp = (v: unknown, path: string): number | undefined => (v === undefined ? undefined : Number.isInteger(v) && (v as number) >= -10000 && (v as number) <= 100000 ? v as number : fail([invalid(path)]));

  return {
    // ------------------------------------------------------------------------------------------------ downloadPriceListTemplate
    async template(ctx: Ctx, query: unknown) {
      await assert(ctx, MANAGE);
      const qy = keys(query, ['price_list_id']);
      let rows: string[][] = [];
      if (qy['price_list_id'] !== undefined) {
        const list = await findList(ctx, uuidArg(qy['price_list_id'], '/price_list_id'));
        const vs = await versionsOf(ctx, list.id);
        const prices = await itemsOf(ctx, (vs.find((v) => v.status === 'draft') ?? currentOf(vs, nowMs(ctx)))?.id);   // the draft wins over the current version
        const ords = await q(ctx, `SELECT id, code, name FROM catalog.orderables WHERE tenant_id = $1 AND is_active AND ${KINDS} ORDER BY code COLLATE "C", id`, [ctx.tenantId]);
        rows = ords.map((o) => [String(o.code), safeText(String(o.name ?? '')), prices.has(o.id) ? paisaText(prices.get(o.id)!) : '', '']);
      }
      const instructions = [
        ['Price list import (synthetic template)'],
        ['Fill the Prices sheet, one row per test. Test Code and Price (Rs) are required; Test Name is read only and ignored on upload.'],
        ['Price (Rs) is in rupee with at most 2 decimals (for example 1250.50), from 0 to 9999999.99, digits only: no commas, no currency symbol.'],
        ['Effective From is optional: a date written YYYY-MM-DD.'],
        ['xlsx only, at most 5 MB and at most 5000 rows. No macros, no external links, no formulas; a text cell may not start with = + - or @.'],
        ['Upload first runs a dry run: every error is listed with its row and column and nothing changes.'],
        ['Commit writes the prices into a new DRAFT version of the list (tests not in the file keep their current price); the draft is published only through Publish.'],
      ];
      const bytes = writeWorkbook([{ name: SHEET.prices, rows: [[...HEADERS], ...rows], inputCols: HEADERS.length }, { name: SHEET.instructions, rows: instructions }]);
      return { fileName: 'price-list-template.xlsx', contentType: XLSX, bytes };
    },

    // ------------------------------------------------------------------------------------------------ dryRunPriceListImport
    async dryRun(ctx: Ctx, listId: unknown, body: unknown) {
      await assert(ctx, MANAGE);
      const id = uuidArg(listId, '/price_list_id');
      const b = keys(body, ['file'], ['file']);
      const f = isObj(b['file']) ? b['file'] : undefined;
      const raw = f ? (f['bytes'] ?? f['data']) : undefined;
      if (!(raw instanceof Uint8Array)) fail([invalid('/file')]);
      await findList(ctx, id);
      // file level checks BEFORE parsing: size, then the ZIP magic bytes (a csv / xls / pdf renamed .xlsx is 415); refusals record nothing
      const bytes = raw as Uint8Array;
      if (bytes.length > MAX_FILE_BYTES) throw new LimsError('common.payload_too_large');
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new LimsError('common.unsupported_media_type');
      let wb: ReturnType<typeof readWorkbook>;
      try { wb = readWorkbook(bytes, '*'); }                                    // every sheet: zip bomb caps, macros, external links, DOCTYPE, formula cells (hidden sheets too)
      catch (e) {
        if (e instanceof LimsError) throw e.code === 'catalog.import_too_large' ? new LimsError('common.payload_too_large') : e;
        throw new LimsError('catalog.import_invalid_file');                      // a parser fault on a malformed container is a bad file, never a 500
      }
      const sheet = wb.sheets.get(SHEET.prices);
      if (!sheet) throw new LimsError('catalog.import_invalid_file', 'the workbook has no Prices sheet');
      const head = (sheet.rows.find((r) => r.row === 1)?.cells ?? []).map((x) => clean(x));
      if (HEADERS.some((h, i) => head[i] !== h) || head.slice(HEADERS.length).some(Boolean)) throw new LimsError('catalog.import_invalid_file', 'the Prices sheet does not have the template headers');
      const data = sheet.rows.filter((r) => r.row > 1);
      if (data.some((r) => !Number.isInteger(r.row) || r.row > 1_048_576)) throw new LimsError('catalog.import_invalid_file', 'row numbers beyond the sheet limit');
      const codes = [...new Set(data.map((r) => clean(r.cells[0] ?? '')).filter((c) => c.length <= 64 && isValidCode('orderable', c)).map(normaliseCode))];
      const ords = codes.length ? await q(ctx, `SELECT id, code FROM catalog.orderables WHERE tenant_id = $1 AND is_active AND ${KINDS} AND code = ANY($2)`, [ctx.tenantId, codes]) : [];
      const { errors, valid, rowCount } = validateRows(data, new Map(ords.map((o) => [String(o.code), String(o.id)])));
      if (rowCount === 0) errors.push({ row_no: 2, column: 'test_code', code: 'required_missing', message: 'The file has no data row' });
      const summary: R = { rows: rowCount, errors: errors.length };
      if (errors.length === 0) {
        const cur = await itemsOf(ctx, currentOf(await versionsOf(ctx, id), nowMs(ctx))?.id);
        summary['added'] = valid.filter((v) => !cur.has(v.orderable_id)).length;
        summary['changed'] = valid.filter((v) => cur.has(v.orderable_id) && cur.get(v.orderable_id) !== v.paisa).length;
        summary['unchanged'] = valid.length - summary['added'] - summary['changed'];
      }
      const fileSha = sha256(bytes);
      const items = errors.length ? [] : valid.map((v) => [v.orderable_id, v.paisa]);
      const stored = { ...summary, items, seal: sealOf(fileSha, items) };
      const [batch] = await q(ctx,
        `INSERT INTO catalog.price_list_import_batch (id, tenant_id, price_list_id, status, row_count, error_count, file_ref, file_sha256, summary, created_by, updated_by)
         VALUES ($1, $2, $3, 'dry_run', $4, $5, $6, $7, $8::jsonb, $9, $9) RETURNING ${BATCH_COLS.join(', ')}`,
        [uuidv7(), ctx.tenantId, id, rowCount, errors.length, `sha256:${fileSha}`, fileSha, JSON.stringify(stored), ctx.actor.id]);
      if (errors.length) await insertErrors(ctx, batch.id, errors);
      return { batch: batchDto(batch), errors };
    },

    // ------------------------------------------------------------------------------------------------ commitPriceListImport
    async commit(ctx: Ctx, batchId: unknown, body: unknown) {
      await assert(ctx, MANAGE);
      const id = uuidArg(batchId, '/batch_id');
      const b = keys(body, ['change_reason'], ['change_reason']);
      const reason = typeof b['change_reason'] === 'string' ? b['change_reason'].trim() : '';
      if (reason.length < 1 || reason.length > 500) fail([invalid('/change_reason')]);
      // row lock: a concurrent commit of the same batch waits here, then sees it committed and gets the first result (done_when 2)
      const [batch] = await q(ctx, `SELECT ${BATCH_COLS.join(', ')} FROM catalog.price_list_import_batch WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [ctx.tenantId, id]);
      if (!batch) notFound();
      if (batch.status === 'committed' && batch.result_price_list_version_id) {
        const [v] = await q(ctx, `SELECT ${VER_COLS.join(', ')} FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, batch.result_price_list_version_id]);
        if (v) return { status: 200, body: versionDto(v) };
      }
      if (batch.status !== 'dry_run' || Number(batch.error_count) > 0) throw new LimsError('catalog.import_not_committable');
      const items = batch.summary?.items;
      if (!Array.isArray(items) || batch.summary?.seal !== sealOf(String(batch.file_sha256), items)) throw new LimsError('catalog.import_not_committable', 'the stored file hash does not match the validated rows');
      const list = await findList(ctx, batch.price_list_id, true);              // lock order: batch, then list (createPriceListVersionDraft locks the list too)
      const vs = await versionsOf(ctx, list.id);
      const merged = await itemsOf(ctx, currentOf(vs, nowMs(ctx))?.id);       // the draft = the current version overlaid by the file (file wins, nothing lost silently)
      for (const [o, p] of items as Array<[string, number]>) merged.set(o, p);
      const v = await insertDraft(ctx, list.id, vs, merged, { source_import_id: batch.id, change_reason: reason });
      await q(ctx, `UPDATE catalog.price_list_import_batch SET status = 'committed', result_price_list_version_id = $3, version = version + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND id = $2 AND status = 'dry_run'`, [ctx.tenantId, batch.id, v.id, ctx.actor.id]);
      return { status: 201, body: versionDto(v) };
    },

    // ------------------------------------------------------------------------------------------------ listPriceListImportBatches
    async listBatches(ctx: Ctx, query: unknown) {
      await assert(ctx, READ);
      const qy = keys(query, ['price_list_id', 'status', 'cursor', 'limit']);
      const errs: FieldError[] = [];
      if (qy['price_list_id'] !== undefined && !(typeof qy['price_list_id'] === 'string' && UUID.test(qy['price_list_id']))) errs.push(invalid('/price_list_id'));
      if (qy['status'] !== undefined && !STATUSES.includes(qy['status'] as string)) errs.push(invalid('/status'));
      const limit = limitOf(qy['limit'], 50, 200, errs);
      if (errs.length) fail(errs);
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (qy['price_list_id'] !== undefined) where.push(`price_list_id = ${bind(qy['price_list_id'])}`);
      if (qy['status'] !== undefined) where.push(`status = ${bind(qy['status'])}`);
      if (qy['cursor'] !== undefined) { const [v, cid] = decodeCursor(qy['cursor'], '-created_at'); where.push(`(created_at, id) < (${bind(v)}::timestamptz, ${bind(cid)}::uuid)`); }
      const rows = await q(ctx, `SELECT ${BATCH_COLS.join(', ')} FROM catalog.price_list_import_batch WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${bind(limit + 1)}`, values);
      const data = rows.slice(0, limit); const last = data[data.length - 1];
      // the history carries no error data (security.test: "no error rows"); error_count is the count, summary.errors (optional in the schema) is left out here
      return { data: data.map((x) => { const d = batchDto(x) as R; delete d['summary']['errors']; return d; }), page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor('-created_at', iso(last.created_at), last.id) } : {}) } };
    },

    // ------------------------------------------------------------------------------------------------ bulkUpdatePriceListDraft
    async bulk(ctx: Ctx, versionId: unknown, body: unknown) {
      await assert(ctx, MANAGE);
      const id = uuidArg(versionId, '/price_list_version_id');
      const b = keys(body, ['change_kind', 'percent_bp', 'amount_paisa', 'rounding', 'scope', 'department_id', 'orderable_ids'], ['change_kind', 'rounding', 'scope']);
      const kind = b['change_kind'];
      if (kind !== 'percent' && kind !== 'fixed_amount') fail([invalid('/change_kind')]);
      const scope = b['scope'];
      if (scope !== 'all' && scope !== 'department' && scope !== 'listed_tests') fail([invalid('/scope')]);
      const change: Change = { kind: kind as Change['kind'], rounding: rounding(b['rounding']) };
      if (kind === 'percent') { if (b['percent_bp'] === undefined) refuse('percent needs percent_bp'); change.percentBp = bp(b['percent_bp'], '/percent_bp') as number; }
      else {
        if (b['amount_paisa'] === undefined) refuse('fixed_amount needs amount_paisa');
        if (!Number.isSafeInteger(b['amount_paisa'])) fail([invalid('/amount_paisa')]);
        change.amountPaisa = b['amount_paisa'] as number;
      }
      let dept: string | undefined; let listed: string[] | undefined;
      if (scope === 'department') { if (b['department_id'] === undefined) refuse('scope department needs department_id'); dept = uuidArg(b['department_id'], '/department_id'); }
      if (scope === 'listed_tests') {
        const ids = b['orderable_ids'];
        if (ids === undefined) refuse('scope listed_tests needs orderable_ids');
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5000 || ids.some((x) => typeof x !== 'string' || !UUID.test(x)) || new Set(ids).size !== ids.length) fail([invalid('/orderable_ids')]);
        listed = ids as string[];
      }
      // row lock on the draft: two bulk updates of one draft run one after the other, the second on the first's result (no lost update)
      const [ver] = await q(ctx, 'SELECT id, status FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctx.tenantId, id]);
      if (!ver) notFound();
      if (ver.status !== 'draft') throw new LimsError('catalog.version_in_use');
      if (dept && (await q(ctx, 'SELECT id FROM catalog.departments WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, dept])).length === 0) notFound();
      const rows = await q(ctx, `SELECT i.id, i.orderable_id, i.unit_price_paisa, o.department_id FROM catalog.price_list_items i
        JOIN catalog.orderables o ON o.tenant_id = i.tenant_id AND o.id = i.orderable_id WHERE i.tenant_id = $1 AND i.price_list_version_id = $2`, [ctx.tenantId, id]);
      if (listed) { const have = new Set(rows.map((r) => r.orderable_id as string)); if (listed.some((o) => !have.has(o))) notFound(); }
      const pick = new Set(listed ?? []);
      const inScope = rows.filter((r) => scope === 'all' || (dept !== undefined && r.department_id === dept) || pick.has(r.orderable_id));
      const next = applyAll(new Map(inScope.map((r) => [r.id as string, Number(r.unit_price_paisa)])), change);
      const changed = inScope.filter((r) => next.get(r.id) !== Number(r.unit_price_paisa));
      if (changed.length) {
        await q(ctx, `UPDATE catalog.price_list_items i SET unit_price_paisa = u.p, version = i.version + 1, updated_at = now(), updated_by = $2
          FROM unnest($3::uuid[], $4::bigint[]) AS u(id, p) WHERE i.tenant_id = $1 AND i.id = u.id`, [ctx.tenantId, ctx.actor.id, changed.map((r) => r.id), changed.map((r) => String(next.get(r.id)))]);
      }
      return { price_list_version_id: id, changed_count: changed.length, unchanged_count: rows.length - changed.length };
    },

    // ------------------------------------------------------------------------------------------------ copyPriceList
    async copy(ctx: Ctx, listId: unknown, body: unknown) {
      await assert(ctx, MANAGE);
      const id = uuidArg(listId, '/price_list_id');
      const b = keys(body, ['source_price_list_version_id', 'mode', 'percent_bp', 'rounding'], ['source_price_list_version_id', 'mode']);
      const src = uuidArg(b['source_price_list_version_id'], '/source_price_list_version_id');
      if (b['mode'] !== 'replace' && b['mode'] !== 'merge') fail([invalid('/mode')]);
      const pct = bp(b['percent_bp'], '/percent_bp');
      const change: Change = { kind: pct === undefined ? 'none' : 'percent', ...(pct === undefined ? {} : { percentBp: pct }), rounding: rounding(b['rounding']) };
      const list = await findList(ctx, id, true);                               // serialises two copies (and any draft create) into one target
      if ((await q(ctx, 'SELECT id FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, src])).length === 0) notFound();
      const vs = await versionsOf(ctx, list.id);
      await openDraft(ctx, vs);                                                 // 409 before any work when the target's draft holds items
      const copied = applyAll(await itemsOf(ctx, src), change);
      const base = b['mode'] === 'merge' ? await itemsOf(ctx, currentOf(vs, nowMs(ctx))?.id) : new Map<string, number>();
      for (const [o, p] of copied) base.set(o, p);
      return versionDto(await insertDraft(ctx, list.id, vs, base));
    },

    // ------------------------------------------------------------------------------------------------ comparePriceLists
    async compare(ctx: Ctx, query: unknown) {
      await assert(ctx, READ);
      const qy = keys(query, ['version_a_id', 'version_b_id', 'cursor', 'limit'], ['version_a_id', 'version_b_id']);
      const a = uuidArg(qy['version_a_id'], '/version_a_id'); const bId = uuidArg(qy['version_b_id'], '/version_b_id');
      const errs: FieldError[] = [];
      const limit = limitOf(qy['limit'], 50, 200, errs);
      if (errs.length) fail(errs);
      const after = qy['cursor'] === undefined ? undefined : decodeCursor(qy['cursor'], 'code');
      const found = await q(ctx, 'SELECT id FROM catalog.price_list_versions WHERE tenant_id = $1 AND id = ANY($2)', [ctx.tenantId, [a, bId]]);
      if (found.length !== new Set([a, bId]).size) notFound();
      // ONE paged statement: both item sets FULL JOINed on the orderable, ordered by code (byte order, as the UI sorts), keyset paged
      const rows = await q(ctx, `SELECT o.id, o.code, o.name, x.unit_price_paisa::text AS pa, y.unit_price_paisa::text AS pb
        FROM (SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2) x
        FULL JOIN (SELECT orderable_id, unit_price_paisa FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $3) y ON y.orderable_id = x.orderable_id
        JOIN catalog.orderables o ON o.tenant_id = $1 AND o.id = coalesce(x.orderable_id, y.orderable_id)
        WHERE ($4::text IS NULL OR (o.code COLLATE "C", o.id) > ($4::text COLLATE "C", $5::uuid))
        ORDER BY o.code COLLATE "C", o.id LIMIT $6`, [ctx.tenantId, a, bId, after ? String(after[0]) : null, after ? after[1] : null, limit + 1]);
      const data = rows.slice(0, limit).map((r) => {
        const out: R = { orderable_id: r.id, test_code: String(r.code), test_name: String(r.name ?? r.code).slice(0, 300) || String(r.code) };
        if (r.pa != null) out['price_a_paisa'] = Number(r.pa);
        if (r.pb != null) out['price_b_paisa'] = Number(r.pb);
        if (r.pa != null && r.pb != null) {
          out['difference_paisa'] = Number(r.pb) - Number(r.pa);
          const p = percentBpOf(Number(r.pa), Number(r.pb)); if (p !== undefined) out['percent_bp'] = p;
        }
        return out;
      });
      const last = rows.length > limit ? rows[limit - 1] : undefined;
      return { data, page: { limit, ...(last ? { next_cursor: encodeCursor('code', String(last.code), last.id) } : {}) } };
    },
  };

  /** every error row in ONE statement (append only table) */
  async function insertErrors(ctx: Ctx, batchId: string, errors: RowError[]): Promise<void> {
    await tx(ctx).query(
      `INSERT INTO catalog.price_list_import_error (id, tenant_id, batch_id, row_no, column_name, code, message, created_by)
       SELECT u.id, $1, $2, u.r, u.c, u.k, u.m, $3 FROM unnest($4::uuid[], $5::int[], $6::text[], $7::text[], $8::text[]) AS u(id, r, c, k, m)`,
      [ctx.tenantId, batchId, ctx.actor.id, errors.map(() => uuidv7()), errors.map((e) => e.row_no), errors.map((e) => e.column), errors.map((e) => e.code), errors.map((e) => e.message.slice(0, 300))]);
  }
}
