// C13 T10 (part 2/2) — staff receipt handlers SI1-SI5 (06-IMPLEMENTATION-PLAN row T10): listInboundManifests, getInboundManifest, receiveManifest, retryManifestLineConversion, markManifestLineNotReceived.
// ACs (01-PRD): US-06.1 (receive + not_received, partially_received, one job per received line), US-06.2 (centre C2 -> 404), US-06.6 (retry), US-06.9 (pending-receipt closure, D-104), US-06.10 (tenant B id -> 404),
//               US-06.11 (on_submit: converted line, sample did not arrive -> sample_missing + filter has_missing_samples); 07-SECURITY ST3 (centre probes C1 vs C2), ST10 (replay / double receive: no duplicate jobs), AB15, no PHI in logs.
// Spec: 02-TRD §5.3 SI1-SI5; 03-APP-FLOW §2.1 (MS6-MS8, "Pending receipt"), §2.2 (LS3, LS4, LS7, LS8), §4.2 (SI3 algorithm, retry), 05-SCHEMA (manifest_lines checks, line_not_received_reasons), 02-TRD §13 access-log table (SI2 patient.view / manifest).
//
// Interface expected from the writer (SEAM = not fixed by the spec; the writer follows it or raises a dispute):
//   ../handlers/{listInboundManifests,getInboundManifest,receiveManifest,retryManifestLineConversion,markManifestLineNotReceived}.ts: one named `Handler` export per operationId (same names), wired in manifest.handlers. req = {params, query, headers, body}
//        (params {manifest_id} for SI2/SI3, {line_id} for SI4/SI5; `if-match` header = '"<version>"' as in manifest-drafting.test.ts). Result {status, body}. Query values arrive coerced (numbers, booleans) as in T08.
//   SEAM SQL: the single-table subset of manifest-drafting.world.ts (no JOIN / sub-select / EXISTS). Staff statements are written UNQUALIFIED by centre: the RLS of the staff claims scopes them (the world injects `receiving_centre_id = ANY(...)`).
//        SI1 filters over lines (has_failed_lines, has_missing_samples) therefore read the lines first and the manifests by `id = ANY($n)` (or any other single-table way); partner block via partners.partners.
//   SEAM gate order: actor must be staff -> manifest/line load under RLS (invisible = 404 common.not_found) -> IdentityPort.assertRole({permission: 'partners.manifest.receive', centreId: <receiving centre of the manifest/line>}) -> If-Match shape (428
//        common.precondition_required) -> version (409 common.version_conflict) -> state (409) -> body (400 common.validation_failed) -> per-line checks (422) -> writes. SI1 only asserts the permission (no centre).
//   SEAM SI3: body {lines: [{line_id, outcome: 'received'|'not_received', reason_code?}]} 1..200, no repeated line_id (400|422); reason_code required iff not_received and a code of set line_not_received_reasons (partners.g_cs_reasons), else 400.
//        The whole request is validated first: a line id that is not in the manifest, or a line that is not *pending receipt* (domain/manifest.state.ts isPendingReceipt) -> 422 partners.manifest_invalid, errors[] = every offending line
//        {path: '/lines/<i>/…' (i = 0-based index in the request), code}, NOTHING written, nothing enqueued. Manifest must be submitted | partially_received (else 409 partners.manifest_invalid_transition); the partner may be suspended.
//        on_receipt: received -> line converting, conversion_attempt 1, sample_received_at = ctx.now(), received_by = actor id, ONE `SELECT app.enqueue_job('partners.convert_manifest_line', $payload::jsonb, $key)` per such line (payload {tenant_id, line_id,
//        attempt: 1}, key convert:<line_id>:1); not_received -> line not_received + not_received_reason_code. on_submit: received -> ONLY sample_received_at / received_by (state unchanged, NO job); not_received -> ONLY sample_missing = true + reason (state kept).
//        Manifest recomputed with domain stateAfterReceipt over ALL its lines after the writes: partially_received while some line is pending, else received with received_at = ctx.now(), received_by = actor id; version + 1 either way. 200 InboundManifest.
//   SEAM SI4: body {patient_id?: uuid}; line must be conversion_failed else 409 partners.manifest_line_invalid_transition; sets state converting, conversion_attempt + 1, failure_code = NULL, failed_at = NULL, resolved_patient_id = patient_id when given
//        (kept otherwise), version + 1, updated_by; enqueues convert:<line_id>:<attempt> {tenant_id, line_id, attempt}; the handler calls NO port (C4 validates the patient at conversion). 202 ManifestLine.
//   SEAM SI5: body {reason_code}; allowed for a pending line (on_receipt: submitted -> not_received (LS4); conversion_failed -> not_received (LS8) with failure_code / failed_at cleared; on_submit: sets sample_missing + reason, state kept, order kept);
//        any other line -> 409 partners.manifest_line_invalid_transition; manifest recomputed as SI3 (MS7/MS8). 200 ManifestLine.
//   SEAM SI2: read-only; access log AFTER the read: ctx.audit.access({action: 'patient.view', entityType: 'manifest', entityId: <manifest id>, outcome: 'allowed'}) once per successful call, none on 404, request fails if audit.access rejects.
//   DTO: InboundManifest = Manifest DTO (T09 allowlist MF_KEYS) + `partner {id, partner_code, name}` (+ staff audit fields received_by/created_by/submitted_by); lines = ManifestLine DTO incl. patient block, clinical_note, notes (staff need them, D-102),
//        order {order_id, registration_no}, failure {code}, not_received_reason_code, and may add sample_received_at / sample_missing. Never tenant_id, orderables_snapshot, is_redacted, is_active, credit_party_id.
//   Spec conflict noted: US-06.1 says L1/L2 received + L3 not_received -> manifest partially_received, but US-06.9 / MS7 / D-104 (newer) close the manifest when no line is pending. The tests use a 4th, untouched line for partially_received and
//        a separate case for "all lines handled -> received".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { getInboundManifest } from '../handlers/getInboundManifest.js';
import { listInboundManifests } from '../handlers/listInboundManifests.js';
import { markManifestLineNotReceived } from '../handlers/markManifestLineNotReceived.js';
import { receiveManifest } from '../handlers/receiveManifest.js';
import { retryManifestLineConversion } from '../handlers/retryManifestLineConversion.js';
import { withdrawManifest } from '../handlers/withdrawManifest.js';
import { manifest } from '../index.js';
import { CE, CP, id, jobsOf, L, M, makeCtx9, makePartnerCtx, makeStaffCtx, makeWorld10, NOT_RECEIVED_REASONS, OR, P, PT, release, releaseLocks, STAFF_ID, T_A, USERS, type Row, type StaffOver, type World10 } from './conversion.world.js';

const RECEIVE = 'partners.manifest.receive';
const NOW = '2026-11-13T00:00:00.000Z';
const MF_KEYS = ['id', 'manifest_no', 'state', 'line_count', 'lines_converted', 'lines_failed', 'receiving_centre', 'submitted_at', 'received_at', 'pickup_request_id', 'created_at', 'version', 'notes', 'collected_on', 'withdraw_reason_code', 'lines',
  'partner', 'received_by', 'created_by', 'submitted_by'];
