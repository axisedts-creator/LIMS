// C11.T-06 — numbering service + accession endpoint (A4) + case details (A5) + parts (A6, A7) + assignees (A12).
// Spec: 02-TRD §4.2 (numbering), §5 A4–A7/A12 + "Every handler" rule + D-66 signout_locked, §6.2 (ctx.core.memberships.list / ctx.core.branch), §7 C2;
//       01-PRD AC-02.1…02.7; 07-SECURITY (AB-5 unknown fields, centre scoping A12 → 404, problem detail without accession numbers, REQ-SEC-082).
// Drives the REAL handlers (manifest.handlers) and the real numbering service on top of IN-MEMORY repositories (vi.mock of cases/parts/counters repo with the T-04 signatures).
// The in-memory counter is atomic per call; real row-lock concurrency (20 parallel) is proved by integration/numbering.live.test.ts (gated like T-04).
//
// SEAMS (spec fixes behaviour, not file/function names beyond the plan row; chosen here, writer follows):
//   ../service/numbering.service.ts   export allocateAccessionNumber(ctx, { caseKind, branchId? }): Promise<{ accessionNo, seriesKey, yearAd, seq }>
//        — reads ctx.ports.IdentityPort.getTenantSettings(ctx,{keys:['timezone','numbering']}), ctx.now(), ctx.core.branch(ctx,{branchId}) only when the pattern has {branch};
//          allocates ONLY through repository/counters.repo bumpAccessionCounter; throws LimsError anatomic.accession_pattern_invalid on bad pattern / overflow / missing branch.
//   ../service/case.service.ts       (behaviour only; reached through the handlers) uses repository getCase/updateCase/listParts/getPart/insertPart/updatePart/insertCaseTransition.
//   ctx shape (same assumption as frontdesk/smartreport): { operationId, clientIp, log, requestId, tenantId, actor:{type,id}, tx, now(), core:{branch,user,memberships:{list}},
//        ports:{ IdentityPort:{ assertRole(ctx,{permission,centreId?}), getTenantSettings(ctx,{keys}) } } }.
//   request: { params:{case_id,part_id}, query, headers:{'if-match':'"<version>"'}, body }; responses: A4/A5 200 CaseDetail-ish {accession_no?,status,version,…}, A6 201 Part, A7 200 Part, A12 200 {data:[{membership_id,display_name}]}.
// Fails now: ../service/numbering.service.js does not exist and the five handlers are 501/common.internal stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../core/errors.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  cases: new Map<string, Row>(), parts: new Map<string, Row>(), counters: new Map<string, number>(), transitions: [] as Row[],
  hidden: new Set<string>(), bumps: [] as Row[], writes: 0, sql: [] as string[], failNext: undefined as unknown,
}));
const pgErr = (code: string, constraint: string) => Object.assign(new Error('duplicate key value violates unique constraint'), { code, constraint });

