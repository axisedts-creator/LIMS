// Narrative engine, API side: templates N8-N10, list/get N1-N2, draft save N3, sign N4, amendment N5 (02-TRD §6.4, §4.1 narrative_ready;
// 01-PRD AC-05.1, 05.2, 05.4-05.7; 07-SECURITY REQ-SEC-088). Tenant and actor come from ctx only.
// - Every html string is sanitised server-side (domain/sanitise.ts, DOMPurify) before it is stored or returned; stored sections are [{key, heading, html}]
//   (05-SCHEMA §2.12), so a signed version's headings are frozen and covered by content_sha256.
// - If-Match = narrative_reports.version. N3/N4/N5 first win the version-guarded UPDATE of narrative_reports (the lost racer gets
//   common.version_conflict having written nothing), then write the narrative_versions row (status-guarded).
// - [CONV] N2 creates draft v1 lazily from the test's template (AC-05.1); N4/N5 call IdentityPort.assertRole(reporting.narrative.sign) after loading
//   the target (P-10) besides the pipeline's privileged/aal2 gate; N5 leaves narrative_ready untouched (v1 stays the signed truth until v2 is signed).
import { createHash } from 'node:crypto';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { isBlankHtml, sanitiseHtml } from '../domain/sanitise.js';
import * as repo from '../repository/narrative.repo.js';
import { enqueue, lockOrderItem, markNeedsAssembly } from '../repository/outsourced.repo.js';
import { listCodes } from '../repository/settings.repo.js';
import { ASSEMBLE_TASK, type OutsourcedCtx } from './outsourced.service.js';

export interface NarrativeCtx extends OutsourcedCtx { readonly ports?: Readonly<Record<string, any>> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['xray', 'usg', 'endoscopy', 'cytogenetics', 'other'];
const STATUSES = ['draft', 'signed', 'amending'];
const CODE = /^[A-Z0-9_]{1,32}$/;
const MAX_SECTIONS = 12; const MAX_IMAGES = 12; const MAX_HTML = 20000; const MAX_DEFAULT_HTML = 5000;
const PAGE_DEFAULT = 50; const PAGE_MAX = 200;

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
function scope(ctx: NarrativeCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as repo.Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const nowIso = (ctx: NarrativeCtx) => (typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString());
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const asJson = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
/** uuid[] as returned by the driver (array) or as a Postgres literal. */
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);
const errCode = (e: unknown) => (e as { code?: string } | null)?.code;

type StoredSection = { key: string; heading: string; html: string };
type TemplateSection = { key: string; heading: string; required: boolean; default_html: string };

/** Template sections (N9/N10 body): closed objects, unique keys, default_html sanitised (it is pre-filled into every draft). */
function templateSections(v: unknown): TemplateSection[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_SECTIONS) fail('/sections');
  const seen = new Set<string>();
  return (v as unknown[]).map((s, i) => {
    const p = `/sections/${i}`;
    if (!isObj(s)) return fail(p);
    onlyKeys(s, ['key', 'heading', 'required', 'default_html']);
    const { key, heading, required, default_html: html } = s;
    if (typeof key !== 'string' || key.length < 1 || key.length > 40 || seen.has(key)) fail(`${p}/key`);
    seen.add(key as string);
    if (typeof heading !== 'string' || heading.length < 1 || heading.length > 80) fail(`${p}/heading`);
    if (typeof required !== 'boolean') fail(`${p}/required`);
    if (html !== undefined && (typeof html !== 'string' || html.length > MAX_DEFAULT_HTML)) fail(`${p}/default_html`);
    return { key: key as string, heading: heading as string, required: required as boolean, default_html: sanitiseHtml(typeof html === 'string' ? html : '') };
  });
}
const optBool = (v: unknown, path: string): boolean | null => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true; if (v === 'false') return false;
  return fail(path);
};

/** OpenAPI NarrativeTemplate: only these keys; absent optionals are omitted (no nulls). */
function templateBody(r: any) {
  return {
    id: r.id, code: r.code, name: r.name, kind: r.kind, ...(r.test_id != null ? { test_id: r.test_id } : {}),
    sections: asJson(r.sections) as TemplateSection[], is_active: r.is_active, version: r.version,
  };
}