const SUMMARY_KEYS = ['id', 'manifest_no', 'state', 'line_count', 'lines_converted', 'lines_failed', 'receiving_centre', 'submitted_at', 'received_at', 'pickup_request_id', 'created_at', 'version', 'partner', 'received_by', 'created_by', 'submitted_by'];
const LEAKY = ['tenant_id', 'orderables_snapshot', 'is_redacted', 'is_active', 'credit_party_id'];
const PHI = ['Synthetic Patient R1', 'Synthetic Patient R2', 'Synthetic note for the lab', 'SYN-R1'];

const IFM = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const req = (o: { manifest_id?: string; line_id?: string; headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}) =>
  ({ params: { ...(o.manifest_id ? { manifest_id: o.manifest_id } : {}), ...(o.line_id ? { line_id: o.line_id } : {}) }, query: o.query ?? {}, headers: o.headers ?? {}, body: o.body });
type Out = { status: number; body: any };
const call = (h: (r: any, c: any) => Promise<unknown>, ctx: any, r: unknown) => (h(r, ctx) as Promise<Out>).finally(() => release(ctx));
const fails = async (p: Promise<unknown>, code: string, status: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe(code); expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const settle = (p: Promise<Out>) => p.then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e: e as LimsError }));
const writes = (w: World10, n: number) => w.log.slice(n).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text));
const quiet = (w: World10, n: number, jobs = 0) => { expect(writes(w, n)).toEqual([]); expect(w.jobs).toHaveLength(jobs); };
const keysWithin = (o: object, allowed: string[]) => { for (const k of Object.keys(o)) expect(allowed, `unexpected key ${k}`).toContain(k); };
const noLeak = (o: object) => { for (const k of LEAKY) expect(JSON.stringify(o)).not.toContain(`"${k}"`); };
const noPhi = (o: unknown) => { const s = typeof o === 'string' ? o : JSON.stringify(o); for (const p of PHI) expect(s).not.toContain(p); };
const man = (w: World10, mid: string) => w.manifests.find((m) => m['id'] === mid)!;
const line = (w: World10, lid: string) => w.lines.find((l) => l['id'] === lid)!;
const iso = (d: unknown) => new Date(d as any).toISOString();
const errPaths = (e: any) => (e.errors ?? []).map((x: Row) => String(x['path']));

/** on_receipt manifest of partner X at centre C1, four lines `submitted`. */
function recv(over: Row = {}, lineOver: Row[] = [{}, {}, {}, {}]) {
  const w = makeWorld10();
  const m = w.mkManifest({ state: 'submitted', version: 4, line_count: lineOver.length, submitted_by: USERS.x1.actor, notes: 'Synthetic manifest note', ...over });
  const ls = lineOver.map((o, i) => w.mkLine(m['id'], { state: 'submitted', partner_sample_ref: `SYN-R${i + 1}`, patient_full_name: `Synthetic Patient R${i + 1}`, clinical_note: i === 0 ? 'Synthetic note for the lab' : null, ...o }));
  return { w, m, ls };
}
/** on_submit manifest of partner Y at centre C2: converting / converted / conversion_failed / converting lines. */
function sub(over: Row = {}) {
  const w = makeWorld10();
  const m = w.mkManifest({ partner_id: P.y, state: 'submitted', version: 3, line_count: 4, submitted_by: USERS.y1.actor, ...over });
  const conv = { conversion_attempt: 1 };
  const ls = [
    w.mkLine(m['id'], { state: 'converting', ...conv, partner_sample_ref: 'SYN-S1' }),
    w.mkLine(m['id'], { state: 'converted', ...conv, partner_sample_ref: 'SYN-S2', order_id: id(7301), registration_no: '0001SY000301', converted_at: new Date('2026-11-12T01:00:00Z') }),
    w.mkLine(m['id'], { state: 'conversion_failed', ...conv, partner_sample_ref: 'SYN-S3', failure_code: 'catalog.no_price', failed_at: new Date('2026-11-12T01:00:00Z') }),
    w.mkLine(m['id'], { state: 'converting', ...conv, partner_sample_ref: 'SYN-S4' }),
  ];
  return { w, m, ls };
}
const staff = (w: World10, o: StaffOver = {}) => makeStaffCtx(w, o);
const body = (...lines: Array<[string, 'received' | 'not_received', string?]>) => ({ lines: lines.map(([line_id, outcome, reason_code]) => ({ line_id, outcome, ...(reason_code ? { reason_code } : {}) })) });
const doReceive = (w: World10, mid: string, b: unknown, o: { v?: number; ctx?: StaffOver; headers?: Record<string, string> } = {}) => {
  const s = staff(w, o.ctx ?? { centres: [CE.a1] });
  return { s, p: call(receiveManifest, s.ctx, req({ manifest_id: mid, headers: o.headers ?? IFM(o.v ?? man(w, mid)['version']), body: b })) };
};

describe('T10 wiring + contract', () => {
  it('SI1-SI5 are wired to the handlers (T01 stubs replaced)', () => {
    for (const [op, h] of Object.entries({ listInboundManifests, getInboundManifest, receiveManifest, retryManifestLineConversion, markManifestLineNotReceived })) { expect(typeof h).toBe('function'); expect(manifest.handlers[op]).toBe(h); }
  });
  it('contract: all five need partners.manifest.receive; receive + retry require an Idempotency-Key, list / get need none; list has the D-104 filters', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../../../../../contracts/openapi/partners.yaml', import.meta.url)), 'utf8');
    const block = (op: string) => { const s = yaml.indexOf(`operationId: ${op}`); expect(s).toBeGreaterThan(0); const n = yaml.indexOf('operationId:', s + 10); return yaml.slice(s, n < 0 ? undefined : n); };
    for (const op of ['listInboundManifests', 'getInboundManifest', 'receiveManifest', 'retryManifestLineConversion', 'markManifestLineNotReceived']) expect(block(op)).toMatch(/x-permission: partners\.manifest\.receive/);
    expect(block('receiveManifest')).toMatch(/x-idempotency: required/); expect(block('retryManifestLineConversion')).toMatch(/x-idempotency: required/);
    expect(block('listInboundManifests')).toMatch(/x-idempotency: none/); expect(block('getInboundManifest')).toMatch(/x-idempotency: none/); expect(block('markManifestLineNotReceived')).toMatch(/x-idempotency: (none|optional)/);
    expect(block('listInboundManifests')).toMatch(/has_missing_samples/); expect(block('listInboundManifests')).toMatch(/has_failed_lines/);
  });
});

