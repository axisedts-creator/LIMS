// C6-T18 — report templates admin T1-T4 and T6: create/list/get, draft save, publish with immutable versions, TemplateConfig validation, frozen versions for renders
// (02-TRD §6.4 rows T1-T4/T6, §6.5 TemplateConfig; 05-SCHEMA §2.12 report_templates / report_template_versions; 01-PRD AC-13.2, AC-13.3; 03-APP-FLOW E24;
//  07-SECURITY REQ-SEC-024 tenant scope, A11 no URL fields). T5 previewReportTemplate stays a 501 stub (C6-T16).
// Integration level: the REAL manifest handlers + the REAL service over the in-memory fake tx of outsourced.helpers.ts (partial unique indexes and the
// non-draft immutability trigger are modelled there). ASSUMED (spec gives no more; see .orchestra/notes/C6-T18-tests.md):
//  - request shape { params:{template_id}, headers:{'if-match':'"<n>"'}, body } like O1-O4 / N1-N10; success bodies are ReportTemplateDetail (T2 201, T3/T4/T6 200)
//  - If-Match = report_templates.version (the detail `version`, also the ETag). T4 and T6 bump it; stale -> common.version_conflict, absent -> common.precondition_required
//  - T4 on a template with no draft creates draft version_no = max+1 (published/retired rows are never touched); T6 retires the previous published row BEFORE promoting the draft
//  - publish sets published_at/published_by, report_templates.current_version_id = the new published row, and leaves no draft
//  - `versions` is ordered by version_no ascending; `published_at` only on published/retired rows
//  - service factory `createTemplatesService()` also exposes getVersionById(ctx,{templateVersionId}) and resolvePublishedVersion(ctx,{templateId}) for the renderer path
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { pgError, rejection } from './outsourced.helpers.js';
import { validateTemplateConfig } from '../domain/templates.js';
import {
  CFG_BAD, CFG_V1, CFG_V2, TENANT_A, TENANT_B, TPL_B, TPL_BAD_DRAFT, TPL_BOTH, TPL_DRAFT, TPL_NARR, TPL_NONE, TPL_PUB, USER, V,
  base, cfg, env, idN, ifm, seedAll, storedConfig, tplOf, tplRows, verOf, verRows,
} from './templates.helpers.js';

let manifest: any;
let createTemplatesService: () => any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t18-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
  createTemplatesService = (await import('../service/templates.service.js')).createTemplatesService;
});

const T = { list: 'listReportTemplates', create: 'createReportTemplate', get: 'getReportTemplate', draft: 'updateReportTemplateDraft', publish: 'publishReportTemplate' } as const;
const e = (op: string, seed = seedAll(), over: Record<string, unknown> = {}) => env(op, manifest, seed, over);
const run = (op: string, t: ReturnType<typeof e>, req: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown }) =>
  manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, t.hctx);
const NO_IFM = Symbol('no-if-match');   // explicit "send no If-Match header" (JS default params would swallow `undefined`)
const hdr = (v: unknown) => (v === NO_IFM ? {} : ifm(v));
const create = (t: ReturnType<typeof e>, b: unknown) => run(T.create, t, { body: b });
const get = (t: ReturnType<typeof e>, id: unknown) => run(T.get, t, { params: { template_id: id } });
const saveDraft = (t: ReturnType<typeof e>, id: unknown, config: unknown, v: unknown = 4) => run(T.draft, t, { params: { template_id: id }, headers: hdr(v), body: { config } });
const publish = (t: ReturnType<typeof e>, id: unknown, v: unknown = 4) => run(T.publish, t, { params: { template_id: id }, headers: hdr(v) });
const code = async (p: Promise<unknown>) => (await rejection(p))?.code;
const nothingWritten = (t: ReturnType<typeof e>) => expect(t.db.writes()).toHaveLength(0);
const snap = (v: unknown) => structuredClone(v);
const okBody = (name = 'Synthetic lab layout', config: unknown = cfg('new')) => ({ family: 'laboratory', name, config });
const KEYS_SUMMARY = ['id', 'family', 'name', 'current_version_no', 'draft_version_no', 'is_active', 'version'];
const KEYS_DETAIL = [...KEYS_SUMMARY, 'versions', 'draft'];
const expected = (c: unknown) => { const r = validateTemplateConfig(c); if (!r.ok) throw new Error('fixture config invalid'); return r.config; };