export function createNarrativeService(deps: { newId?: () => string } = {}) {
  const newId = deps.newId ?? uuidv7;

  function port(ctx: NarrativeCtx, name: 'IdentityPort' | 'CatalogPort'): any {
    const p = ctx.ports?.[name];
    if (!p) throw new LimsError('common.internal');   // fail closed
    return p;
  }
  const assertRole = (ctx: NarrativeCtx, permission: string, centreId: string) => port(ctx, 'IdentityPort').assertRole(ctx, { permission, centreId });
  async function testName(ctx: NarrativeCtx, testId: string, cache?: Map<string, string>): Promise<string> {
    const hit = cache?.get(testId); if (hit !== undefined) return hit;
    const name = String((await port(ctx, 'CatalogPort').getTest(ctx, { testId })).name);
    cache?.set(testId, name);
    return name;
  }
  async function ownNarrative(tx: repo.Tx, tenantId: string, id: unknown) {
    if (!isUuid(id)) throw new LimsError('common.not_found');
    const row = await repo.findNarrative(tx, tenantId, id);
    if (!row || row.tenant_id !== tenantId) throw new LimsError('common.not_found');   // RLS + predicate; re-checked so a missing predicate can never leak
    return row;
  }

  /** AC-05.1: the test's own active template wins, else the active unbound template of the narrative's kind. */
  async function pickTemplate(tx: repo.Tx, tenantId: string, n: any) {
    const own = (await repo.activeTemplatesForTest(tx, tenantId, n.test_id)).find((t) => t.tenant_id === tenantId && t.is_active === true && t.test_id === n.test_id);
    if (own) return own;
    return (await repo.activeTemplatesForKind(tx, tenantId, n.template_kind)).find((t) => t.tenant_id === tenantId && t.is_active === true && t.test_id == null && t.kind === n.template_kind);
  }
  /** The current version row; a narrative without one gets draft v1 pre-filled from its template (concurrent first opens: one insert wins). */
  async function currentVersion(ctx: NarrativeCtx, n: any) {
    const { tx, tenantId, actorId } = scope(ctx);
    const existing = await repo.findVersion(tx, tenantId, n.id, n.current_version_no);
    if (existing || n.status !== 'draft') return existing;
    const tpl = await pickTemplate(tx, tenantId, n);
    const sections: StoredSection[] = tpl ? (asJson(tpl.sections) as TemplateSection[]).map((s) => ({ key: s.key, heading: s.heading, html: sanitiseHtml(s.default_html ?? '') })) : [];
    await repo.insertVersion(tx, {
      id: newId(), tenantId, centreId: n.centre_id, narrativeId: n.id, versionNo: n.current_version_no, templateId: tpl?.id ?? null, sections, imageFileIds: [],
      amendmentOf: null, reasonCode: null, reasonText: null, actorId,
    });
    return repo.findVersion(tx, tenantId, n.id, n.current_version_no);
  }

  /** OpenAPI NarrativeReport. */
  async function view(ctx: NarrativeCtx, n: any, cv: any) {
    const { tx, tenantId } = scope(ctx);
    const [all, tpl, name] = await Promise.all([repo.versionsOf(tx, tenantId, n.id), cv.template_id ? repo.findTemplate(tx, tenantId, cv.template_id) : undefined, testName(ctx, n.test_id)]);
    const headings = new Map<string, string>(tpl && tpl.tenant_id === tenantId ? (asJson(tpl.sections) as TemplateSection[]).map((s) => [s.key, s.heading]) : []);
    const images: Array<{ image_id: string; caption?: string }> = [];
    for (const id of idList(cv.image_file_ids)) {
      const f = await repo.findImage(tx, tenantId, id);
      if (f && f.tenant_id === tenantId) images.push({ image_id: id, ...(f.caption != null ? { caption: f.caption } : {}) });
    }
    const current: Record<string, unknown> = {
      version_no: cv.version_no, status: cv.status, ...(cv.template_id ? { template_id: cv.template_id } : {}),
      sections: (asJson(cv.sections) as StoredSection[]).map((s) => ({ key: s.key, heading: s.heading ?? headings.get(s.key) ?? s.key, html: s.html })), images,
    };
    if (cv.signed_by_membership_id) current['signed_by'] = cv.signed_by_membership_id;
    if (cv.signed_at) current['signed_at'] = iso(cv.signed_at);
    if (cv.amendment_reason_code) current['amendment_reason_code'] = cv.amendment_reason_code;
    return {
      id: n.id, order_item_id: n.order_item_id, test_id: n.test_id, test_name: name, template_kind: n.template_kind, status: n.status, current_version: current,
      history: all.sort((a, b) => a.version_no - b.version_no).map((v) => ({ version_no: v.version_no, status: v.status, ...(v.signed_at ? { signed_at: iso(v.signed_at) } : {}) })),
      version: n.version,
    };
  }

  /** AC-05.4: every required section of the version's template must show text. Without a template at least one section must. */
  async function assertComplete(tx: repo.Tx, tenantId: string, cv: any) {
    const sections = asJson(cv.sections) as StoredSection[];
    const tpl = cv.template_id ? await repo.findTemplate(tx, tenantId, cv.template_id) : undefined;
    const filled = (key: string) => sections.some((s) => s.key === key && !isBlankHtml(s.html));
    const ok = tpl && tpl.tenant_id === tenantId ? (asJson(tpl.sections) as TemplateSection[]).filter((s) => s.required).every((s) => filled(s.key)) : sections.some((s) => !isBlankHtml(s.html));
    if (!ok) throw new LimsError('reporting.narrative_incomplete');
  }

  return {
    // ------------------------------------------------------------------------------------------------ templates
    /** N8 */
    async listTemplates(ctx: NarrativeCtx, q: { kind?: unknown; testId?: unknown; isActive?: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (q?.kind !== undefined && (typeof q.kind !== 'string' || !KINDS.includes(q.kind))) fail('/kind');
      if (q?.testId !== undefined && !isUuid(q.testId)) fail('/test_id');
      const rows = await repo.listTemplates(tx, tenantId, { kind: (q?.kind as string) ?? null, testId: (q?.testId as string) ?? null, isActive: optBool(q?.isActive, '/is_active') });
      return { data: rows.filter((r) => r.tenant_id === tenantId).map(templateBody) };
    },

    /** N9 */
    async createTemplate(ctx: NarrativeCtx, input: { body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['code', 'name', 'kind', 'test_id', 'sections']);
      if (typeof b['code'] !== 'string' || !CODE.test(b['code'])) fail('/code');
      if (typeof b['name'] !== 'string' || b['name'].length < 1 || b['name'].length > 120) fail('/name');
      if (typeof b['kind'] !== 'string' || !KINDS.includes(b['kind'])) fail('/kind');
      if (b['test_id'] !== undefined && !isUuid(b['test_id'])) fail('/test_id');
      const sections = templateSections(b['sections']);
      if (b['test_id'] !== undefined) await port(ctx, 'CatalogPort').getTest(ctx, { testId: b['test_id'], requireActive: true });   // unknown / other tenant -> not_found
      if (await repo.findTemplateByCode(tx, tenantId, b['code'] as string)) throw new LimsError('reporting.template_invalid');
      try {
        const row = await repo.insertTemplate(tx, { id: newId(), tenantId, code: b['code'] as string, name: b['name'] as string, kind: b['kind'] as string, testId: (b['test_id'] as string) ?? null, sections, actorId });
        return templateBody(row);
      } catch (e) {
        if (errCode(e) === '23505') throw new LimsError('reporting.template_invalid');   // lost a race on (tenant_id, code)
        throw e;
      }
    },

    /** N10 — code, kind and test binding are immutable; existing drafts keep their stored sections. */
    async updateTemplate(ctx: NarrativeCtx, input: { templateId: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['name', 'sections', 'is_active']);
      if (Object.keys(b).length === 0) fail('/');
      if (b['name'] !== undefined && (typeof b['name'] !== 'string' || b['name'].length < 1 || b['name'].length > 120)) fail('/name');
      if (b['is_active'] !== undefined && typeof b['is_active'] !== 'boolean') fail('/is_active');
      const sections = b['sections'] === undefined ? null : templateSections(b['sections']);
      if (!isUuid(input.templateId)) throw new LimsError('common.not_found');
      const cur = await repo.findTemplate(tx, tenantId, input.templateId);
      if (!cur || cur.tenant_id !== tenantId) throw new LimsError('common.not_found');
      if (cur.version !== v) throw new LimsError('common.version_conflict');
      const row = await repo.updateTemplate(tx, tenantId, cur.id, v, { name: (b['name'] as string) ?? null, sections, isActive: (b['is_active'] as boolean) ?? null }, actorId);
      if (!row) throw new LimsError('common.version_conflict');
      return templateBody(row);
    },

    // ------------------------------------------------------------------------------------------------ narratives
    /** N1 */
    async list(ctx: NarrativeCtx, q: { status?: unknown; templateKind?: unknown; centreId?: unknown; cursor?: unknown; limit?: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (q?.status !== undefined && (typeof q.status !== 'string' || !STATUSES.includes(q.status))) fail('/status');
      if (q?.templateKind !== undefined && (typeof q.templateKind !== 'string' || !KINDS.includes(q.templateKind))) fail('/template_kind');
      if (q?.centreId !== undefined && !isUuid(q.centreId)) fail('/centre_id');
      const limit = q?.limit === undefined ? PAGE_DEFAULT : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) fail('/limit');
      let afterId: string | null = null;
      if (q?.cursor !== undefined) {
        try {
          const c = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8'));
          if (!isUuid(c?.i)) throw new Error('bad');
          afterId = c.i;
        } catch { throw new LimsError('common.invalid_cursor'); }
      }
      const rows = (await repo.listNarratives(tx, tenantId, { status: (q?.status as string) ?? null, kind: (q?.templateKind as string) ?? null, centreId: (q?.centreId as string) ?? null, afterId, limit: limit + 1 }))
        .filter((r) => r.tenant_id === tenantId);
      const pageRows = rows.slice(0, limit);
      const names = new Map<string, string>();
      const data = [];
      for (const r of pageRows) {
        data.push({
          id: r.id, order_item_id: r.order_item_id, test_id: r.test_id, test_name: await testName(ctx, r.test_id, names), template_kind: r.template_kind, status: r.status,
          current_version_no: r.current_version_no, ...(r.updated_at ? { updated_at: iso(r.updated_at) } : {}), version: r.version,
        });
      }
      const last = pageRows[pageRows.length - 1];
      const page: Record<string, unknown> = { limit };
      if (rows.length > limit && last) page['next_cursor'] = Buffer.from(JSON.stringify({ i: last.id })).toString('base64url');
      return { data, page };
    },

    /** N2 — AC-05.1 */
    async get(ctx: NarrativeCtx, input: { narrativeId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const n = await ownNarrative(tx, tenantId, input?.narrativeId);
      const cv = await currentVersion(ctx, n);
      if (!cv) throw new LimsError('common.not_found');
      return view(ctx, n, cv);
    },

    /** N3 — AC-05.2: every section is sanitised before it is stored; what is returned is what is stored. */
    async save(ctx: NarrativeCtx, input: { narrativeId: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['template_id', 'sections', 'images']);
      if (b['template_id'] !== undefined && !isUuid(b['template_id'])) fail('/template_id');
      if (!Array.isArray(b['sections']) || b['sections'].length > MAX_SECTIONS) fail('/sections');
      if (!Array.isArray(b['images']) || b['images'].length > MAX_IMAGES) fail('/images');
      const keys = new Set<string>();
      const sections: StoredSection[] = (b['sections'] as unknown[]).map((s, i) => {
        if (!isObj(s)) return fail(`/sections/${i}`);
        onlyKeys(s, ['key', 'html']);
        if (typeof s['key'] !== 'string' || s['key'].length < 1 || s['key'].length > 40 || keys.has(s['key'])) fail(`/sections/${i}/key`);
        if (typeof s['html'] !== 'string' || s['html'].length > MAX_HTML) fail(`/sections/${i}/html`);
        keys.add(s['key'] as string);
        return { key: s['key'] as string, heading: s['key'] as string, html: sanitiseHtml(s['html'] as string) };
      });
      const ids = new Set<string>();
      const images = (b['images'] as unknown[]).map((im, i) => {
        if (!isObj(im)) return fail(`/images/${i}`);
        onlyKeys(im, ['image_id', 'caption']);
        if (!isUuid(im['image_id']) || ids.has(im['image_id'])) fail(`/images/${i}/image_id`);
        if (im['caption'] !== undefined && (typeof im['caption'] !== 'string' || im['caption'].length > 200)) fail(`/images/${i}/caption`);
        ids.add(im['image_id'] as string);
        return { id: im['image_id'] as string, caption: im['caption'] as string | undefined };
      });

      const n = await ownNarrative(tx, tenantId, input.narrativeId);
      if (n.status !== 'draft' && n.status !== 'amending') throw new LimsError('reporting.narrative_locked');
      if (n.version !== v) throw new LimsError('common.version_conflict');
      const cv = await currentVersion(ctx, n);
      if (!cv || cv.status !== 'draft') throw new LimsError('reporting.narrative_locked');

      let templateId: string | null = null;
      let tpl = cv.template_id ? await repo.findTemplate(tx, tenantId, cv.template_id) : undefined;
      if (b['template_id'] !== undefined) {
        tpl = await repo.findTemplate(tx, tenantId, b['template_id'] as string);
        if (!tpl || tpl.tenant_id !== tenantId || tpl.is_active !== true || tpl.kind !== n.template_kind) fail('/template_id');
        templateId = tpl.id;
      }
      if (tpl && tpl.tenant_id === tenantId) {
        const allowed = new Set((asJson(tpl.sections) as TemplateSection[]).map((s) => s.key));
        const tplHeadings = new Map((asJson(tpl.sections) as TemplateSection[]).map((s) => [s.key, s.heading]));
        sections.forEach((s, i) => { if (!allowed.has(s.key)) fail(`/sections/${i}/key`); s.heading = tplHeadings.get(s.key) ?? s.key; });
      }
      for (const [i, im] of images.entries()) {   // only this narrative's ready images; never another tenant's, never quarantined / rejected / withdrawn
        const f = await repo.findImage(tx, tenantId, im.id);
        if (!f || f.tenant_id !== tenantId || f.kind !== 'narrative_image' || f.state !== 'ready' || f.narrative_report_id !== n.id) fail(`/images/${i}/image_id`);
      }

      const bumped = await repo.bumpNarrative(tx, tenantId, n.id, v, { status: null, currentVersionNo: null, signedVersionNo: null }, actorId);
      if (!bumped) throw new LimsError('common.version_conflict');
      const saved = await repo.saveDraft(tx, tenantId, n.id, cv.version_no, { templateId, sections, imageFileIds: images.map((i) => i.id) }, actorId);
      if (!saved) throw new LimsError('reporting.narrative_locked');
      for (const im of images) if (im.caption !== undefined) await repo.setImageCaption(tx, tenantId, im.id, im.caption, actorId);
      return view(ctx, bumped, saved);
    },

    /** N4 — AC-05.4 / 05.5 / 05.7 */
    async sign(ctx: NarrativeCtx, input: { narrativeId: unknown; expectedVersion: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const membershipId = ctx.actor.membershipId;
      if (typeof membershipId !== 'string' || !ctx.audit) throw new LimsError('common.internal');
      const n = await ownNarrative(tx, tenantId, input.narrativeId);
      await assertRole(ctx, 'reporting.narrative.sign', n.centre_id);
      if (n.status !== 'draft' && n.status !== 'amending') throw new LimsError('reporting.narrative_locked');
      if (n.version !== v) throw new LimsError('common.version_conflict');
      const cv = await repo.findVersion(tx, tenantId, n.id, n.current_version_no);
      if (!cv) throw new LimsError('reporting.narrative_incomplete');
      if (cv.status !== 'draft') throw new LimsError('reporting.narrative_locked');
      await assertComplete(tx, tenantId, cv);

      const sha256 = createHash('sha256').update(JSON.stringify({ n: n.id, v: cv.version_no, t: cv.template_id ?? null, s: asJson(cv.sections), i: idList(cv.image_file_ids) })).digest('hex');
      const bumped = await repo.bumpNarrative(tx, tenantId, n.id, v, { status: 'signed', currentVersionNo: null, signedVersionNo: cv.version_no }, actorId);
      if (!bumped) throw new LimsError('common.version_conflict');
      const signed = await repo.signVersion(tx, tenantId, n.id, cv.version_no, membershipId, nowIso(ctx), sha256, actorId);
      if (!signed) throw new LimsError('reporting.narrative_locked');
      if (cv.amendment_of_version_no != null) await repo.supersedeVersion(tx, tenantId, n.id, cv.amendment_of_version_no, actorId);

      // Readiness hook (02-TRD §4.1): narrative_ready = every narrative of the item is signed. Like the outsourced hook the item's reports are always
      // flagged and queued (deduped assemble:<report_id>); the assembly job decides from the readiness flags whether a version can be built.
      await lockOrderItem(tx, tenantId, n.order_item_id);
      const siblings = (await repo.narrativesOfItem(tx, tenantId, n.order_item_id)).filter((s) => s.status !== 'cancelled');
      const ready = siblings.length > 0 && siblings.every((s) => s.status === 'signed');
      for (const reportId of await repo.setNarrativeReady(tx, tenantId, n.order_item_id, ready, actorId)) {
        await markNeedsAssembly(tx, tenantId, reportId, actorId);
        await enqueue(tx, ASSEMBLE_TASK, { tenant_id: tenantId, report_id: reportId }, `assemble:${reportId}`);
      }
      await ctx.audit.access({ action: 'report.narrative_sign', entityType: 'narrative_version', entityId: signed.id, centreId: n.centre_id, outcome: 'allowed' });
      return view(ctx, bumped, signed);
    },

    /** N5 — AC-05.6: v(n+1) draft from the signed version; the signed row is untouched (superseded only when the amendment is signed). */
    async amend(ctx: NarrativeCtx, input: { narrativeId: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['reason_code', 'reason_text']);
      const code = b['reason_code'];
      if (typeof code !== 'string' || code.length < 1 || code.length > 64) fail('/reason_code');
      const text = b['reason_text'];
      if (text !== undefined && (typeof text !== 'string' || text.length > 500)) fail('/reason_text');
      if (code === 'other' && (typeof text !== 'string' || text.trim().length === 0)) fail('/reason_text');   // OpenAPI: required when reason_code = other
      const n = await ownNarrative(tx, tenantId, input.narrativeId);
      await assertRole(ctx, 'reporting.narrative.sign', n.centre_id);
      if (n.status !== 'signed') throw new LimsError('common.immutable_record');
      if (n.version !== v) throw new LimsError('common.version_conflict');
      if (!(await listCodes(tx, tenantId, 'narrative_amend_reasons', 200)).some((c) => c.code === code)) fail('/reason_code');
      const prev = n.signed_version_no == null ? undefined : await repo.findVersion(tx, tenantId, n.id, n.signed_version_no);
      if (!prev || prev.status !== 'signed') throw new LimsError('common.immutable_record');

      const next = n.current_version_no + 1;
      const bumped = await repo.bumpNarrative(tx, tenantId, n.id, v, { status: 'amending', currentVersionNo: next, signedVersionNo: null }, actorId);
      if (!bumped) throw new LimsError('common.version_conflict');
      await repo.insertVersion(tx, {
        id: newId(), tenantId, centreId: n.centre_id, narrativeId: n.id, versionNo: next, templateId: prev.template_id ?? null, sections: asJson(prev.sections),
        imageFileIds: idList(prev.image_file_ids), amendmentOf: prev.version_no, reasonCode: code as string, reasonText: typeof text === 'string' ? text : null, actorId,
      });
      const cv = await repo.findVersion(tx, tenantId, n.id, next);
      if (!cv) throw new LimsError('common.internal');
      return view(ctx, bumped, cv);
    },
  };
}
export type NarrativeService = ReturnType<typeof createNarrativeService>;