describe('T10 SI3 receiveManifest — mode on_receipt (US-06.1, LS3/LS4, MS6)', () => {
  it('L1, L2 received + L3 not_received (sample_missing) + L4 untouched: 200, manifest partially_received, one job per received line, L4 unchanged, assertRole on the manifest centre', async () => {
    const { w, m, ls } = recv(); const s = staff(w, { centres: [CE.a1] });
    const r = await call(receiveManifest, s.ctx, req({ manifest_id: m['id'], headers: IFM(4), body: body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'received'], [ls[2]!['id'], 'not_received', 'sample_missing']) }));
    expect(r.status).toBe(200);
    expect(man(w, m['id'])).toMatchObject({ state: 'partially_received', version: 5, received_at: null });
    for (const i of [0, 1]) { expect(line(w, ls[i]!['id'])).toMatchObject({ state: 'converting', conversion_attempt: 1, received_by: STAFF_ID, not_received_reason_code: null, sample_missing: false, order_id: null }); expect(iso(line(w, ls[i]!['id'])['sample_received_at'])).toBe(NOW); }
    expect(line(w, ls[2]!['id'])).toMatchObject({ state: 'not_received', not_received_reason_code: 'sample_missing', sample_received_at: null, conversion_attempt: 0 });
    expect(line(w, ls[3]!['id'])).toMatchObject({ state: 'submitted', sample_received_at: null, not_received_reason_code: null, conversion_attempt: 0 });
    const jobs = jobsOf(w); expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => [j.task, j.key]).sort()).toEqual([0, 1].map((i) => ['partners.convert_manifest_line', `convert:${ls[i]!['id']}:1`]).sort());
    for (const j of jobs) expect(j.payload).toEqual({ tenant_id: T_A, line_id: expect.any(String), attempt: 1 });
    expect(r.body).toMatchObject({ id: m['id'], state: 'partially_received', version: 5, line_count: 4, lines_converted: 0, lines_failed: 0 });
    expect(r.body).not.toHaveProperty('received_at'); // 02-CONVENTIONS:474 omit optional fields; InboundManifest.received_at is non-nullable IsoUtc (C13.T10 ruling)
    expect(r.body.lines.map((l: Row) => l['state'])).toEqual(['converting', 'converting', 'not_received', 'submitted']);
    expect(r.body.lines[2].not_received_reason_code).toBe('sample_missing');
    expect(r.body.partner).toEqual({ id: P.x, partner_code: 'SYN-X', name: 'Synthetic Partner SYN-X' });
    keysWithin(r.body, MF_KEYS); noLeak(r.body);
    expect(s.roleCalls.some((c) => c.permission === RECEIVE && c.centreId === CE.a1)).toBe(true);
  });
  it('US-06.9 closure: every line handled -> manifest received (received_at now, received_by actor); a later call that handles the last pending line closes a partially_received manifest (MS7)', async () => {
    const { w, m, ls } = recv();
    const a = await doReceive(w, m['id'], body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'received'], [ls[2]!['id'], 'not_received', 'wrong_container'])).p; expect(a.body.state).toBe('partially_received');
    const b = await doReceive(w, m['id'], body([ls[3]!['id'], 'received'])).p;
    expect(b.status).toBe(200); expect(b.body.state).toBe('received'); expect(b.body.version).toBe(6);
    expect(man(w, m['id'])).toMatchObject({ state: 'received', received_by: STAFF_ID, version: 6 }); expect(iso(man(w, m['id'])['received_at'])).toBe(NOW);
    expect(jobsOf(w)).toHaveLength(3); expect(new Set(jobsOf(w).map((j) => j.key)).size).toBe(3);
  });
  it('all lines not_received (every reason of the set is accepted) -> manifest received, no job', async () => {
    const { w, m, ls } = recv({}, NOT_RECEIVED_REASONS.map(() => ({})));
    const r = await doReceive(w, m['id'], { lines: ls.map((l, i) => ({ line_id: l['id'], outcome: 'not_received', reason_code: NOT_RECEIVED_REASONS[i] })) }).p;
    expect(r.body.state).toBe('received'); expect(w.jobs).toEqual([]); ls.forEach((l, i) => expect(line(w, l['id'])).toMatchObject({ state: 'not_received', not_received_reason_code: NOT_RECEIVED_REASONS[i] }));
  });
  it('a suspended partner\'s submitted manifest can still be received (DECISION, SI3 step 2)', async () => {
    const { w, m, ls } = recv({ partner_id: P.s }); const r = await doReceive(w, m['id'], body([ls[0]!['id'], 'received'])).p;
    expect(r.status).toBe(200); expect(line(w, ls[0]!['id'])['state']).toBe('converting'); expect(jobsOf(w)).toHaveLength(1);
  });
  it('planted body fields (state, received_by, received_at, version, partner_id, tenant_id, per-line state / order_id) never reach a column', async () => {
    const { w, m, ls } = recv(); const b: any = body([ls[0]!['id'], 'received']);
    Object.assign(b, { state: 'received', received_by: id(77), received_at: '2026-01-01T00:00:00Z', version: 99, partner_id: P.y, tenant_id: id(2) }); Object.assign(b.lines[0], { state: 'converted', order_id: id(7777), received_by: id(77), conversion_attempt: 9 });
    const out = await settle(doReceive(w, m['id'], b).p);
    if (!out.ok) { expect(out.e.statusCode).toBe(400); expect(man(w, m['id'])['state']).toBe('submitted'); return; }
    expect(man(w, m['id'])).toMatchObject({ state: 'partially_received', partner_id: P.x, version: 5, received_at: null, received_by: null });
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'converting', order_id: null, received_by: STAFF_ID, conversion_attempt: 1 });
  });
});

describe('T10 SI3 receiveManifest — mode on_submit (D-104): receipt flags only', () => {
  it('received sets sample_received_at / received_by only (state kept, NO job); not_received sets sample_missing + reason (state, failure and order kept); pending lines keep the manifest partially_received', async () => {
    const { w, m, ls } = sub(); const s = staff(w, { centres: [CE.a2] });
    const r = await call(receiveManifest, s.ctx, req({ manifest_id: m['id'], headers: IFM(3), body: body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'received'], [ls[2]!['id'], 'not_received', 'label_unreadable']) }));
    expect(r.status).toBe(200); expect(r.body.state).toBe('partially_received');
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'converting', received_by: STAFF_ID, sample_missing: false, conversion_attempt: 1 }); expect(iso(line(w, ls[0]!['id'])['sample_received_at'])).toBe(NOW);
    expect(line(w, ls[1]!['id'])).toMatchObject({ state: 'converted', received_by: STAFF_ID, order_id: id(7301), registration_no: '0001SY000301' });
    expect(line(w, ls[2]!['id'])).toMatchObject({ state: 'conversion_failed', failure_code: 'catalog.no_price', sample_missing: true, not_received_reason_code: 'label_unreadable', sample_received_at: null });
    expect(line(w, ls[3]!['id'])).toMatchObject({ state: 'converting', sample_received_at: null, sample_missing: false });
    expect(w.jobs).toEqual([]);
  });
  it('US-06.11: a converted line whose sample did not arrive keeps its order and gets sample_missing + reason; it shows up under has_missing_samples; the last pending line closes the manifest', async () => {
    const { w, m, ls } = sub();
    await doReceive(w, m['id'], body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'not_received', 'sample_missing'], [ls[2]!['id'], 'received']), { ctx: { centres: [CE.a2] } }).p;
    expect(line(w, ls[1]!['id'])).toMatchObject({ state: 'converted', order_id: id(7301), sample_missing: true, not_received_reason_code: 'sample_missing' });
    const lst = await call(listInboundManifests, staff(w, { centres: [CE.a2] }).ctx, req({ query: { has_missing_samples: true } })); expect(lst.body.data.map((x: Row) => x['id'])).toEqual([m['id']]);
    const last = await doReceive(w, m['id'], body([ls[3]!['id'], 'received']), { ctx: { centres: [CE.a2] } }).p;
    expect(last.body.state).toBe('received'); expect(man(w, m['id'])).toMatchObject({ state: 'received', received_by: STAFF_ID });
    expect((await call(listInboundManifests, staff(w, { centres: [CE.a2] }).ctx, req({ query: { state: 'received', has_missing_samples: true } }))).body.data).toHaveLength(1);
    expect(w.jobs).toEqual([]);
  });
});