// ---------------------------------------------------------------------------------------------------------------- wiring
describe('T1-T4 and T6 are no longer 501 stubs', () => {
  it.each(Object.values(T))('%s fails closed without a request context', async (op) => {
    const noop = { info() {}, warn() {}, error() {} };
    const err = await rejection(manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(err?.code).toBe('auth.unauthenticated');
  });
  // C6-T16 implemented T5 previewReportTemplate (print.handlers.test.ts); the former "still a 501 stub" assertion is superseded there (LEAD-VISIBLE edit).
  it('T5 previewReportTemplate is no longer a 501 stub (C6-T16): fails closed without a request context', async () => {
    const noop = { info() {}, warn() {}, error() {} };
    const err = await rejection(manifest.handlers['previewReportTemplate']({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: 'previewReportTemplate', clientIp: '203.0.113.9', log: noop }));
    expect(err?.code).toBe('auth.unauthenticated');
  });
});

// ---------------------------------------------------------------------------------------------------------------- T1
describe('T1 listReportTemplates', () => {
  it('lists the tenant\'s templates only, with the OpenAPI summary keys and no tenant/audit columns', async () => {
    const t = e(T.list); const r = await run(T.list, t, { query: {} });
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.id).sort()).toEqual([TPL_PUB, TPL_DRAFT, TPL_BOTH, TPL_NARR, TPL_BAD_DRAFT].sort());
    for (const x of r.body.data) {
      expect(Object.keys(x).every((k) => KEYS_SUMMARY.includes(k)), JSON.stringify(Object.keys(x))).toBe(true);
      expect(Object.values(x).some((v) => v === null)).toBe(false);
    }
    expect(JSON.stringify(r.body)).not.toContain(TPL_B); expect(JSON.stringify(r.body)).not.toContain(TENANT_B);
    nothingWritten(t);
  });
  it('current_version_no is the published version and draft_version_no the draft; either is absent when there is none', async () => {
    const r = await run(T.list, e(T.list), { query: {} }); const by = (id: string) => r.body.data.find((x: any) => x.id === id);
    expect(by(TPL_PUB)).toMatchObject({ current_version_no: 1, version: 2 }); expect(by(TPL_PUB)).not.toHaveProperty('draft_version_no');
    expect(by(TPL_DRAFT)).toMatchObject({ draft_version_no: 1 }); expect(by(TPL_DRAFT)).not.toHaveProperty('current_version_no');
    expect(by(TPL_BOTH)).toMatchObject({ current_version_no: 1, draft_version_no: 2 });
  });
  it('filters by family; a hostile family value is rejected and cannot widen the tenant scope', async () => {
    const ids = async (query: any) => (await run(T.list, e(T.list), { query })).body.data.map((x: any) => x.id);
    expect(await ids({ family: 'narrative' })).toEqual([TPL_NARR]);
    expect((await ids({ family: 'laboratory' })).sort()).toEqual([TPL_PUB, TPL_DRAFT, TPL_BOTH, TPL_BAD_DRAFT].sort());
    for (const family of ["laboratory' OR tenant_id IS NOT NULL --", 'pathology', 7]) expect(await code(run(T.list, e(T.list), { query: { family } }))).toBe('common.validation_failed');
  });
  it('the SELECT carries an explicit tenant predicate bound to the context tenant (REQ-SEC-024)', async () => {
    const t = e(T.list); await run(T.list, t, { query: {} });
    const sel = t.db.reporting().filter((s) => /report_templates/.test(s.text)); expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) { expect(s.text).toMatch(/tenant_id\s*=\s*\$\d+/); expect(s.values).toContain(TENANT_A); }
  });
});

