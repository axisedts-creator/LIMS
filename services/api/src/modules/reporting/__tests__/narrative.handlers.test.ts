// C6-T17 — narrative engine, API side: templates N8-N10, list/get N1-N2, draft save N3 (server-side sanitise), sign N4, amendment N5, N7 P-10 conditional
// permission (02-TRD §6.4 rows N1-N10, §4.1 narrative_ready; 01-PRD AC-05.1, 05.2, 05.4-05.7 (05.3 is C6-T11); 07-SECURITY REQ-SEC-088, T8).
// Integration level: the REAL manifest handlers over the in-memory fakes of outsourced.helpers.ts; ports are fakes on ctx.ports.{IdentityPort,CatalogPort}.
// ASSUMED (spec gives no more; see .orchestra/notes/C6-T17-tests.md): request shape { params, query, headers:{'if-match':'"<n>"'}, body } like O1-O4; If-Match is the
// narrative_reports.version; N3/N4/N5 bump it and echo it as `version` + ETag; stored version sections are [{key, heading, html}] per 05-SCHEMA §2.12 (heading copied from the template at draft/save time, so signed versions are frozen; legacy rows without heading fall back to the template);
// the first draft is created lazily by N2 when none exists (the order consumer is another task); N4/N5 call IdentityPort.assertRole({permission:'reporting.narrative.sign',
// centreId}) in the handler path as defence-in-depth over the pipeline's privileged/aal2 gate; sign enqueues reporting.assemble_report (key assemble:<report_id>).
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { BUCKET, TENANT_B, pgError, rejection, sha256 } from './outsourced.helpers.js';
import { pngBytes } from './narrative-image.helpers.js';
import {
  CENTRE_1, DANGEROUS, ITEM_1, MEM, NARR_1, NARR_B, NARR_SIGNED, NOW, REPORT_1, SAFE_HTML, SECTIONS, TEST_NAME, TEST_XRAY, TENANT_A, TPL_B, TPL_KIND, TPL_TEST, USER, XSS_CORPUS,
  asJson, env, idN, ifm, imageRow, narrativeRow, seedAll, signedV1, storedIds, storedSections, templates, versionRow, versionsOf,
} from './narrative.helpers.js';

let manifest: any;
beforeAll(async () => {
  const k = join(mkdtempSync(join(tmpdir(), 'c6-t17-')), 'otp.key'); writeFileSync(k, Buffer.alloc(32, 7));
  process.env.LIMS_CORE_ENV = 'dev'; delete process.env.NODE_ENV; delete process.env.LIMS_REPORTING_ALLOW_REAL_PROVIDERS; process.env.LIMS_REPORTING_OTP_HMAC_KEY_FILE = k;
  manifest = (await import('../index.js')).manifest;
});

const N = { list: 'listNarrativeReports', get: 'getNarrativeReport', save: 'saveNarrativeDraft', sign: 'signNarrativeReport', amend: 'startNarrativeAmendment',
  tList: 'listNarrativeTemplates', tCreate: 'createNarrativeTemplate', tUpdate: 'updateNarrativeTemplate', img: 'getNarrativeImageContent' } as const;
const run = (op: string, t: ReturnType<typeof e>, req: { params?: unknown; query?: unknown; headers?: unknown; body?: unknown }) =>
  manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, t.hctx);
const e = (op: string, seed = seedAll(), over: Record<string, unknown> = {}) => env(op, manifest, seed, over);
const body = (html: string, key = 'findings') => ({ sections: [{ key, html }], images: [] });
const full = (f = '<p>Synthetic finding.</p>', i = '<p>Synthetic impression.</p>') => ({ sections: [{ key: 'findings', html: f }, { key: 'impression', html: i }], images: [] });
const NO_IFM = Symbol('no-if-match'); // explicit "send no If-Match header" (JS default params would swallow `undefined`)
const save = (t: ReturnType<typeof e>, b: unknown, id: unknown = NARR_1, v: unknown = 1) => run(N.save, t, { params: { narrative_id: id }, headers: v === NO_IFM ? {} : ifm(v), body: b });
const sign = (t: ReturnType<typeof e>, id: unknown = NARR_1, v: unknown = 1) => run(N.sign, t, { params: { narrative_id: id }, headers: v === NO_IFM ? {} : ifm(v) });
const amend = (t: ReturnType<typeof e>, b: unknown = { reason_code: 'transcription_error' }, id: unknown = NARR_SIGNED, v: unknown = 3) =>
  run(N.amend, t, { params: { narrative_id: id }, headers: v === NO_IFM ? {} : ifm(v), body: b });
const code = async (p: Promise<unknown>) => (await rejection(p))?.code;
const nothingWritten = (t: ReturnType<typeof e>) => { expect(t.db.writes()).toHaveLength(0); expect(t.db.jobs).toHaveLength(0); };
const allHtml = (r: any) => JSON.stringify(r.body.current_version.sections.map((s: any) => s.html));
const NARR_2 = idN(0x3003); const NARR_NEW = idN(0x3004); const NARR_KIND = idN(0x3005); const ITEM_2 = idN(0x1105);
const narrRow = (id: string, o: Record<string, unknown> = {}) => ({ tenant_id: TENANT_A, id, centre_id: CENTRE_1, report_id: REPORT_1, order_id: idN(0x0d01), order_item_id: ITEM_1, test_id: TEST_XRAY, template_kind: 'xray', status: 'draft', current_version_no: 1, signed_version_no: null, version: 1, created_by: USER, updated_by: USER, ...o });
const withNarratives = (extra: any[], versions: any[] = []) => { const s = seedAll(); s.narrative_reports = [...s.narrative_reports!, ...extra]; s.narrative_versions = [...s.narrative_versions!, ...versions]; return s; };

// ---------------------------------------------------------------------------------------------------------------- wiring
describe('N1-N5 and N8-N10 are no longer 501 stubs', () => {
  it.each(Object.values(N).filter((o) => o !== N.img))('%s fails closed without a request context', async (op) => {
    const noop = { info() {}, warn() {}, error() {} };
    const err = await rejection(manifest.handlers[op]({ params: {}, query: {}, headers: {}, body: undefined }, { operationId: op, clientIp: '203.0.113.9', log: noop }));
    expect(err?.code).toBe('auth.unauthenticated');
  });
});

