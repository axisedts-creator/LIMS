// C11.T-24 — observability + audit access events (02-TRD §12; 06-PLAN T-24; 08 A13 P-3; 08 A17 D-53; 07-SECURITY REQ-SEC-045/096/097/098/133, §5.6 log scan).
// Two layers:
//   (1) STATIC scans of the module's own non-test source (comments stripped): the CI string-literal rule (P-3), "exactly the six D-53 codes", operation -> action -> entityType,
//       metric presence (names, label keys, enum values), metric names known to the core registry, consistency with the C1 alert rules, no PHI-bearing identifiers in log calls.
//   (2) BEHAVIOURAL runs of the REAL handlers A2 lookupAnatomicObject / A3 getAnatomicCase on in-memory repos with PLANTED PHI: one access row per success (none on not_found),
//       `lims_anatomic_lookup_total{result}`, and a log-scan proving no accession no / label / history text / patient name reaches a log line or a metric label.
// SEAMS (spec fixes behaviour; names chosen here — the writer follows or disputes):
//   * metrics reach the services as `hctx.metrics.inc(name, labels?)` / `hctx.metrics.observe(name, seconds, labels?)` (as image.service / intake.service already do; optional chaining allowed).
//   * lookup: ONE `lims_anatomic_lookup_total` increment per A2 call, result = case|block|slide|not_found (the object_kind of the hit). No access row on not_found (TRD §12 "success only").
//   * cases_created_total{case_kind}: emitted where a case row is created (service/**). signouts_total{version_kind}: R3 + R10 (+ the amendment/revision sign-out paths). submit_failures_total{error_code}:
//     emitted before a port error is rethrown (the code is the propagated `lab.*` / `anatomic.*` code, never a message). image_processing_seconds: histogram, no labels (observe(name, seconds)).
//   * image_processing_total outcome `failed` (dead-lettered re-scan) is emitted by the worker task source (anatomic.process_image) or service/** — any non-test file under the module.
//   * every lims_anatomic_* name must be declared in core/observability/metrics.ts DEFS (the registry THROWS on an unknown name/label) — C0 owns that file: the writer raises a CR (see notes).
//   * alert rules: C1 already transcribed 02-TRD §12 into infra/monitoring/rules/anatomic.rules.yml (read-only here); every lims_anatomic_* metric it queries must be emitted by this module.
// Fails now: metrics cases_created / signouts / submit_failures / lookup / image_processing_seconds / outcome `failed` are not emitted; the core registry lacks every lims_anatomic_* name.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { REQUIRED_METRICS } from '../../../core/observability/metrics.js';

type Row = Record<string, any>;

// ============================================================================================================ static source helpers
const MODULE_DIR = fileURLToPath(new URL('..', import.meta.url));
const RULES_FILE = fileURLToPath(new URL('../../../../../../infra/monitoring/rules/anatomic.rules.yml', import.meta.url));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' || n === 'node_modules' ? [] : walk(p);
    return /\.ts$/.test(n) && !/\.(test|spec)\.ts$/.test(n) ? [p] : [];
  });
}
const SRC = walk(MODULE_DIR).map((p) => ({ rel: p.slice(MODULE_DIR.length).replace(/\\/g, '/'), text: stripComments(readFileSync(p, 'utf8')) }));
const all = SRC.map((f) => f.text).join('\n');
const fileText = (rel: string) => SRC.find((f) => f.rel === rel)?.text ?? '';

const SIX = ['anatomic_case.view', 'anatomic_report.view', 'anatomic_image.view', 'anatomic_label.print', 'anatomic_object.lookup', 'anatomic_report.sign_out'];
const ENTITY_TYPES = ['anatomic_case', 'anatomic_image'];
const METRICS: Record<string, { type: 'counter' | 'histogram'; labels: string[] }> = {
  lims_anatomic_cases_created_total: { type: 'counter', labels: ['case_kind'] },
  lims_anatomic_consumer_ignored_total: { type: 'counter', labels: ['reason'] },
  lims_anatomic_signouts_total: { type: 'counter', labels: ['version_kind'] },
  lims_anatomic_submit_failures_total: { type: 'counter', labels: ['error_code'] },
  lims_anatomic_image_processing_total: { type: 'counter', labels: ['outcome'] },
  lims_anatomic_image_processing_seconds: { type: 'histogram', labels: [] },
  lims_anatomic_lookup_total: { type: 'counter', labels: ['result'] },
};
/** the statement that mentions a metric name: from the literal to the next `;` (or 400 chars) */
const stmtsFor = (name: string): string[] => [...all.matchAll(new RegExp(`['"\`]${name}['"\`]`, 'g'))].map((m) => all.slice(m.index!, m.index! + 400).split(';')[0]!);

