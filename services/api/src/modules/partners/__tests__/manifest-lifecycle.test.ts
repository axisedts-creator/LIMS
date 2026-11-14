// C13 T09 — submit / withdraw / print (06-IMPLEMENTATION-PLAN row T09). Tests: integration (in-memory SQL world, see manifest-lifecycle.world.ts -> manifest-drafting.world.ts).
// ACs (01-PRD): US-04.4 (0 lines -> 422), US-04.5 (submit), US-04.6 (idempotent replay, no 2nd set of jobs), US-04.9 (withdraw), US-04.10 (withdraw after conversion -> 409), US-05.1 (print view + access log), US-05.2 (cross-partner 404).
// done_when: "all-errors-at-once; idempotent submit replay (no duplicate jobs); withdraw race with receive serialised; print access-log row".
// Spec: 02-TRD §5.1 DTOs, §5.2 M8/M9/M11, §13 access-log table; 03-APP-FLOW §2.1 MS3/MS5 + forbidden transitions, §2.2 LS2/LS2b/LS10, §4.1 M8/M9/M11, §5.1 sequence; 05-SCHEMA manifests (withdrawn__ck, manifest_withdraw_reasons);
//       07-SECURITY (REQ-SEC-096/097 manifest.print, AB11/AB12, ST10 idempotency, no PHI in logs, cross-partner 404). LD-140 (UI only) does not apply: backend task.
//
// Interface expected from the writer (SEAM = not fixed by the spec; the writer follows it or raises a dispute):
//   ../handlers/{submitManifest,withdrawManifest,getManifestPrintView}.ts: one named `Handler` export per operationId, wired in manifest.handlers (as T08). req/result shapes as in manifest-drafting.test.ts.
//   SEAM gate order (as T08): partnerContext.require -> IdentityPort.assertRole -> If-Match shape (M8/M9; M11 has none) -> manifest FOR UPDATE bound by (tenant, partner) from partnerContext -> If-Match version (409 common.version_conflict)
//        -> state/transition (409 partners.manifest_invalid_transition) -> validation (422 partners.manifest_invalid) -> writes. M8/M9 -> partners.manifest.submit; M11 -> partners.order.read.
//   SEAM M8 validation: the STORED lines are re-validated at submit with domain/line-validation.ts validateManifestForSubmit (offered orderables of (tenant, partner) incl. the include_default_price_list setting, own active referrers,
//        max_lines_per_manifest, patient/consents/... shape): 422 code partners.manifest_invalid, errors[] = every issue of every line at once: {path: '/lines/<i>/…' (i = 0-based position in line_no order; '/lines' for 0 or too many lines), code}
//        where code is the issue's own code (partners.orderable_not_offered, partners.manifest_invalid, common.validation_failed ...). Nothing is written, nothing enqueued. No submitted value is echoed in an error.
//        Receiving centre inactive (ctx.core.centre(ctx,{centreId}).isActive false) -> 422 partners.manifest_invalid, nothing written. Partner active is already guaranteed by partnerContext.
//        Stored columns -> validator input (dates as ISO strings, snapshot irrelevant) is the writer's mapping; the valid fixtures deliberately use birth_on, phone, collected_at (Date) and a referrer.
//   SEAM M8 writes (MS3): manifest row FIRST: ONE version-guarded UPDATE (state 'submitted', submitted_at = now, submitted_by = actor id, conversion_mode / receiving_branch_id / receiving_centre_id re-snapshotted from partners.partners,
//        version + 1); then draft lines of this manifest: mode on_receipt -> state 'submitted'; mode on_submit -> state 'converting' + conversion_attempt 1 (LS2b); every line gets receiving_centre_id = the manifest's refreshed value;
//        mode on_submit: ONE `SELECT app.enqueue_job('partners.convert_manifest_line', $payload::jsonb, $key)` per line, payload {tenant_id, line_id, attempt: 1}, job_key `convert:<line_id>:1` (03-APP-FLOW §4.2). on_receipt: no job.
//        Response 200 Manifest (ManifestDTO allowlist, lines included). Body {} only: planted body fields never reach a column.
//   SEAM idempotency: the Idempotency-Key replay itself is core pipeline stage 6/10 (x-idempotency: required in contracts/openapi/partners.yaml; core tests own the replay mechanics). What the handler owes: a repeated submit with the same
//        If-Match (the first one bumped the version) answers 409 common.version_conflict and enqueues nothing; two concurrent identical submits -> exactly one 200 and one 409, one job per line, unique job keys.
//   SEAM M9: body {reason_code ∈ manifest_withdraw_reasons (entered_in_error | samples_not_sent | duplicate_manifest | other), reason_text? ≤ 300 string|null}; bad body -> 400 common.validation_failed before any write (handler-side,
//        the DB has no FK on the code). Allowed only manifest 'submitted' AND conversion_mode 'on_receipt' AND no line converting/converted (domain assertWithdrawable) else 409 partners.manifest_invalid_transition.
//        Writes: manifest withdrawn / withdrawn_at = now / withdrawn_by = actor / withdraw_reason_code / withdraw_reason_text / version + 1; lines submitted -> withdrawn. Lines are read AFTER the manifest lock is held.
//        Pickup cascade (MS5: open pickups -> cancelled, link rows is_open = false) needs tables that are not in the fake world and is not asserted here (see notes).
//   SEAM M11: read-only (no SQL write). Result 200 {manifest: <Manifest DTO with lines>, partner: {name, partner_code}, receiving_centre: {name, code}, printed_at: ctx.now()}. Allowed manifest states: submitted,
//        partially_received, received, withdrawn; draft / discarded -> 409 partners.manifest_invalid_transition. Access log AFTER the read succeeded: ctx.audit.access({action: 'manifest.print', entityType: 'manifest',
//        entityId: <manifest id>, outcome: 'allowed'}) — exactly one entry per successful call, none on 404/409/403, no PHI in the entry; if audit.access rejects the request fails (no data without a log row).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { getManifestPrintView } from '../handlers/getManifestPrintView.js';
import { addManifestLine } from '../handlers/addManifestLine.js';
import { submitManifest } from '../handlers/submitManifest.js';
import { withdrawManifest } from '../handlers/withdrawManifest.js';
import { manifest } from '../index.js';
import { BR, CE, id, jobsOf, M, makeCtx9, makeWorld9, OR, P, RF, releaseLocks, staffReceive, T_A, USERS, type Over9, type Row, type World } from './manifest-lifecycle.world.js';