// ---------------------------------------------------------------------------------------------------------------- T2
describe('T2 createReportTemplate', () => {
  it('201 ReportTemplateDetail: draft v1 with the validated config (defaults filled), template version 1, ETag = version', async () => {
    const t = e(T.create); const r = await create(t, okBody());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ family: 'laboratory', name: 'Synthetic lab layout', version: 1, draft_version_no: 1, versions: [{ version_no: 1, status: 'draft' }] });
    expect(typeof r.body.is_active).toBe('boolean'); expect(r.body).not.toHaveProperty('current_version_no');
    expect(r.body.versions[0]).not.toHaveProperty('published_at');
    expect(r.body.draft.config).toEqual(expected(cfg('new'))); expect(typeof r.body.draft.version).toBe('number');
    expect(Object.keys(r.body).every((k) => KEYS_DETAIL.includes(k)), JSON.stringify(Object.keys(r.body))).toBe(true);
    expect(String(r.headers?.etag ?? r.headers?.ETag ?? '"1"')).toBe('"1"');
  });
  it('stores one template (tenant from ctx, no published version, not default) and one draft version row with a sha256', async () => {
    const t = e(T.create); const r = await create(t, okBody('Stored one'));
    const tpl = tplRows(t.db).find((x) => x['id'] === r.body.id)!; const vs = verRows(t.db, r.body.id);
    expect(tpl).toMatchObject({ tenant_id: TENANT_A, family: 'laboratory', name: 'Stored one', is_default: false, created_by: USER });
    expect(tpl['current_version_id'] ?? null).toBeNull();
    expect(vs).toHaveLength(1); expect(vs[0]).toMatchObject({ tenant_id: TENANT_A, version_no: 1, status: 'draft', created_by: USER });
    expect(vs[0]!['config_sha256']).toMatch(/^[0-9a-f]{64}$/); expect(storedConfig(vs[0]!)).toEqual(expected(cfg('new')));
    expect(vs[0]!['published_at'] ?? null).toBeNull();
  });
  it('config_sha256 is a function of the config: equal configs equal, different configs different', async () => {
    const a = e(T.create); const b = e(T.create);
    const [r1, r2, r3] = [await create(a, okBody('One', cfg('same'))), await create(a, okBody('Two', cfg('same'))), await create(b, okBody('Three', cfg('other')))];
    const sha = (t: ReturnType<typeof e>, id: string) => verRows(t.db, id)[0]!['config_sha256'];
    expect(sha(a, r1.body.id)).toBe(sha(a, r2.body.id)); expect(sha(b, r3.body.id)).not.toBe(sha(a, r1.body.id));
  });
  it('a narrative-family template is accepted', async () => {
    const t = e(T.create); expect((await create(t, { ...okBody(), family: 'narrative' })).body.family).toBe('narrative');
  });
  it.each([
    ['empty name', { name: '' }], ['81-char name', { name: 'n'.repeat(81) }], ['numeric name', { name: 7 }], ['missing name', { name: undefined }],
    ['unknown family', { family: 'pathology' }], ['missing family', { family: undefined }], ['unknown top-level field', { status: 'published' }],
    ['tenant_id smuggled in the body', { tenant_id: TENANT_B }],
  ])('rejects %s without writing', async (_n, over) => {
    const t = e(T.create); const b: any = { ...okBody(), ...over };
    expect(['common.validation_failed', 'reporting.template_invalid']).toContain(await code(create(t, b))); nothingWritten(t);
  });
  it('a name with SQL metacharacters is bound as a parameter, never spliced into a statement', async () => {
    const evil = "x'); DROP TABLE reporting.report_templates; --"; const t = e(T.create); const r = await create(t, okBody(evil));
    expect(r.body.name).toBe(evil); expect(t.db.stmts.some((s) => s.text.includes('DROP TABLE'))).toBe(false);
  });
});

