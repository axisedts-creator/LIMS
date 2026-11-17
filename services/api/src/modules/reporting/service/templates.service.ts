// Report templates admin, API side: list T1, create T2, get T3, draft save T4, publish T6 (02-TRD §6.4, §6.5 TemplateConfig; 05-SCHEMA §2.12;
// 01-PRD AC-13.2, AC-13.3; 03-APP-FLOW E24; 07-SECURITY REQ-SEC-024, A11). Tenant and actor come from ctx only. T5 preview is C6-T16.
// - AC-13.3: every config is validated by domain/templates.ts (validateTemplateConfig) on T2, T4 and again on the stored draft at T6; rejection is
//   422 reporting.template_invalid with field paths and messages, never the offending value. What is stored is the validated copy (defaults filled).
// - AC-13.2: a version row's config is written only while it is a draft. T6 retires the previous published row, then promotes the draft; the next
//   edit starts a NEW draft (version_no = max + 1). Retired and published rows are never edited, so a report rendered against v1 keeps resolving v1.
// - [CONV] If-Match = report_templates.version. T4/T6 first win the version-guarded UPDATE of the header (the lost racer gets common.version_conflict
//   having written no version row), then write the version rows; a 23505 on the one-draft / one-published partial unique indexes is also version_conflict.
// - Renderer path (E24): getVersionById (a frozen non-draft version) and resolvePublishedVersion (the live published one); a draft is never rendered.
import { createHash } from 'node:crypto';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { validateTemplateConfig } from '../domain/templates.js';
import * as repo from '../repository/templates.repo.js';
import type { OutsourcedCtx } from './outsourced.service.js';