const SUBMIT = 'partners.manifest.submit', READ = 'partners.order.read';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MF_KEYS = ['id', 'manifest_no', 'state', 'line_count', 'lines_converted', 'lines_failed', 'receiving_centre', 'submitted_at', 'received_at', 'pickup_request_id', 'created_at', 'version', 'notes', 'collected_on', 'withdraw_reason_code', 'lines'];
const LEAKY = ['tenant_id', 'partner_id', 'created_by', 'updated_by', 'orderable_ids', 'orderables_snapshot', 'is_redacted', 'resolved_patient_id', 'conversion_attempt', 'receiving_centre_id', 'receiving_branch_id', 'conversion_mode', 'price_list_id', 'credit_party_id', 'withdrawn_by', 'submitted_by'];
const PHI = ['Synthetic Patient', 'SYN-A', 'SYN-REF', '+15555550142', '1990-05-17'];

const IFM = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const req = (o: { manifest_id?: string; headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}) =>
  ({ params: { ...(o.manifest_id ? { manifest_id: o.manifest_id } : {}) }, query: o.query ?? {}, headers: o.headers ?? {}, body: o.body });
type Out = { status: number; body: any; headers?: Record<string, string> };
const call = (h: (r: any, c: any) => Promise<unknown>, ctx: any, r: unknown) => (h(r, ctx) as Promise<Out>).finally(() => releaseLocks(ctx.tx)); // the fake "transaction" ends when the handler settles
const fails = async (p: Promise<unknown>, code: string, status: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe(code); expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const settle = (p: Promise<Out>) => p.then((r) => ({ ok: true as const, r }), (e) => ({ ok: false as const, e: e as LimsError }));
const mk = (over: Over9 = {}) => { const w = makeWorld9(); return { w, ...makeCtx9(w, over) }; };
const ctxFor = (w: World, over: Over9 = {}) => makeCtx9(w, over);
const man = (w: World, mid: string) => w.manifests.find((m) => m['id'] === mid)!;
const mark = (w: World) => w.log.length;
/** nothing written / enqueued since `n` (the world's log is cumulative, so every case compares against its own start). */
const quiet = (w: World, n: number, jobs = 0) => { expect(w.log.slice(n).filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.text))).toEqual([]); expect(w.jobs).toHaveLength(jobs); };
const keysWithin = (o: object, allowed: string[]) => { for (const k of Object.keys(o)) expect(allowed, `unexpected key ${k}`).toContain(k); };
const noLeak = (o: object) => { for (const k of LEAKY) expect(JSON.stringify(o)).not.toContain(`"${k}"`); };
const noPhi = (o: unknown) => { const s = typeof o === 'string' ? o : JSON.stringify(o); for (const p of PHI) expect(s).not.toContain(p); };
const sameError = (a: any, b: any) => { expect(a.code).toBe(b.code); expect(a.statusCode).toBe(b.statusCode); expect(a.detail).toBe(b.detail); expect(a.errors).toEqual(b.errors); };
const errs = (e: any) => (e.errors ?? []).map((x: Row) => ({ path: x['path'], code: x['code'] }));

const GOOD_LINE: Row = { patient_full_name: 'Synthetic Patient Good', patient_sex: 'male', patient_birth_on: '1990-05-17', patient_age_years: null, patient_phone_e164: '+15555550142', partner_sample_ref: 'SYN-A',
  collected_at: new Date('2026-11-12T09:30:00Z'), referrer_id: RF.x1, priority: 'urgent', consent_sms: true, consent_share_with_referrer: true, orderable_ids: [OR.glu, OR.cbc, OR.tsh],
  orderables_snapshot: [{ orderable_id: OR.glu, kind: 'test', code: 'GLU', name: 'Glucose Fasting' }, { orderable_id: OR.cbc, kind: 'panel', code: 'CBC', name: 'Complete Blood Count' }, { orderable_id: OR.tsh, kind: 'test', code: 'TSH', name: 'Thyroid Stimulating Hormone' }] };
const BAD_ORDERABLE: Row = { orderable_ids: [OR.a1c], orderables_snapshot: [{ orderable_id: OR.a1c, kind: 'test', code: 'A1C', name: 'HbA1c Synthetic' }] }; // partner Y's price list only

/** draft manifest (partner x unless over.partner_id) with the given line overrides; line_count kept equal to the number of lines. */
function draft(w: World, specs: Row[], over: Row = {}): Row {
  const m = w.mkManifest({ version: 5, ...over });
  specs.forEach((s) => w.mkLine(m['id'], s));
  m['line_count'] = specs.length;
  return m;
}
const linesOf = (w: World, mid: string) => w.linesOf(mid);
const states = (w: World, mid: string) => linesOf(w, mid).map((l) => l['state']);

describe('T09 wiring + contract', () => {
  it('M8, M9, M11 are wired to the handlers (T01 stubs replaced)', () => {
    for (const [op, h] of Object.entries({ submitManifest, withdrawManifest, getManifestPrintView })) { expect(typeof h).toBe('function'); expect(manifest.handlers[op]).toBe(h); }
  });
  it('contract: submit / withdraw require an Idempotency-Key (core replays), print does not; permissions as TRD §5.2', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../../../../../contracts/openapi/partners.yaml', import.meta.url)), 'utf8');
    const block = (op: string) => { const s = yaml.indexOf(`operationId: ${op}`); expect(s).toBeGreaterThan(0); const n = yaml.indexOf('operationId:', s + 10); return yaml.slice(s, n < 0 ? undefined : n); };
    expect(block('submitManifest')).toMatch(/x-idempotency: required/); expect(block('submitManifest')).toMatch(/x-permission: partners\.manifest\.submit/);
    expect(block('withdrawManifest')).toMatch(/x-idempotency: required/); expect(block('withdrawManifest')).toMatch(/x-permission: partners\.manifest\.submit/);
    expect(block('getManifestPrintView')).toMatch(/x-idempotency: none/); expect(block('getManifestPrintView')).toMatch(/x-permission: partners\.order\.read/);
  });
});