describe('AC-13.3 TemplateConfig validation (T2 and T4): 422 reporting.template_invalid', () => {
  const longDisclaimer = 'D'.repeat(201);
  const withDisclaimer = (s: string) => ({ ...base(), disclaimers: [s] });
  it('a disclaimer line of 201 characters -> 422 reporting.template_invalid, the error names the field and never echoes the value', async () => {
    const t = e(T.create); const err = await rejection(create(t, okBody('x', withDisclaimer(longDisclaimer))));
    expect(err?.code).toBe('reporting.template_invalid'); expect(err.statusCode).toBe(422);
    expect(JSON.stringify(err.errors ?? [])).toMatch(/disclaimers\/0/); expect(JSON.stringify([err.errors, err.message, err.detail])).not.toContain(longDisclaimer);
    nothingWritten(t);
  });
  it('a disclaimer of exactly 200 characters is accepted (boundary)', async () => {
    const t = e(T.create); expect((await create(t, okBody('x', withDisclaimer('D'.repeat(200))))).status).toBe(201);
  });
  it('an unknown key -> 422 reporting.template_invalid (top level and nested)', async () => {
    for (const bad of [{ ...base(), watermark_url: 'x' }, { ...base(), qr: { ...base().qr, url: 'x' } }, { ...base(), page: { ...base().page, margin_mm: { ...base().page.margin_mm, extra: 1 } } }]) {
      const t = e(T.create); const err = await rejection(create(t, okBody('x', bad))); expect(err?.code).toBe('reporting.template_invalid'); expect(err.statusCode).toBe(422); nothingWritten(t);
    }
  });
  const hostile = (f: (c: any) => void) => { const c = base(); f(c); return c; };
  it.each([
    ['missing page', hostile((c) => { delete c.page; })],
    ['page size A3', hostile((c) => { c.page.size = 'A3'; })],
    ['top margin 4 mm', hostile((c) => { c.page.margin_mm.top = 4; })],
    ['left margin 41 mm', hostile((c) => { c.page.margin_mm.left = 41; })],
    ['letterhead asset as a URL (no URL fields: 07 A11)', hostile((c) => { c.letterhead.header_asset = 'http://169.254.169.254/latest/meta-data'; })],
    ['duplicate header field', hostile((c) => { c.header_fields = ['name', 'name']; })],
    ['unknown header field', hostile((c) => { c.header_fields = ['name', 'ssn']; })],
    ['QR size 40 mm', hostile((c) => { c.qr.size_mm = 40; })],
    ['watermark opacity 0.5', hostile((c) => { c.watermark = { text: 'DRAFT', opacity: 0.5 }; })],
    ['6 disclaimers', hostile((c) => { c.disclaimers = ['a', 'b', 'c', 'd', 'e', 'f']; })],
    ['signatories max 5', hostile((c) => { c.signatories.max = 5; })],
    ['font 12 pt', hostile((c) => { c.fonts.base_pt = 12; })],
    ['config null', null], ['config an array', [base()]], ['config a string', 'x'], ['config empty object', {}],
  ])('rejects %s', async (_n, config) => {
    const t = e(T.create); expect(await code(create(t, okBody('x', config)))).toBe('reporting.template_invalid'); nothingWritten(t);
    const t2 = e(T.draft); expect(await code(saveDraft(t2, TPL_DRAFT, config, 1))).toBe('reporting.template_invalid'); nothingWritten(t2);
  });
  it('a __proto__ key is rejected as an unknown key and pollutes nothing', async () => {
    const polluted = JSON.parse(`{"__proto__":{"polluted":"yes"},"page":${JSON.stringify(base().page)}}`);
    const t = e(T.create); expect(['reporting.template_invalid', 'common.validation_failed']).toContain(await code(create(t, okBody('x', polluted))));
    expect(({} as any).polluted).toBeUndefined(); nothingWritten(t);
  });
  it('T4 applies the same rules: 201-char disclaimer -> 422 and the stored draft is unchanged', async () => {
    const t = e(T.draft); const before = snap(verOf(t.db, TPL_DRAFT, 1));
    const err = await rejection(saveDraft(t, TPL_DRAFT, withDisclaimer(longDisclaimer), 1)); expect(err?.code).toBe('reporting.template_invalid'); expect(err.statusCode).toBe(422);
    nothingWritten(t); expect(verOf(t.db, TPL_DRAFT, 1)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------- T3
describe('T3 getReportTemplate', () => {
  it('published only: versions list with published_at, current_version_no, no draft', async () => {
    const t = e(T.get); const r = await get(t, TPL_PUB);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: TPL_PUB, family: 'laboratory', name: 'Published only', current_version_no: 1, version: 2 });
    expect(r.body.versions).toHaveLength(1); expect(r.body.versions[0]).toMatchObject({ version_no: 1, status: 'published' }); expect(typeof r.body.versions[0].published_at).toBe('string');
    expect(r.body).not.toHaveProperty('draft'); expect(r.body).not.toHaveProperty('draft_version_no');
    expect(String(r.headers?.etag ?? r.headers?.ETag)).toBe('"2"'); nothingWritten(t);
  });
  it('published + draft: both versions ascending, the draft with its config and version, draft versions carry no published_at', async () => {
    const r = await get(e(T.get), TPL_BOTH);
    expect(r.body).toMatchObject({ current_version_no: 1, draft_version_no: 2, version: 4 });
    expect(r.body.versions.map((v: any) => [v.version_no, v.status])).toEqual([[1, 'published'], [2, 'draft']]);
    expect(r.body.versions[1]).not.toHaveProperty('published_at');
    expect(r.body.draft.config).toEqual(CFG_V2); expect(typeof r.body.draft.version).toBe('number');
    expect(Object.keys(r.body).every((k) => KEYS_DETAIL.includes(k))).toBe(true);
  });
  it('a retired version is listed as retired', async () => {
    const s = seedAll(); const row = s.report_template_versions!.find((v) => v['template_id'] === TPL_BOTH && v['version_no'] === 1)!; row['status'] = 'retired';
    const r = await get(e(T.get, s), TPL_BOTH); expect(r.body.versions[0]).toMatchObject({ version_no: 1, status: 'retired' });
  });
  it('another tenant\'s template, an unknown id and a malformed id are all common.not_found', async () => {
    for (const id of [TPL_B, TPL_NONE, 'not-a-uuid', "x' OR 1=1 --", undefined, 42]) {
      const t = e(T.get); expect(await code(get(t, id))).toBe('common.not_found'); nothingWritten(t);
    }
  });
  it('every statement is tenant-scoped (REQ-SEC-024)', async () => {
    const t = e(T.get); await get(t, TPL_BOTH);
    for (const s of t.db.reporting()) { expect(s.text).toMatch(/tenant_id\s*=\s*\$\d+/); expect(s.values).toContain(TENANT_A); }
  });
});

// ---------------------------------------------------------------------------------------------------------------- T4
describe('T4 updateReportTemplateDraft', () => {
  it('updates the existing draft in place: same row, new config + sha, bumped versions; the published row is untouched', async () => {
    const t = e(T.draft); const pub = snap(verOf(t.db, TPL_BOTH, 1)); const shaBefore = verOf(t.db, TPL_BOTH, 2)!['config_sha256'];
    const r = await saveDraft(t, TPL_BOTH, cfg('edited'), 4);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: TPL_BOTH, version: 5, current_version_no: 1, draft_version_no: 2 });
    expect(r.body.draft.config).toEqual(expected(cfg('edited'))); expect(r.body.draft.version).toBeGreaterThan(3);
    expect(String(r.headers?.etag ?? r.headers?.ETag)).toBe('"5"');
    expect(verRows(t.db, TPL_BOTH)).toHaveLength(2); const d = verOf(t.db, TPL_BOTH, 2)!;
    expect(d).toMatchObject({ id: V(3, 2), status: 'draft', updated_by: USER }); expect(storedConfig(d)).toEqual(expected(cfg('edited'))); expect(d['config_sha256']).not.toBe(shaBefore);
    expect(tplOf(t.db, TPL_BOTH)['version']).toBe(5);
    expect(verOf(t.db, TPL_BOTH, 1)).toEqual(pub);   // published v1 byte-for-byte
  });
  it('with no draft, creates draft version_no = max + 1 and leaves the published version byte-for-byte unchanged', async () => {
    const t = e(T.draft); const pub = snap(verOf(t.db, TPL_PUB, 1));
    const r = await saveDraft(t, TPL_PUB, cfg('next'), 2);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ version: 3, current_version_no: 1, draft_version_no: 2 });
    expect(r.body.versions.map((v: any) => [v.version_no, v.status])).toEqual([[1, 'published'], [2, 'draft']]);
    expect(verRows(t.db, TPL_PUB)).toHaveLength(2); expect(verOf(t.db, TPL_PUB, 1)).toEqual(pub);
    expect(verOf(t.db, TPL_PUB, 2)).toMatchObject({ status: 'draft', tenant_id: TENANT_A, created_by: USER }); expect(storedConfig(verOf(t.db, TPL_PUB, 2)!)).toEqual(expected(cfg('next')));
    expect(tplOf(t.db, TPL_PUB)).toMatchObject({ version: 3, current_version_id: V(1, 1) });   // the live published version does not change until publish
  });
  it('a never-published template keeps no current version after a draft save', async () => {
    const t = e(T.draft); const r = await saveDraft(t, TPL_DRAFT, cfg('d2'), 1);
    expect(r.body).toMatchObject({ version: 2, draft_version_no: 1 }); expect(r.body).not.toHaveProperty('current_version_no'); expect(tplOf(t.db, TPL_DRAFT)['current_version_id'] ?? null).toBeNull();
  });
  it('If-Match is mandatory and optimistic: absent -> precondition_required, stale -> version_conflict, malformed/oversize -> 400; nothing written', async () => {
    const cases: Array<[unknown, string[]]> = [
      [NO_IFM, ['common.precondition_required']], [3, ['common.version_conflict']], [5, ['common.version_conflict']],
      [0, ['common.validation_failed', 'common.precondition_required']], ['abc', ['common.validation_failed', 'common.precondition_required']],
      ['2147483648', ['common.validation_failed']], ['99999999999999999999', ['common.validation_failed', 'common.precondition_required']],
    ];
    for (const [v, ok] of cases) { const t = e(T.draft); expect(ok, String(v)).toContain(await code(saveDraft(t, TPL_BOTH, cfg('x'), v))); nothingWritten(t); }
  });
  it('the body may carry only {config}: status/version_no/published fields are rejected and nothing is written', async () => {
    for (const body of [{ config: cfg('x'), status: 'published' }, { config: cfg('x'), version_no: 1 }, { config: cfg('x'), published_at: NOW_ISO }, { config: cfg('x'), tenant_id: TENANT_B }, {}, undefined]) {
      const t = e(T.draft); const pub = snap(verOf(t.db, TPL_BOTH, 1));
      expect(['common.validation_failed', 'reporting.template_invalid']).toContain(await code(run(T.draft, t, { params: { template_id: TPL_BOTH }, headers: ifm(4), body })));
      nothingWritten(t); expect(verOf(t.db, TPL_BOTH, 1)).toEqual(pub);
    }
  });
  it('another tenant\'s, an unknown and a malformed template id -> common.not_found; tenant B rows are untouched', async () => {
    for (const id of [TPL_B, TPL_NONE, 'not-a-uuid']) {
      const t = e(T.draft); const b = snap([tplOf(t.db, TPL_B), ...verRows(t.db, TPL_B)]);
      expect(await code(saveDraft(t, id, cfg('x'), 1))).toBe('common.not_found'); nothingWritten(t); expect([tplOf(t.db, TPL_B), ...verRows(t.db, TPL_B)]).toEqual(b);
    }
  });
  it('two saves racing on the same If-Match: exactly one wins, the loser gets version_conflict, still one draft row', async () => {
    const t = e(T.draft); const res = await Promise.allSettled([saveDraft(t, TPL_BOTH, cfg('r1'), 4), saveDraft(t, TPL_BOTH, cfg('r2'), 4)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult; expect(lost.reason?.code).toBe('common.version_conflict');
    expect(verRows(t.db, TPL_BOTH).filter((v) => v['status'] === 'draft')).toHaveLength(1);
  });
  it('a lost race on the unique draft index (23505) surfaces as version_conflict, not a 500', async () => {
    const t = e(T.draft, seedAll(), {}); const orig = t.db.tx.query.bind(t.db.tx);
    (t.db.tx as any).query = async (text: string, values: unknown[] = []) => { if (/insert\s+into\s+reporting\.report_template_versions/i.test(text)) throw pgError('23505', 'duplicate key'); return orig(text, values); };
    expect(['common.version_conflict', 'common.conflict']).toContain(await code(saveDraft(t, TPL_PUB, cfg('x'), 2)));
  });
});
const NOW_ISO = '2026-11-07T12:00:00.000Z';

// ---------------------------------------------------------------------------------------------------------------- T6 + AC-13.2
describe('T6 publishReportTemplate and AC-13.2 (published versions are immutable)', () => {
  it('first publish: the draft becomes published (published_at/by set), becomes the current version, no draft remains', async () => {
    const t = e(T.publish); const before = storedConfig(verOf(t.db, TPL_DRAFT, 1)!);
    const r = await publish(t, TPL_DRAFT, 1);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: TPL_DRAFT, current_version_no: 1, version: 2 });
    expect(r.body).not.toHaveProperty('draft'); expect(r.body).not.toHaveProperty('draft_version_no');
    expect(r.body.versions).toHaveLength(1); expect(r.body.versions[0]).toMatchObject({ version_no: 1, status: 'published' }); expect(typeof r.body.versions[0].published_at).toBe('string');
    expect(String(r.headers?.etag ?? r.headers?.ETag)).toBe('"2"');
    const v = verOf(t.db, TPL_DRAFT, 1)!; expect(v).toMatchObject({ status: 'published', published_by: USER }); expect(v['published_at']).toBeTruthy(); expect(storedConfig(v)).toEqual(before);
    expect(tplOf(t.db, TPL_DRAFT)).toMatchObject({ current_version_id: v['id'], version: 2 });
  });
  it('AC-13.2: publishing a second time creates a new immutable version; the previous published one is retired and keeps its exact config', async () => {
    const t = e(T.publish); const v1 = snap(verOf(t.db, TPL_BOTH, 1)); const draftCfg = snap(storedConfig(verOf(t.db, TPL_BOTH, 2)!));
    const r = await publish(t, TPL_BOTH, 4);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ current_version_no: 2, version: 5 }); expect(r.body).not.toHaveProperty('draft');
    expect(r.body.versions.map((v: any) => [v.version_no, v.status])).toEqual([[1, 'retired'], [2, 'published']]);
    const [o, n] = [verOf(t.db, TPL_BOTH, 1)!, verOf(t.db, TPL_BOTH, 2)!];
    expect(o['id']).toBe(v1['id']); expect(storedConfig(o)).toEqual(storedConfig(v1 as any)); expect(o['config_sha256']).toBe(v1['config_sha256']); expect(o['status']).toBe('retired');
    expect(o['published_at']).toBe(v1['published_at']);   // retiring does not rewrite history
    expect(n).toMatchObject({ id: V(3, 2), status: 'published', published_by: USER }); expect(storedConfig(n)).toEqual(draftCfg);
    expect(verRows(t.db, TPL_BOTH).filter((v) => v['status'] === 'published')).toHaveLength(1);
    expect(verRows(t.db, TPL_BOTH).filter((v) => v['status'] === 'draft')).toHaveLength(0);
    expect(tplOf(t.db, TPL_BOTH)).toMatchObject({ current_version_id: V(3, 2), version: 5 });
  });
  it('after a publish the next edit starts a NEW draft; the just-published version is never edited', async () => {
    const t = e(T.publish); await publish(t, TPL_BOTH, 4); const pub2 = snap(verOf(t.db, TPL_BOTH, 2));
    const r = await run(T.draft, t, { params: { template_id: TPL_BOTH }, headers: ifm(5), body: { config: cfg('after') } });
    expect(r.body).toMatchObject({ current_version_no: 2, draft_version_no: 3 });
    expect(r.body.versions.map((v: any) => [v.version_no, v.status])).toEqual([[1, 'retired'], [2, 'published'], [3, 'draft']]);
    expect(verOf(t.db, TPL_BOTH, 2)).toEqual(pub2);
  });
  it('If-Match is mandatory and optimistic; a stale or missing one changes nothing (the previous published stays published)', async () => {
    for (const [v, ok] of [[NO_IFM, 'common.precondition_required'], [3, 'common.version_conflict'], [6, 'common.version_conflict'], ['2147483648', 'common.validation_failed']] as Array<[unknown, string]>) {
      const t = e(T.publish); expect(await code(publish(t, TPL_BOTH, v)), String(v)).toBe(ok); nothingWritten(t);
      expect(verOf(t.db, TPL_BOTH, 1)!['status']).toBe('published'); expect(verOf(t.db, TPL_BOTH, 2)!['status']).toBe('draft');
    }
  });
  it('nothing to publish (published only, no draft) is rejected without a write', async () => {
    const t = e(T.publish); expect(['reporting.template_invalid', 'common.version_conflict', 'common.not_found']).toContain(await code(publish(t, TPL_PUB, 2))); nothingWritten(t);
  });
  it('a stored draft that is not valid TemplateConfig cannot be published: 422 template_invalid, the live published version stays live', async () => {
    const t = e(T.publish); const err = await rejection(publish(t, TPL_BAD_DRAFT, 3));
    expect(err?.code).toBe('reporting.template_invalid'); expect(err.statusCode).toBe(422); expect(JSON.stringify([err.errors, err.message])).not.toContain('x'.repeat(201));
    nothingWritten(t); expect(verOf(t.db, TPL_BAD_DRAFT, 1)!['status']).toBe('published'); expect(verOf(t.db, TPL_BAD_DRAFT, 2)!['status']).toBe('draft');
    expect(storedConfig(verOf(t.db, TPL_BAD_DRAFT, 2)!)).toEqual(CFG_BAD);
  });
  it('another tenant\'s, an unknown and a malformed template id -> common.not_found; tenant B untouched', async () => {
    for (const id of [TPL_B, TPL_NONE, 'not-a-uuid']) {
      const t = e(T.publish); const b = snap([tplOf(t.db, TPL_B), ...verRows(t.db, TPL_B)]);
      expect(await code(publish(t, id, 1))).toBe('common.not_found'); nothingWritten(t); expect([tplOf(t.db, TPL_B), ...verRows(t.db, TPL_B)]).toEqual(b);
    }
  });
  it('two publishes racing on the same If-Match: exactly one wins, one published row, no row mutated twice', async () => {
    const t = e(T.publish); const res = await Promise.allSettled([publish(t, TPL_BOTH, 4), publish(t, TPL_BOTH, 4)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason?.code).toMatch(/^(common\.version_conflict|reporting\.template_invalid|common\.not_found)$/);
    expect(verRows(t.db, TPL_BOTH).filter((v) => v['status'] === 'published')).toHaveLength(1); expect(tplOf(t.db, TPL_BOTH)['version']).toBe(5);
  });
  it('a lost race on the unique published index (23505) is version_conflict, not a 500', async () => {
    const t = e(T.publish); const orig = t.db.tx.query.bind(t.db.tx);
    (t.db.tx as any).query = async (text: string, values: unknown[] = []) => { if (/update\s+reporting\.report_template_versions[\s\S]*published/i.test(text) && !/retired/i.test(text) && /published_at/i.test(text)) throw pgError('23505', 'duplicate key'); return orig(text, values); };
    expect(['common.version_conflict', 'common.conflict']).toContain(await code(publish(t, TPL_BOTH, 4)));
  });
  it('publishing never touches rows of other templates or the narrative family', async () => {
    const t = e(T.publish); const others = snap([...verRows(t.db, TPL_PUB), ...verRows(t.db, TPL_NARR), tplOf(t.db, TPL_PUB), tplOf(t.db, TPL_NARR)]);
    await publish(t, TPL_BOTH, 4); expect([...verRows(t.db, TPL_PUB), ...verRows(t.db, TPL_NARR), tplOf(t.db, TPL_PUB), tplOf(t.db, TPL_NARR)]).toEqual(others);
  });
  it('never writes a report_versions row and never deletes anything (lims_app has no DELETE grant)', async () => {
    const t = e(T.publish); await publish(t, TPL_BOTH, 4);
    expect(t.db.writes().some((s) => /report_versions\b/.test(s.text.replace(/report_template_versions/g, '')))).toBe(false);
    expect(t.db.stmts.some((s) => s.verb === 'delete')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------- frozen versions for renders (E24)
describe('renders use the frozen template version (done_when; 03-APP-FLOW E24)', () => {
  const REPORT_VERSION = idN(0xa001);
  const seedWithRenderedReport = () => seedAll({ report_versions: [{ tenant_id: TENANT_A, id: REPORT_VERSION, report_id: idN(0x0e01), status: 'released', template_version_id: V(3, 1) }] });
  const sctx = (t: ReturnType<typeof e>) => t.hctx;

  it('a report version rendered against v1 still resolves v1\'s exact config after v2 is published; new renders resolve v2', async () => {
    const t = e(T.publish, seedWithRenderedReport()); const svc = createTemplatesService();
    const frozenBefore = await svc.getVersionById(sctx(t), { templateVersionId: V(3, 1) });
    await publish(t, TPL_BOTH, 4);
    const frozenAfter = await svc.getVersionById(sctx(t), { templateVersionId: V(3, 1) });
    expect(frozenAfter.config).toEqual(frozenBefore.config); expect(frozenAfter.config).toEqual(expected(CFG_V1)); expect(frozenAfter.status).toBe('retired');
    expect(t.db.store['report_versions']![0]!['template_version_id']).toBe(V(3, 1));   // the released report still points at v1
    const live = await svc.resolvePublishedVersion(sctx(t), { templateId: TPL_BOTH });
    expect(live).toMatchObject({ templateVersionId: V(3, 2), versionNo: 2 }); expect(live.config).toEqual(expected(CFG_V2));
  });
  it('before the second publish, new renders still resolve the published v1 (a saved draft is never rendered)', async () => {
    const t = e(T.draft, seedWithRenderedReport()); const svc = createTemplatesService();
    await saveDraft(t, TPL_BOTH, cfg('unpublished'), 4);
    expect(await svc.resolvePublishedVersion(sctx(t), { templateId: TPL_BOTH })).toMatchObject({ templateVersionId: V(3, 1), versionNo: 1 });
  });
  it('a draft version id is not a frozen version: it cannot be resolved for a render', async () => {
    const svc = createTemplatesService(); const t = e(T.get);
    expect(['common.not_found', 'reporting.template_invalid']).toContain(await code(svc.getVersionById(sctx(t), { templateVersionId: V(3, 2) })));
  });
  it('version lookups are tenant-scoped: another tenant\'s or an unknown version id is common.not_found', async () => {
    const svc = createTemplatesService();
    for (const id of [idN(0x9b01), idN(0x9fff), 'not-a-uuid']) { const t = e(T.get); expect(await code(svc.getVersionById(sctx(t), { templateVersionId: id }))).toBe('common.not_found'); }
    const t = e(T.get); expect(await code(svc.resolvePublishedVersion(sctx(t), { templateId: TPL_B }))).toBe('common.not_found');
  });
  it('the lookups are read-only', async () => {
    const svc = createTemplatesService(); const t = e(T.get); await svc.getVersionById(sctx(t), { templateVersionId: V(3, 1) }); await svc.resolvePublishedVersion(sctx(t), { templateId: TPL_PUB });
    nothingWritten(t);
  });
});