export type TemplatesCtx = OutsourcedCtx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAMILIES = ['laboratory', 'narrative'];

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
};
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
function version(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) fail('/If-Match');
  return v as number;
}
function scope(ctx: TemplatesCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as repo.Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const nowIso = (ctx: TemplatesCtx) => iso(typeof ctx.now === 'function' ? ctx.now() : new Date());
const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const errCode = (e: unknown) => (e as { code?: string } | null)?.code;

/** AC-13.3: the validated copy of a TemplateConfig, or 422 with paths + messages (never values). */
function validConfig(input: unknown) {
  const r = validateTemplateConfig(input);
  if (!r.ok) throw new LimsError('reporting.template_invalid', undefined, r.errors.map((e) => ({ path: e.path, code: 'reporting.template_invalid', message: e.message })));
  return r.config;
}
const sha256 = (config: unknown) => createHash('sha256').update(JSON.stringify(config)).digest('hex');
const byNo = (a: any, b: any) => a.version_no - b.version_no;

/** OpenAPI ReportTemplateSummary / Detail head: absent optionals are omitted (no nulls). */
function head(t: any, live: any[]) {
  const pub = live.find((v) => v.status === 'published'); const draft = live.find((v) => v.status === 'draft');
  return {
    id: t.id, family: t.family, name: t.name, ...(pub ? { current_version_no: pub.version_no } : {}), ...(draft ? { draft_version_no: draft.version_no } : {}),
    is_active: t.is_active, version: t.version,
  };
}

export function createTemplatesService(deps: { newId?: () => string } = {}) {
  const newId = deps.newId ?? uuidv7;

  async function ownTemplate(tx: repo.Tx, tenantId: string, id: unknown) {
    if (!isUuid(id)) throw new LimsError('common.not_found');
    const row = await repo.findTemplate(tx, tenantId, id);
    if (!row || row.tenant_id !== tenantId) throw new LimsError('common.not_found');   // RLS + predicate; re-checked so a missing predicate can never leak
    return row;
  }
  /** Version rows of one template, ascending, tenant re-checked. */
  async function versionsOf(tx: repo.Tx, tenantId: string, templateId: string) {
    return (await repo.versionsOf(tx, tenantId, templateId)).filter((v) => v.tenant_id === tenantId && v.template_id === templateId).sort(byNo);
  }
  /** OpenAPI ReportTemplateDetail. */
  function detail(t: any, versions: any[]) {
    const draft = versions.find((v) => v.status === 'draft');
    return {
      ...head(t, versions),
      versions: versions.map((v) => ({ version_no: v.version_no, status: v.status, ...(v.status !== 'draft' && v.published_at ? { published_at: iso(v.published_at) } : {}) })),
      ...(draft ? { draft: { config: asJson(draft.config), version: draft.version } } : {}),
    };
  }
  const frozen = (v: any) => ({ templateVersionId: v.id as string, templateId: v.template_id as string, versionNo: v.version_no as number, status: v.status as string, config: asJson(v.config) });

  return {
    /** T1 */
    async listTemplates(ctx: TemplatesCtx, q: { family?: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (q?.family !== undefined && (typeof q.family !== 'string' || !FAMILIES.includes(q.family))) fail('/family');
      const [rows, live] = await Promise.all([repo.listTemplates(tx, tenantId, (q?.family as string) ?? null), repo.liveVersionsOfTenant(tx, tenantId)]);
      return { data: rows.filter((r) => r.tenant_id === tenantId).map((t) => head(t, live.filter((v) => v.tenant_id === tenantId && v.template_id === t.id))) };
    },

    /** T2 — draft v1 with the validated config; no published version yet. */
    async createTemplate(ctx: TemplatesCtx, input: { body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['family', 'name', 'config']);
      if (typeof b['family'] !== 'string' || !FAMILIES.includes(b['family'])) fail('/family');
      if (typeof b['name'] !== 'string' || b['name'].length < 1 || b['name'].length > 80) fail('/name');
      const config = validConfig(b['config']);
      const tpl = await repo.insertTemplate(tx, { id: newId(), tenantId, family: b['family'] as string, name: b['name'] as string, actorId });
      const ver = await repo.insertVersion(tx, { id: newId(), tenantId, templateId: tpl.id, versionNo: 1, config, sha256: sha256(config), actorId });
      return detail(tpl, [ver]);
    },

    /** T3 */
    async getTemplate(ctx: TemplatesCtx, input: { templateId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const t = await ownTemplate(tx, tenantId, input?.templateId);
      return detail(t, await versionsOf(tx, tenantId, t.id));
    },

    /** T4 — updates the draft in place, or starts draft max + 1 when there is none (published / retired rows are never touched). */
    async saveDraft(ctx: TemplatesCtx, input: { templateId: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['config']);
      const config = validConfig(b['config']);
      const t = await ownTemplate(tx, tenantId, input.templateId);
      if (t.version !== v) throw new LimsError('common.version_conflict');
      const before = await versionsOf(tx, tenantId, t.id);
      const draft = before.find((x) => x.status === 'draft');
      const nextNo = before.reduce((m, x) => Math.max(m, x.version_no), 0) + 1;

      const bumped = await repo.bumpTemplate(tx, tenantId, t.id, v, null, actorId);
      if (!bumped) throw new LimsError('common.version_conflict');
      try {
        if (draft) {
          if (!(await repo.saveDraft(tx, tenantId, draft.id, config, sha256(config), actorId))) throw new LimsError('common.version_conflict');
        } else {
          await repo.insertVersion(tx, { id: newId(), tenantId, templateId: t.id, versionNo: nextNo, config, sha256: sha256(config), actorId });
        }
      } catch (e) {
        if (errCode(e) === '23505') throw new LimsError('common.version_conflict');   // lost a race on (template, version_no) / the one-draft index
        throw e;
      }
      return detail(bumped, await versionsOf(tx, tenantId, t.id));
    },

    /** T6 — AC-13.2: retire the previous published version, promote the draft (immutable from then on), point the template at it. */
    async publish(ctx: TemplatesCtx, input: { templateId: unknown; expectedVersion: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const t = await ownTemplate(tx, tenantId, input?.templateId);
      if (t.version !== v) throw new LimsError('common.version_conflict');
      const draft = (await versionsOf(tx, tenantId, t.id)).find((x) => x.status === 'draft');
      if (!draft) throw new LimsError('reporting.template_invalid');   // nothing to publish
      validConfig(asJson(draft.config));   // a stored draft must still be valid TemplateConfig before it can go live

      const bumped = await repo.bumpTemplate(tx, tenantId, t.id, v, draft.id, actorId);
      if (!bumped) throw new LimsError('common.version_conflict');
      try {
        await repo.retirePublished(tx, tenantId, t.id, actorId);
        if (!(await repo.promoteDraft(tx, tenantId, draft.id, nowIso(ctx), actorId))) throw new LimsError('common.version_conflict');
      } catch (e) {
        if (errCode(e) === '23505') throw new LimsError('common.version_conflict');   // lost a race on the one-published index
        throw e;
      }
      return detail(bumped, await versionsOf(tx, tenantId, t.id));
    },

    // ------------------------------------------------------------------------------------------------ renderer path (E24)
    /** The frozen version a report was rendered against. A draft is not frozen: not_found. */
    async getVersionById(ctx: TemplatesCtx, input: { templateVersionId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (!isUuid(input?.templateVersionId)) throw new LimsError('common.not_found');
      const row = await repo.findVersion(tx, tenantId, input.templateVersionId);
      if (!row || row.tenant_id !== tenantId || row.status === 'draft') throw new LimsError('common.not_found');
      return frozen(row);
    },

    /** The live published version of a template (what a new render uses). */
    async resolvePublishedVersion(ctx: TemplatesCtx, input: { templateId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const t = await ownTemplate(tx, tenantId, input?.templateId);
      const pub = (await versionsOf(tx, tenantId, t.id)).find((x) => x.status === 'published');
      if (!pub) throw new LimsError('common.not_found');
      return frozen(pub);
    },
  };
}
export type TemplatesService = ReturnType<typeof createTemplatesService>;