describe('T09 M8 submitManifest — US-04.5 happy path (mode on_receipt)', () => {
  it('200: manifest submitted (submitted_at now, submitted_by actor, version + 1), every draft line submitted at the manifest\'s centre, NO job, DTO allowlist', async () => {
    const { w, ctx } = mk(); const m = draft(w, [GOOD_LINE, { ...GOOD_LINE, partner_sample_ref: 'SYN-B' }]); const lineNo = linesOf(w, m['id']).map((l) => l['id']);
    const r = await call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} }));
    expect(r.status).toBe(200);
    expect(man(w, m['id'])).toMatchObject({ state: 'submitted', version: 6, line_count: 2, submitted_by: USERS.x1.actor, updated_by: USERS.x1.actor, receiving_centre_id: CE.a1, received_at: null, in_transit_at: null });
    expect(new Date(man(w, m['id'])['submitted_at']).toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(linesOf(w, m['id']).map((l) => l['id'])).toEqual(lineNo);
    for (const l of linesOf(w, m['id'])) expect(l).toMatchObject({ state: 'submitted', receiving_centre_id: CE.a1, conversion_attempt: 0, order_id: null, failure_code: null }); // never `converting` in on_receipt (AB12)
    expect(w.jobs).toEqual([]);
    expect(r.body).toMatchObject({ id: m['id'], state: 'submitted', version: 6, line_count: 2, lines_converted: 0, lines_failed: 0 });
    expect(r.body.submitted_at).toMatch(ISO); expect(r.body.receiving_centre).toEqual({ id: CE.a1, name: 'Synthetic Centre A1' });
    expect(r.body.lines.map((l: Row) => [l['line_no'], l['state']])).toEqual([[1, 'submitted'], [2, 'submitted']]);
    keysWithin(r.body, MF_KEYS); noLeak(r.body);
  });

  it('MS3: conversion_mode / receiving branch / centre are re-snapshotted from the partner at submit (review m#18); a mode change to on_submit makes the lines converting + jobs', async () => {
    const { w, ctx } = mk(); const m = draft(w, [GOOD_LINE]);
    Object.assign(w.partners.find((p) => p['id'] === P.x)!, { receiving_branch_id: BR.a2, receiving_centre_id: CE.a2, conversion_mode: 'on_submit' });
    const r = await call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} }));
    expect(man(w, m['id'])).toMatchObject({ state: 'submitted', conversion_mode: 'on_submit', receiving_branch_id: BR.a2, receiving_centre_id: CE.a2 });
    expect(linesOf(w, m['id'])[0]).toMatchObject({ state: 'converting', conversion_attempt: 1, receiving_centre_id: CE.a2 });
    expect(r.body.receiving_centre).toEqual({ id: CE.a2, name: 'Synthetic Centre A2' });
    expect(jobsOf(w)).toHaveLength(1);
  });

  it('the stored line is validated with its real values: birth_on date string, Date collected_at, phone, referrer and a standard-list orderable are all accepted', async () => {
    const { w, ctx } = mk(); const m = draft(w, [GOOD_LINE]);
    expect((await call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} }))).status).toBe(200);
  });

  it('planted body fields never reach a column (AB11/AB12): state, received_at, order_id, submitted_by, partner_id, conversion_mode are ignored or the body is rejected', async () => {
    const { w, ctx } = mk(); const m = draft(w, [GOOD_LINE]);
    const planted = { state: 'received', received_at: '2026-01-01T00:00:00Z', in_transit_at: '2026-01-01T00:00:00Z', submitted_by: id(77), partner_id: P.y, conversion_mode: 'on_submit', line_state: 'converting', receiving_centre_id: CE.a2, version: 99 };
    const out = await settle(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: planted })));
    if (!out.ok) { expect(out.e.code).toBe('common.validation_failed'); expect(man(w, m['id'])['state']).toBe('draft'); return; }
    expect(man(w, m['id'])).toMatchObject({ state: 'submitted', partner_id: P.x, conversion_mode: 'on_receipt', receiving_centre_id: CE.a1, submitted_by: USERS.x1.actor, received_at: null, in_transit_at: null, version: 6 });
    expect(states(w, m['id'])).toEqual(['submitted']); expect(w.jobs).toEqual([]);
  });
});

describe('T09 M8 submitManifest — mode on_submit: one job per line (US-04.5)', () => {
  const yDraft = (w: World, n = 3) => draft(w, Array.from({ length: n }, (_, i) => ({ partner_sample_ref: `SYN-Y${i}`, orderable_ids: [OR.a1c], orderables_snapshot: [{ orderable_id: OR.a1c, kind: 'test', code: 'A1C', name: 'HbA1c Synthetic' }] })), { partner_id: P.y, version: 2 });

  it('lines draft -> converting with conversion_attempt 1 (LS2b); exactly one partners.convert_manifest_line job per line, payload {tenant_id, line_id, attempt: 1}, job_key convert:<line_id>:1', async () => {
    const { w, ctx } = mk({ who: 'y1' }); const m = yDraft(w);
    const r = await call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(2), body: {} }));
    expect(r.status).toBe(200);
    expect(man(w, m['id'])).toMatchObject({ state: 'submitted', conversion_mode: 'on_submit', version: 3, submitted_by: USERS.y1.actor });
    for (const l of linesOf(w, m['id'])) expect(l).toMatchObject({ state: 'converting', conversion_attempt: 1, receiving_centre_id: CE.a2 });
    const jobs = jobsOf(w); const ids = linesOf(w, m['id']).map((l) => l['id']);
    expect(jobs).toHaveLength(3);
    for (const j of jobs) expect(j.task).toBe('partners.convert_manifest_line');
    expect(jobs.map((j) => j.payload)).toEqual(expect.arrayContaining(ids.map((line_id) => ({ tenant_id: T_A, line_id, attempt: 1 }))));
    expect(jobs.map((j) => j.key).sort()).toEqual(ids.map((x) => `convert:${x}:1`).sort());
    expect(r.body.lines.map((l: Row) => l['state'])).toEqual(['converting', 'converting', 'converting']);
  });

  it('no job is enqueued for a manifest that fails validation, is stale or is not a draft (validation happens before any enqueue)', async () => {
    const { w } = mk(); const m = yDraft(w, 2);
    w.lines.find((l) => l['manifest_id'] === m['id'])!['orderable_ids'] = [OR.glu]; // partner X's price list: not offered to Y
    await fails(call(submitManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: m['id'], headers: IFM(2), body: {} })), 'partners.manifest_invalid', 422);
    await fails(call(submitManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: m['id'], headers: IFM(1), body: {} })), 'common.version_conflict', 409);
    expect(w.jobs).toEqual([]); expect(man(w, m['id'])['state']).toBe('draft');
  });
});