describe('T10 SI3 receiveManifest — validation, preconditions, races', () => {
  it('422 partners.manifest_invalid lists EVERY offending line (foreign line id, line not pending); the whole request is rejected: nothing written, no job, the valid line stays submitted', async () => {
    const { w, m, ls } = recv(); await doReceive(w, m['id'], body([ls[0]!['id'], 'received'])).p;
    const n = w.log.length; const jobs = w.jobs.length;
    const e: any = await fails(doReceive(w, m['id'], body([ls[1]!['id'], 'received'], [ls[0]!['id'], 'received'], [L.xs, 'received']), { v: 5 }).p, 'partners.manifest_invalid', 422);
    expect(errPaths(e).sort()).toEqual([expect.stringMatching(/^\/lines\/1(\/|$)/), expect.stringMatching(/^\/lines\/2(\/|$)/)]);
    expect(writes(w, n)).toEqual([]); expect(w.jobs).toHaveLength(jobs); expect(line(w, ls[1]!['id'])['state']).toBe('submitted');
  });
  it('a line of ANOTHER manifest (also another tenant) in the request -> 422 for that line, nothing changes in the other manifest / tenant B', async () => {
    const { w, m, ls } = recv(); const bm = w.mkManifest({ partner_id: P.b, state: 'submitted', version: 2, line_count: 1 }); const bl = w.mkLine(bm['id'], { state: 'submitted' });
    const snapB = JSON.stringify([bm, bl]); const snapX = JSON.stringify(line(w, L.xs));
    const e: any = await fails(doReceive(w, m['id'], body([ls[0]!['id'], 'received'], [bl['id'], 'received'], [L.xs, 'received'], [id(7999), 'received'])).p, 'partners.manifest_invalid', 422);
    expect(errPaths(e).sort()).toEqual([expect.stringMatching(/^\/lines\/1(\/|$)/), expect.stringMatching(/^\/lines\/2(\/|$)/), expect.stringMatching(/^\/lines\/3(\/|$)/)]);
    expect(JSON.stringify([bm, bl])).toBe(snapB); expect(JSON.stringify(line(w, L.xs))).toBe(snapX); expect(line(w, ls[0]!['id'])['state']).toBe('submitted'); expect(w.jobs).toEqual([]);
  });
  it('two staff tabs: the same request twice at once (same If-Match) -> exactly one 200, the other 409/422; ONE job per line; sequentially with a fresh If-Match the second is 422 (line no longer pending), still no second job', async () => {
    const { w, m, ls } = recv(); const b = body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'received']);
    const [x, y] = await Promise.all([settle(doReceive(w, m['id'], b, { v: 4 }).p), settle(doReceive(w, m['id'], b, { v: 4 }).p)]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1); const loser: any = x.ok ? (y as any).e : (x as any).e; expect([409, 422]).toContain(loser.statusCode);
    expect(jobsOf(w)).toHaveLength(2); expect(new Set(jobsOf(w).map((j) => j.key)).size).toBe(2);
    const n = w.log.length; await fails(doReceive(w, m['id'], b).p, 'partners.manifest_invalid', 422); expect(writes(w, n)).toEqual([]); expect(jobsOf(w)).toHaveLength(2);
  });
  it.each([
    ['missing body', undefined], ['no lines key', {}], ['empty lines', { lines: [] }], ['201 lines', { lines: Array.from({ length: 201 }, (_, i) => ({ line_id: id(8000 + i), outcome: 'received' })) }],
    ['unknown outcome', { lines: [{ line_id: id(5000), outcome: 'lost' }] }], ['line_id not a uuid', { lines: [{ line_id: 'nope', outcome: 'received' }] }],
    ['not_received without reason', { lines: [{ line_id: id(5000), outcome: 'not_received' }] }], ['reason on a received line', { lines: [{ line_id: id(5000), outcome: 'received', reason_code: 'sample_missing' }] }],
    ['unknown reason code', { lines: [{ line_id: id(5000), outcome: 'not_received', reason_code: 'nope' }] }], ['lines not an array', { lines: 'x' }],
  ])('400 common.validation_failed before any write: %s', async (_n, b) => {
    const { w, m } = recv(); const n = w.log.length;
    await fails(doReceive(w, m['id'], b as any).p, 'common.validation_failed', 400); expect(writes(w, n)).toEqual([]); expect(w.jobs).toEqual([]);
  });
  it('the same line twice in one request is rejected (400|422), nothing written', async () => {
    const { w, m, ls } = recv(); const n = w.log.length; const out = await settle(doReceive(w, m['id'], body([ls[0]!['id'], 'received'], [ls[0]!['id'], 'not_received', 'sample_missing'])).p);
    expect(out.ok).toBe(false); expect([400, 422]).toContain((out as any).e.statusCode); expect(writes(w, n)).toEqual([]); expect(w.jobs).toEqual([]);
  });
  it('If-Match: missing -> 428 common.precondition_required, stale -> 409 common.version_conflict; nothing written', async () => {
    const { w, m, ls } = recv(); const n = w.log.length; const b = body([ls[0]!['id'], 'received']);
    await fails(doReceive(w, m['id'], b, { headers: {} }).p, 'common.precondition_required', 428); await fails(doReceive(w, m['id'], b, { v: 3 }).p, 'common.version_conflict', 409); quiet(w, n);
  });
  it.each(['received', 'withdrawn'])('manifest in state %s -> 409 partners.manifest_invalid_transition, nothing written', async (state) => {
    const { w, m, ls } = recv({ state }, [{ state: state === 'received' ? 'not_received' : 'withdrawn', not_received_reason_code: state === 'received' ? 'sample_missing' : null }]); const n = w.log.length;
    await fails(doReceive(w, m['id'], body([ls[0]!['id'], 'received'])).p, 'partners.manifest_invalid_transition', 409); quiet(w, n);
  });
  it('race with the partner\'s withdraw (M9): serialised on the manifest row for every interleaving - one wins, the other 409; end state coherent (withdrawn + no job, or received/partially_received + one job per received line)', async () => {
    for (let k = 0; k < 8; k++) for (const first of ['receive', 'withdraw'] as const) {
      const { w, m, ls } = recv(); const rs = staff(w, { centres: [CE.a1] }); const pc = makeCtx9(w, { who: 'x1' });
      const doRecv = async () => { if (first === 'withdraw') for (let i = 0; i < k; i++) await Promise.resolve(); return call(receiveManifest, rs.ctx, req({ manifest_id: m['id'], headers: IFM(4), body: body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'not_received', 'sample_missing']) })); };
      const doWd = async () => { if (first === 'receive') for (let i = 0; i < k; i++) await Promise.resolve(); return (withdrawManifest(req({ manifest_id: m['id'], headers: IFM(4), body: { reason_code: 'entered_in_error' } }) as any, pc.ctx) as Promise<Out>).finally(() => releaseLocks(pc.ctx.tx)); };
      const [a, b] = await Promise.all([settle(doRecv()), settle(doWd())]);
      expect([a.ok, b.ok].filter(Boolean), `k=${k} first=${first}`).toHaveLength(1);
      const loser: any = a.ok ? (b as any).e : (a as any).e; expect(loser.statusCode).toBe(409); expect(['common.version_conflict', 'partners.manifest_invalid_transition']).toContain(loser.code);
      if (b.ok) { expect(man(w, m['id'])['state']).toBe('withdrawn'); expect(w.lines.filter((l) => l['manifest_id'] === m['id']).every((l) => l['state'] === 'withdrawn')).toBe(true); expect(w.jobs).toEqual([]); }
      else { expect(man(w, m['id'])['state']).toBe('partially_received'); expect(w.lines.filter((l) => l['manifest_id'] === m['id']).map((l) => l['state'])).toEqual(['converting', 'not_received', 'submitted', 'submitted']); expect(jobsOf(w)).toHaveLength(1); }
    }
  });
});

