// Comment codes #57–#59 (02-TRD §5, §5.0, §9.1; PRD AC-09.1–09.3; 05-SCHEMA comment_codes / comment_code_texts); 07-SECURITY S-1, S-5, AB-20.
// Uniqueness (tenant, code, department-or-tenant-wide) is the expression index comment_codes__tenant_id_code_dept__uq: its 23505 -> 409.
// Text history: create writes text_version 1; a text edit closes the open row (effective_to = new effective_from) and inserts
// text_version = the code's new version, all in the caller's transaction with the revision bump. Lock order: code row, texts, catalog_state.
// [CONV] uuidv7 via relative import (same as masters.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import {
  BOOL, RESULT_TYPES, UUID, checkFields, checkUpdate, fail, invalid, isObj, kindOf, lockAt, mapPg, ptr, required, str, unknown, unsetOf,
  type Ctx, type Deps, type Tx,
} from './masters.service.js';
import { createRevisionService } from './revision.service.js';

const NEW = ['category_id', 'result_type', 'is_default_template', 'text_format'];   // T0B-TESTMGMT-1 (LD-318, ElabAssist Notes)
const COLS = ['id', 'code', 'department_id', 'text', 'is_active', 'version', ...NEW];
const TEXT_COLS = ['id', 'text_version'];
const CODE_IN = /^[A-Za-z0-9_]{1,16}$/;          // checked BEFORE upper-casing: no Unicode case-fold forgeries (ı -> I)
const NEW_FIELDS = { category_id: { t: 'uuid' } as const, result_type: { t: 'enum', values: RESULT_TYPES } as const, is_default_template: BOOL,
  text_format: { t: 'enum', values: ['plain', 'markdown'] } as const };
const CREATE = { fields: { department_id: { t: 'uuid' } as const, text: str(1, 2000), ...NEW_FIELDS } };
const UPDATE = { fields: { text: str(1, 2000), is_active: BOOL, ...NEW_FIELDS } };
/** LD-318: plain text or safe Markdown, never raw HTML: '<' followed by a letter, '/' or '!' is refused (same rule as the DB CHECK backstop); "<5 mg/dL" stays legal. */
const RAW_HTML = /<[A-Za-z/!]/;
const htmlErr = (b: Record<string, unknown>) => { if (typeof b['text'] === 'string' && RAW_HTML.test(b['text'])) fail([invalid('/text')]); };

type R = Record<string, any>;
const dto = (r: R) => ({
  id: r.id as string, code: r.code as string, ...(r.department_id == null ? {} : { department_id: r.department_id as string }),
  text: r.text as string, is_active: r.is_active === true, version: Number(r.version),
  ...Object.fromEntries(NEW.filter((k) => r[k] != null).map((k) => [k, r[k]])),
});

interface ListQuery { department_id?: string; code_prefix?: string; cursor?: string; limit?: number; is_active?: string }
function checkQuery(query: unknown): ListQuery {
  const q = query === undefined ? {} : query;
  if (!isObj(q)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  const out: ListQuery = {};
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (k === 'department_id') { if (typeof v === 'string' && UUID.test(v)) out.department_id = v; else errors.push(invalid('/department_id')); }
    // [CR-pending] .orchestra/cr/T0B-TESTMGMT-1.md: catalog.yaml #57 has no is_active parameter; deactivate-not-delete (done_when 5) needs `all` to show deactivated notes. [CONV] same values as the other lists.
    else if (k === 'is_active') { if (v === 'true' || v === 'false' || v === 'all') out.is_active = v; else errors.push(invalid('/is_active')); }
    else if (k === 'code_prefix') { if (typeof v === 'string' && CODE_IN.test(v)) out.code_prefix = v.toUpperCase(); else errors.push(invalid('/code_prefix')); }
    else if (k === 'cursor') { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(v)) throw new LimsError('common.invalid_cursor'); out.cursor = v; }
    else if (k === 'limit') {
      const n = typeof v === 'string' && /^[0-9]{1,3}$/.test(v) ? Number(v) : v;
      if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 200) out.limit = n as number; else errors.push(invalid('/limit'));
    } else errors.push(unknown(ptr(k)));
  }
  if (errors.length) fail(errors);
  return out;
}