describe('T09 M8 submitManifest — validation: all errors at once (US-04.4, 03-APP-FLOW §4.1 M8)', () => {
  it('0 lines -> 422 partners.manifest_invalid with errors[] [{path: /lines}], nothing written', async () => {
    const { w, ctx } = mk(); const n = mark(w);
    const e = await fails(call(submitManifest, ctx, req({ manifest_id: M.x2, headers: IFM(1), body: {} })), 'partners.manifest_invalid', 422);
    expect(errs(e)).toEqual([{ path: '/lines', code: 'partners.manifest_invalid' }]);
    quiet(w, n); expect(man(w, M.x2)['state']).toBe('draft');
  });

  it('every bad line is reported in ONE response with /lines/<i>/… pointers and per-issue codes; the good line is not reported; nothing written or enqueued', async () => {
    const { w, ctx } = mk();
    const m = draft(w, [GOOD_LINE, { ...BAD_ORDERABLE, partner_sample_ref: 'SYN-B1' }, { referrer_id: RF.x2inactive, partner_sample_ref: 'SYN-B2' }, { ...BAD_ORDERABLE, referrer_id: RF.x2inactive, partner_sample_ref: 'SYN-B3' }]);
    const n = mark(w);
    const e = await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    const got = errs(e);
    expect(got).toHaveLength(4);
    expect(got).toEqual(expect.arrayContaining([
      { path: '/lines/1/orderable_ids/0', code: 'partners.orderable_not_offered' },
      { path: '/lines/2/referrer_id', code: 'partners.manifest_invalid' },
      { path: '/lines/3/orderable_ids/0', code: 'partners.orderable_not_offered' },
      { path: '/lines/3/referrer_id', code: 'partners.manifest_invalid' },
    ]));
    expect(got.some((x: Row) => String(x['path']).startsWith('/lines/0'))).toBe(false);
    quiet(w, n); expect(man(w, m['id'])).toMatchObject({ state: 'draft', version: 5, submitted_at: null }); expect(states(w, m['id'])).toEqual(['draft', 'draft', 'draft', 'draft']);
  });

  it('a bad line plus a manifest-level problem are reported together: too many lines for max_lines_per_manifest -> /lines AND the line issues', async () => {
    const { w, ctx } = mk(); w.setSettings(T_A, { max_lines_per_manifest: 2 });
    const m = draft(w, [GOOD_LINE, { ...BAD_ORDERABLE, partner_sample_ref: 'SYN-B1' }, { partner_sample_ref: 'SYN-B2' }]);
    const e = await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    expect(errs(e)).toEqual(expect.arrayContaining([{ path: '/lines', code: 'partners.manifest_invalid' }, { path: '/lines/1/orderable_ids/0', code: 'partners.orderable_not_offered' }]));
    expect(man(w, m['id'])['state']).toBe('draft');
  });

  it('the price list is checked AT SUBMIT: an orderable that was offered while drafting but is no longer (row removed / default list switched off) fails the submit', async () => {
    const { w } = mk(); const m = draft(w, [{ orderable_ids: [OR.glu] }, { orderable_ids: [OR.tsh], partner_sample_ref: 'SYN-T' }]);
    w.setSettings(T_A, { include_default_price_list: false }); // tsh is a `standard` item
    let e = await fails(call(submitManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    expect(errs(e)).toEqual([{ path: '/lines/1/orderable_ids/0', code: 'partners.orderable_not_offered' }]);
    w.setSettings(T_A, { include_default_price_list: true }); w.prices.splice(w.prices.findIndex((p) => p['partner_id'] === P.x && p['orderable_id'] === OR.glu), 1);
    e = await fails(call(submitManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    expect(errs(e)).toEqual([{ path: '/lines/0/orderable_ids/0', code: 'partners.orderable_not_offered' }]);
  });

  it('a structurally broken stored line (both birth_on and age_years) is reported with the shape code at its own pointer', async () => {
    const { w, ctx } = mk(); const m = draft(w, [GOOD_LINE, { patient_birth_on: '1990-05-17', patient_age_years: 30, partner_sample_ref: 'SYN-C' }]);
    const e = await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    expect(errs(e).map((x: Row) => x['path'])).toEqual(['/lines/1/patient']); expect(['common.validation_failed', 'common.field_invalid']).toContain(errs(e)[0].code); // T08 maps the shape code to common.field_invalid in errors[]
  });

  it('errors never echo submitted values (names, sample refs, phone, orderable ids, manifest no)', async () => {
    const { w, ctx, logs } = mk(); const m = draft(w, [{ ...GOOD_LINE, ...BAD_ORDERABLE }, { ...BAD_ORDERABLE, partner_sample_ref: 'SYN-B1' }]);
    const e = await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    noPhi(JSON.stringify({ code: e.code, detail: e.detail, errors: e.errors }));
    for (const s of [OR.a1c, m['manifest_no']]) expect(JSON.stringify({ detail: e.detail, errors: e.errors })).not.toContain(s);
    for (const l of logs) { noPhi(l); expect(l).not.toContain(m['manifest_no']); }
  });

  it('receiving centre inactive -> 422 partners.manifest_invalid, nothing written, no job', async () => {
    const { w, ctx } = mk({ centreActive: false }); const m = draft(w, [GOOD_LINE]); const n = mark(w);
    await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid', 422);
    quiet(w, n); expect(man(w, m['id'])['state']).toBe('draft');
  });
});

describe('T09 M8 submitManifest — preconditions, state, access', () => {
  it('If-Match: missing -> 428 common.precondition_required, malformed -> 400 common.validation_failed, stale -> 409 common.version_conflict; nothing written', async () => {
    const { w } = mk(); const m = draft(w, [GOOD_LINE]); const n = mark(w);
    const c = () => ctxFor(w).ctx;
    await fails(call(submitManifest, c(), req({ manifest_id: m['id'], body: {} })), 'common.precondition_required', 428);
    for (const h of ['5', 'W/"5"', '"abc"', '"0"', '"-1"', '"99999999999"']) await fails(call(submitManifest, c(), req({ manifest_id: m['id'], headers: IFM(h), body: {} })), 'common.validation_failed', 400);
    await fails(call(submitManifest, c(), req({ manifest_id: m['id'], headers: IFM(4), body: {} })), 'common.version_conflict', 409);
    await fails(call(submitManifest, c(), req({ manifest_id: m['id'], headers: IFM(6), body: {} })), 'common.version_conflict', 409);
    quiet(w, n);
  });

  it('only a draft can be submitted: submitted / partially_received / received / withdrawn / discarded -> 409 partners.manifest_invalid_transition, nothing written', async () => {
    for (const state of ['submitted', 'partially_received', 'received', 'withdrawn', 'discarded']) {
      const { w, ctx } = mk(); const m = w.mkManifest({ state, version: 7, line_count: 1 }); w.mkLine(m['id'], { state: state === 'discarded' ? 'discarded' : 'submitted' }); const n = mark(w);
      await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(7), body: {} })), 'partners.manifest_invalid_transition', 409);
      quiet(w, n);
    }
  });

  it('refused before any write: staff actor, partner user without partners.manifest.submit (read-only), user of a suspended partner', async () => {
    for (const [over, code, status] of [[{ who: 'staff' }, 'auth.forbidden', 403], [{ perms: [READ] }, 'auth.forbidden', 403], [{ who: 's1' }, 'partners.partner_inactive', 403]] as const) {
      const { w, ctx } = mk(over); const m = draft(w, [GOOD_LINE]); const n = mark(w);
      await fails(call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), code, status);
      quiet(w, n);
    }
  });

  it('probe: partner X submits a manifest of partner Y / tenant B / a random id / a non-uuid -> identical 404 common.not_found; the victim is untouched; no job', async () => {
    const { w } = mk(); const before = JSON.stringify(w.manifests); const n = mark(w); const out = [];
    for (const mid of [M.y1, M.b1, id(999), 'not-a-uuid']) out.push(await fails(call(submitManifest, ctxFor(w).ctx, req({ manifest_id: mid, headers: IFM(2), body: {} })), 'common.not_found', 404));
    for (const e of out.slice(1)) sameError(out[0], e);
    for (const e of out) { expect(JSON.stringify(e)).not.toContain(M.y1); expect(JSON.stringify(e)).not.toContain('MF26'); }
    quiet(w, n); expect(JSON.stringify(w.manifests)).toBe(before);
  });

  it('no PHI, manifest_no or sample ref in SQL text or logs', async () => {
    const { w, ctx, logs } = mk(); const m = draft(w, [GOOD_LINE]);
    await call(submitManifest, ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} }));
    for (const q of w.log) { expect(q.text).not.toContain(m['manifest_no']); for (const p of PHI) expect(q.text).not.toContain(p); }
    for (const l of logs) { noPhi(l); expect(l).not.toContain(m['manifest_no']); }
  });
});