// ---------------------------------------------------------------------------------------------------------------- N8-N10 templates
describe('N8 listNarrativeTemplates', () => {
  it('lists the tenant\'s templates only, with the OpenAPI NarrativeTemplate keys and no tenant/audit columns', async () => {
    const t = e(N.tList); const r = await run(N.tList, t, { query: {} });
    expect(r.status).toBe(200); expect(r.body.data.map((x: any) => x.id).sort()).toEqual([TPL_KIND, TPL_TEST].sort());
    for (const x of r.body.data) {
      expect(Object.keys(x).every((k) => ['id', 'code', 'name', 'kind', 'test_id', 'sections', 'is_active', 'version'].includes(k)), JSON.stringify(Object.keys(x))).toBe(true);
      expect(Object.values(x).some((v) => v === null)).toBe(false);
    }
    expect(JSON.stringify(r.body)).not.toContain(TPL_B);
  });
  it('filters by kind, test_id and is_active', async () => {
    const s = seedAll(); s.narrative_templates!.push({ ...templates()[1]!, id: idN(0x5003), code: 'USG_ABD', kind: 'usg' }, { ...templates()[1]!, id: idN(0x5004), code: 'OLD', is_active: false });
    const ids = async (query: any) => (await run(N.tList, e(N.tList, s), { query })).body.data.map((x: any) => x.id).sort();
    expect(await ids({ kind: 'usg' })).toEqual([idN(0x5003)]);
    expect(await ids({ test_id: TEST_XRAY })).toEqual([TPL_TEST]);
    expect(await ids({ is_active: false })).toEqual([idN(0x5004)]);
    expect(await ids({ kind: 'xray', is_active: true })).toEqual([TPL_KIND, TPL_TEST].sort());
  });
  it('a hostile filter value cannot widen the tenant scope', async () => {
    const t = e(N.tList); const r = await rejection(run(N.tList, t, { query: { kind: "xray' OR tenant_id IS NOT NULL --" } }));
    expect(['common.validation_failed']).toContain(r?.code);
  });
});

describe('N9 createNarrativeTemplate', () => {
  const ok = (o: Record<string, unknown> = {}) => ({ code: 'XRAY_KNEE', name: 'Synthetic knee', kind: 'xray', sections: [{ key: 'findings', heading: 'Findings', required: true, default_html: '<p></p>' }], ...o });
  const create = (t: ReturnType<typeof e>, b: unknown) => run(N.tCreate, t, { body: b });
  it('201 NarrativeTemplate: tenant from ctx, version 1, active, created_by the actor; ETag = version', async () => {
    const t = e(N.tCreate); const r = await create(t, ok({ test_id: TEST_XRAY }));
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ code: 'XRAY_KNEE', name: 'Synthetic knee', kind: 'xray', test_id: TEST_XRAY, is_active: true, version: 1 });
    expect(r.body.sections).toEqual([{ key: 'findings', heading: 'Findings', required: true, default_html: '<p></p>' }]);
    const row = t.db.store['narrative_templates']!.find((x) => x['code'] === 'XRAY_KNEE')!; expect(row).toMatchObject({ tenant_id: TENANT_A, created_by: USER });
    expect(String(r.headers?.etag ?? r.headers?.ETag ?? '"1"')).toBe('"1"');
  });
  it('default_html is sanitised before it is stored and returned (it is pre-filled into every draft)', async () => {
    const t = e(N.tCreate); const dirty = '<p>KEEP-ME</p><img src=x onerror=alert(1)><script>alert(1)</script>';
    const r = await create(t, ok({ sections: [{ key: 'findings', heading: 'Findings', required: true, default_html: dirty }] }));
    expect(JSON.stringify(r.body)).not.toMatch(DANGEROUS); expect(JSON.stringify(r.body)).toContain('KEEP-ME');
    expect(JSON.stringify(t.db.store['narrative_templates']!.find((x) => x['code'] === 'XRAY_KNEE')!['sections'])).not.toMatch(DANGEROUS);
  });
  const sec = (o: Record<string, unknown> = {}) => ({ key: 'a', heading: 'A', required: false, default_html: '', ...o });
  it.each([
    ['lowercase code', ok({ code: 'xray_knee' })], ['33-char code', ok({ code: 'A'.repeat(33) })], ['empty name', ok({ name: '' })], ['121-char name', ok({ name: 'n'.repeat(121) })],
    ['unknown kind', ok({ kind: 'mri' })], ['no sections', ok({ sections: [] })], ['13 sections', ok({ sections: Array.from({ length: 13 }, (_, i) => sec({ key: `k${i}` })) })],
    ['duplicate section keys', ok({ sections: [sec(), sec()] })], ['81-char heading', ok({ sections: [sec({ heading: 'h'.repeat(81) })] })],
    ['5001-char default_html', ok({ sections: [sec({ default_html: 'x'.repeat(5001) })] })], ['required not boolean', ok({ sections: [sec({ required: 'yes' })] })],
    ['41-char section key', ok({ sections: [sec({ key: 'k'.repeat(41) })] })], ['unknown top-level field', ok({ tenant_id: TENANT_B })], ['body not an object', 'x'],
  ])('%s -> 400/422, nothing persisted', async (_n, b) => {
    const t = e(N.tCreate); expect(['reporting.template_invalid', 'common.validation_failed']).toContain(await code(create(t, b)));
    expect(t.db.writes()).toHaveLength(0);
  });
  it('a duplicate code in the tenant is refused (unique tenant_id+code), not a 500', async () => {
    const t = e(N.tCreate); expect(['reporting.template_invalid', 'common.validation_failed', 'common.conflict']).toContain(await code(create(t, ok({ code: 'XRAY_CHEST' }))));
  });
  it('the same code in ANOTHER tenant does not collide', async () => {
    const t = e(N.tCreate); const r = await create(t, ok({ code: 'XRAY_B' })); expect(r.status).toBe(201);
  });
  it('a test_id of another tenant / unknown test is refused', async () => {
    const t = e(N.tCreate); t.ctx.ports.CatalogPort.getTest = async () => { throw Object.assign(new Error('nf'), { code: 'common.not_found' }); };
    const err = await rejection(create(t, ok({ test_id: idN(0x7fff) }))); expect(err).toBeTruthy(); expect(t.db.writes()).toHaveLength(0);
  });
});