describe('T10 SI3 / SI2 / SI4 / SI5 — centre, tenant and permission probes (US-06.2, US-06.10, ST3, AB15)', () => {
  it('staff scoped only to C2: receive / open a manifest of C1 -> 404 common.not_found, nothing written, no job, no access-log row; staff with all centres and staff of C1 reach it', async () => {
    const { w, m, ls } = recv(); const n = w.log.length;
    await fails(doReceive(w, m['id'], body([ls[0]!['id'], 'received']), { ctx: { centres: [CE.a2] } }).p, 'common.not_found', 404); quiet(w, n);
    const s2 = staff(w, { centres: [CE.a2] }); await fails(call(getInboundManifest, s2.ctx, req({ manifest_id: m['id'] })), 'common.not_found', 404); expect(s2.audit).toEqual([]);
    expect((await call(getInboundManifest, staff(w, { centres: [CE.a1] }).ctx, req({ manifest_id: m['id'] }))).status).toBe(200);
    expect((await call(getInboundManifest, staff(w, { centres: 'all' }).ctx, req({ manifest_id: m['id'] }))).status).toBe(200);
    expect((await doReceive(w, m['id'], body([ls[0]!['id'], 'received']), { ctx: { centres: 'all' } }).p).status).toBe(200);
  });
  it('the other direction: C1-only staff cannot reach a manifest / line of C2 (SI2, SI3, SI4, SI5)', async () => {
    const { w, m, ls } = sub(); const n = w.log.length; const c1 = () => staff(w, { centres: [CE.a1] });
    await fails(call(getInboundManifest, c1().ctx, req({ manifest_id: m['id'] })), 'common.not_found', 404);
    await fails(doReceive(w, m['id'], body([ls[0]!['id'], 'received']), { ctx: { centres: [CE.a1] } }).p, 'common.not_found', 404);
    await fails(call(retryManifestLineConversion, c1().ctx, req({ line_id: ls[2]!['id'], headers: IFM(1), body: {} })), 'common.not_found', 404);
    await fails(call(markManifestLineNotReceived, c1().ctx, req({ line_id: ls[1]!['id'], headers: IFM(1), body: { reason_code: 'sample_missing' } })), 'common.not_found', 404);
    quiet(w, n);
  });
  it('tenant B: a manifest / line id of tenant B used by tenant A staff (even with all centres) -> 404 and tenant B is untouched', async () => {
    const { w } = recv(); const bm = w.mkManifest({ partner_id: P.b, state: 'submitted', version: 2, line_count: 1 }); const bl = w.mkLine(bm['id'], { state: 'conversion_failed', failure_code: 'catalog.no_price', conversion_attempt: 1 });
    const snap = JSON.stringify([w.manifests.filter((x) => x['tenant_id'] !== T_A), w.lines.filter((x) => x['tenant_id'] !== T_A)]); const all = () => staff(w, { centres: 'all' });
    await fails(call(getInboundManifest, all().ctx, req({ manifest_id: bm['id'] })), 'common.not_found', 404);
    await fails(doReceive(w, bm['id'], body([bl['id'], 'received']), { v: 2, ctx: { centres: 'all' } }).p, 'common.not_found', 404);
    await fails(call(retryManifestLineConversion, all().ctx, req({ line_id: bl['id'], headers: IFM(1), body: {} })), 'common.not_found', 404);
    await fails(call(markManifestLineNotReceived, all().ctx, req({ line_id: bl['id'], headers: IFM(1), body: { reason_code: 'sample_missing' } })), 'common.not_found', 404);
    expect(JSON.stringify([w.manifests.filter((x) => x['tenant_id'] !== T_A), w.lines.filter((x) => x['tenant_id'] !== T_A)])).toBe(snap); expect(w.jobs).toEqual([]);
  });
  it('without partners.manifest.receive -> 403 auth.forbidden for every operation (staff without the permission, and a partner user); nothing written', async () => {
    const { w, m, ls } = sub(); const n = w.log.length; const noPerm = () => staff(w, { centres: 'all', staffPerms: ['partners.partner.read'] });
    const ops: Array<[(r: any, c: any) => Promise<unknown>, unknown]> = [[listInboundManifests, req({})], [getInboundManifest, req({ manifest_id: m['id'] })],
      [receiveManifest, req({ manifest_id: m['id'], headers: IFM(3), body: body([ls[0]!['id'], 'received']) })], [retryManifestLineConversion, req({ line_id: ls[2]!['id'], headers: IFM(1), body: {} })],
      [markManifestLineNotReceived, req({ line_id: ls[1]!['id'], headers: IFM(1), body: { reason_code: 'sample_missing' } })]];
    for (const [h, r] of ops) {
      await fails(call(h, noPerm().ctx, r), 'auth.forbidden', 403);
      const pc = makePartnerCtx(w, 'y1'); await fails(call(h, pc.ctx, r), 'auth.forbidden', 403);
    }
    quiet(w, n);
  });
});