describe('T09 M8 — idempotent replay and races (US-04.6, ST10)', () => {
  const yDraft = (w: World, n: number) => draft(w, Array.from({ length: n }, (_, i) => ({ partner_sample_ref: `SYN-Y${i}`, orderable_ids: [OR.a1c], orderables_snapshot: [{ orderable_id: OR.a1c, kind: 'test', code: 'A1C', name: 'HbA1c Synthetic' }] })), { partner_id: P.y, version: 2 });

  it('the same submit sent again (same If-Match) -> 409 common.version_conflict, NO second set of jobs, state and lines unchanged', async () => {
    const { w } = mk(); const m = yDraft(w, 3);
    const c = () => ctxFor(w, { who: 'y1' }).ctx;
    await call(submitManifest, c(), req({ manifest_id: m['id'], headers: IFM(2), body: {} }));
    expect(jobsOf(w)).toHaveLength(3); const snap = JSON.stringify([w.manifests, w.lines]); const n = mark(w);
    await fails(call(submitManifest, c(), req({ manifest_id: m['id'], headers: IFM(2), body: {} })), 'common.version_conflict', 409);
    await fails(call(submitManifest, c(), req({ manifest_id: m['id'], headers: IFM(3), body: {} })), 'partners.manifest_invalid_transition', 409); // fresh If-Match, no longer a draft
    expect(w.jobs).toHaveLength(3); quiet(w, n, 3); expect(JSON.stringify([w.manifests, w.lines])).toBe(snap);
  });

  it('two concurrent identical submits (same If-Match): exactly one 200 and one 409; one job per line, all job keys unique', async () => {
    for (const lag of [0, 1, 2, 3, 5, 8, 13]) {
      const { w } = mk(); const m = yDraft(w, 4);
      const a = call(submitManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: m['id'], headers: IFM(2), body: {} }));
      for (let i = 0; i < lag; i++) await Promise.resolve();
      const b = call(submitManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: m['id'], headers: IFM(2), body: {} }));
      const res = await Promise.all([settle(a), settle(b)]);
      expect(res.filter((r) => r.ok)).toHaveLength(1);
      const lost = res.find((r) => !r.ok) as { ok: false; e: LimsError }; expect(lost.e.statusCode).toBe(409);
      const jobs = jobsOf(w); expect(jobs).toHaveLength(4); expect(new Set(jobs.map((j) => j.key)).size).toBe(4);
      expect(man(w, m['id'])).toMatchObject({ state: 'submitted', version: 3 }); expect(states(w, m['id'])).toEqual(Array(4).fill('converting'));
    }
  });

  it('submit races an add-line with the same If-Match: exactly one wins; a submitted manifest never holds a stray draft line and line_count matches the lines', async () => {
    const seen = new Set<string>();
    for (const lag of [0, 1, 2, 3, 4, 6, 8, 10, 14, 20, 30, 45]) for (const first of ['submit', 'add'] as const) {
      const { w } = mk(); const m = draft(w, [GOOD_LINE]);
      const doSubmit = () => call(submitManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} }));
      const doAdd = () => call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(5), body: { partner_sample_ref: 'SYN-NEW', patient: { full_name: 'Synthetic Patient New', sex: 'female', age_years: 41 }, consents: { sms: false, whatsapp: false, email: false, share_with_referrer: false }, orderable_ids: [OR.glu], priority: 'routine' } }));
      const p1 = settle(first === 'submit' ? doSubmit() : doAdd());
      for (let i = 0; i < lag; i++) await Promise.resolve();
      const p2 = settle(first === 'submit' ? doAdd() : doSubmit());
      const [r1, r2] = await Promise.all([p1, p2]);
      expect([r1, r2].filter((r) => r.ok)).toHaveLength(1);
      const lost = [r1, r2].find((r) => !r.ok) as { ok: false; e: LimsError }; expect(lost.e.statusCode).toBe(409);
      const ls = linesOf(w, m['id']); const mm = man(w, m['id']);
      expect(mm['line_count']).toBe(ls.length);
      if (mm['state'] === 'submitted') { expect(ls).toHaveLength(1); expect(states(w, m['id'])).toEqual(['submitted']); } else { expect(mm['state']).toBe('draft'); expect(ls).toHaveLength(2); expect(states(w, m['id'])).toEqual(['draft', 'draft']); }
      seen.add(mm['state']);
    }
    expect([...seen].sort()).toEqual(['draft', 'submitted']); // the sweep really exercised both interleavings
  });
});