// ============================================================================================================ (1a) access-log codes — P-3 / D-53
describe('access log — exactly the six D-53 codes, as string literals (08 A13 P-3, 02-TRD §12)', () => {
  const actions = [...all.matchAll(/\baction\s*:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim());
  it('every `action:` in the module source is a plain string literal (CI string-literal check)', () => {
    expect(actions.length).toBeGreaterThanOrEqual(6);
    for (const a of actions) expect(a, `non-literal action ${a}`).toMatch(/^'[a-z_.]+'$/);
  });
  it('the set of literals is EXACTLY the six registered codes — nothing extra, nothing missing', () => {
    expect([...new Set(actions.map((a) => a.slice(1, -1)))].sort()).toEqual([...SIX].sort());
  });
  it('no retired three-segment anatomic.* access string and no other module\'s code is used', () => {
    expect(all).not.toMatch(/['"`]anatomic\.(case|report|image|label|object)\.[a-z_]+['"`]\s*[,}]\s*entityType/);
    for (const a of actions) expect(a).not.toMatch(/\.[a-z_]+\./);
  });
  it('entityType is a literal from the documented set [CONV: entityType names]', () => {
    const types = [...all.matchAll(/\bentityType\s*:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim());
    expect(types.length).toBe(actions.length);
    for (const t of types) expect(ENTITY_TYPES).toContain(t.replace(/^'|'$/g, ''));
  });
  const WHERE: [string, string, string][] = [   // [file, action, entityType]
    ['service/case.read.service.ts', 'anatomic_case.view', 'anatomic_case'], ['service/case.read.service.ts', 'anatomic_object.lookup', 'anatomic_case'],
    ['service/changes.service.ts', 'anatomic_report.view', 'anatomic_case'], ['service/changes.service.ts', 'anatomic_report.sign_out', 'anatomic_case'],
    ['service/report.service.ts', 'anatomic_report.sign_out', 'anatomic_case'], ['service/image.service.ts', 'anatomic_image.view', 'anatomic_image'],
    ['service/material.service.ts', 'anatomic_label.print', 'anatomic_case'],
  ];
  it.each(WHERE)('%s writes %s with entityType %s (operation -> action table)', (file, action, type) => {
    const t = fileText(file);
    const i = t.indexOf(`'${action}'`);
    expect(i, `${action} missing in ${file}`).toBeGreaterThan(-1);
    expect(t.slice(i, i + 160)).toContain(`entityType: '${type}'`);
  });
  it('detail payloads: report view/sign-out carry version_no, label print carries kind + count; the lookup row has no detail with the label', () => {
    expect(fileText('service/changes.service.ts')).toMatch(/anatomic_report\.view'[\s\S]{0,260}detail:\s*\{\s*version_no/);
    expect(fileText('service/report.service.ts')).toMatch(/anatomic_report\.sign_out'[\s\S]{0,260}detail:\s*\{\s*version_no/);
    expect(fileText('service/material.service.ts')).toMatch(/anatomic_label\.print'[\s\S]{0,260}detail:\s*\{\s*kind\b[\s\S]{0,40}count/);
    expect(fileText('service/case.read.service.ts')).not.toMatch(/anatomic_object\.lookup'[^;]{0,200}detail/);
  });
});

// ============================================================================================================ (1b) metrics — presence, labels, enum values, registry, alerts
describe('metrics — every 02-TRD §12 metric is emitted with its documented label keys', () => {
  it.each(Object.entries(METRICS))('%s is emitted from module source as a %s', (name, def) => {
    const stmts = stmtsFor(name);
    expect(stmts.length, `${name} not found in non-test, non-comment source`).toBeGreaterThan(0);
    const call = def.type === 'counter' ? /\binc\s*\??\.?\s*\(/ : /\bobserve\s*\??\.?\s*\(/;
    expect(stmts.some((s) => call.test(`.${s}`) || /\b(inc|observe)\b/.test(all.slice(Math.max(0, all.indexOf(s) - 120), all.indexOf(s))))).toBe(true);
  });
  it.each(Object.entries(METRICS).filter(([, d]) => d.labels.length))('%s uses exactly its documented label key(s) and no id/PHI label', (name, def) => {
    const stmts = stmtsFor(name).join('\n');
    for (const l of def.labels) expect(stmts, `${name} must carry label ${l}`).toMatch(new RegExp(`\\b${l}\\b`));
    expect(stmts).not.toMatch(/\b(accession|accession_no|label|caption|case_id|image_id|patient|patient_id|centre_id|user_id)\s*[:,}]/);
  });
  it('enum values are emitted as literals: consumer_ignored reasons, image outcomes (incl. `failed`), lookup results', () => {
    for (const r of ['stale', 'aliquot', 'no_anatomic_items']) expect(stmtsFor('lims_anatomic_consumer_ignored_total').join('\n') + all).toContain(`'${r}'`);
    const img = all.match(/lims_anatomic_image_processing_total[\s\S]{0,2500}/g)?.join('\n') ?? '';
    for (const o of ['ready', 'quarantined', 'scan_retry', 'failed']) expect(all, `outcome ${o}`).toMatch(new RegExp(`['"\`]${o}['"\`]`));
    expect(img).toMatch(/failed/);
    const lk = stmtsFor('lims_anatomic_lookup_total').join('\n');
    expect(lk).toMatch(/not_found/);
    expect(lk, 'result must come from the hit (case|block|slide), not be hard-coded to one value').toMatch(/object_kind|kind|case.*block.*slide/s);
  });
  it('signouts_total is emitted on BOTH sign-out paths (R3 report.service, R10/amendment changes.service); submit_failures on the same paths', () => {
    for (const f of ['service/report.service.ts', 'service/changes.service.ts']) {
      expect(fileText(f), `${f} signouts`).toContain('lims_anatomic_signouts_total');
      expect(fileText(f), `${f} submit_failures`).toContain('lims_anatomic_submit_failures_total');
    }
  });
  it('cases_created_total is emitted where cases are created (service/**), and image_processing_seconds is observed (histogram)', () => {
    expect(SRC.filter((f) => f.rel.startsWith('service/') && f.text.includes('lims_anatomic_cases_created_total')).length).toBeGreaterThan(0);
    expect(all).toMatch(/observe\s*\??\.?\s*\([^)]*lims_anatomic_image_processing_seconds|lims_anatomic_image_processing_seconds['"`]\s*,/);
  });
  it('every lims_anatomic_* name used in code is a name the core registry knows (it throws on an unknown name) — C0 DEFS needs the 7 names + labels', () => {
    const used = [...new Set([...all.matchAll(/['"`](lims_anatomic_[a-z_]+)['"`]/g)].map((m) => m[1]!))];
    for (const n of Object.keys(METRICS)) expect(REQUIRED_METRICS as readonly string[], `${n} missing in core/observability/metrics.ts DEFS`).toContain(n);
  });
  it('the module uses no lims_anatomic_* name outside the seven documented ones', () => {
    const used = [...new Set([...all.matchAll(/['"`](lims_anatomic_[a-z_]+)['"`]/g)].map((m) => m[1]!))];
    for (const n of used) expect(Object.keys(METRICS)).toContain(n);
  });
  it('alert handoff: every lims_anatomic_* metric in the C1 rule file (02-TRD §12 transcription) is emitted by this module, incl. outcome="quarantined"', () => {
    const rules = readFileSync(RULES_FILE, 'utf8');
    const queried = [...new Set([...rules.matchAll(/lims_anatomic_[a-z_]+/g)].map((m) => m[0].replace(/_bucket$/, '')))];
    expect(queried.length).toBeGreaterThanOrEqual(3);
    for (const n of queried) expect(stmtsFor(n).length, `${n} is alerted on but never emitted`).toBeGreaterThan(0);
    expect(rules).toMatch(/lims_anatomic_image_processing_total\{outcome="quarantined"\}/);
    expect(all).toMatch(/['"`]quarantined['"`]/);
  });
});

// ============================================================================================================ (1c) logs — no PHI-bearing identifiers (02-CV §9.2, TRD §12)
describe('logs — ids and codes only (static)', () => {
  const calls = SRC.flatMap((f) => [...f.text.matchAll(/\blog\s*\??\.\s*(?:info|warn|error|debug|fatal)\s*\(/g)].map((m) => ({ file: f.rel, text: f.text.slice(m.index!, m.index! + 240).replace(/'[^'\n]*'|"[^"\n]*"/g, "''") })));
  it('there are log calls to check, and none passes an accession no, label, caption, free text, diagnosis, name or filename identifier', () => {
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.text, `${c.file}: ${c.text}`).not.toMatch(/accession|\blabel|caption|clinical_history|history_text|_text\b|\btext\b|diagnos|display_?name|full_?name|patient_?name|filename|message|\.stack|\be\.message|String\(e\)|JSON\.stringify\((?:body|row|input)/i);
  });
});

// ============================================================================================================ (2) behavioural — A2 / A3 with planted PHI
const S = vi.hoisted(() => ({ cases: new Map<string, Record<string, any>>(), objects: new Map<string, Record<string, any>>() }));
const emptyList = async () => [];
vi.mock('../repository/cases.repo.js', async (orig) => ({
  ...((await orig()) as Row),
  async getCase(_tx: unknown, i: Row) { const r = S.cases.get(i['caseId']); return r && r['tenant_id'] === i['tenantId'] ? { ...r } : undefined; },
  async lookupObjectByLabel(_tx: unknown, i: Row) { const o = S.objects.get(i['label']); return o && o['tenant_id'] === i['tenantId'] ? { ...o } : undefined; },
  listCaseItems: emptyList, listCaseTransitions: emptyList,
}));
vi.mock('../repository/parts.repo.js', async (orig) => ({ ...((await orig()) as Row), listParts: emptyList }));
vi.mock('../repository/gross.repo.js', async (orig) => ({ ...((await orig()) as Row), listGrossRecords: emptyList }));
vi.mock('../repository/blocks.repo.js', async (orig) => ({ ...((await orig()) as Row), listBlocks: emptyList }));
vi.mock('../repository/slides.repo.js', async (orig) => ({ ...((await orig()) as Row), listSlides: emptyList }));
vi.mock('../repository/stainOrders.repo.js', async (orig) => ({ ...((await orig()) as Row), listStainOrders: emptyList }));
vi.mock('../repository/images.repo.js', async (orig) => ({ ...((await orig()) as Row), listImages: emptyList }));
vi.mock('../repository/addenda.repo.js', async (orig) => ({ ...((await orig()) as Row), listAddenda: emptyList }));
vi.mock('../repository/molecular.repo.js', async (orig) => ({ ...((await orig()) as Row), listMolecularResults: emptyList }));
vi.mock('../repository/submissions.repo.js', async (orig) => ({ ...((await orig()) as Row), listItemSubmissions: emptyList }));
vi.mock('../repository/drafts.repo.js', async (orig) => ({ ...((await orig()) as Row), async getOpenDraft() { return undefined; } }));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMB = '01a1a98a-ac40-7000-8000-00000000a500';
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
// PLANTED PHI (synthetic): none of these may appear in any log line or metric label
const PLANT = { name: 'PLANTED-Sita-Karki', acc: 'PLANTACC-26-0042', history: 'PLANTED-history-ca-breast', label: 'PLANTLBL-B7-S3', caption: 'PLANTED-caption-left-axilla', msg: 'PLANTED-upstream-detail-9911' };
const CASE_ID = uid(101);
const mkCase = (): Row => ({
  id: CASE_ID, tenant_id: T, centre_id: CENTRE, branch_id: null, order_id: uid(501), patient_id: uid(601), case_kind: 'histology', status: 'accessioned', priority: 'routine',
  accession_no: PLANT.acc, accession_series: 'histology', accession_year: 2026, clinical_history_text: PLANT.history, assigned_pathologist_membership_id: null, profile_missing: false,
  received_at: '2026-11-10T04:00:00.000Z', accessioned_at: '2026-11-10T05:00:00.000Z', signed_out_at: null, current_version_no: 0, molecular_rev: 0, version: 3, created_by: ACTOR, updated_by: ACTOR,
});

const seen = { logs: [] as string[], incs: [] as { name: string; labels?: Record<string, unknown> }[], obs: [] as { name: string; value: number; labels?: Record<string, unknown> }[], access: [] as Row[] };
const mkCtx = (o: { fdThrows?: unknown; membersThrow?: unknown } = {}) => {
  const lg = (x: unknown, m?: unknown) => { seen.logs.push(JSON.stringify([x, m])); };
  return {
    operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999), log: { info: lg, warn: lg, error: lg, debug: lg },
    metrics: { inc: (name: string, labels?: Record<string, unknown>) => { seen.incs.push({ name, labels }); }, observe: (name: string, value: number, labels?: Record<string, unknown>) => { seen.obs.push({ name, value, labels }); }, set() {} },
    tenantId: T, actor: { type: 'user', id: ACTOR, membershipId: MEMB }, tx: { async query() { return { rows: [] }; } }, now: () => new Date('2026-11-12T01:30:00Z'),
    audit: { async access(e: Row) { seen.access.push(structuredClone(e)); } },
    core: {
      async user() { return { id: ACTOR, displayName: 'Synthetic Tech', isActive: true }; },
      async branch() { return { id: uid(1), branchCode: 'B1', name: 'B', isProcessingLab: true, isActive: true }; },
      memberships: { async list() { if (o.membersThrow) throw o.membersThrow; return []; } },
    },
    ports: {
      IdentityPort: { async assertRole() { /* allowed */ }, async getTenantSettings() { return { timezone: 'Asia/Kathmandu', numbering: {} }; } },
      FrontdeskPort: { async getPatientDemographicsBatch() { if (o.fdThrows) throw o.fdThrows; return []; } },
      LabPort: { async getOrderResults(_c: unknown, i: Row) { return { orderId: i['orderId'], specimens: [], items: [], approvedSetHash: 'h' }; } },
    },
  } as any;
};
const call = (op: string, req: Row, ctx = mkCtx()): Promise<any> => (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx);
const rejects = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e) as Promise<any>;
const lookupCounts = () => seen.incs.filter((i) => i.name === 'lims_anatomic_lookup_total');

beforeEach(() => {
  S.cases.clear(); S.objects.clear(); S.cases.set(CASE_ID, mkCase());
  seen.logs.length = 0; seen.incs.length = 0; seen.obs.length = 0; seen.access.length = 0;
  S.objects.set('CASE-OK-1', { tenant_id: T, object_kind: 'case', case_id: CASE_ID, centre_id: CENTRE });
  S.objects.set('BLOCK-OK-1', { tenant_id: T, object_kind: 'block', case_id: CASE_ID, block_id: uid(301), centre_id: CENTRE });
  S.objects.set('SLIDE-OK-1', { tenant_id: T, object_kind: 'slide', case_id: CASE_ID, block_id: uid(301), slide_id: uid(401), centre_id: CENTRE });
});

describe('A2 lookupAnatomicObject — lims_anatomic_lookup_total{result} + access row on success only (TRD §12, REQ-SEC-045/096)', () => {
  it.each([['CASE-OK-1', 'case'], ['BLOCK-OK-1', 'block'], ['SLIDE-OK-1', 'slide']])('hit %s -> result=%s, ONE access row anatomic_object.lookup on the case', async (label, kind) => {
    const r = await call('lookupAnatomicObject', { body: { label } });
    expect(r.status).toBe(200);
    expect(lookupCounts()).toEqual([{ name: 'lims_anatomic_lookup_total', labels: { result: kind } }]);
    expect(seen.access).toHaveLength(1);
    expect(seen.access[0]).toMatchObject({ action: 'anatomic_object.lookup', entityType: 'anatomic_case', entityId: CASE_ID, centreId: CENTRE, outcome: 'allowed' });
    expect(JSON.stringify(seen.access[0])).not.toContain(label);
  });
  it('unknown label -> 404 common.not_found, result=not_found counted, NO access row (success only)', async () => {
    const e = await rejects(call('lookupAnatomicObject', { body: { label: PLANT.label } }));
    expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe('common.not_found');
    expect(lookupCounts()).toEqual([{ name: 'lims_anatomic_lookup_total', labels: { result: 'not_found' } }]);
    expect(seen.access).toHaveLength(0);
  });
  it('other tenant\'s label is counted as not_found exactly like an unknown one (no distinguishable signal)', async () => {
    S.objects.set('TENANT-B-1', { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001', object_kind: 'case', case_id: uid(999), centre_id: CENTRE });
    const e = await rejects(call('lookupAnatomicObject', { body: { label: 'TENANT-B-1' } }));
    expect(e.code).toBe('common.not_found');
    expect(lookupCounts()).toEqual([{ name: 'lims_anatomic_lookup_total', labels: { result: 'not_found' } }]);
    expect(seen.access).toHaveLength(0);
  });
  it('an invalid label (400) is a validation error, not a lookup: nothing counted, nothing logged with the label', async () => {
    const e = await rejects(call('lookupAnatomicObject', { body: { label: `bad label ${PLANT.label}!` } }));
    expect(e.code).toBe('common.validation_failed');
    expect(lookupCounts()).toHaveLength(0);
    expect(seen.access).toHaveLength(0);
    expect(seen.logs.join('\n')).not.toContain(PLANT.label);
  });
});

describe('A3 getAnatomicCase — one anatomic_case.view row per call', () => {
  it('writes exactly one access row {anatomic_case.view, anatomic_case, case id}', async () => {
    const r = await call('getAnatomicCase', { params: { case_id: CASE_ID } });
    expect(r.status).toBe(200);
    expect(seen.access).toHaveLength(1);
    expect(seen.access[0]).toMatchObject({ action: 'anatomic_case.view', entityType: 'anatomic_case', entityId: CASE_ID, centreId: CENTRE, outcome: 'allowed' });
  });
  it('a case the caller cannot see (404) writes no access row', async () => {
    const e = await rejects(call('getAnatomicCase', { params: { case_id: uid(555) } }));
    expect(e.code).toBe('common.not_found');
    expect(seen.access).toHaveLength(0);
  });
});

describe('log scan with planted PHI — no accession no, label, history text, caption or patient name in logs or metric labels (TRD §12, 07-SECURITY §5.6, REQ-SEC-098)', () => {
  const planted = Object.values(PLANT);
  const clean = () => {
    const blob = [...seen.logs, JSON.stringify(seen.incs), JSON.stringify(seen.obs)].join('\n');
    for (const p of planted) expect(blob, `planted value leaked: ${p}`).not.toContain(p);
  };
  it('A3 with an upstream (FrontdeskPort) failure whose message carries the patient name, and a member-directory failure: degraded but logs hold codes/ids only', async () => {
    const r = await call('getAnatomicCase', { params: { case_id: CASE_ID } }, mkCtx({ fdThrows: new Error(`upstream said ${PLANT.name} ${PLANT.msg}`), membersThrow: new Error(`dir ${PLANT.msg}`) }));
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(PLANT.name);
    clean();
  });
  it('A3 with a LimsError from the patient port: logged by code only', async () => {
    await call('getAnatomicCase', { params: { case_id: CASE_ID } }, mkCtx({ fdThrows: new LimsError('common.unavailable') }));
    clean();
  });
  it('A2 success, not_found and invalid-label paths with planted labels leave no label in any log line or metric label', async () => {
    await call('lookupAnatomicObject', { body: { label: 'BLOCK-OK-1' } });
    await rejects(call('lookupAnatomicObject', { body: { label: PLANT.label } }));
    await rejects(call('lookupAnatomicObject', { body: { label: `${PLANT.label} x` } }));
    clean();
  });
  it('every metric label value emitted by A2/A3 is from the documented enum (no free text, no ids)', async () => {
    await call('lookupAnatomicObject', { body: { label: 'SLIDE-OK-1' } });
    await rejects(call('lookupAnatomicObject', { body: { label: PLANT.label } }));
    await call('getAnatomicCase', { params: { case_id: CASE_ID } });
    for (const i of seen.incs.filter((x) => x.name.startsWith('lims_anatomic_'))) {
      expect(Object.keys(METRICS)).toContain(i.name);
      for (const [k, v] of Object.entries(i.labels ?? {})) {
        expect(METRICS[i.name]!.labels, `label key ${k}`).toContain(k);
        expect(String(v)).toMatch(/^[a-z_.]{1,48}$/);
      }
    }
  });
});