describe('N10 updateNarrativeTemplate', () => {
  const patch = (t: ReturnType<typeof e>, b: unknown, id: unknown = TPL_TEST, v: unknown = 1) => run(N.tUpdate, t, { params: { narrative_template_id: id }, headers: v === NO_IFM ? {} : ifm(v), body: b });
  it('200: renames, toggles is_active, replaces sections; version + 1; sanitises default_html', async () => {
    const t = e(N.tUpdate); const r = await patch(t, { name: 'Renamed', is_active: false, sections: [{ key: 'findings', heading: 'Findings', required: true, default_html: '<p>KEEP-ME</p><script>alert(1)</script>' }] });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: TPL_TEST, name: 'Renamed', is_active: false, version: 2 });
    expect(JSON.stringify(r.body)).not.toMatch(DANGEROUS); expect(t.db.store['narrative_templates']!.find((x) => x['id'] === TPL_TEST)!['version']).toBe(2);
  });
  it('existing drafts keep their stored sections when the template changes', async () => {
    const t = e(N.tUpdate); const before = JSON.stringify(versionsOf(t.db, NARR_1)); expect((await patch(t, { sections: [{ key: 'only', heading: 'Only', required: true, default_html: '' }] })).status).toBe(200);
    expect(JSON.stringify(versionsOf(t.db, NARR_1))).toBe(before);
  });
  it('missing If-Match -> 428; stale -> 409 version_conflict; malformed / overflowing -> 400, never 500', async () => {
    expect(await code(patch(e(N.tUpdate), { name: 'x' }, TPL_TEST, NO_IFM))).toBe('common.precondition_required');
    expect(await code(patch(e(N.tUpdate), { name: 'x' }, TPL_TEST, 7))).toBe('common.version_conflict');
    for (const v of ['abc', '0', '99999999999']) expect(await code(run(N.tUpdate, e(N.tUpdate), { params: { narrative_template_id: TPL_TEST }, headers: { 'if-match': v === 'abc' ? 'abc' : `"${v}"` }, body: { name: 'x' } }))).toBe('common.validation_failed');
  });
  it('BOLA: another tenant\'s template -> 404 and nothing is changed', async () => {
    const t = e(N.tUpdate); expect(await code(patch(t, { name: 'x' }, TPL_B))).toBe('common.not_found'); expect(t.db.store['narrative_templates']!.find((x) => x['id'] === TPL_B)!['name']).toBe('Synthetic XRAY_B');
  });
  it.each([['code is immutable', { code: 'NEW_CODE' }], ['kind is immutable', { kind: 'usg' }], ['tenant_id', { tenant_id: TENANT_B }], ['empty sections', { sections: [] }], ['duplicate keys', { sections: [{ key: 'a', heading: 'A', required: true }, { key: 'a', heading: 'B', required: false }] }]])('%s -> refused', async (_n, b) => {
    const t = e(N.tUpdate); expect(['common.validation_failed', 'reporting.template_invalid']).toContain(await code(patch(t, b))); expect(t.db.writes()).toHaveLength(0);
  });
  it('two concurrent updates with the same If-Match: exactly one wins', async () => {
    const t = e(N.tUpdate); const rs = await Promise.allSettled([patch(t, { name: 'A1' }), patch(t, { name: 'B2' })]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect((rs.find((x) => x.status === 'rejected') as any).reason.code).toBe('common.version_conflict');
  });
});

// ---------------------------------------------------------------------------------------------------------------- N1 / N2 + AC-05.1
describe('N1 listNarrativeReports', () => {
  it('lists this tenant\'s narratives as NarrativeReportSummary rows (test_name from CatalogPort), never another tenant\'s', async () => {
    const t = e(N.list); const r = await run(N.list, t, { query: {} });
    expect(r.status).toBe(200); expect(r.body.data.map((x: any) => x.id).sort()).toEqual([NARR_1, NARR_SIGNED].sort()); expect(r.body.page).toBeDefined();
    const row = r.body.data.find((x: any) => x.id === NARR_1); expect(row).toMatchObject({ order_item_id: ITEM_1, test_id: TEST_XRAY, test_name: TEST_NAME, template_kind: 'xray', status: 'draft', current_version_no: 1, version: 1 });
    expect(JSON.stringify(r.body)).not.toContain(NARR_B);
    for (const x of r.body.data) expect(Object.keys(x).every((k) => ['id', 'order_item_id', 'test_id', 'test_name', 'template_kind', 'status', 'current_version_no', 'updated_at', 'version'].includes(k)), JSON.stringify(Object.keys(x))).toBe(true);
  });
  it('filters by status, template_kind and centre_id', async () => {
    const ids = async (query: any) => (await run(N.list, e(N.list), { query })).body.data.map((x: any) => x.id);
    expect(await ids({ status: 'signed' })).toEqual([NARR_SIGNED]); expect(await ids({ status: 'draft' })).toEqual([NARR_1]); expect(await ids({ template_kind: 'usg' })).toEqual([]);
    expect(await ids({ centre_id: idN(0xc9) })).toEqual([]);
  });
});

describe('AC-05.1 — opening a narrative gives a draft pre-filled from the test\'s template', () => {
  const open = (t: ReturnType<typeof e>, id: string) => run(N.get, t, { params: { narrative_id: id } });
  it('no draft yet: N2 returns draft v1 with the template\'s sections (headings in order) and default_html, and persists it', async () => {
    const t = e(N.get, withNarratives([narrRow(NARR_NEW)])); const r = await open(t, NARR_NEW);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: NARR_NEW, status: 'draft', test_name: TEST_NAME, template_kind: 'xray', current_version: { version_no: 1, status: 'draft', template_id: TPL_TEST } });
    expect(r.body.current_version.sections.map((s: any) => [s.key, s.heading])).toEqual(SECTIONS.map((s) => [s.key, s.heading]));
    expect(r.body.current_version.sections.find((s: any) => s.key === 'technique').html).toBe('<p>PA view.</p>');
    const rows = versionsOf(t.db, NARR_NEW); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, version_no: 1, status: 'draft', template_id: TPL_TEST });
    expect(t.catalogCalls).toHaveLength(1);
  });
  it('opening twice does not create a second draft', async () => {
    const t = e(N.get, withNarratives([narrRow(NARR_NEW)])); await open(t, NARR_NEW); await open(t, NARR_NEW); expect(versionsOf(t.db, NARR_NEW)).toHaveLength(1);
  });
  it('concurrent first opens create exactly one draft', async () => {
    const t = e(N.get, withNarratives([narrRow(NARR_NEW)])); await Promise.allSettled([open(t, NARR_NEW), open(t, NARR_NEW), open(t, NARR_NEW)]); expect(versionsOf(t.db, NARR_NEW)).toHaveLength(1);
  });
  it('the test-specific template wins over the generic one of the same kind; the generic one is used when no template is bound to the test', async () => {
    const t = e(N.get, withNarratives([narrRow(NARR_KIND, { test_id: idN(0x7002), order_item_id: idN(0x1106) })]));
    expect((await open(t, NARR_KIND)).body.current_version.template_id).toBe(TPL_KIND);
  });
  it('an inactive template and another tenant\'s template are never used', async () => {
    const s = withNarratives([narrRow(NARR_NEW)]); s.narrative_templates = s.narrative_templates!.map((x) => (x['id'] === TPL_TEST ? { ...x, is_active: false } : x));
    const r = await open(e(N.get, s), NARR_NEW); expect(r.body.current_version.template_id).toBe(TPL_KIND); expect(JSON.stringify(r.body)).not.toContain(TPL_B);
  });
  it('an existing draft is returned as saved, with headings from its template', async () => {
    const r = await open(e(N.get), NARR_1); expect(r.body.current_version.sections).toEqual([{ key: 'findings', heading: 'Findings', html: '<p>Synthetic finding.</p>' }, { key: 'impression', heading: 'Impression', html: '<p>Synthetic impression.</p>' }]);
    expect(r.body.history).toEqual([{ version_no: 1, status: 'draft' }]);
  });
  it('response keys are exactly the OpenAPI NarrativeReport keys: no tenant, audit, hash or null values', async () => {
    const r = await open(e(N.get), NARR_SIGNED);
    expect(Object.keys(r.body).every((k) => ['id', 'order_item_id', 'test_id', 'test_name', 'template_kind', 'status', 'current_version', 'history', 'version'].includes(k)), JSON.stringify(Object.keys(r.body))).toBe(true);
    expect(Object.keys(r.body.current_version).every((k) => ['version_no', 'status', 'template_id', 'sections', 'images', 'signed_by', 'signed_at', 'amendment_reason_code'].includes(k))).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/tenant_id|content_sha256|created_by|centre_id/); expect(JSON.stringify(r.body)).not.toContain('null');
    expect(r.headers?.etag).toBe(`"${r.body.version}"`);
  });
  it.each([['another tenant', NARR_B], ['unknown', idN(0xdead)], ['not a uuid', "1' OR '1'='1"], ['number', 5]])('BOLA / bad id: %s -> 404 common.not_found, nothing written', async (_n, id) => {
    const t = e(N.get); expect(await code(open(t, id as string))).toBe('common.not_found'); nothingWritten(t);
  });
});