describe('T09 M9 withdrawManifest — US-04.9 / US-04.10', () => {
  const sub = (w: World, lineStates: string[] = ['submitted', 'submitted'], over: Row = {}) => {
    const m = w.mkManifest({ state: 'submitted', version: 4, line_count: lineStates.length, ...over });
    lineStates.forEach((s, i) => w.mkLine(m['id'], { state: s, partner_sample_ref: `SYN-W${i}`, ...(s === 'converted' ? { order_id: id(7000 + i), registration_no: `SYN-REG-${i}`, converted_at: new Date('2026-11-12T00:00:00Z') } : {}) }));
    return m;
  };
  const W = (o: Row = {}) => ({ reason_code: 'entered_in_error', reason_text: 'Synthetic mistake', ...o });

  it('200: submitted on_receipt manifest with unconverted lines -> withdrawn (withdrawn_at now, by actor, reason code + text, version + 1), lines withdrawn, no job; DTO shows the reason', async () => {
    const { w, ctx } = mk(); const m = sub(w);
    const r = await call(withdrawManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W() }));
    expect(r.status).toBe(200);
    expect(man(w, m['id'])).toMatchObject({ state: 'withdrawn', version: 5, withdrawn_by: USERS.x1.actor, updated_by: USERS.x1.actor, withdraw_reason_code: 'entered_in_error', withdraw_reason_text: 'Synthetic mistake', received_at: null });
    expect(new Date(man(w, m['id'])['withdrawn_at']).toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(states(w, m['id'])).toEqual(['withdrawn', 'withdrawn']); expect(w.jobs).toEqual([]);
    expect(r.body).toMatchObject({ id: m['id'], state: 'withdrawn', version: 5, withdraw_reason_code: 'entered_in_error' });
    expect(r.body.lines.map((l: Row) => l['state'])).toEqual(['withdrawn', 'withdrawn']);
    keysWithin(r.body, MF_KEYS); noLeak(r.body);
  });

  it('reason_text is optional except for `other` (requires_text, 05-SCHEMA §7); all four manifest_withdraw_reasons codes are accepted', async () => {
    for (const [i, code] of ['entered_in_error', 'samples_not_sent', 'duplicate_manifest', 'other'].entries()) {
      const { w, ctx } = mk(); const m = sub(w); const text = i % 2 === 0 || code === 'other';
      const r = await call(withdrawManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: text ? { reason_code: code, reason_text: 'Synthetic note' } : { reason_code: code } }));
      expect(r.status).toBe(200); expect(man(w, m['id'])).toMatchObject({ withdraw_reason_code: code, withdraw_reason_text: text ? 'Synthetic note' : null, state: 'withdrawn' });
    }
  });

  it('`other` without reason_text (missing, null, empty or whitespace) -> 400 common.validation_failed and nothing written', async () => {
    const { w } = mk(); const m = sub(w); const n = mark(w);
    for (const body of [{ reason_code: 'other' }, { reason_code: 'other', reason_text: null }, { reason_code: 'other', reason_text: '' }, { reason_code: 'other', reason_text: '   ' }])
      await fails(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body })), 'common.validation_failed', 400);
    quiet(w, n); expect(man(w, m['id'])['state']).toBe('submitted');
  });

  it('bad body -> 400 common.validation_failed and nothing written: no / unknown / non-string reason_code, reason_text > 300 or not a string, body not an object', async () => {
    const { w } = mk(); const m = sub(w); const n = mark(w);
    for (const body of [{}, { reason_text: 'x' }, { reason_code: 'because' }, { reason_code: 7 }, { reason_code: null }, W({ reason_text: 'x'.repeat(301) }), W({ reason_text: 42 }), 'entered_in_error', null, []])
      await fails(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body })), 'common.validation_failed', 400);
    quiet(w, n); expect(man(w, m['id'])['state']).toBe('submitted');
    expect((await call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W({ reason_text: 'x'.repeat(300) }) }))).status).toBe(200); // the limit itself is fine
  });

  it('US-04.10: a converted or converting line forbids withdraw -> 409 partners.manifest_invalid_transition, nothing written', async () => {
    for (const ls of [['submitted', 'converted'], ['converted'], ['submitted', 'converting'], ['converting', 'converting']]) {
      const { w, ctx } = mk(); const m = sub(w, ls); const n = mark(w);
      await fails(call(withdrawManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W() })), 'partners.manifest_invalid_transition', 409);
      quiet(w, n); expect(man(w, m['id'])['state']).toBe('submitted'); expect(states(w, m['id'])).toEqual(ls);
    }
  });

  it('US-04.9 (on_submit): withdraw is unavailable — lines are converting from submit; 409 partners.manifest_invalid_transition even if the line state were not converting', async () => {
    for (const ls of [['converting', 'converting'], ['submitted']]) {
      const { w } = mk({ who: 'y1' }); const m = sub(w, ls, { partner_id: P.y, conversion_mode: 'on_submit', receiving_centre_id: CE.a2, receiving_branch_id: BR.a2 }); const n = mark(w);
      await fails(call(withdrawManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W() })), 'partners.manifest_invalid_transition', 409);
      quiet(w, n);
    }
  });

  it('only a submitted manifest can be withdrawn: draft / partially_received / received / withdrawn / discarded -> 409 partners.manifest_invalid_transition', async () => {
    for (const state of ['draft', 'partially_received', 'received', 'withdrawn', 'discarded']) {
      const { w, ctx } = mk(); const m = w.mkManifest({ state, version: 4, line_count: 1 }); w.mkLine(m['id'], { state: state === 'draft' ? 'draft' : state === 'withdrawn' ? 'withdrawn' : state === 'discarded' ? 'discarded' : 'submitted' }); const n = mark(w);
      await fails(call(withdrawManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W() })), 'partners.manifest_invalid_transition', 409);
      quiet(w, n);
    }
  });

  it('If-Match: missing -> 428, malformed -> 400, stale -> 409 common.version_conflict; nothing written', async () => {
    const { w } = mk(); const m = sub(w); const n = mark(w); const c = () => ctxFor(w).ctx;
    await fails(call(withdrawManifest, c(), req({ manifest_id: m['id'], body: W() })), 'common.precondition_required', 428);
    await fails(call(withdrawManifest, c(), req({ manifest_id: m['id'], headers: IFM('4'), body: W() })), 'common.validation_failed', 400);
    await fails(call(withdrawManifest, c(), req({ manifest_id: m['id'], headers: IFM(3), body: W() })), 'common.version_conflict', 409);
    quiet(w, n);
  });

  it('refused before any write: staff actor, read-only partner user, suspended partner; probe: manifests of partner Y / tenant B / random / non-uuid -> identical 404', async () => {
    for (const [over, code, status] of [[{ who: 'staff' }, 'auth.forbidden', 403], [{ perms: [READ] }, 'auth.forbidden', 403], [{ who: 's1' }, 'partners.partner_inactive', 403]] as const) {
      const { w, ctx } = mk(over); const m = sub(w); const n = mark(w);
      await fails(call(withdrawManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W() })), code, status); quiet(w, n);
    }
    const { w } = mk(); const ym = sub(w, ['submitted'], { partner_id: P.y }); const before = JSON.stringify([w.manifests, w.lines]); const n = mark(w); const out = [];
    for (const mid of [ym['id'], M.b1, id(999), 'not-a-uuid']) out.push(await fails(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: mid, headers: IFM(4), body: W() })), 'common.not_found', 404));
    for (const e of out.slice(1)) sameError(out[0], e);
    quiet(w, n); expect(JSON.stringify([w.manifests, w.lines])).toBe(before);
  });

  it('hostile reason_text is only a bound parameter and stored verbatim; never in SQL text or logs', async () => {
    const { w, ctx, logs } = mk(); const m = sub(w); const text = `x'); DROP TABLE partners.manifests;--`;
    await call(withdrawManifest, ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W({ reason_text: text }) }));
    expect(man(w, m['id'])['withdraw_reason_text']).toBe(text);
    for (const q of w.log) expect(q.text).not.toMatch(/DROP\s+TABLE/i);
    expect(w.log.some((q) => q.values.includes(text))).toBe(true);
    for (const l of logs) { expect(l).not.toContain('DROP TABLE'); expect(l).not.toContain(m['manifest_no']); }
  });

  it('the withdrawn manifest is read-only: add / delete / submit afterwards -> 409; a second withdraw -> 409 (twice with the same If-Match: one 200, one 409)', async () => {
    const { w } = mk(); const m = sub(w);
    const res = await Promise.all([settle(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W() }))), settle(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body: W({ reason_code: 'other', reason_text: 'Synthetic note' }) })))]);
    expect(res.filter((r) => r.ok)).toHaveLength(1); expect((res.find((r) => !r.ok) as { e: LimsError }).e.statusCode).toBe(409);
    expect(man(w, m['id'])).toMatchObject({ state: 'withdrawn', version: 5 });
    await fails(call(submitManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(5), body: {} })), 'partners.manifest_invalid_transition', 409);
  });
});