export function createCommentsService(deps: Deps) {
  const revision = createRevisionService(deps);
  const nowOf = (ctx: Ctx) => ctx.now?.() ?? new Date().toISOString();
  const bump = (ctx: Ctx, id: string, changeKind: string, effectiveFrom: string) =>
    revision.bumpRevision(ctx, { entityType: 'comment_code', entityId: id, changeKind, effectiveFrom });
  const insertText = (ctx: Ctx, codeId: string, textVersion: number, text: string, effectiveFrom: string) =>
    repo.insertRow(ctx.tx as Tx, 'comment_code_texts', TEXT_COLS, {
      id: uuidv7(), tenant_id: ctx.tenantId, comment_code_id: codeId, text_version: textVersion, text,
      effective_from: effectiveFrom, created_by: ctx.actor.id, updated_by: ctx.actor.id,
    });

  return {
    /** Active codes only (TRD §5.0 default; catalog.yaml #57 has no is_active param). department_id adds the tenant-wide codes. */
    async listCommentCodes(ctx: Ctx, query?: unknown) {
      const q = checkQuery(query);
      const limit = q.limit ?? 50;
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (q.is_active !== 'all') where.push(`is_active = ${bind(q.is_active !== 'false')}`);
      if (q.department_id !== undefined) where.push(`(department_id = ${bind(q.department_id)} OR department_id IS NULL)`);
      if (q.code_prefix !== undefined) {
        // Literal prefix as a range (no LIKE wildcards). ponytail: relies on code ordering byte-wise ([A-Z0-9_] under C/ICU-root collation),
        // same assumption as the (code, id) cursor; switch to left(code, n) = $p if the DB collation ever disagrees.
        const p = q.code_prefix;
        where.push(`code >= ${bind(p)} AND code < ${bind(p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1))}`);
      }
      if (q.cursor !== undefined) { const [c, id] = decodeCursor(q.cursor, 'code'); where.push(`(code, id) > (${bind(c)}, ${bind(id)})`); }
      const { rows } = await (ctx.tx as Tx).query(
        `SELECT ${COLS.join(', ')} FROM catalog.comment_codes WHERE ${where.join(' AND ')} ORDER BY code ASC, id ASC LIMIT ${bind(limit + 1)}`, values);
      const data = rows.slice(0, limit);
      const last = data[data.length - 1];
      const page: { limit: number; next_cursor?: string } = { limit };
      if (rows.length > limit && last) page.next_cursor = encodeCursor('code', last.code, last.id);
      return { data: data.map(dto), page };
    },

    async createCommentCode(ctx: Ctx, body?: unknown) {
      const b = checkFields(CREATE, body, ['code']);
      const errors: FieldError[] = [];
      const code = typeof b['code'] === 'string' ? b['code'].trim() : undefined;
      if (b['code'] === undefined) errors.push(required('/code'));
      else if (code === undefined || !CODE_IN.test(code)) errors.push(invalid('/code'));
      if (b['text'] === undefined) errors.push(required('/text'));
      if (errors.length) fail(errors);
      htmlErr(b);
      const at = nowOf(ctx);
      const created = await repo.insertRow(ctx.tx as Tx, 'comment_codes', COLS, {
        id: uuidv7(), tenant_id: ctx.tenantId, code: code!.toUpperCase(),
        ...(b['department_id'] === undefined ? {} : { department_id: b['department_id'] }),   // FK (tenant_id, department_id): foreign/unknown -> 23503 -> 404
        ...Object.fromEntries(NEW.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])),  // category FK too (tenant_id, category_id)
        text: b['text'], is_active: true, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      }).catch(mapPg);
      await insertText(ctx, created.id, 1, created.text, at);
      await bump(ctx, created.id, 'created', at);
      return dto(created);
    },

    async updateCommentCode(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const patch = checkFields(UPDATE, input.patch, ['unset']);
      const nulls = unsetOf(patch, ['category_id', 'result_type']);
      delete patch['unset'];
      htmlErr(patch);
      const at = nowOf(ctx);
      const before = await lockAt(ctx, 'comment_codes', COLS, id, ev);
      const after = await repo.updateRow(ctx.tx as Tx, 'comment_codes', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, { ...patch, ...nulls }).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      if (patch['text'] !== undefined) {
        await (ctx.tx as Tx).query(
          'UPDATE catalog.comment_code_texts SET effective_to = $3, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND comment_code_id = $2 AND effective_to IS NULL',
          [ctx.tenantId, id, at, ctx.actor.id]);
        await insertText(ctx, id, Number(after.version), after.text, at);
      }
      await bump(ctx, id, kindOf(before, after), at);
      return dto(after);
    },
  };
}