// ---------------------------------------------------------------------------------------------------------------- N3 + AC-05.2
describe('AC-05.2 / REQ-SEC-088 — saveNarrativeDraft sanitises server-side (XSS corpus)', () => {
  it.each(XSS_CORPUS)('%s: stripped from the stored html AND from the response; the safe text survives', async (_n, dirty) => {
    const t = e(N.save); const r = await save(t, body(dirty));
    expect(r.status).toBe(200); expect(allHtml(r)).not.toMatch(DANGEROUS);
    const stored = JSON.stringify(storedSections(versionsOf(t.db, NARR_1)[0]!)); expect(stored).not.toMatch(DANGEROUS);
    if (dirty.includes('KEEP-ME') && !/<(noscript|math)/i.test(dirty)) expect(allHtml(r)).toContain('KEEP-ME');
    expect(stored).toBe(JSON.stringify(r.body.current_version.sections.map((s: any) => ({ key: s.key, heading: s.heading, html: s.html }))));   // what is shown is what is stored
  });
  it('the sanitiser keeps the clinical formatting allowlist (p, strong, em, ul/ol/li, br, table)', async () => {
    const html = `${SAFE_HTML}<p>line<br>two</p><ol><li>x</li></ol><table><tbody><tr><td>cell</td></tr></tbody></table>`;
    const r = await save(e(N.save), body(html)); const out = r.body.current_version.sections[0].html;
    for (const frag of ['<p>', '<strong>finding</strong>', '<em>emphasis</em>', '<ul>', '<li>one</li>', '<br>', '<ol>', '<table>', '<td>cell</td>']) expect(out, frag).toContain(frag);
  });
  it('sanitising is idempotent: saving the returned html again returns the same html', async () => {
    const t = e(N.save); const first = await save(t, body(XSS_CORPUS.map((c) => c[1]).join('')));
    const again = await save(t, { sections: first.body.current_version.sections.map((s: any) => ({ key: s.key, html: s.html })), images: [] }, NARR_1, first.body.version);
    expect(again.body.current_version.sections).toEqual(first.body.current_version.sections);
  });
  it('a hostile section is neutralised in EVERY section of one save, not just the first', async () => {
    const r = await save(e(N.save), full('<img src=x onerror=alert(1)><p>one</p>', '<script>alert(2)</script><p>two</p>')); expect(allHtml(r)).not.toMatch(DANGEROUS); expect(allHtml(r)).toContain('one'); expect(allHtml(r)).toContain('two');
  });
  it('plain text, entities and unicode are not mangled (no double-encoding)', async () => {
    const r = await save(e(N.save), body('<p>5 &lt; 6 &amp; नमस्ते — ≥ 3 mm</p>')); expect(r.body.current_version.sections[0].html).toBe('<p>5 &lt; 6 &amp; नमस्ते — ≥ 3 mm</p>');
  });
  it('a draft may be saved incomplete (required sections empty is only an error at sign)', async () => {
    const r = await save(e(N.save), body('<p>Only findings.</p>')); expect(r.status).toBe(200);
  });
  it('narrative text never reaches the logs or metric labels', async () => {
    const t = e(N.save); expect((await save(t, body('<p>SENTINEL-Narr-Text</p>'))).status).toBe(200); expect(JSON.stringify({ l: t.logs, m: t.metrics })).not.toContain('SENTINEL-Narr-Text');
  });
});

