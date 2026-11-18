// Test categories listTestCategories / createTestCategory / updateTestCategory (T0B-TESTMGMT-1; T0C-TESTMGMT-1 contract; LD-318, ElabAssist Test Category).
// Validates its own input (the Excel import of T0B-TESTIMPORT-1 will call it directly). Deactivate, never delete (done_when 5): no delete path exists.
// Unique (tenant, department, lower(name)) is the index test_categories__tenant_id_department_id_lower_name__uq: 23505 -> 409 catalog.code_duplicate;
// the composite FK (tenant_id, department_id) makes an unknown or other tenant's department 23503 -> 404 common.not_found (same answer, S-1).
// LD-333(b): a category bumps as entity_type test_category (added to catalog.changed.v1 by T0C-TESTIMPORT-1); entity_id stays the category id.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { FieldError } from '../../../core/errors.js';
import { LimsError } from '../../../core/errors.js';
import { decodeCursor, encodeCursor } from '../mappers/masters.mapper.js';
import * as repo from '../repo/masters.repo.js';
import { BOOL, checkFields, checkUpdate, fail, invalid, kindOf, lockAt, mapPg, required, str, unsetOf, UUID, type Ctx, type Deps, type Field, type Tx } from './masters.service.js';
import { createRevisionService } from './revision.service.js';
import { checkQuery, isActiveOf, limitOf } from './tests.service.js';

const COLS = ['id', 'department_id', 'name', 'display_order', 'print_footer', 'footer_text', 'is_active', 'version'];
const FIELDS: Record<string, Field> = { name: str(1, 200), display_order: { t: 'int', min: 0, max: 9999 }, print_footer: BOOL, footer_text: str(1, 2000), is_active: BOOL };
const SORTS = ['name', '-name', 'display_order', '-display_order'];
const ENTITY = 'test_category';   // LD-333(b)

type R = Record<string, any>;
const dto = (r: R) => ({
  id: r.id as string, department_id: r.department_id as string, name: r.name as string, display_order: Number(r.display_order), print_footer: r.print_footer === true,
  ...(r.footer_text == null ? {} : { footer_text: r.footer_text as string }), is_active: r.is_active === true, version: Number(r.version),
});

export function createCategoriesService(deps: Deps) {
  const revision = createRevisionService(deps);
  const bump = (ctx: Ctx, id: string, changeKind: string) =>
    revision.bumpRevision(ctx, { entityType: ENTITY, entityId: id, changeKind, effectiveFrom: ctx.now?.() ?? new Date().toISOString() });

  return {
    async listTestCategories(ctx: Ctx, query?: unknown) {
      const q = checkQuery(query, ['department_id', 'is_active', 'sort', 'cursor', 'limit']);
      const errors: FieldError[] = [];
      if (q['department_id'] !== undefined && !(typeof q['department_id'] === 'string' && UUID.test(q['department_id']))) errors.push(invalid('/department_id'));
      const isActive = isActiveOf(q['is_active'], errors);
      if (q['sort'] !== undefined && !(typeof q['sort'] === 'string' && SORTS.includes(q['sort']))) errors.push(invalid('/sort'));
      const limit = limitOf(q['limit'], 50, 200, errors);
      if (errors.length) fail(errors);
      const sort = (q['sort'] as string | undefined) ?? 'display_order';
      const col = sort.replace(/^-/, ''), dir = sort.startsWith('-') ? 'DESC' : 'ASC';
      const values: unknown[] = [ctx.tenantId];
      const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
      const where = ['tenant_id = $1'];
      if (isActive !== undefined) where.push(`is_active = ${bind(isActive)}`);
      if (q['department_id'] !== undefined) where.push(`department_id = ${bind(q['department_id'])}`);
      if (q['cursor'] !== undefined) {
        const [v, id] = decodeCursor(q['cursor'], sort);
        where.push(`(${col}, id) ${dir === 'DESC' ? '<' : '>'} (${bind(v)}, ${bind(id)})`);
      }
      // col / dir come from the fixed SORTS list above, never from the request text.
      const { rows } = await (ctx.tx as Tx).query(
        `SELECT ${COLS.join(', ')} FROM catalog.test_categories WHERE ${where.join(' AND ')} ORDER BY ${col} ${dir}, id ${dir} LIMIT ${bind(limit + 1)}`, values);
      const data = rows.slice(0, limit);
      const last = data[data.length - 1];
      return { data: data.map(dto), page: { limit, ...(rows.length > limit && last ? { next_cursor: encodeCursor(sort, col === 'name' ? last.name : Number(last.display_order), last.id) } : {}) } };
    },

    async createTestCategory(ctx: Ctx, body?: unknown) {
      const b = checkFields({ fields: { ...FIELDS, department_id: { t: 'uuid' } } }, body, []);
      const errors = ['department_id', 'name'].filter((k) => b[k] === undefined).map((k) => required(`/${k}`));
      if (errors.length) fail(errors);
      const created = await repo.insertRow(ctx.tx as Tx, 'test_categories', COLS, {
        id: uuidv7(), tenant_id: ctx.tenantId, ...b, is_active: b['is_active'] ?? true, created_by: ctx.actor.id, updated_by: ctx.actor.id,
      }).catch(mapPg);
      await bump(ctx, created.id, 'created');
      return dto(created);
    },

    /** department_id is not an update field (closed body); `unset` may only clear footer_text. */
    async updateTestCategory(ctx: Ctx, input: { id?: unknown; expectedVersion?: unknown; patch?: unknown } = {}) {
      const { id, ev } = checkUpdate(input);
      const patch = checkFields({ fields: FIELDS }, input.patch, ['unset']);
      const nulls = unsetOf(patch, ['footer_text']);
      delete patch['unset'];
      const before = await lockAt(ctx, 'test_categories', COLS, id, ev);
      const after = await repo.updateRow(ctx.tx as Tx, 'test_categories', COLS, { tenantId: ctx.tenantId, id, expectedVersion: ev, actorId: ctx.actor.id }, { ...patch, ...nulls }).catch(mapPg);
      if (!after) throw new LimsError('common.version_conflict');
      await bump(ctx, id, kindOf(before, after));
      return dto(after);
    },
  };
}