describe('T09 M9 — withdraw races a staff receipt: serialised on the manifest row (03-APP-FLOW §4.1 M9)', () => {
  const fresh = () => { const { w } = mk(); const m = w.mkManifest({ state: 'submitted', version: 4, line_count: 2 }); w.mkLine(m['id'], { state: 'submitted', partner_sample_ref: 'SYN-R0' }); w.mkLine(m['id'], { state: 'submitted', partner_sample_ref: 'SYN-R1' }); return { w, m }; };

  it('sweep over interleavings: exactly one of {withdraw, receipt} wins; never withdrawn + converting; the loser is a clean 409 / conflict; both outcomes occur', async () => {
    const outcomes = new Set<string>();
    for (let lag = 0; lag <= 150; lag += 3) for (const withdrawFirst of [true, false]) {
      const { w, m } = fresh();
      const wd = () => settle(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body: { reason_code: 'samples_not_sent' } })));
      const rc = (after: number) => staffReceive(w, m['id'], after);
      let w1: ReturnType<typeof wd>; let r1: ReturnType<typeof rc>;
      if (withdrawFirst) { w1 = wd(); r1 = rc(lag); } else { r1 = rc(0); for (let i = 0; i < lag; i++) await Promise.resolve(); w1 = wd(); }
      const [wr, rr] = await Promise.all([w1, r1]);
      const mm = man(w, m['id']); const st = states(w, m['id']);
      if (wr.ok) { // withdraw committed first
        expect(rr).toBe('conflict'); expect(mm['state']).toBe('withdrawn'); expect(st).toEqual(['withdrawn', 'withdrawn']); outcomes.add('withdrawn');
      } else { // receipt committed first: the withdraw sees it and is refused
        expect(rr).toBe('received'); expect(wr.e).toBeInstanceOf(LimsError); expect(wr.e.statusCode).toBe(409);
        expect(['partners.manifest_invalid_transition', 'common.version_conflict']).toContain(wr.e.code);
        expect(mm['state']).toBe('partially_received'); expect(st).toEqual(['converting', 'converting']); expect(mm['withdrawn_at']).toBeNull(); outcomes.add('received');
      }
      expect(st.includes('withdrawn') && st.includes('converting')).toBe(false);
    }
    expect([...outcomes].sort()).toEqual(['received', 'withdrawn']);
  });

  it('a line that went converting before the withdraw ran is seen: the withdraw reads the lines only after it holds the manifest lock (no stale pre-lock read)', async () => {
    const { w, m } = fresh();
    const tx = w.newTx(); // staff holds the manifest row lock
    await tx.query('SELECT id FROM partners.manifests WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [T_A, m['id']]);
    const p = settle(call(withdrawManifest, ctxFor(w).ctx, req({ manifest_id: m['id'], headers: IFM(4), body: { reason_code: 'other', reason_text: 'Synthetic note' } })));
    for (let i = 0; i < 40; i++) await Promise.resolve(); // the withdraw is now waiting on the lock (it must not have written anything)
    expect(w.writes).toEqual([]);
    await tx.query("UPDATE partners.manifest_lines SET state = 'converting', conversion_attempt = 1 WHERE tenant_id = $1 AND manifest_id = $2", [T_A, m['id']]);
    await tx.query("UPDATE partners.manifests SET state = 'partially_received', version = version + 1 WHERE tenant_id = $1 AND id = $2", [T_A, m['id']]);
    releaseLocks(tx);
    const r = await p; expect(r.ok).toBe(false); expect((r as { e: LimsError }).e.statusCode).toBe(409);
    expect(states(w, m['id'])).toEqual(['converting', 'converting']); expect(man(w, m['id'])['state']).toBe('partially_received');
  });
});