describe('N3 saveNarrativeDraft — contract, versioning, concurrency, isolation', () => {
  it('200: the narrative version moves 1 -> 2 (body, ETag and DB agree) and the draft row carries the sections in order; actor recorded', async () => {
    const t = e(N.save); const r = await save(t, full('<p>F</p>', '<p>I</p>'));
    expect(r.body.version).toBe(2); expect(r.headers?.etag).toBe('"2"'); expect(narrativeRow(t.db, NARR_1)['version']).toBe(2);
    expect(storedSections(versionsOf(t.db, NARR_1)[0]!)).toEqual([{ key: 'findings', heading: 'Findings', html: '<p>F</p>' }, { key: 'impression', heading: 'Impression', html: '<p>I</p>' }]);
    expect(versionsOf(t.db, NARR_1)[0]!['updated_by']).toBe(USER);
  });
  it('missing If-Match -> 428; stale -> 409 version_conflict; malformed/overflowing -> 400 (never a 500 from the integer column); nothing written', async () => {
    const t = e(N.save); expect(await code(save(t, body('<p>x</p>'), NARR_1, NO_IFM))).toBe('common.precondition_required');
    expect(await code(save(t, body('<p>x</p>'), NARR_1, 9))).toBe('common.version_conflict');
    for (const v of ['"abc"', '"0"', '"99999999999"']) expect(await code(run(N.save, t, { params: { narrative_id: NARR_1 }, headers: { 'if-match': v }, body: body('<p>x</p>') }))).toBe('common.validation_failed');
    nothingWritten(t);
  });
  it('two concurrent saves with the same If-Match: exactly one wins, the other is 409 version_conflict, the stored draft is one of the two', async () => {
    const t = e(N.save); const rs = await Promise.allSettled([save(t, body('<p>AAA</p>')), save(t, body('<p>BBB</p>'))]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect((rs.find((x) => x.status === 'rejected') as any).reason.code).toBe('common.version_conflict');
    expect(JSON.stringify(storedSections(versionsOf(t.db, NARR_1)[0]!))).toMatch(/AAA|BBB/);
  });
  it('a signed narrative is locked: 409 reporting.narrative_locked, nothing changes (AC-05.5)', async () => {
    const t = e(N.save); const before = JSON.stringify(versionsOf(t.db, NARR_SIGNED));
    expect(await code(save(t, body('<p>tamper</p>'), NARR_SIGNED, 3))).toBe('reporting.narrative_locked'); nothingWritten(t); expect(JSON.stringify(versionsOf(t.db, NARR_SIGNED))).toBe(before);
  });
  it('the lock holds even when If-Match is stale, absent or the body is hostile (no information or write path around it)', async () => {
    for (const v of [99, 3]) { const t = e(N.save); const c = await code(save(t, body('<script>alert(1)</script>'), NARR_SIGNED, v)); expect(['reporting.narrative_locked', 'common.version_conflict']).toContain(c); nothingWritten(t); }
  });
  it('while amending, a save goes to the new draft; the signed version stays byte-identical', async () => {
    const t = e(N.amend); const a = await amend(t); const signedBefore = JSON.stringify(versionsOf(t.db, NARR_SIGNED)[0]);
    const r = await save(t, body('<p>Corrected finding.</p>'), NARR_SIGNED, a.body.version);
    expect(r.status).toBe(200); expect(r.body.current_version).toMatchObject({ version_no: 2, status: 'draft' }); expect(JSON.stringify(versionsOf(t.db, NARR_SIGNED)[0])).toBe(signedBefore);
  });
  it.each([
    ['unknown section key', { sections: [{ key: 'not_in_template', html: '<p>x</p>' }], images: [] }], ['duplicate section key', { sections: [{ key: 'findings', html: 'a' }, { key: 'findings', html: 'b' }], images: [] }],
    ['html not a string', { sections: [{ key: 'findings', html: 5 }], images: [] }], ['html > 20000 chars', body('x'.repeat(20001))], ['key > 40 chars', { sections: [{ key: 'k'.repeat(41), html: 'x' }], images: [] }],
    ['13 sections', { sections: Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, html: 'x' })), images: [] }], ['extra section field', { sections: [{ key: 'findings', html: 'x', heading: 'H' }], images: [] }],
    ['extra top-level field', { ...body('x'), status: 'signed' }], ['status smuggled', { ...body('x'), signed_by: MEM }], ['no images array', { sections: [] }], ['body null', null], ['13 images', { sections: [], images: Array.from({ length: 13 }, (_, i) => ({ image_id: idN(0x9000 + i) })) }],
    ['caption > 200', { sections: [], images: [{ image_id: idN(0x9001), caption: 'c'.repeat(201) }] }], ['image_id not a uuid', { sections: [], images: [{ image_id: "x'; DROP TABLE" }] }],
    ['template_id not a uuid', { ...body('x'), template_id: 'nope' }],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, b) => {
    const t = e(N.save); expect(await code(save(t, b))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('template_id of another tenant / unknown / inactive -> 400, nothing written', async () => {
    for (const id of [TPL_B, idN(0x5fff)]) { const t = e(N.save); expect(await code(save(t, { ...body('<p>x</p>'), template_id: id }))).toBe('common.validation_failed'); nothingWritten(t); }
  });
  it('a valid template_id of the tenant is accepted and recorded', async () => {
    const t = e(N.save); const r = await save(t, { ...body('<p>x</p>'), template_id: TPL_KIND }); expect(r.body.current_version.template_id).toBe(TPL_KIND); expect(versionsOf(t.db, NARR_1)[0]!['template_id']).toBe(TPL_KIND);
  });
  it.each([['another tenant', NARR_B], ['unknown', idN(0xdead)], ['not a uuid', "1' OR '1'='1"]])('BOLA / bad id: %s -> 404, nothing written', async (_n, id) => {
    const t = e(N.save); expect(await code(save(t, body('<p>x</p>'), id as string))).toBe('common.not_found'); nothingWritten(t);
  });
  it('every reporting statement carries the tenant of the context (no cross-tenant read or write)', async () => {
    const t = e(N.save); await save(t, body('<p>x</p>')); const st = t.db.reporting(); expect(st.length).toBeGreaterThan(1);
    for (const s of st) { expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A); }
  });
  it('a DB failure mid-save surfaces as an error and leaves no half-written draft', async () => {
    const t = e(N.save, seedAll(), {}); t.db.tx.query = (async (text: string) => { throw pgError('08006', 'connection lost'); }) as any;
    await rejection(save(t, body('<p>x</p>'))); expect(JSON.stringify(storedSections(versionsOf(t.db, NARR_1)[0]!))).not.toContain('<p>x</p>');
  });
});