describe('T10 SI4 retryManifestLineConversion (US-06.6, LS7)', () => {
  const failed = (over: Row = {}) => recv({ state: 'partially_received', version: 6 }, [{ state: 'conversion_failed', conversion_attempt: 1, failure_code: 'frontdesk.patient_duplicate_suspected', failed_at: new Date('2026-11-12T01:00:00Z'), version: 3, ...over }, {}]);
  const retry = (w: World10, lid: string, b: unknown, o: { v?: number | string; headers?: Record<string, string>; ctx?: StaffOver } = {}) => {
    const s = staff(w, o.ctx ?? { centres: [CE.a1] }); return { s, p: call(retryManifestLineConversion, s.ctx, req({ line_id: lid, headers: o.headers ?? IFM(o.v ?? line(w, lid)['version']), body: b })) };
  };
  it('202 ManifestLine (converting): attempt + 1, failure cleared, resolved_patient_id from the body, version + 1, updated_by staff, ONE job convert:<line>:2; manifest untouched; no port call', async () => {
    const { w, m, ls } = failed(); const mBefore = JSON.stringify(man(w, m['id'])); const { s, p } = retry(w, ls[0]!['id'], { patient_id: PT }, { v: 3 }); const r = await p;
    expect(r.status).toBe(202); expect(r.body).toMatchObject({ id: ls[0]!['id'], state: 'converting', version: 4 }); noLeak(r.body);
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'converting', conversion_attempt: 2, failure_code: null, failed_at: null, resolved_patient_id: PT, version: 4, updated_by: STAFF_ID });
    expect(jobsOf(w)).toEqual([{ task: 'partners.convert_manifest_line', key: `convert:${ls[0]!['id']}:2`, payload: { tenant_id: T_A, line_id: ls[0]!['id'], attempt: 2 } }]);
    expect(JSON.stringify(man(w, m['id']))).toBe(mBefore); expect(Object.keys(s.ctx.ports)).toEqual(['IdentityPort']);
    expect(s.roleCalls.every((c) => c.permission === RECEIVE && (c.centreId === undefined || c.centreId === CE.a1))).toBe(true);
  });
  it('without patient_id the previously resolved patient (or none) is kept', async () => {
    const a = failed(); await retry(a.w, a.ls[0]!['id'], {}).p; expect(line(a.w, a.ls[0]!['id'])).toMatchObject({ state: 'converting', conversion_attempt: 2, resolved_patient_id: null });
    const b = failed({ resolved_patient_id: PT }); await retry(b.w, b.ls[0]!['id'], {}).p; expect(line(b.w, b.ls[0]!['id'])['resolved_patient_id']).toBe(PT);
  });
  it.each(['submitted', 'converting', 'converted', 'not_received', 'cancelled', 'withdrawn'])('a %s line cannot be retried: 409 partners.manifest_line_invalid_transition, nothing written, no job', async (state) => {
    const extra: Row = state === 'converted' || state === 'cancelled' ? { order_id: id(7400), registration_no: '0001SY000400', converted_at: new Date(NOW) } : state === 'not_received' ? { not_received_reason_code: 'sample_missing' } : {};
    const { w, ls } = recv({ state: 'partially_received', version: 6 }, [{ state, conversion_attempt: state === 'submitted' ? 0 : 1, ...extra }, {}]); const n = w.log.length;
    await fails(retry(w, ls[0]!['id'], {}).p, 'partners.manifest_line_invalid_transition', 409); quiet(w, n);
  });
  it('If-Match = line version: missing 428, stale 409; patient_id must be a uuid (400); two concurrent retries with the same If-Match -> one 202, one 409, ONE job', async () => {
    const { w, ls } = failed(); const n = w.log.length; const lid = ls[0]!['id'];
    await fails(retry(w, lid, {}, { headers: {} }).p, 'common.precondition_required', 428); await fails(retry(w, lid, {}, { v: 2 }).p, 'common.version_conflict', 409);
    await fails(retry(w, lid, { patient_id: 'not-a-uuid' }).p, 'common.validation_failed', 400); await fails(retry(w, lid, { patient_id: 123 }).p, 'common.validation_failed', 400); quiet(w, n);
    const [a, b] = await Promise.all([settle(retry(w, lid, {}, { v: 3 }).p), settle(retry(w, lid, {}, { v: 3 }).p)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1); expect((a.ok ? (b as any).e : (a as any).e).statusCode).toBe(409); expect(jobsOf(w)).toHaveLength(1); expect(line(w, lid)['conversion_attempt']).toBe(2);
  });
  it('planted body fields (state, conversion_attempt, order_id, failure_code) never reach a column', async () => {
    const { w, ls } = failed(); const out = await settle(retry(w, ls[0]!['id'], { patient_id: PT, state: 'converted', conversion_attempt: 9, order_id: id(7777), failure_code: 'x.y' }).p);
    if (!out.ok) { expect(out.e.statusCode).toBe(400); return; }
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'converting', conversion_attempt: 2, order_id: null, failure_code: null });
  });
});

describe('T10 SI5 markManifestLineNotReceived (LS4, LS8, MS7/MS8, US-06.11)', () => {
  const mark = (w: World10, lid: string, b: unknown, o: { v?: number; headers?: Record<string, string>; ctx?: StaffOver } = {}) => {
    const s = staff(w, o.ctx ?? { centres: [CE.a1] }); return { s, p: call(markManifestLineNotReceived, s.ctx, req({ line_id: lid, headers: o.headers ?? IFM(o.v ?? line(w, lid)['version']), body: b })) };
  };
  it('on_receipt, submitted line -> not_received + reason (200 ManifestLine); manifest partially_received while another line is pending, received (received_at / received_by) when none is', async () => {
    const { w, m, ls } = recv({}, [{}, {}]);
    const a = await mark(w, ls[0]!['id'], { reason_code: 'wrong_container' }).p;
    expect(a.status).toBe(200); expect(a.body).toMatchObject({ id: ls[0]!['id'], state: 'not_received', not_received_reason_code: 'wrong_container' }); noLeak(a.body);
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'not_received', not_received_reason_code: 'wrong_container', sample_received_at: null }); expect(man(w, m['id'])['state']).toBe('partially_received');
    await mark(w, ls[1]!['id'], { reason_code: 'leaked_or_broken' }).p;
    expect(man(w, m['id'])).toMatchObject({ state: 'received', received_by: STAFF_ID }); expect(iso(man(w, m['id'])['received_at'])).toBe(NOW); expect(w.jobs).toEqual([]);
  });
  it('on_receipt, conversion_failed line -> not_received (LS8): failure_code / failed_at cleared (schema check), manifest recomputed', async () => {
    const { w, m, ls } = recv({ state: 'partially_received', version: 6 }, [{ state: 'conversion_failed', conversion_attempt: 1, failure_code: 'catalog.no_price', failed_at: new Date(NOW) }, { state: 'not_received', not_received_reason_code: 'sample_missing' }]);
    await mark(w, ls[0]!['id'], { reason_code: 'test_not_available' }).p;
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'not_received', not_received_reason_code: 'test_not_available', failure_code: null, failed_at: null }); expect(man(w, m['id'])['state']).toBe('received');
  });
  it('on_submit, converted line (US-06.11) -> state converted kept, order kept, sample_missing + reason; filter has_missing_samples finds it; closes the manifest when nothing else is pending', async () => {
    const { w, m, ls } = sub(); for (const i of [0, 2, 3]) line(w, ls[i]!['id'])['sample_received_at'] = new Date('2026-11-12T10:00:00Z');
    const r = await mark(w, ls[1]!['id'], { reason_code: 'sample_missing' }, { ctx: { centres: [CE.a2] } }).p;
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ state: 'converted' });
    expect(line(w, ls[1]!['id'])).toMatchObject({ state: 'converted', order_id: id(7301), registration_no: '0001SY000301', sample_missing: true, not_received_reason_code: 'sample_missing' });
    expect(man(w, m['id'])['state']).toBe('received');
    expect((await call(listInboundManifests, staff(w, { centres: [CE.a2] }).ctx, req({ query: { state: 'received', has_missing_samples: true } }))).body.data.map((x: Row) => x['id'])).toEqual([m['id']]);
  });
  it.each([['on_receipt line converting', 'recv', { state: 'converting', conversion_attempt: 1 }], ['on_receipt line converted', 'recv', { state: 'converted', conversion_attempt: 1, order_id: id(7500), registration_no: '0001SY000500', converted_at: new Date(NOW) }],
    ['on_receipt line already not_received', 'recv', { state: 'not_received', not_received_reason_code: 'sample_missing' }],
    ['on_submit line already received', 'sub', { sample_received_at: new Date(NOW), received_by: STAFF_ID }], ['on_submit line already sample_missing', 'sub', { sample_missing: true, not_received_reason_code: 'sample_missing' }]] as const)(
    '409 partners.manifest_line_invalid_transition: %s; nothing written', async (_n, kind, over) => {
      const x = kind === 'recv' ? recv({ state: 'partially_received', version: 6 }, [over as Row, {}]) : sub(); const target = kind === 'recv' ? x.ls[0]! : x.ls[1]!; if (kind === 'sub') Object.assign(target, over);
      const n = x.w.log.length; await fails(mark(x.w, target['id'], { reason_code: 'sample_missing' }, { ctx: { centres: kind === 'recv' ? [CE.a1] : [CE.a2] } }).p, 'partners.manifest_line_invalid_transition', 409); quiet(x.w, n);
    });
  it('reason_code: missing / unknown / not a string -> 400; If-Match missing 428, stale 409; manifest withdrawn -> 409; nothing written', async () => {
    const { w, ls } = recv({}, [{}, {}]); const n = w.log.length; const lid = ls[0]!['id'];
    for (const b of [{}, { reason_code: 'nope' }, { reason_code: 5 }, undefined]) await fails(mark(w, lid, b as any).p, 'common.validation_failed', 400);
    await fails(mark(w, lid, { reason_code: 'sample_missing' }, { headers: {} }).p, 'common.precondition_required', 428); await fails(mark(w, lid, { reason_code: 'sample_missing' }, { v: 7 }).p, 'common.version_conflict', 409); quiet(w, n);
    const wd = recv({ state: 'withdrawn' }, [{ state: 'withdrawn' }]); const e: any = await mark(wd.w, wd.ls[0]!['id'], { reason_code: 'sample_missing' }).p.then(() => null, (x) => x); expect(e?.statusCode).toBe(409);
  });
  it('planted body fields never reach a column; the sample_received_at of a not_received line stays empty', async () => {
    const { w, ls } = recv({}, [{}, {}]); const out = await settle(mark(w, ls[0]!['id'], { reason_code: 'sample_missing', state: 'converted', order_id: id(7777), sample_received_at: NOW }).p);
    if (!out.ok) { expect(out.e.statusCode).toBe(400); return; }
    expect(line(w, ls[0]!['id'])).toMatchObject({ state: 'not_received', order_id: null, sample_received_at: null });
  });
});