describe('T09 M11 getManifestPrintView — US-05.1 / US-05.2', () => {
  const sub = (w: World, state: string, over: Row = {}) => { const m = w.mkManifest({ state, version: 4, line_count: 2, ...over }); w.mkLine(m['id'], { ...GOOD_LINE, state: state === 'withdrawn' ? 'withdrawn' : 'submitted' }); w.mkLine(m['id'], { partner_sample_ref: 'SYN-A2', state: state === 'withdrawn' ? 'withdrawn' : 'submitted' }); return m; };

  it('200 for a submitted manifest: {manifest (with lines), partner {name, partner_code}, receiving_centre {name, code}, printed_at}; no extra keys, no internal columns', async () => {
    const { w, ctx } = mk(); const m = sub(w, 'submitted');
    const r = await call(getManifestPrintView, ctx, req({ manifest_id: m['id'] }));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['manifest', 'partner', 'printed_at', 'receiving_centre']);
    expect(r.body.partner).toEqual({ name: 'Synthetic Partner SYN-X', partner_code: 'SYN-X' });
    expect(r.body.receiving_centre).toEqual({ name: 'Synthetic Centre A1', code: 'CE-A1' });
    expect(r.body.printed_at).toMatch(ISO); expect(new Date(r.body.printed_at).toISOString()).toBe('2026-11-13T00:00:00.000Z');
    expect(r.body.manifest).toMatchObject({ id: m['id'], manifest_no: m['manifest_no'], state: 'submitted', line_count: 2 });
    keysWithin(r.body.manifest, MF_KEYS); noLeak(r.body);
    const l0 = r.body.manifest.lines[0];
    expect(l0).toMatchObject({ line_no: 1, partner_sample_ref: 'SYN-A', priority: 'urgent', patient: { full_name: 'Synthetic Patient Good', sex: 'male' } });
    expect(l0.orderables.map((o: Row) => o['code'])).toEqual(['GLU', 'CBC', 'TSH']);
    expect(r.body.manifest.lines.map((l: Row) => l['line_no'])).toEqual([1, 2]);
  });

  it('US-05.1: exactly ONE audit.access row {action manifest.print, entityType manifest, entityId, outcome allowed} per print, no PHI in it; two prints -> two rows; no SQL write', async () => {
    const { w, ctx, audit } = mk(); const m = sub(w, 'submitted'); const n = mark(w);
    await call(getManifestPrintView, ctx, req({ manifest_id: m['id'] }));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'manifest.print', entityType: 'manifest', entityId: m['id'], outcome: 'allowed' });
    noPhi(audit[0]); expect(JSON.stringify(audit[0])).not.toContain(m['manifest_no']);
    await call(getManifestPrintView, ctx, req({ manifest_id: m['id'] }));
    expect(audit).toHaveLength(2);
    quiet(w, n);
  });

  it('allowed in submitted / partially_received / received / withdrawn (one row each); draft and discarded -> 409 partners.manifest_invalid_transition with no access-log row and no data', async () => {
    for (const state of ['submitted', 'partially_received', 'received', 'withdrawn']) {
      const { w, ctx, audit } = mk(); const m = sub(w, state);
      const r = await call(getManifestPrintView, ctx, req({ manifest_id: m['id'] }));
      expect(r.status).toBe(200); expect(r.body.manifest.state).toBe(state); expect(audit.map((a) => a['entityId'])).toEqual([m['id']]);
    }
    for (const state of ['draft', 'discarded']) {
      const { w, ctx, audit } = mk(); const m = sub(w, state);
      await fails(call(getManifestPrintView, ctx, req({ manifest_id: m['id'] })), 'partners.manifest_invalid_transition', 409);
      expect(audit).toEqual([]);
    }
  });

  it('US-05.2 probe: partner X asks for the print view of partner Y / tenant B / a random id / a non-uuid -> identical 404 common.not_found, NO allowed access-log row, nothing leaked', async () => {
    const { w } = mk(); const ym = sub(w, 'submitted', { partner_id: P.y }); const out = []; const rows: unknown[] = [];
    for (const mid of [ym['id'], M.b1, id(999), 'not-a-uuid']) { const c = ctxFor(w); out.push(await fails(call(getManifestPrintView, c.ctx, req({ manifest_id: mid })), 'common.not_found', 404)); rows.push(...c.audit); }
    for (const e of out.slice(1)) sameError(out[0], e);
    for (const e of out) { expect(JSON.stringify(e)).not.toContain(ym['id']); expect(JSON.stringify(e)).not.toContain(ym['manifest_no']); }
    expect(rows.filter((a: any) => a.outcome === 'allowed')).toEqual([]);
  });

  it('permissions: partners.order.read is enough (a read-only member may print); partners.manifest.submit alone is not; staff actor and suspended partner are refused — all without an access-log row', async () => {
    const ok = mk({ perms: [READ] }); const m = sub(ok.w, 'submitted');
    expect((await call(getManifestPrintView, ok.ctx, req({ manifest_id: m['id'] }))).status).toBe(200); expect(ok.audit).toHaveLength(1);
    for (const [over, code, status] of [[{ perms: [SUBMIT] }, 'auth.forbidden', 403], [{ who: 'staff' }, 'auth.forbidden', 403], [{ who: 's1' }, 'partners.partner_inactive', 403], [{ perms: [] }, 'auth.forbidden', 403]] as const) {
      const { w, ctx, audit } = mk(over); const mm = sub(w, 'submitted');
      await fails(call(getManifestPrintView, ctx, req({ manifest_id: mm['id'] })), code, status); expect(audit).toEqual([]);
    }
  });

  it('no data without a log row: if the access-log write fails the request fails', async () => {
    const { w, ctx } = mk({ auditFails: true }); const m = sub(w, 'submitted');
    const out = await settle(call(getManifestPrintView, ctx, req({ manifest_id: m['id'] })));
    expect(out.ok).toBe(false);
  });

  it('values are returned verbatim for the BFF to escape (a stored script tag is data, not markup the API strips or executes); no PHI / manifest_no / sample ref in logs', async () => {
    const { w, ctx, logs } = mk(); const m = sub(w, 'submitted'); const xss = '<script>alert("syn")</script>';
    w.lines.find((l) => l['manifest_id'] === m['id'])!['patient_full_name'] = xss;
    const r = await call(getManifestPrintView, ctx, req({ manifest_id: m['id'] }));
    expect(r.body.manifest.lines[0].patient.full_name).toBe(xss);
    for (const l of logs) { noPhi(l); expect(l).not.toContain(m['manifest_no']); expect(l).not.toContain('alert'); }
  });
});