vi.mock('../repository/counters.repo.js', () => ({
  async bumpAccessionCounter(_tx: unknown, k: { tenantId: string; seriesKey: string; yearAd: number; actorId: string }) {
    S.bumps.push({ ...k });
    await Promise.resolve(); // a read-then-write implementation elsewhere would interleave here
    const key = `${k.tenantId}|${k.seriesKey}|${k.yearAd}`;
    const v = (S.counters.get(key) ?? 0) + 1;
    S.counters.set(key, v);
    return v;
  },
  async getAccessionCounter(_tx: unknown, k: { tenantId: string; seriesKey: string; yearAd: number }) { return S.counters.get(`${k.tenantId}|${k.seriesKey}|${k.yearAd}`); },
}));
vi.mock('../repository/cases.repo.js', () => ({
  async getCase(_tx: unknown, i: { tenantId: string; caseId: string }) {
    const r = S.cases.get(i.caseId);
    return r && r['tenant_id'] === i.tenantId && !S.hidden.has(i.caseId) ? { ...r } : undefined;
  },
  async updateCase(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    if (S.failNext) { const f = S.failNext; S.failNext = undefined; throw f; }
    const r = S.cases.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const no = i.patch['accession_no'];
    if (no !== undefined && [...S.cases.values()].some((c) => c['tenant_id'] === i.tenantId && c['id'] !== i.id && c['accession_no'] === no)) throw pgErr('23505', 'cases_tenant_id_accession_no_key');
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.cases.set(i.id, next);
    return { ...next };
  },
  async insertCaseTransition(_tx: unknown, row: Row) { S.writes++; S.transitions.push({ ...row }); return { ...row }; },
  async listCaseTransitions(_tx: unknown, i: { caseId: string }) { return S.transitions.filter((t) => t['case_id'] === i.caseId); },
  async listCaseItems() { return []; },
  async getCaseItem() { return undefined; },
  async insertCaseItem(_tx: unknown, row: Row) { return row; },
  async updateCaseItem() { return undefined; },
  async listCases() { return [...S.cases.values()]; },
  async listCasesByOrder() { return []; },
  async insertCase(_tx: unknown, row: Row) { S.cases.set(row['id'], { ...row }); return row; },
  async getCaseTransition() { return undefined; },
}));
vi.mock('../repository/parts.repo.js', () => ({
  async getPart(_tx: unknown, i: { tenantId: string; id: string }) { const r = S.parts.get(i.id); return r && r['tenant_id'] === i.tenantId ? { ...r } : undefined; },
  async listParts(_tx: unknown, i: { tenantId: string; caseId: string }) {
    return [...S.parts.values()].filter((p) => p['tenant_id'] === i.tenantId && p['case_id'] === i.caseId).sort((a, b) => a['letter_seq'] - b['letter_seq']).map((p) => ({ ...p }));
  },
  async insertPart(_tx: unknown, row: Row) { S.writes++; const r = { version: 1, specimen_state: 'none', ...row }; S.parts.set(r['id'], r); return { ...r }; },
  async updatePart(_tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    S.writes++;
    const r = S.parts.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next = { ...r, ...i.patch, version: r['version'] + 1, updated_by: i.actorId };
    S.parts.set(i.id, next);
    return { ...next };
  },
}));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201', BRANCH = '01a1a98a-ac40-7000-8000-00000000a101';
const ACTOR = '01a1a98a-ac40-7000-8000-00000000a300';
const uid = (n: number) => `0190c411-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-12T01:30:00Z'); // 07:15 Asia/Kathmandu, 2026

const mkCase = (n: number, over: Row = {}): Row => ({
  id: uid(100 + n), tenant_id: T, centre_id: CENTRE, branch_id: null, order_id: uid(500 + n), patient_id: uid(600 + n), case_kind: 'histology', status: 'received',
  priority: 'routine', accession_no: null, accession_series: null, accession_year: null, clinical_history_text: null, assigned_pathologist_membership_id: null,
  received_at: '2026-11-10T04:00:00.000Z', version: 1, ...over,
});
const mkPart = (n: number, caseId: string, letter = 'A', seq = 1, over: Row = {}): Row =>
  ({ id: uid(200 + n), tenant_id: T, centre_id: CENTRE, case_id: caseId, letter, letter_seq: seq, site_text: null, description_text: null, version: 1, ...over });
const seed = (c: Row, ...ps: Row[]) => { S.cases.set(c['id'], c); for (const p of ps) S.parts.set(p['id'], p); return c['id'] as string; };
/** one case with its single part #n */
const seedCase = (n: number, over: Row = {}) => { const c = mkCase(n, over); const p = mkPart(n, c['id']); seed(c, p); return { caseId: c['id'] as string, partId: p['id'] as string }; };

interface CtxOpts { settings?: Row; branches?: Record<string, string>; members?: Row[]; now?: Date; assertRole?: (c: unknown, i: Row) => Promise<unknown> }
const calls = { assertRole: [] as Row[], branch: [] as Row[], members: [] as Row[], settings: [] as Row[], logs: [] as string[] };
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: T, actor: { type: 'user', id: ACTOR }, tx: { async query(text: string) { S.sql.push(text); return { rows: [] }; } }, now: () => o.now ?? NOW,
  core: {
    async branch(_c: unknown, i: { branchId: string }) { calls.branch.push(i); const code = o.branches?.[i.branchId]; if (!code) throw Object.assign(new Error('nf'), { code: 'common.not_found' }); return { id: i.branchId, branchCode: code, name: 'B', isProcessingLab: true, isActive: true }; },
    async user() { return { id: ACTOR, displayName: 'Synthetic Tech', isActive: true }; },
    memberships: { async list(_c: unknown, i: Row) { calls.members.push(i); return (o.members ?? []).map((m) => ({ roleCodes: [], allCentres: false, isActive: true, ...m })); } },
  },
  ports: { IdentityPort: {
    async assertRole(c: unknown, i: Row) { calls.assertRole.push(i); return o.assertRole ? o.assertRole(c, i) : undefined; },
    async getTenantSettings(_c: unknown, i: Row) { calls.settings.push(i); return { timezone: 'Asia/Kathmandu', numbering: {}, ...(o.settings ?? {}) }; },
  } },
}) as any;

/** emulates requestTx: a throwing handler rolls the whole transaction back */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  const snap = { c: structuredClone([...S.cases]), p: structuredClone([...S.parts]), k: [...S.counters], t: structuredClone(S.transitions) };
  try {
    return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx);
  } catch (e) {
    S.cases = new Map(snap.c) as never; S.parts = new Map(snap.p) as never; S.counters = new Map(snap.k) as never; S.transitions = snap.t as never;
    throw e;
  }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const accession = (caseId: string, partId: string | string[], body: Row = {}, version = 1, ctx?: any) =>
  call('accessionAnatomicCase', {
    params: { case_id: caseId }, headers: ifm(version),
    body: { clinical_history_text: 'Synthetic history', parts: (Array.isArray(partId) ? partId : [partId]).map((id) => ({ part_id: id, site_text: 'Left breast' })), ...body },
  }, ctx);
const snapshot = () => JSON.stringify({ c: [...S.cases], p: [...S.parts], k: [...S.counters], t: S.transitions });

beforeEach(() => {
  S.cases.clear(); S.parts.clear(); S.counters.clear(); S.transitions.length = 0; S.hidden.clear(); S.bumps.length = 0; S.writes = 0; S.sql.length = 0; S.failNext = undefined;
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k].length = 0;
});

describe('C11-T06 AC-02.1 accession: next number of the series, status accessioned', () => {
  it('first histology case of 2026 gets S26-0001; counter scope (tenant, histology, 2026); case + part updated, transition recorded', async () => {
    const { caseId, partId } = seedCase(1);
    const r = await accession(caseId, partId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: caseId, accession_no: 'S26-0001', status: 'accessioned', version: 2 });
    expect(S.cases.get(caseId)).toMatchObject({ accession_no: 'S26-0001', accession_series: 'histology', accession_year: 2026, status: 'accessioned', accessioned_by: ACTOR, clinical_history_text: 'Synthetic history', version: 2 });
    expect(S.cases.get(caseId)!['accessioned_at']).toBeTruthy();
    expect(S.parts.get(partId)).toMatchObject({ site_text: 'Left breast', version: 2 });
    expect(S.counters.get(`${T}|histology|2026`)).toBe(1);
    expect(S.transitions).toHaveLength(1);
    expect(S.transitions[0]).toMatchObject({ tenant_id: T, case_id: caseId, from_status: 'received', to_status: 'accessioned' });
  });

  it('counter at 41 → S26-0042 (PRD example)', async () => {
    S.counters.set(`${T}|histology|2026`, 41);
    const { caseId, partId } = seedCase(1);
    expect((await accession(caseId, partId)).body.accession_no).toBe('S26-0042');
  });

  it('series = case kind with default prefixes S/C/I/M; counters are independent per series', async () => {
    const ids = (['histology', 'cytology', 'ihc', 'molecular'] as const).map((k, i) => seedCase(i + 1, { case_kind: k }));
    const nos = [];
    for (const { caseId, partId } of ids) nos.push((await accession(caseId, partId)).body.accession_no);
    expect(nos).toEqual(['S26-0001', 'C26-0001', 'I26-0001', 'M26-0001']);
    expect(new Set(S.bumps.map((b) => b['seriesKey']))).toEqual(new Set(['histology', 'cytology', 'ihc', 'molecular']));
  });

  it('tenant pattern/prefix from IdentityPort.getTenantSettings({keys incl. numbering}) wins over defaults; missing prefix falls back to the default', async () => {
    const ctx = () => mkCtx({ settings: { numbering: { accessionNoPattern: '{prefix}-{yy}{seq:5}', accessionPrefixes: { histology: 'HP' } } } });
    const a = seedCase(1), b = seedCase(2, { case_kind: 'cytology' });
    expect((await accession(a.caseId, a.partId, {}, 1, ctx())).body.accession_no).toBe('HP-2600001');
    expect((await accession(b.caseId, b.partId, {}, 1, ctx())).body.accession_no).toBe('C-2600001');
    expect(calls.settings.some((s) => (s['keys'] as string[]).includes('numbering'))).toBe(true);
  });

  it('the number never changes afterwards: A5 details update keeps it; A5/A4 bodies cannot set accession_no (AB-5)', async () => {
    const { caseId, partId } = seedCase(1);
    await accession(caseId, partId);
    const r = await call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(2), body: { clinical_history_text: 'Edited' } });
    expect(r.body).toMatchObject({ accession_no: 'S26-0001' });
    expect(S.cases.get(caseId)).toMatchObject({ accession_no: 'S26-0001', accession_series: 'histology', accession_year: 2026, clinical_history_text: 'Edited' });
    const before = snapshot();
    const e = await rejects(call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(3), body: { accession_no: 'S26-9999' } }));
    expect(isLimsError(e, 'common.validation_failed')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  it('assigned pathologist is stored when given', async () => {
    const { caseId, partId } = seedCase(1);
    await accession(caseId, partId, { assigned_pathologist_membership_id: uid(777) });
    expect(S.cases.get(caseId)!['assigned_pathologist_membership_id']).toBe(uid(777));
  });
});

describe('C11-T06 AC-02.2 concurrency: distinct + consecutive', () => {
  it('20 parallel accessions of 20 cases → S26-0001…S26-0020 exactly once each, allocated through bumpAccessionCounter only', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => seedCase(i + 1));
    const rs = await Promise.all(ids.map(({ caseId, partId }) => accession(caseId, partId)));
    const nos = rs.map((r) => r.body.accession_no as string).sort();
    expect(new Set(nos).size).toBe(20);
    expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => `S26-${String(i + 1).padStart(4, '0')}`));
    expect(S.bumps).toHaveLength(20);
    expect(S.counters.get(`${T}|histology|2026`)).toBe(20);
  });
});

describe('C11-T06 AC-02.3 overflow / pattern errors → 500 anatomic.accession_pattern_invalid, nothing changes', () => {
  it('counter at 9999 with {seq:4}: 10000 does not fit → 500; case, part, counter, transitions unchanged', async () => {
    S.counters.set(`${T}|histology|2026`, 9999);
    const { caseId, partId } = seedCase(1);
    const before = snapshot();
    const e = await rejects(accession(caseId, partId));
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
    expect(e.statusCode).toBe(500);
    expect(snapshot()).toBe(before);
    expect(S.cases.get(caseId)!['status']).toBe('received');
  });

  it('the last number that fits (9999) is issued; {seq:3} overflows at 1000', async () => {
    S.counters.set(`${T}|histology|2026`, 9998);
    const a = seedCase(1);
    expect((await accession(a.caseId, a.partId)).body.accession_no).toBe('S26-9999');
    S.counters.set(`${T}|histology|2026`, 999);
    const b = seedCase(2);
    const e = await rejects(accession(b.caseId, b.partId, {}, 1, mkCtx({ settings: { numbering: { accessionNoPattern: '{prefix}{yy}-{seq:3}' } } })));
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
  });

  it.each(['{foo}{seq:4}', '{prefix}{yy}', '{prefix}{seq:2}', '{seq:4}{seq:4}', 'S26_{seq:4}', 's{yy}-{seq:4}', '{prefix}{yy}-{seq:9}'])('invalid tenant pattern %j → 500, nothing changes', async (pattern) => {
    const { caseId, partId } = seedCase(1);
    const before = snapshot();
    const e = await rejects(accession(caseId, partId, {}, 1, mkCtx({ settings: { numbering: { accessionNoPattern: pattern } } })));
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  it('problem detail never carries an accession number (REQ-SEC-095)', async () => {
    S.counters.set(`${T}|histology|2026`, 9999);
    const { caseId, partId } = seedCase(1);
    const e = await rejects(accession(caseId, partId));
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
    expect(JSON.stringify({ d: e.detail, m: e.message })).not.toMatch(/S26-|10000/);
  });
});

describe('C11-T06 AC-02.4 year rollover in the tenant time zone (Asia/Kathmandu)', () => {
  it('31 Dec 18:14 UTC is still 2026 (23:59 NPT); 18:15 UTC is 1 Jan 2027 NPT → sequence restarts at 1, old counter untouched', async () => {
    S.counters.set(`${T}|histology|2026`, 57);
    const a = seedCase(1), b = seedCase(2);
    expect((await accession(a.caseId, a.partId, {}, 1, mkCtx({ now: new Date('2026-12-31T18:14:00Z') }))).body.accession_no).toBe('S26-0058');
    expect((await accession(b.caseId, b.partId, {}, 1, mkCtx({ now: new Date('2026-12-31T18:15:00Z') }))).body.accession_no).toBe('S27-0001');
    expect(S.counters.get(`${T}|histology|2026`)).toBe(58);
    expect(S.counters.get(`${T}|histology|2027`)).toBe(1);
    expect(S.cases.get(b.caseId)).toMatchObject({ accession_year: 2027 });
  });

  it('pattern without {yy}: one counter per series with year_ad 0 (no rollover)', async () => {
    const ctx = (now: string) => mkCtx({ now: new Date(now), settings: { numbering: { accessionNoPattern: '{prefix}-{seq:4}' } } });
    const a = seedCase(1), b = seedCase(2);
    expect((await accession(a.caseId, a.partId, {}, 1, ctx('2026-06-01T00:00:00Z'))).body.accession_no).toBe('S-0001');
    expect((await accession(b.caseId, b.partId, {}, 1, ctx('2027-06-01T00:00:00Z'))).body.accession_no).toBe('S-0002');
    expect(S.counters.get(`${T}|histology|0`)).toBe(2);
  });
});

describe('C11-T06 {branch} comes from ctx.core.branch(case.branch_id), upper-cased (02-TRD §4.2)', () => {
  const settings = { numbering: { accessionNoPattern: '{prefix}{branch}{yy}-{seq:4}' } };

  it('renders the upper-cased branch_code of the case processing branch', async () => {
    const { caseId, partId } = seedCase(1, { branch_id: BRANCH });
    const r = await accession(caseId, partId, {}, 1, mkCtx({ settings, branches: { [BRANCH]: 'kt1' } }));
    expect(r.body.accession_no).toBe('SKT126-0001');
    expect(calls.branch).toEqual([{ branchId: BRANCH }]);
  });

  it('{branch} in the pattern but case.branch_id absent → 500 anatomic.accession_pattern_invalid, core.branch never called, nothing changes', async () => {
    const { caseId, partId } = seedCase(1);
    const before = snapshot();
    const e = await rejects(accession(caseId, partId, {}, 1, mkCtx({ settings, branches: { [BRANCH]: 'kt1' } })));
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
    expect(e.statusCode).toBe(500);
    expect(calls.branch).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it('patterns without {branch} never read the branch even when branch_id is set', async () => {
    const { caseId, partId } = seedCase(1, { branch_id: BRANCH });
    await accession(caseId, partId, {}, 1, mkCtx({ branches: { [BRANCH]: 'kt1' } }));
    expect(calls.branch).toEqual([]);
  });

  it('numbering service direct: allocateAccessionNumber returns { accessionNo, seriesKey, yearAd, seq }', async () => {
    const { allocateAccessionNumber } = await import('../service/numbering.service.js'); // lazy: one missing file must not hide the handler tests
    const out = await allocateAccessionNumber(mkCtx(), { caseKind: 'cytology' });
    expect(out).toMatchObject({ accessionNo: 'C26-0001', seriesKey: 'cytology', yearAd: 2026, seq: 1 });
    const e = await rejects(allocateAccessionNumber(mkCtx({ settings }), { caseKind: 'histology' }));
    expect(isLimsError(e, 'anatomic.accession_pattern_invalid')).toBe(true);
  });
});

describe('C11-T06 AC-02.5 already accessioned → 409 anatomic.case_invalid_transition', () => {
  it.each(['accessioned', 'in_processing', 'ready_for_reporting', 'signed_out', 'cancelled'])('status %s: 409, counter not bumped, nothing changes', async (status) => {
    const { caseId, partId } = seedCase(1, { status, accession_no: status === 'cancelled' ? null : 'S26-0001' });
    const before = snapshot();
    const e = await rejects(accession(caseId, partId));
    expect(isLimsError(e, 'anatomic.case_invalid_transition')).toBe(true);
    expect(e.statusCode).toBe(409);
    expect(S.bumps).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

describe('C11-T06 AC-02.6 duplicate rendered number → 409 anatomic.accession_duplicate', () => {
  it('pattern without {yy}, counter manually reset to 0 while S-0001 exists → 409; rolled back; detail without the number', async () => {
    seed(mkCase(50, { status: 'accessioned', accession_no: 'S-0001' }));
    const { caseId, partId } = seedCase(1);
    const before = snapshot();
    const e = await rejects(accession(caseId, partId, {}, 1, mkCtx({ settings: { numbering: { accessionNoPattern: '{prefix}-{seq:4}' } } })));
    expect(isLimsError(e, 'anatomic.accession_duplicate')).toBe(true);
    expect(e.statusCode).toBe(409);
    expect(JSON.stringify({ d: e.detail, m: e.message })).not.toContain('S-0001');
    expect(snapshot()).toBe(before);
  });

  it('a non-duplicate DB failure is not mapped to accession_duplicate (→ propagates unchanged)', async () => {
    const { caseId, partId } = seedCase(1);
    S.failNext = Object.assign(new Error('boom'), { code: '40001' });
    const e = await rejects(accession(caseId, partId));
    expect(isLimsError(e, 'anatomic.accession_duplicate')).toBe(false);
    expect(e.code).toBe('40001');
  });
});

describe('C11-T06 AC-02.7 authorisation (02-TRD §5: load through RLS → 404, then assertRole(permission, centreId: case.centre_id))', () => {
  it('without anatomic.case.work → 403 auth.forbidden; assertRole asked for anatomic.case.work at the case centre; nothing changes', async () => {
    const { caseId, partId } = seedCase(1);
    const before = snapshot();
    const deny = async () => { const { LimsError } = await import('../../../core/errors.js'); throw new LimsError('auth.forbidden'); };
    const e = await rejects(accession(caseId, partId, {}, 1, mkCtx({ assertRole: deny })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(e.statusCode).toBe(403);
    expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.work', centreId: CENTRE }]);
    expect(S.bumps).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it.each([
    ['updateAnatomicCaseDetails', { body: { clinical_history_text: 'x' }, headers: ifm(1) }],
    ['addAnatomicPart', { body: { site_text: 'Skin' } }],
  ])('%s asserts anatomic.case.work at the case centre', async (op, extra) => {
    const { caseId } = seedCase(1);
    await call(op, { params: { case_id: caseId }, ...extra });
    expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.work', centreId: CENTRE }]);
  });

  it('updateAnatomicPart asserts anatomic.case.work at the case centre', async () => {
    const { caseId, partId } = seedCase(1);
    await call('updateAnatomicPart', { params: { case_id: caseId, part_id: partId }, headers: ifm(1), body: { site_text: 'Skin' } });
    expect(calls.assertRole).toEqual([{ permission: 'anatomic.case.work', centreId: CENTRE }]);
  });

  it('a case invisible through RLS (other tenant / other centre) → 404 common.not_found BEFORE any permission or counter work', async () => {
    const { caseId, partId } = seedCase(1);
    S.hidden.add(caseId);
    for (const run of [
      () => accession(caseId, partId),
      () => call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(1), body: {} }),
      () => call('addAnatomicPart', { params: { case_id: caseId }, body: { site_text: 'Skin' } }),
      () => call('updateAnatomicPart', { params: { case_id: caseId, part_id: partId }, headers: ifm(1), body: { site_text: 'Skin' } }),
    ]) {
      const e = await rejects(run());
      expect(isLimsError(e, 'common.not_found')).toBe(true);
    }
    expect(S.bumps).toEqual([]);
    expect(S.writes).toBe(0);
  });

  it('another tenant\'s case id → 404 (explicit tenant filter, REQ-SEC-024)', async () => {
    const c = mkCase(1, { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' });
    seed(c, mkPart(1, c['id'], 'A', 1, { tenant_id: c['tenant_id'] }));
    expect(isLimsError(await rejects(accession(c['id'], uid(201))), 'common.not_found')).toBe(true);
  });
});

describe('C11-T06 A4 input rules (If-Match, closed body, every part listed)', () => {
  it('no If-Match → 428 common.precondition_required; stale If-Match → 409 common.version_conflict; nothing changes', async () => {
    const { caseId, partId } = seedCase(1, { version: 3 });
    const before = snapshot();
    const noHeader = await rejects(call('accessionAnatomicCase', { params: { case_id: caseId }, headers: {}, body: { parts: [{ part_id: partId, site_text: 'x' }] } }));
    expect(isLimsError(noHeader, 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(accession(caseId, partId, {}, 2)), 'common.version_conflict')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  it('every existing part must be listed (A4); unknown part, foreign-case part and duplicate part ids → 400; nothing changes', async () => {
    const c = mkCase(1), p1 = mkPart(1, c['id']), p2 = mkPart(2, c['id'], 'B', 2);
    const other = mkCase(2), po = mkPart(3, other['id']);
    seed(c, p1, p2); seed(other, po);
    const before = snapshot();
    for (const parts of [
      [{ part_id: p1['id'], site_text: 'a' }],
      [{ part_id: p1['id'], site_text: 'a' }, { part_id: p2['id'], site_text: 'b' }, { part_id: uid(299), site_text: 'c' }],
      [{ part_id: p1['id'], site_text: 'a' }, { part_id: po['id'], site_text: 'b' }],
      [{ part_id: p1['id'], site_text: 'a' }, { part_id: p1['id'], site_text: 'b' }],
    ]) {
      const e = await rejects(call('accessionAnatomicCase', { params: { case_id: c['id'] }, headers: ifm(1), body: { parts } }));
      expect(isLimsError(e, 'common.validation_failed')).toBe(true);
    }
    expect(snapshot()).toBe(before);
  });

  const okPart = { part_id: uid(201), site_text: 'Left breast' };
  it.each([
    ['parts missing', {}], ['parts empty', { parts: [] }], ['site_text empty', { parts: [{ ...okPart, site_text: '' }] }],
    ['site_text 201 chars', { parts: [{ ...okPart, site_text: 'x'.repeat(201) }] }], ['description 1001 chars', { parts: [{ ...okPart, description_text: 'x'.repeat(1001) }] }],
    ['history 4001 chars', { parts: [okPart], clinical_history_text: 'x'.repeat(4001) }], ['53 parts', { parts: Array.from({ length: 53 }, (_, i) => ({ part_id: uid(300 + i), site_text: 's' })) }],
    ['unknown field status (AB-5)', { parts: [okPart], status: 'signed_out' }], ['unknown field accession_no (AB-5)', { parts: [okPart], accession_no: 'S26-0001' }],
    ['unknown field tenant_id (AB-5)', { parts: [okPart], tenant_id: uid(1) }], ['unknown field in part item', { parts: [{ ...okPart, letter: 'Z' }] }],
    ['non-uuid part_id', { parts: [{ part_id: 'not-a-uuid', site_text: 's' }] }], ['site_text wrong type', { parts: [{ ...okPart, site_text: 5 }] }],
  ])('invalid body (%s) → 400 common.validation_failed, counter not bumped, nothing changes', async (_n, body) => {
    const { caseId } = seedCase(1);
    const before = snapshot();
    const e = await rejects(call('accessionAnatomicCase', { params: { case_id: caseId }, headers: ifm(1), body }));
    expect(isLimsError(e, 'common.validation_failed')).toBe(true);
    expect(S.bumps).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it('unknown fields are reported with sub-code common.unknown_field and never echo the submitted value', async () => {
    const { caseId, partId } = seedCase(1);
    const e = await rejects(call('accessionAnatomicCase', { params: { case_id: caseId }, headers: ifm(1), body: { parts: [{ part_id: partId, site_text: 's' }], accession_no: 'PLANTED-9f3a' } }));
    expect(e.errors?.some((f: any) => f.code === 'common.unknown_field')).toBe(true);
    expect(JSON.stringify(e.errors)).not.toContain('PLANTED-9f3a');
  });

  it('log lines never contain accession numbers or clinical text (REQ-SEC-098)', async () => {
    const { caseId, partId } = seedCase(1);
    await accession(caseId, partId, { clinical_history_text: 'PHI-MARKER-HISTORY' });
    expect(calls.logs.join('\n')).not.toMatch(/S26-0001|PHI-MARKER-HISTORY|Left breast/);
  });
});

describe('C11-T06 A5 updateAnatomicCaseDetails (full replace)', () => {
  it('omitted fields are cleared (full replace); version + 1; If-Match enforced', async () => {
    const { caseId } = seedCase(1, { status: 'accessioned', accession_no: 'S26-0001', clinical_history_text: 'old', assigned_pathologist_membership_id: uid(777) });
    const r = await call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(1), body: {} });
    expect(r.status).toBe(200);
    expect(S.cases.get(caseId)).toMatchObject({ clinical_history_text: null, assigned_pathologist_membership_id: null, version: 2 });
    expect(isLimsError(await rejects(call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(1), body: {} })), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: {}, body: {} })), 'common.precondition_required')).toBe(true);
  });

  it('signed_out case → 409 anatomic.signout_locked (clinical history is snapshotted content, D-66 (c)); nothing changes', async () => {
    const { caseId } = seedCase(1, { status: 'signed_out', accession_no: 'S26-0001' });
    const before = snapshot();
    const e = await rejects(call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(1), body: { clinical_history_text: 'x' } }));
    expect(isLimsError(e, 'anatomic.signout_locked')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  it.each([['history 4001', { clinical_history_text: 'x'.repeat(4001) }], ['unknown status', { status: 'accessioned' }], ['unknown tenant_id', { tenant_id: uid(1) }], ['non-uuid pathologist', { assigned_pathologist_membership_id: 'x' }]])('invalid body (%s) → 400', async (_n, body) => {
    const { caseId } = seedCase(1);
    expect(isLimsError(await rejects(call('updateAnatomicCaseDetails', { params: { case_id: caseId }, headers: ifm(1), body })), 'common.validation_failed')).toBe(true);
  });
});

describe('C11-T06 A6 addAnatomicPart', () => {
  it('201 Part with the next letter (B after A) and letter_seq + 1; site/description stored; tenant/centre from the case, not the body', async () => {
    const { caseId } = seedCase(1, { status: 'accessioned', accession_no: 'S26-0001' });
    const r = await call('addAnatomicPart', { params: { case_id: caseId }, body: { site_text: 'Right axilla', description_text: 'lymph node' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ letter: 'B', site_text: 'Right axilla', description_text: 'lymph node', specimen_state: 'none', version: 1 });
    const stored = [...S.parts.values()].find((p) => p['letter'] === 'B')!;
    expect(stored).toMatchObject({ case_id: caseId, tenant_id: T, centre_id: CENTRE, letter_seq: 2, created_by: ACTOR });
  });

  it('after Z comes AA (letter_seq 27)', async () => {
    const c = mkCase(1, { status: 'accessioned', accession_no: 'S26-0001' });
    seed(c, ...Array.from({ length: 26 }, (_, i) => mkPart(i + 1, c['id'], String.fromCharCode(65 + i), i + 1)));
    const r = await call('addAnatomicPart', { params: { case_id: c['id'] }, body: { site_text: 'x' } });
    expect(r.body.letter).toBe('AA');
  });

  it('signed_out → 409 anatomic.signout_locked; cancelled → 409 anatomic.case_invalid_transition; nothing changes', async () => {
    const a = seedCase(1, { status: 'signed_out', accession_no: 'S26-0001' }), b = seedCase(2, { status: 'cancelled' });
    const before = snapshot();
    expect(isLimsError(await rejects(call('addAnatomicPart', { params: { case_id: a.caseId }, body: { site_text: 'x' } })), 'anatomic.signout_locked')).toBe(true);
    expect(isLimsError(await rejects(call('addAnatomicPart', { params: { case_id: b.caseId }, body: { site_text: 'x' } })), 'anatomic.case_invalid_transition')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  it.each([['site empty', { site_text: '' }], ['site missing', {}], ['site 201', { site_text: 'x'.repeat(201) }], ['description 1001', { site_text: 'x', description_text: 'x'.repeat(1001) }],
    ['unknown letter', { site_text: 'x', letter: 'Z' }], ['unknown case_id', { site_text: 'x', case_id: uid(1) }], ['unknown tenant_id', { site_text: 'x', tenant_id: uid(1) }]])('invalid body (%s) → 400, no part inserted', async (_n, body) => {
    const { caseId } = seedCase(1);
    expect(isLimsError(await rejects(call('addAnatomicPart', { params: { case_id: caseId }, body })), 'common.validation_failed')).toBe(true);
    expect(S.parts.size).toBe(1);
  });
});

describe('C11-T06 A7 updateAnatomicPart', () => {
  it('200 Part: site/description replaced, version + 1 (If-Match = part version)', async () => {
    const { caseId, partId } = seedCase(1);
    const r = await call('updateAnatomicPart', { params: { case_id: caseId, part_id: partId }, headers: ifm(1), body: { site_text: 'Colon', description_text: 'polyp' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: partId, site_text: 'Colon', description_text: 'polyp', version: 2 });
    expect(S.parts.get(partId)).toMatchObject({ site_text: 'Colon', description_text: 'polyp', version: 2 });
  });

  it('stale → 409 common.version_conflict; missing If-Match → 428; part of another case → 404; unknown part → 404', async () => {
    const a = seedCase(1), b = seedCase(2);
    const upd = (caseId: string, partId: string, headers: Row = ifm(5)) => call('updateAnatomicPart', { params: { case_id: caseId, part_id: partId }, headers, body: { site_text: 'x' } });
    expect(isLimsError(await rejects(upd(a.caseId, a.partId)), 'common.version_conflict')).toBe(true);
    expect(isLimsError(await rejects(upd(a.caseId, a.partId, {})), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(upd(a.caseId, b.partId, ifm(1))), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(upd(a.caseId, uid(299), ifm(1))), 'common.not_found')).toBe(true);
  });

  it('signed_out case without an open change draft → 409 anatomic.signout_locked; nothing changes', async () => {
    const { caseId, partId } = seedCase(1, { status: 'signed_out', accession_no: 'S26-0001' });
    const before = snapshot();
    const e = await rejects(call('updateAnatomicPart', { params: { case_id: caseId, part_id: partId }, headers: ifm(1), body: { site_text: 'x' } }));
    expect(isLimsError(e, 'anatomic.signout_locked')).toBe(true);
    expect(snapshot()).toBe(before);
  });

  it.each([['site empty', { site_text: '' }], ['site 201', { site_text: 'x'.repeat(201) }], ['unknown letter', { site_text: 'x', letter: 'Q' }], ['unknown case_id', { site_text: 'x', case_id: uid(1) }]])('invalid body (%s) → 400', async (_n, body) => {
    const { caseId, partId } = seedCase(1);
    expect(isLimsError(await rejects(call('updateAnatomicPart', { params: { case_id: caseId, part_id: partId }, headers: ifm(1), body })), 'common.validation_failed')).toBe(true);
  });
});

describe('C11-T06 A12 listAnatomicAssignees (ctx.core.memberships.list, 08 A17 D-47)', () => {
  const staff = [
    { membershipId: uid(901), displayName: 'Dr Anna Rai' }, { membershipId: uid(902), displayName: 'dr anil thapa' },
    { membershipId: uid(903), displayName: 'Dr Binod Shrestha' }, { membershipId: uid(904), displayName: '50%_Odd Name' },
  ];
  const list = (query: Row, ctx = mkCtx({ members: staff })) => call('listAnatomicAssignees', { query }, ctx);

  it('without case_id: tenant-wide — memberships.list(permission anatomic.case.signout, activeOnly true, limit 500), NO centreId; maps to { membership_id, display_name }', async () => {
    const r = await list({});
    expect(r.status).toBe(200);
    expect(calls.members).toEqual([{ permission: 'anatomic.case.signout', activeOnly: true, limit: 500 }]);
    expect(r.body.data).toEqual(staff.map((s) => ({ membership_id: s.membershipId, display_name: s.displayName })));
    expect(Object.keys(r.body.data[0]).sort()).toEqual(['display_name', 'membership_id']); // no roleCodes/allCentres leak
  });

  it('with case_id: loads the case through RLS first and passes centreId = case.centre_id; asserts anatomic.case.read at that centre', async () => {
    const { caseId } = seedCase(1);
    await list({ case_id: caseId });
    expect(calls.members).toEqual([{ permission: 'anatomic.case.signout', centreId: CENTRE, activeOnly: true, limit: 500 }]);
    expect(calls.assertRole.some((a) => a['permission'] === 'anatomic.case.read')).toBe(true);
  });

  it('case_id of an invisible case (other centre/tenant) → 404 common.not_found and the memberships are never listed', async () => {
    const { caseId } = seedCase(1);
    S.hidden.add(caseId);
    expect(isLimsError(await rejects(list({ case_id: caseId })), 'common.not_found')).toBe(true);
    expect(calls.members).toEqual([]);
  });

  it('q = case-insensitive PREFIX of display_name (not substring)', async () => {
    expect((await list({ q: 'dr an' })).body.data.map((d: any) => d.display_name)).toEqual(['Dr Anna Rai', 'dr anil thapa']);
    expect((await list({ q: 'ANNA' })).body.data).toEqual([]);
    expect((await list({ q: 'Binod' })).body.data).toEqual([]);
  });

  it('q is a literal prefix: % and _ are not wildcards (REQ-SEC-082); no SQL is issued by the handler for q', async () => {
    expect((await list({ q: '%' })).body.data).toEqual([]);
    expect((await list({ q: '_' })).body.data).toEqual([]);
    expect((await list({ q: '50%_' })).body.data.map((d: any) => d.display_name)).toEqual(['50%_Odd Name']);
    expect(S.sql.filter((s) => /ILIKE|LIKE/i.test(s))).toEqual([]);
  });

  it('limit defaults to 20, caps the result, and is bounded 1…50', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ membershipId: uid(1000 + i), displayName: `Dr Staff ${String(i).padStart(2, '0')}` }));
    const ctx = () => mkCtx({ members: many });
    expect((await list({}, ctx())).body.data).toHaveLength(20);
    expect((await list({ limit: 5 }, ctx())).body.data).toHaveLength(5);
    expect((await list({ limit: 50 }, ctx())).body.data).toHaveLength(50);
    expect((await list({ limit: '7' }, ctx())).body.data).toHaveLength(7); // query strings arrive as strings
    for (const bad of [0, 51, -1, 'abc', '1.5']) expect(isLimsError(await rejects(list({ limit: bad }, ctx())), 'common.validation_failed'), `limit ${bad}`).toBe(true);
  });

  it('limit applies AFTER the q filter (q matches 3 of 80 → 3 rows, not fewer)', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ membershipId: uid(1000 + i), displayName: i < 3 ? `Zed ${i}` : `Dr Staff ${i}` }));
    expect((await list({ q: 'zed', limit: 10 }, mkCtx({ members: many }))).body.data).toHaveLength(3);
  });

  it.each([['q 61 chars', { q: 'x'.repeat(61) }], ['case_id not a uuid', { case_id: 'nope' }], ['unknown query param', { permission: 'anatomic.case.work' }]])('invalid query (%s) → 400', async (_n, query) => {
    expect(isLimsError(await rejects(list(query)), 'common.validation_failed')).toBe(true);
    expect(calls.members).toEqual([]);
  });

  it('q of exactly 60 chars is accepted', async () => {
    expect((await list({ q: 'x'.repeat(60) })).status).toBe(200);
  });

  it('never reads core.memberships itself (no SQL from the handler)', async () => {
    await list({});
    expect(S.sql.filter((s) => /core\.memberships/i.test(s))).toEqual([]);
  });
});

describe('C11-T06 spec wiring (operationId permissions of A4–A7, A12 — AC-02.7 at the route level)', () => {
  it('x-permission: A4–A7 anatomic.case.work, A12 anatomic.case.read (the route-level gate that yields 403 before any handler runs)', async () => {
    const { join } = await import('node:path');
    const { loadSpec, REPO_ROOT } = await import('../../../core/module.js');
    const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'anatomic.yaml'));
    const perm: Record<string, string> = {};
    for (const item of Object.values<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) perm[op.operationId] = op['x-permission'];
    for (const op of ['accessionAnatomicCase', 'updateAnatomicCaseDetails', 'addAnatomicPart', 'updateAnatomicPart']) expect(perm[op], op).toBe('anatomic.case.work');
    expect(perm['listAnatomicAssignees']).toBe('anatomic.case.read');
  });
});