describe('T10 SI1 listInboundManifests (inbox, centre scoped, D-104 filters)', () => {
  function inbox() {
    const w = makeWorld10(); const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const mk = (over: Row, lines: Row[]) => { const m = w.mkManifest({ line_count: lines.length, version: 2, ...over }); lines.forEach((l, i) => w.mkLine(m['id'], { partner_sample_ref: `SYN-I${m['manifest_no']}${i}`, ...l })); return m; };
    const A1 = mk({ state: 'submitted', submitted_at: d('2026-11-07'), manifest_no: 'MF26000011' }, [{ state: 'submitted' }]);
    const A2 = mk({ state: 'partially_received', submitted_at: d('2026-11-08'), manifest_no: 'MF26000012' }, [{ state: 'converting', conversion_attempt: 1 }, { state: 'conversion_failed', conversion_attempt: 1, failure_code: 'catalog.no_price', failed_at: d('2026-11-08') }]);
    const A3 = mk({ state: 'received', submitted_at: d('2026-11-06'), manifest_no: 'MF26000013', received_at: d('2026-11-07'), received_by: STAFF_ID }, [{ state: 'converted', conversion_attempt: 1, order_id: id(7601), registration_no: '0001SY000601', converted_at: d('2026-11-07') }]);
    const W1 = mk({ state: 'withdrawn', submitted_at: d('2026-11-04'), manifest_no: 'MF26000014' }, [{ state: 'withdrawn' }]);
    const B1 = mk({ partner_id: P.y, state: 'submitted', submitted_at: d('2026-11-09'), manifest_no: 'MF26000021' }, [{ state: 'converted', conversion_attempt: 1, order_id: id(7602), registration_no: '0001SY000602', converted_at: d('2026-11-09'), sample_missing: true, not_received_reason_code: 'sample_missing' }, { state: 'converting', conversion_attempt: 1 }]);
    const B2 = mk({ partner_id: P.y, state: 'submitted', submitted_at: d('2026-11-10'), manifest_no: 'MF26000022' }, [{ state: 'converting', conversion_attempt: 1 }]);
    const TB = mk({ partner_id: P.b, state: 'submitted', submitted_at: d('2026-11-11'), manifest_no: 'MF26000031' }, [{ state: 'submitted' }]);
    return { w, A1, A2, A3, W1, B1, B2, TB, xs: man(w, M.xs) };
  }
  const list = async (w: World10, q: Row, o: StaffOver = { centres: 'all' }) => call(listInboundManifests, staff(w, o).ctx, req({ query: q }));
  const ids = (r: Out) => r.body.data.map((x: Row) => x['id']);

  it('default = submitted + partially_received, newest submission first, only the staff centres (C1 / C2 / all), never tenant B or drafts', async () => {
    const t = inbox();
    expect(ids(await list(t.w, {}, { centres: [CE.a1] }))).toEqual([t.A2['id'], t.A1['id'], M.xs]);
    expect(ids(await list(t.w, {}, { centres: [CE.a2] }))).toEqual([t.B2['id'], t.B1['id']]);
    expect(ids(await list(t.w, {}, { centres: 'all' }))).toEqual([t.B2['id'], t.B1['id'], t.A2['id'], t.A1['id'], M.xs]);
  });
  it('ManifestSummary + partner block, no lines, per-state counts (lines_converted / lines_failed), page.limit, no leaks, no PHI', async () => {
    const t = inbox(); const r = await list(t.w, { limit: 50 }); expect(r.status).toBe(200); expect(r.body.page.limit).toBe(50);
    for (const x of r.body.data) { keysWithin(x, SUMMARY_KEYS); expect(x).not.toHaveProperty('lines'); expect(x.partner).toEqual({ id: expect.any(String), partner_code: expect.stringMatching(/^SYN-/), name: expect.stringContaining('Synthetic Partner') }); }
    const a2 = r.body.data.find((x: Row) => x['id'] === t.A2['id']); expect(a2).toMatchObject({ state: 'partially_received', line_count: 2, lines_converted: 0, lines_failed: 1, receiving_centre: { id: CE.a1, name: 'Synthetic Centre A1' }, partner: { id: P.x, partner_code: 'SYN-X' } });
    expect(r.body.data.find((x: Row) => x['id'] === t.B1['id'])).toMatchObject({ lines_converted: 1, lines_failed: 0, partner: { id: P.y } }); noLeak(r.body); noPhi(r.body);
  });
  it('centre probe: filtering by a centre outside the staff scope is an empty list (200), not an error and not a leak', async () => {
    const t = inbox();
    expect(ids(await list(t.w, { receiving_centre_id: CE.a2 }, { centres: [CE.a1] }))).toEqual([]); expect(ids(await list(t.w, { receiving_centre_id: CE.a1 }, { centres: [CE.a2] }))).toEqual([]);
    expect(ids(await list(t.w, { receiving_centre_id: CE.a2 }, { centres: 'all' }))).toEqual([t.B2['id'], t.B1['id']]);
  });
  it('state (csv), partner_id, submitted_at range', async () => {
    const t = inbox();
    expect(ids(await list(t.w, { state: 'received,withdrawn' }))).toEqual([t.A3['id'], t.W1['id']]); expect(ids(await list(t.w, { state: 'submitted' }))).toEqual([t.B2['id'], t.B1['id'], t.A1['id'], M.xs]);
    expect(ids(await list(t.w, { partner_id: P.y }))).toEqual([t.B2['id'], t.B1['id']]); expect(ids(await list(t.w, { partner_id: P.x }))).toEqual([t.A2['id'], t.A1['id'], M.xs]); expect(ids(await list(t.w, { partner_id: P.b }))).toEqual([]);
    expect(ids(await list(t.w, { submitted_at_from: '2026-11-08T00:00:00Z' }))).toEqual([t.B2['id'], t.B1['id'], t.A2['id']]); expect(ids(await list(t.w, { submitted_at_to: '2026-11-07T23:59:59Z' }))).toEqual([t.A1['id'], M.xs]);
  });
  it('has_failed_lines and has_missing_samples (D-104: on_submit converted line with sample_missing)', async () => {
    const t = inbox();
    expect(ids(await list(t.w, { has_failed_lines: true }))).toEqual([t.A2['id']]); expect(ids(await list(t.w, { has_failed_lines: false }))).toEqual([t.B2['id'], t.B1['id'], t.A1['id'], M.xs]);
    expect(ids(await list(t.w, { has_missing_samples: true }))).toEqual([t.B1['id']]); expect(ids(await list(t.w, { has_missing_samples: true }, { centres: [CE.a1] }))).toEqual([]);
    expect(ids(await list(t.w, { has_missing_samples: true, has_failed_lines: true }))).toEqual([]);
  });
  it('has_missing_samples = order exists AND sample missing (05-SCHEMA missing idx: sample_missing AND state = converted): a sample_missing line in conversion_failed / converting does not match', async () => {
    const w = makeWorld10(); const d = new Date('2026-11-09T00:00:00Z');
    const mk = (no: string, line: Row) => { const m = w.mkManifest({ state: 'submitted', submitted_at: d, manifest_no: no, line_count: 1, version: 2 }); w.mkLine(m['id'], { partner_sample_ref: `SYN-${no}`, ...line }); return m; };
    const miss = { sample_missing: true, not_received_reason_code: 'sample_missing', conversion_attempt: 1 };
    const F = mk('MF26000041', { ...miss, state: 'conversion_failed', failure_code: 'catalog.no_price', failed_at: d });
    const C = mk('MF26000042', { ...miss, state: 'converting' });
    const OK = mk('MF26000043', { ...miss, state: 'converted', order_id: id(7701), registration_no: '0001SY000701', converted_at: d });
    const N = mk('MF26000044', { state: 'converted', conversion_attempt: 1, order_id: id(7702), registration_no: '0001SY000702', converted_at: d });
    expect(ids(await list(w, { has_missing_samples: true }))).toEqual([OK['id']]);
    expect([...ids(await list(w, { has_missing_samples: false }))].sort()).toEqual([F['id'], C['id'], N['id'], M.xs].sort());
  });
  it('sort manifest_no, and a cursor round trip: no overlap, no gap, no foreign row; invalid cursor -> 400 common.invalid_cursor', async () => {
    const t = inbox();
    expect(ids(await list(t.w, { sort: 'manifest_no' }))).toEqual([M.xs, t.A1['id'], t.A2['id'], t.B1['id'], t.B2['id']]);
    for (const sort of ['-submitted_at', 'manifest_no']) {
      const all = ids(await list(t.w, { sort })); const seen: string[] = []; let cursor: string | undefined;
      for (let i = 0; i < 5; i++) { const p = await list(t.w, { sort, limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...ids(p)); cursor = p.body.page.next_cursor; if (!cursor) break; }
      expect(seen).toEqual(all); expect(new Set(seen).size).toBe(5);
    }
    await fails(list(t.w, { cursor: 'garbage' }), 'common.invalid_cursor', 400);
  });
  it('read-only (no write statements, no job, no access-log row)', async () => {
    const t = inbox(); const n = t.w.log.length; const s = staff(t.w, { centres: 'all' }); await call(listInboundManifests, s.ctx, req({ query: {} })); quiet(t.w, n); expect(s.audit).toEqual([]);
  });
});

describe('T10 SI2 getInboundManifest (staff view, access log patient.view)', () => {
  it('200 InboundManifest: partner block, patient block of every line, notes / clinical_note, order + failure + not_received details; DTO allowlist; ONE access-log row after the read', async () => {
    const { w, m, ls } = recv({ state: 'partially_received', version: 6 }, [{ state: 'converting', conversion_attempt: 1 }, { state: 'conversion_failed', conversion_attempt: 1, failure_code: 'catalog.no_price', failed_at: new Date(NOW) },
      { state: 'converted', conversion_attempt: 1, order_id: id(7701), registration_no: '0001SY000701', converted_at: new Date(NOW) }, { state: 'not_received', not_received_reason_code: 'wrong_container' }]);
    const s = staff(w, { centres: [CE.a1] }); const n = w.log.length; const r = await call(getInboundManifest, s.ctx, req({ manifest_id: m['id'] }));
    expect(r.status).toBe(200); keysWithin(r.body, MF_KEYS); noLeak(r.body); quiet(w, n);
    expect(r.body).toMatchObject({ id: m['id'], state: 'partially_received', notes: 'Synthetic manifest note', partner: { id: P.x, partner_code: 'SYN-X', name: 'Synthetic Partner SYN-X' }, receiving_centre: { id: CE.a1, name: 'Synthetic Centre A1' }, line_count: 4, lines_converted: 1, lines_failed: 1 });
    expect(r.body.lines.map((l: Row) => l['line_no'])).toEqual([1, 2, 3, 4]);
    expect(r.body.lines[0]).toMatchObject({ partner_sample_ref: 'SYN-R1', clinical_note: 'Synthetic note for the lab', patient: { full_name: 'Synthetic Patient R1', sex: 'female', age_years: 30 }, priority: 'routine' });
    expect(r.body.lines[1]).toMatchObject({ state: 'conversion_failed', failure: { code: 'catalog.no_price' } });
    expect(r.body.lines[2]).toMatchObject({ state: 'converted', order: { order_id: id(7701), registration_no: '0001SY000701' } }); expect(r.body.lines[3]).toMatchObject({ state: 'not_received', not_received_reason_code: 'wrong_container' });
    expect(s.audit).toEqual([{ action: 'patient.view', entityType: 'manifest', entityId: m['id'], outcome: 'allowed' }]); noPhi(s.audit);
  });
  it('404 for an unknown id and for a foreign centre writes no access-log row; if audit.access fails the request fails (no PHI without a log row)', async () => {
    const { w, m } = recv(); const s = staff(w, { centres: [CE.a1] });
    await fails(call(getInboundManifest, s.ctx, req({ manifest_id: id(7999) })), 'common.not_found', 404); expect(s.audit).toEqual([]);
    const bad = staff(w, { centres: [CE.a1], auditFails: true }); const out = await settle(call(getInboundManifest, bad.ctx, req({ manifest_id: m['id'] }))); expect(out.ok).toBe(false);
  });
  it('no patient data in the log lines of SI2 / SI3 / SI4 / SI5', async () => {
    const { w, m, ls } = recv(); const a = staff(w, { centres: [CE.a1] }); await call(getInboundManifest, a.ctx, req({ manifest_id: m['id'] })); noPhi(a.logs);
    const b = doReceive(w, m['id'], body([ls[0]!['id'], 'received'], [ls[1]!['id'], 'not_received', 'sample_missing'])); await b.p; noPhi(b.s.logs);
    const c = staff(w, { centres: [CE.a1] }); await call(markManifestLineNotReceived, c.ctx, req({ line_id: ls[2]!['id'], headers: IFM(1), body: { reason_code: 'sample_missing' } })); noPhi(c.logs);
    const d = staff(w, { centres: [CE.a1] }); await settle(call(retryManifestLineConversion, d.ctx, req({ line_id: ls[3]!['id'], headers: IFM(1), body: {} }))); noPhi(d.logs);
  });
});

void CP; void OR;
