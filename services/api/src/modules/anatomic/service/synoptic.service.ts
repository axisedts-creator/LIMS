// Synoptic template lifecycle — K13 list, K14 create draft, K15 get, K16 update draft, K17 publish, K18 retire, K19 new version (02-TRD §5.6/§5.7, 05-SCHEMA synoptic_templates, PRD AC-08.1–08.4, 08.6).
// Every operation: IdentityPort.assertRole FIRST (reads anatomic.case.read, writes anatomic.config.manage — the privileged aal2 check lives behind it, its error is passed through) -> validate -> repo.
// DB rules this service respects (the guard trigger / partial unique index stay the second wall): published and retired rows are immutable except status published->retired + bookkeeping, so the
// service checks the status FIRST and throws common.immutable_record itself; publish retires the key's published row BEFORE publishing the new one (one published per tenant+key).
// No submitted value is echoed in an error and nothing is logged (REQ-SEC-098). The caller's transaction (requestTx) rolls back on any throw, so the two-row publish is atomic.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { bad, isObj, strict, UUID } from './case.service.js';
import { ifMatch } from './config.service.js';
import { validateSynopticDefinition } from '../domain/synoptic.js';
import * as tpl from '../repository/templates.repo.js';
import type { Row } from '../repository/_sql.js';

type Obj = Record<string, unknown>;
type Result = { status: number; body: unknown };
type Perm = 'anatomic.case.read' | 'anatomic.config.manage';
interface Ctx { tenantId: string; tx: any; actor: { id: string }; now: () => Date; ports: { IdentityPort: { assertRole(c: unknown, i: { permission: Perm }): Promise<unknown> } } }

const MAX = 500; // repo page ceiling (TRD K13: up to 500 templates)
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const STATUSES = ['draft', 'published', 'retired'];
const CASE_KINDS = ['histology', 'cytology', 'ihc', 'molecular'];

async function gate(hctx: unknown, permission: Perm): Promise<Ctx> {
  const c = hctx as Partial<Ctx> | null;
  if (typeof c?.tenantId !== 'string' || !c.tx || typeof c.actor?.id !== 'string' || typeof c.now !== 'function' || !c.ports?.IdentityPort) throw new LimsError('auth.unauthenticated');
  await c.ports.IdentityPort.assertRole(c, { permission });
  return c as Ctx;
}
const ver = (r: Row): number => Number(r['version']);
const dup = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === '23505';
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const templateId = (params: unknown): string | undefined => (isObj(params) && typeof params['template_id'] === 'string' && UUID.test(params['template_id']) ? params['template_id'] : undefined);

/** Definition violations -> 422 anatomic.template_invalid; errors[] carry the validator's JSON Pointers (static messages, never the submitted values). */
function checkDefinition(def: unknown): asserts def is Obj {
  const r = validateSynopticDefinition(def);
  if (!r.ok) throw new LimsError('anatomic.template_invalid', undefined, r.errors.map((e): FieldError => ({ path: e.path, code: 'common.field_invalid', message: e.message })));
}

// ---- DTOs (closed key sets, no nulls, no tenant/audit columns) ----
const summaryDto = (r: Row): Obj => {
  const o: Obj = { id: r['id'], template_key: r['template_key'], version_no: r['version_no'], status: r['status'], title: r['title'], applies_to_case_kinds: r['applies_to_case_kinds'] };
  if (r['published_at'] != null) o['published_at'] = iso(r['published_at']);
  return o;
};
const fullDto = (r: Row): Obj => ({ ...summaryDto(r), definition: r['definition'], version: ver(r) });

/** Every row of the tenant (pages of MAX). ponytail: linear scan; add key-scoped repo lookups if a tenant ever holds thousands of template versions. */
async function allRows(c: Ctx): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += MAX) {
    const rows = await tpl.listSynopticTemplates(c.tx, { tenantId: c.tenantId, limit: MAX, offset });
    out.push(...rows);
    if (rows.length < MAX) return out;
  }
}
const ofKey = async (c: Ctx, key: unknown): Promise<Row[]> => (await allRows(c)).filter((r) => r['template_key'] === key);

async function load(c: Ctx, params: unknown): Promise<Row> {
  const id = templateId(params);
  const row = id ? await tpl.getSynopticTemplate(c.tx, { tenantId: c.tenantId, id }) : undefined;
  if (!row) throw new LimsError('common.not_found');
  return row;
}
const draftInsert = (c: Ctx, key: string, versionNo: number, title: unknown, kinds: unknown, definition: unknown): Promise<Row> =>
  tpl.insertSynopticTemplate(c.tx, {
    id: uuidv7(), tenant_id: c.tenantId, template_key: key, version_no: versionNo, status: 'draft', title, applies_to_case_kinds: kinds, definition, created_by: c.actor.id, updated_by: c.actor.id,
  });