describe('N3 images — captions live on the narrative_image rows; only this narrative\'s ready images can be attached', () => {
  const IMG = idN(0xa001); const IMG2 = idN(0xa002);
  const ready = (id: string, o: Record<string, unknown> = {}) => imageRow({ id, state: 'ready', ...o });
  const imgs = (a: any[]) => ({ sections: [], images: a });
  it('attaches ready images in the given order and stores the caption on the input_files row', async () => {
    const t = e(N.save, seedAll({ input_files: [ready(IMG), ready(IMG2)] })); const r = await save(t, imgs([{ image_id: IMG2, caption: 'Second' }, { image_id: IMG, caption: 'First' }]));
    expect(r.body.current_version.images).toEqual([{ image_id: IMG2, caption: 'Second' }, { image_id: IMG, caption: 'First' }]);
    expect(storedIds(versionsOf(t.db, NARR_1)[0]!['image_file_ids'])).toEqual([IMG2, IMG]); expect(t.db.file(IMG)!.caption).toBe('First');
  });
  it.each([['an image of another narrative', { narrative_report_id: NARR_SIGNED }], ['an outsourced pdf row', { kind: 'outsourced_pdf', narrative_report_id: null }],
    ['an image of another tenant', { tenant_id: TENANT_B, narrative_report_id: NARR_B }]])('%s -> 400 common.validation_failed, nothing attached', async (_n, o) => {
    const t = e(N.save, seedAll({ input_files: [ready(IMG, o as any)] })); expect(await code(save(t, imgs([{ image_id: IMG }])))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it.each(['quarantined', 'rejected', 'withdrawn'])('a %s image can never be attached', async (state) => {
    const t = e(N.save, seedAll({ input_files: [ready(IMG, { state })] })); expect(await code(save(t, imgs([{ image_id: IMG }])))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('an unknown image id and a duplicate image id are refused', async () => {
    const t = e(N.save, seedAll({ input_files: [ready(IMG)] })); expect(await code(save(t, imgs([{ image_id: idN(0xa0ff) }])))).toBe('common.validation_failed');
    expect(await code(save(t, imgs([{ image_id: IMG }, { image_id: IMG }])))).toBe('common.validation_failed');
  });
});

// ---------------------------------------------------------------------------------------------------------------- N4 + AC-05.4/5.5/5.7
describe('AC-05.4 — sign with an empty required section: 422 reporting.narrative_incomplete, nothing changes', () => {
  const seedWith = (sections: unknown[]) => { const s = seedAll(); s.narrative_versions = [versionRow(NARR_1, 1, { sections }), signedV1()]; return s; };
  it.each([
    ['empty <p>', [{ key: 'findings', html: '<p></p>' }, { key: 'impression', html: '<p>I</p>' }]], ['whitespace only', [{ key: 'findings', html: '   \n\t ' }, { key: 'impression', html: '<p>I</p>' }]],
    ['nbsp only', [{ key: 'findings', html: '<p>&nbsp; &nbsp;</p>' }, { key: 'impression', html: '<p>I</p>' }]], ['only <br>', [{ key: 'findings', html: '<p><br></p>' }, { key: 'impression', html: '<p>I</p>' }]],
    ['required section absent', [{ key: 'impression', html: '<p>I</p>' }]], ['all sections empty', []],
    ['markup that sanitises to nothing', [{ key: 'findings', html: '<script>alert(1)</script><img src=x onerror=alert(1)>' }, { key: 'impression', html: '<p>I</p>' }]],
  ])('%s', async (_n, sections) => {
    const t = e(N.sign, seedWith(sections)); const before = JSON.stringify(t.db.store['narrative_versions']);
    expect(await code(sign(t))).toBe('reporting.narrative_incomplete'); nothingWritten(t); expect(JSON.stringify(t.db.store['narrative_versions'])).toBe(before); expect(narrativeRow(t.db, NARR_1)['status']).toBe('draft');
    expect(t.db.item(ITEM_1)!.narrative_ready).toBe(false);
  });
  it('optional sections may stay empty', async () => {
    const t = e(N.sign, seedWith([{ key: 'clinical_history', html: '' }, { key: 'findings', html: '<p>F</p>' }, { key: 'impression', html: '<p>I</p>' }])); expect((await sign(t)).status).toBe(200);
  });
});

describe('AC-05.5 — sign: version signed, signatory recorded, item ready, edits locked', () => {
  it('200: version signed with signer = the actor\'s membership, signed_at, 64-hex content hash; narrative signed; response shows it', async () => {
    const t = e(N.sign); const r = await sign(t);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: NARR_1, status: 'signed', version: 2, current_version: { version_no: 1, status: 'signed', signed_by: MEM, signed_at: NOW } });
    const v = versionsOf(t.db, NARR_1)[0]!; expect(v).toMatchObject({ status: 'signed', signed_by_membership_id: MEM }); expect(v['content_sha256']).toMatch(/^[0-9a-f]{64}$/); expect(String(v['signed_at'])).toContain('2026-11-07');
    expect(narrativeRow(t.db, NARR_1)).toMatchObject({ status: 'signed', signed_version_no: 1, version: 2 }); expect(r.headers?.etag).toBe('"2"'); expect(JSON.stringify(r.body)).not.toContain('content_sha256');
  });
  it('the content hash covers the content: different sections -> different hash', async () => {
    const a = e(N.sign); await sign(a); const s = seedAll(); s.narrative_versions = [versionRow(NARR_1, 1, { sections: [{ key: 'findings', html: '<p>OTHER</p>' }, { key: 'impression', html: '<p>I</p>' }] }), signedV1()];
    const b = e(N.sign, s); await sign(b); expect(versionsOf(a.db, NARR_1)[0]!['content_sha256']).not.toBe(versionsOf(b.db, NARR_1)[0]!['content_sha256']);
  });
  it('readiness hook: the item becomes narrative_ready, the report is flagged and exactly one deduped assemble job is queued', async () => {
    const t = e(N.sign); await sign(t); expect(t.db.item(ITEM_1)!.narrative_ready).toBe(true); expect(t.db.report(REPORT_1)!.needs_assembly).toBe(true);
    const jobs = t.db.jobsOf('reporting.assemble_report'); expect(jobs).toHaveLength(1); expect(jobs[0]!.jobKey).toBe(`assemble:${REPORT_1}`); expect(JSON.stringify(jobs[0]!.payload)).toContain(REPORT_1); expect(JSON.stringify(jobs[0]!.payload)).toContain(TENANT_A);
  });
  it('an item with two narratives is ready only when BOTH are signed', async () => {
    const s = withNarratives([narrRow(NARR_2, { test_id: idN(0x7002) })], [versionRow(NARR_2, 1)]); const t = e(N.sign, s);
    await sign(t, NARR_1); expect(t.db.item(ITEM_1)!.narrative_ready).toBe(false);
    await sign(t, NARR_2); expect(t.db.item(ITEM_1)!.narrative_ready).toBe(true);
  });
  it('after signing, every edit path is locked: save and a second sign -> 409 reporting.narrative_locked', async () => {
    const t = e(N.sign); const r = await sign(t); const w = t.db.writes().length;
    expect(await code(save(t, body('<p>x</p>'), NARR_1, r.body.version))).toBe('reporting.narrative_locked'); expect(await code(sign(t, NARR_1, r.body.version))).toBe('reporting.narrative_locked'); expect(t.db.writes()).toHaveLength(w);
  });
  it('signing an already-signed narrative changes nothing and queues no second assembly', async () => {
    const t = e(N.sign); expect(await code(sign(t, NARR_SIGNED, 3))).toBe('reporting.narrative_locked'); nothingWritten(t);
  });
  it('the signed narrative is frozen incl. headings: an N10 heading rename after sign does not change what N2 returns for the signed version (05-SCHEMA §2.12 {key, heading, html})', async () => {
    const t = e(N.sign); const saved = await save(t, full(), NARR_1, 1); const signed = await sign(t, NARR_1, saved.body.version); expect(signed.body.status).toBe('signed');
    const renamed = SECTIONS.map((s) => ({ key: s.key, heading: `RENAMED ${s.heading}`, required: s.required, default_html: s.default_html }));
    expect((await run(N.tUpdate, t, { params: { narrative_template_id: TPL_TEST }, headers: ifm(1), body: { sections: renamed } })).status).toBe(200);
    const r = await run(N.get, t, { params: { narrative_id: NARR_1 } });
    expect(r.body.current_version).toMatchObject({ status: 'signed' }); expect(r.body.current_version.sections.map((s: any) => [s.key, s.heading])).toEqual([['findings', 'Findings'], ['impression', 'Impression']]);
    expect(JSON.stringify(r.body)).not.toContain('RENAMED');
    expect(storedSections(versionsOf(t.db, NARR_1).at(-1)!).map((s: any) => s.heading)).toEqual(['Findings', 'Impression']);
  });
  it('two concurrent signs: exactly one succeeds, one assemble job, one signature', async () => {
    const t = e(N.sign); const rs = await Promise.allSettled([sign(t), sign(t)]);
    expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect(['common.version_conflict', 'reporting.narrative_locked']).toContain((rs.find((x) => x.status === 'rejected') as any).reason.code);
    expect(t.db.jobsOf('reporting.assemble_report')).toHaveLength(1);
  });
  it('a save racing a sign never leaves content that was not the signed content', async () => {
    const t = e(N.sign); const rs = await Promise.allSettled([sign(t), save(t, full('<p>RACE</p>', '<p>RACE</p>'))]);
    expect(rs.some((x) => x.status === 'fulfilled' && (x.value as any).status === 200)).toBe(true);
    const v = versionsOf(t.db, NARR_1)[0]!; if (v['status'] === 'signed') { expect(rs[0]!.status).toBe('fulfilled'); }
    expect(rs.filter((x) => x.status === 'fulfilled').length).toBeLessThanOrEqual(1 + (v['status'] === 'signed' ? 0 : 1));
  });
  it('missing If-Match -> 428; stale -> 409 version_conflict; overflow -> 400; nothing written', async () => {
    const t = e(N.sign); expect(await code(sign(t, NARR_1, NO_IFM))).toBe('common.precondition_required'); expect(await code(sign(t, NARR_1, 5))).toBe('common.version_conflict');
    expect(await code(run(N.sign, t, { params: { narrative_id: NARR_1 }, headers: { 'if-match': '"99999999999"' } }))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it.each([['another tenant', NARR_B], ['unknown', idN(0xdead)], ['not a uuid', "1' OR '1'='1"]])('BOLA / bad id: %s -> 404, no write, no assembly', async (_n, id) => {
    const t = e(N.sign); expect(await code(sign(t, id as string))).toBe('common.not_found'); nothingWritten(t);
  });
  it('every reporting statement carries the tenant of the context', async () => {
    const t = e(N.sign); expect((await sign(t)).status).toBe(200); expect(t.db.reporting().length).toBeGreaterThan(2); for (const s of t.db.reporting()) { expect(s.text, s.text).toMatch(/tenant_id/); expect(s.values, s.text).toContain(TENANT_A); }
  });
  it('the sign access-log entry report.narrative_sign (entity narrative_version) is written once, without narrative text (CR-C6-008)', async () => {
    const t = e(N.sign); await sign(t); const rows = t.access.filter((a) => a['action'] === 'report.narrative_sign'); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: 'narrative_version', outcome: 'allowed' }); expect(JSON.stringify(rows[0])).not.toContain('Synthetic finding');
  });
});

describe('AC-05.7 — only a narrative signer at aal2 may sign / amend', () => {
  const readFile = (rel: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../..', rel), 'utf8');
  it('contract: N4/N5 require reporting.narrative.sign; N4 lists auth.mfa_required; the permission is privileged (=> aal2 at the pipeline)', () => {
    const api = readFile('contracts/openapi/reporting.yaml');
    for (const op of ['signNarrativeReport', 'startNarrativeAmendment']) { const i = api.indexOf(`operationId: ${op}`); expect(i).toBeGreaterThan(0); expect(api.slice(i, i + 400)).toContain('x-permission: reporting.narrative.sign'); }
    const i = api.indexOf('operationId: signNarrativeReport'); expect(api.slice(i, i + 900)).toContain('auth.mfa_required');
    expect(readFile('contracts/permissions.yaml')).toMatch(/code:\s*reporting\.narrative\.sign,\s*privileged:\s*true/);
    for (const op of ['saveNarrativeDraft', 'getNarrativeReport', 'listNarrativeReports', 'listNarrativeTemplates']) { const j = api.indexOf(`operationId: ${op}`); expect(api.slice(j, j + 400)).toContain('x-permission: reporting.narrative.write'); }
  });
  it.each([['N4 sign', (t: any) => sign(t)], ['N5 amend', (t: any) => amend(t)]])('%s asks IdentityPort.assertRole for reporting.narrative.sign at the narrative\'s centre', async (_n, call) => {
    const t = e(N.sign); await call(t); expect(t.roleCalls).toContainEqual({ permission: 'reporting.narrative.sign', centreId: CENTRE_1 });
  });
  it.each([['auth.forbidden'], ['auth.mfa_required']])('assertRole rejects with %s -> same code, nothing changes (sign and amend)', async (c) => {
    for (const call of [(t: any) => sign(t, NARR_1, 1), (t: any) => amend(t)]) {
      const t = e(N.sign); t.denied.error = () => Object.assign(new Error(c), { code: c }); expect(await code(call(t))).toBe(c); nothingWritten(t);
      expect(narrativeRow(t.db, NARR_1)['status']).toBe('draft'); expect(t.db.item(ITEM_1)!.narrative_ready).toBe(false);
    }
  });
  it('a user who may only WRITE (not sign) can still save drafts: save does not require the sign permission', async () => {
    const t = e(N.save); t.denied.error = () => Object.assign(new Error('x'), { code: 'auth.forbidden' }); expect((await save(t, body('<p>x</p>'))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------- N5 + AC-05.6
describe('AC-05.6 — amendment of a signed narrative', () => {
  it('201: a new draft v2 is created from v1 with the reason; v1 stays signed and untouched; narrative is amending', async () => {
    const t = e(N.amend); const v1 = JSON.stringify(versionsOf(t.db, NARR_SIGNED)[0]); const r = await amend(t, { reason_code: 'transcription_error', reason_text: 'Synthetic: wrong side typed.' });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ id: NARR_SIGNED, status: 'amending', version: 4, current_version: { version_no: 2, status: 'draft', amendment_reason_code: 'transcription_error' } });
    expect(r.body.current_version.sections.map((s: any) => [s.key, s.html])).toEqual([['findings', '<p>Synthetic finding.</p>'], ['impression', '<p>Synthetic impression.</p>']]);
    expect(r.body.history).toEqual([{ version_no: 1, status: 'signed', signed_at: '2026-11-07T10:00:00.000Z' }, { version_no: 2, status: 'draft' }]);
    const rows = versionsOf(t.db, NARR_SIGNED); expect(rows).toHaveLength(2); expect(JSON.stringify(rows[0])).toBe(v1);
    expect(rows[1]).toMatchObject({ tenant_id: TENANT_A, version_no: 2, status: 'draft', amendment_of_version_no: 1, amendment_reason_code: 'transcription_error', amendment_reason_text: 'Synthetic: wrong side typed.', signed_by_membership_id: null });
    expect(narrativeRow(t.db, NARR_SIGNED)).toMatchObject({ status: 'amending', current_version_no: 2, signed_version_no: 1, version: 4 }); expect(r.headers?.etag).toBe('"4"');
  });
  it('the amendment copies the template reference and the image list of v1', async () => {
    const IMG = idN(0xa101); const s = seedAll({ input_files: [imageRow({ id: IMG, state: 'ready', narrative_report_id: NARR_SIGNED })] });
    s.narrative_versions = [versionRow(NARR_1, 1), signedV1(NARR_SIGNED, { image_file_ids: [IMG] })]; const t = e(N.amend, s); const r = await amend(t);
    expect(r.body.current_version.template_id).toBe(TPL_TEST); expect(r.body.current_version.images.map((i: any) => i.image_id)).toEqual([IMG]);
  });
  it('signing the amendment: v2 signed (reason kept), v1 superseded, narrative signed at v2, item ready again, assembly queued (-> amended report version)', async () => {
    const t = e(N.amend); const a = await amend(t); const s = await sign(t, NARR_SIGNED, a.body.version);
    expect(s.status).toBe(200); expect(s.body).toMatchObject({ status: 'signed', current_version: { version_no: 2, status: 'signed', signed_by: MEM, amendment_reason_code: 'transcription_error' } });
    expect(s.body.history.map((h: any) => [h.version_no, h.status])).toEqual([[1, 'superseded'], [2, 'signed']]);
    const [v1, v2] = versionsOf(t.db, NARR_SIGNED); expect(v1).toMatchObject({ status: 'superseded', content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }); expect(v2).toMatchObject({ status: 'signed', signed_by_membership_id: MEM, amendment_of_version_no: 1, amendment_reason_code: 'transcription_error' });
    expect(narrativeRow(t.db, NARR_SIGNED)).toMatchObject({ status: 'signed', signed_version_no: 2, current_version_no: 2 });
    expect(t.db.jobsOf('reporting.assemble_report')).toHaveLength(1); expect(t.db.jobsOf('reporting.assemble_report')[0]!.jobKey).toBe(`assemble:${REPORT_1}`); expect(t.db.report(REPORT_1)!.needs_assembly).toBe(true);
  });
  it('an amendment is signed only when complete (AC-05.4 applies to v2 as well)', async () => {
    const t = e(N.amend); const a = await amend(t); const b = await save(t, { sections: [{ key: 'findings', html: '<p></p>' }], images: [] }, NARR_SIGNED, a.body.version);
    expect(await code(sign(t, NARR_SIGNED, b.body.version))).toBe('reporting.narrative_incomplete'); expect(narrativeRow(t.db, NARR_SIGNED)['status']).toBe('amending');
  });
  it('a second amendment while one is open is refused (no parallel drafts); a draft narrative cannot be amended: 409 common.immutable_record', async () => {
    const t = e(N.amend); const a = await amend(t); expect(await code(amend(t, { reason_code: 'clinical_correction' }, NARR_SIGNED, a.body.version))).toBe('common.immutable_record'); expect(versionsOf(t.db, NARR_SIGNED)).toHaveLength(2);
    const d = e(N.amend); expect(await code(amend(d, { reason_code: 'transcription_error' }, NARR_1, 1))).toBe('common.immutable_record'); nothingWritten(d);
  });
  it('two concurrent amendments: exactly one v2 row', async () => {
    const t = e(N.amend); const rs = await Promise.allSettled([amend(t), amend(t)]); expect(rs.filter((x) => x.status === 'fulfilled')).toHaveLength(1); expect(versionsOf(t.db, NARR_SIGNED)).toHaveLength(2);
  });
  it.each([['unknown reason code', { reason_code: 'because' }], ['missing reason', {}], ['reason_text > 500', { reason_code: 'transcription_error', reason_text: 'x'.repeat(501) }],
    ['reason_text not a string', { reason_code: 'transcription_error', reason_text: 7 }], ['extra field', { reason_code: 'transcription_error', status: 'signed' }], ['body null', null], ['reason_code with SQL', { reason_code: "x' OR '1'='1" }]])('%s -> 400 common.validation_failed, nothing written', async (_n, b) => {
    const t = e(N.amend); expect(await code(amend(t, b))).toBe('common.validation_failed'); nothingWritten(t);
  });
  it('a tenant-defined narrative_amend_reasons code is accepted; one from another tenant is not', async () => {
    const s = seedAll({ cs_reasons: [{ tenant_id: TENANT_A, id: idN(0xc501), set_name: 'narrative_amend_reasons', code: 'tenant_reason', display: 'T', sort_order: 1 }, { tenant_id: TENANT_B, id: idN(0xc502), set_name: 'narrative_amend_reasons', code: 'b_reason', display: 'B', sort_order: 1 }] });
    expect((await amend(e(N.amend, s), { reason_code: 'tenant_reason' })).status).toBe(201); expect(await code(amend(e(N.amend, s), { reason_code: 'b_reason' }))).toBe('common.validation_failed');
  });
  it('missing If-Match -> 428; stale -> 409; BOLA -> 404', async () => {
    const t = e(N.amend); expect(await code(amend(t, { reason_code: 'transcription_error' }, NARR_SIGNED, NO_IFM))).toBe('common.precondition_required'); expect(await code(amend(t, { reason_code: 'transcription_error' }, NARR_SIGNED, 1))).toBe('common.version_conflict');
    expect(await code(amend(t, { reason_code: 'transcription_error' }, NARR_B, 1))).toBe('common.not_found'); nothingWritten(t);
  });
});

// ---------------------------------------------------------------------------------------------------------------- N7 P-10
describe('N7 getNarrativeImageContent — P-10: + reporting.narrative.write while the image belongs to a draft / amending version', () => {
  const IMG_D = idN(0xb001); const IMG_S = idN(0xb002); const IMG_AM = idN(0xb003);
  const PNG = pngBytes({ width: 4, height: 4 });
  function world7() {
    const f = (id: string, narrative: string) => { const r = imageRow({ id, state: 'ready', narrative_report_id: narrative }); r.sanitized_object_path = `${TENANT_A}/narrative-images/2026/11/${id}.png`; r.sanitized_sha256 = sha256(PNG); r.detected_mime = 'image/png'; return r; };
    const s = seedAll({ input_files: [f(IMG_D, NARR_1), f(IMG_S, NARR_SIGNED), f(IMG_AM, NARR_SIGNED)] });
    s.narrative_versions = [versionRow(NARR_1, 1, { image_file_ids: [IMG_D] }), signedV1(NARR_SIGNED, { image_file_ids: [IMG_S, IMG_AM] }), versionRow(NARR_SIGNED, 2, { image_file_ids: [IMG_AM], amendment_of_version_no: 1, amendment_reason_code: 'transcription_error' })];
    s.narrative_reports = s.narrative_reports!.map((n) => (n['id'] === NARR_SIGNED ? { ...n, status: 'amending', current_version_no: 2 } : n));
    const t = e(N.img, s); for (const id of [IMG_D, IMG_S, IMG_AM]) t.storage.objects.set(`${BUCKET}::${TENANT_A}/narrative-images/2026/11/${id}.png`, PNG); return t;
  }
  const get = (t: ReturnType<typeof e>, id: string) => run(N.img, t, { params: { image_id: id } });
  const writeCalls = (t: ReturnType<typeof e>) => t.roleCalls.filter((c) => c.permission === 'reporting.narrative.write');
  it('an image of a draft version needs reporting.narrative.write at the narrative\'s centre (checked after loading the target)', async () => {
    const t = world7(); const r = await get(t, IMG_D); expect(r.status).toBe(200); expect(writeCalls(t)).toContainEqual({ permission: 'reporting.narrative.write', centreId: CENTRE_1 });
  });
  it('denied (auth.forbidden / auth.mfa_required): no bytes read, no access-log row', async () => {
    for (const c of ['auth.forbidden', 'auth.mfa_required']) { const t = world7(); t.denied.error = () => Object.assign(new Error(c), { code: c }); expect(await code(get(t, IMG_D))).toBe(c); expect(t.storage.reads()).toHaveLength(0); expect(t.access).toHaveLength(0); }
  });
  it('an image that is also in an open amendment draft still needs narrative.write', async () => {
    const t = world7(); t.denied.error = () => Object.assign(new Error('x'), { code: 'auth.forbidden' }); expect(await code(get(t, IMG_AM))).toBe('auth.forbidden');
  });
  it('an image only in a signed / superseded version is readable with report.read alone (no narrative.write check)', async () => {
    const t = world7(); t.denied.error = () => Object.assign(new Error('x'), { code: 'auth.forbidden' }); const r = await get(t, IMG_S);
    expect(r.status).toBe(200); expect(writeCalls(t)).toHaveLength(0); expect(t.access).toHaveLength(1);
  });
  it('an uploaded image not yet attached to any version of a draft narrative is treated as draft (narrative.write required)', async () => {
    const t = world7(); const id = idN(0xb004); const r = imageRow({ id, state: 'ready', narrative_report_id: NARR_1 }); r.sanitized_object_path = `${TENANT_A}/narrative-images/2026/11/${id}.png`; r.detected_mime = 'image/png'; t.db.store['input_files']!.push(r);
    t.storage.objects.set(`${BUCKET}::${r.sanitized_object_path}`, PNG); t.denied.error = () => Object.assign(new Error('x'), { code: 'auth.forbidden' }); expect(await code(get(t, id))).toBe('auth.forbidden');
  });
});