async function patchRow(c: Ctx, row: Row, patch: Row): Promise<Row> {
  const r = await tpl.updateSynopticTemplate(c.tx, { tenantId: c.tenantId, id: row['id'], expectedVersion: ver(row), actorId: c.actor.id, patch });
  if (!r) throw new LimsError('common.version_conflict');
  return r;
}

// ---- K13 ----
export async function listTemplates(hctx: unknown, query: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  const q = strict(query ?? {}, ['status', 'case_kind']);
  let statuses: string[] | undefined;
  if (q['status'] !== undefined) {
    statuses = typeof q['status'] === 'string' ? q['status'].split(',') : [];
    if (statuses.length < 1 || !statuses.every((s) => STATUSES.includes(s))) throw bad('/status');
  }
  if (q['case_kind'] !== undefined && (typeof q['case_kind'] !== 'string' || !CASE_KINDS.includes(q['case_kind']))) throw bad('/case_kind');
  const kind = q['case_kind'];
  const rows = (await allRows(c)).filter((r) => (!statuses || statuses.includes(r['status'])) && (!kind || (r['applies_to_case_kinds'] as string[]).includes(kind as string)));
  return { status: 200, body: { data: rows.slice(0, MAX).map(summaryDto) } };
}

// ---- K14 ----
export async function createTemplate(hctx: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const b = strict(body, ['template_key', 'definition']);
  if (typeof b['template_key'] !== 'string' || !KEY.test(b['template_key'])) throw bad('/template_key');
  if (b['definition'] === undefined) throw bad('/definition');
  const key = b['template_key'];
  checkDefinition(b['definition']);
  if ((await ofKey(c, key)).length) throw bad('/template_key'); // duplicate key (TRD §5.6 K-ops errors)
  const def = b['definition'];
  try { return { status: 201, body: fullDto(await draftInsert(c, key, 1, def['title'], def['applies_to_case_kinds'], def)) }; } catch (e) { throw dup(e) ? bad('/template_key') : e; }
}

// ---- K15 ----
export async function getTemplate(hctx: unknown, params: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.case.read');
  return { status: 200, body: fullDto(await load(c, params)) };
}

// ---- K16 ----
export async function updateTemplate(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const b = strict(body, ['definition']); // template_key, version_no, status, title are not client-settable
  if (b['definition'] === undefined) throw bad('/definition');
  checkDefinition(b['definition']);
  const def = b['definition'];
  const cur = await load(c, params);
  if (cur['status'] !== 'draft') throw new LimsError('common.immutable_record'); // AC-08.3; the guard trigger is the second wall
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  return { status: 200, body: fullDto(await patchRow(c, cur, { definition: def, title: def['title'], applies_to_case_kinds: def['applies_to_case_kinds'] })) };
}

// ---- K17 ----
export async function publishTemplate(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const cur = await load(c, params);
  if (cur['status'] !== 'draft') throw new LimsError('common.immutable_record');
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  const now = c.now().toISOString();
  for (const prev of (await ofKey(c, cur['template_key'])).filter((r) => r['status'] === 'published' && r['id'] !== cur['id'])) { // at most one; retire it first or the partial unique index fails
    await patchRow(c, prev, { status: 'retired', retired_at: now });
  }
  return { status: 200, body: fullDto(await patchRow(c, cur, { status: 'published', published_at: now, published_by: c.actor.id })) };
}

// ---- K18 ----
export async function retireTemplate(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const version = ifMatch(headers);
  const cur = await load(c, params);
  if (cur['status'] !== 'published') throw new LimsError('anatomic.template_not_published');
  if (ver(cur) !== version) throw new LimsError('common.version_conflict');
  return { status: 200, body: fullDto(await patchRow(c, cur, { status: 'retired', retired_at: c.now().toISOString() })) };
}

// ---- K19 ----
export async function createTemplateVersion(hctx: unknown, params: unknown): Promise<Result> {
  const c = await gate(hctx, 'anatomic.config.manage');
  const src = await load(c, params);
  const next = Math.max(...(await ofKey(c, src['template_key'])).map((r) => Number(r['version_no']))) + 1;
  try { return { status: 201, body: fullDto(await draftInsert(c, src['template_key'], next, src['title'], structuredClone(src['applies_to_case_kinds']), structuredClone(src['definition']))) }; } catch (e) {
    throw dup(e) ? new LimsError('common.version_conflict') : e; // lost the race for version_no + 1
  }
}
