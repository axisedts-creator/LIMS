// C13 T08 — manifest drafting (06-IMPLEMENTATION-PLAN row T08). Tests: integration (in-memory SQL world, see manifest-drafting.world.ts) + probes (partner X vs Y ids). ACs: US-04.1, .2, .3, .7, .8.
// done_when: "numbering format + per-partner uniqueness under concurrency (20 parallel creates); If-Match; orderable-not-offered; line limit; DELETE only draft (price projection seeded)".
// Spec: 02-TRD §5.1 (DTOs), §5.2 M1–M7, M10, P2; 03-APP-FLOW §2.1 (MS1/MS4, forbidden transitions), §4.1 (M1 counter, M5 steps 1–4), 05-SCHEMA §3.6–3.7 (manifests, manifest_lines, manifest_counters, price_list_items);
//       07-SECURITY (REQ-SEC-024 partner scope from the token, AB11 server-owned columns, no PHI in logs, cross-partner 404). LD-140 (UI only) does not apply: backend task.
//
// Interface expected from the writer (SEAM = not fixed by the spec; the writer follows it or raises a dispute):
//   ../handlers/{createManifest,listManifests,getManifest,updateManifest,addManifestLine,replaceManifestLine,deleteManifestLine,discardManifest,searchPartnerOrderables}.ts: one named `Handler` export per operationId, wired in
//        manifest.handlers. req = {params:{manifest_id,line_id}, query, headers (lower-case keys), body}; the core already validated shape/enums against OpenAPI (snake_case wire), so the tests never rely on schema validation
//        except where the spec puts a rule in line-validation.ts (exactly one of birth_on/age_years etc.). Result = {status, body, headers?}; M5/M6 return the ManifestLine, M5 adds header ETag = new manifest version.
//   ../service/manifest.service.ts, ../repository/{manifests,manifest-lines,counters}.repo.ts (exercised only through the handlers; the fake SQL subset is documented in the world file).
//   SEAM order: partnerContext.require(ctx) -> ctx.ports.IdentityPort.assertRole(ctx, {permission}) -> work. M1/M4/M5/M6/M7/M10/P2 -> partners.manifest.submit; M2/M3 -> partners.order.read.
//        A staff actor ({type:'user'}) or a partner user of a non-active partner is refused by partnerContext (auth.forbidden / partners.partner_inactive) before any write.
//   SEAM partner scope: every statement is bound by (tenant_id, partner_id) taken from partnerContext, never from the request. The fake has no RLS: a handler that filters by id only leaks and fails the probes.
//   SEAM tenant timezone for `yy`: ctx.core.tenant(ctx) -> {timezone} (A.D. year in that zone via domain/manifest-number.ts manifestYy); the clock is ctx.now() (ISO string).
//   SEAM manifest snapshot: receiving_branch_id / receiving_centre_id / conversion_mode copied from the partner's partners.partners row (SELECT ... FROM partners.partners WHERE tenant_id AND id).
//   SEAM receiving_centre {id, name} in DTOs from ctx.core.centre(ctx,{centreId}) or ctx.core.centres(ctx, ...).
//   SEAM counter: ONE atomic `INSERT INTO partners.manifest_counters (...) VALUES (...) ON CONFLICT (tenant_id, partner_id, yy) DO UPDATE SET last_seq = <col> + 1 ... RETURNING last_seq` (03-APP-FLOW §4.1 M1).
//   SEAM If-Match: header `"<n>"`; missing -> 428 common.precondition_required, malformed -> 400 common.validation_failed, stale -> 409 common.version_conflict (as T07). M4/M5/M10 = manifest version; M6/M7 = line version.
//        Stale detection must be atomic (UPDATE ... WHERE version = $n, 0 rows -> 409), so two writers with the same If-Match cannot both win.
//   SEAM line numbering: line_no = MAX(line_no) + 1 (SELECT COALESCE(MAX(line_no), 0) AS <alias> ... is in the fake subset); manifest.line_count kept equal to the number of lines (SET line_count = line_count +/- 1); M5 also bumps manifest.version.
//   SEAM line validation: domain/line-validation.ts validateLine/…; issue code -> LimsError: common.validation_failed (400), partners.manifest_invalid (422), partners.orderable_not_offered (422, errors[] per id at
//        /orderable_ids/<i>), common.not_found (404, referrer of another partner); `LimsError.errors` carries {path, code, message}. offeredOrderableIds = partners.price_list_items of (tenant, partner) with
//        source 'partner', plus source 'standard' only when partners.settings.include_default_price_list (absent row = true). maxLines = settings.max_lines_per_manifest (absent row = 200).
//        consent_text_version / consent_attested: settings.consent_text_version (default 'partner-v1') / true. orderables_snapshot = array holding code + name (+ kind, orderable_id) of each chosen orderable.
//   SEAM M10: manifest -> state 'discarded' + discarded_at, every draft line -> state 'discarded'; patient redaction is T21/05-SCHEMA §6 (owner function) and is NOT asserted here.
//   SEAM errors never echo submitted values (07-SECURITY): no orderable id / name / sample ref in LimsError.detail/errors.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { addManifestLine } from '../handlers/addManifestLine.js';
import { createManifest } from '../handlers/createManifest.js';
import { deleteManifestLine } from '../handlers/deleteManifestLine.js';
import { discardManifest } from '../handlers/discardManifest.js';
import { getManifest } from '../handlers/getManifest.js';
import { listManifests } from '../handlers/listManifests.js';
import { replaceManifestLine } from '../handlers/replaceManifestLine.js';
import { searchPartnerOrderables } from '../handlers/searchPartnerOrderables.js';
import { updateManifest } from '../handlers/updateManifest.js';
import { manifest } from '../index.js';
import { BR, CE, id, L, M, makeCtx, makeWorld, OR, P, PARTNER_PERMS, releaseLocks, RF, STAFF, T_A, USERS, UUID, type Over, type Row, type World } from './manifest-drafting.world.js';

const SUBMIT = 'partners.manifest.submit', READ = 'partners.order.read';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const NON_DRAFT = ['submitted', 'partially_received', 'received', 'withdrawn', 'discarded'] as const;
const MF_KEYS = ['id', 'manifest_no', 'state', 'line_count', 'lines_converted', 'lines_failed', 'receiving_centre', 'submitted_at', 'received_at', 'pickup_request_id', 'created_at', 'version', 'notes', 'collected_on', 'withdraw_reason_code', 'lines'];
const MS_KEYS = MF_KEYS.filter((k) => !['notes', 'collected_on', 'withdraw_reason_code', 'lines'].includes(k));
const LINE_KEYS = ['id', 'line_no', 'state', 'partner_sample_ref', 'patient', 'consents', 'orderables', 'priority', 'referrer', 'collected_at', 'clinical_note', 'order', 'failure', 'not_received_reason_code', 'version'];
const PRICE_KEYS = ['orderable_id', 'kind', 'code', 'name', 'department_name', 'unit_price', 'source', 'price_list_version', 'effective_from', 'effective_to'];
const LEAKY = ['tenant_id', 'partner_id', 'created_by', 'updated_by', 'orderable_ids', 'orderables_snapshot', 'is_redacted', 'resolved_patient_id', 'conversion_attempt', 'receiving_centre_id', 'receiving_branch_id', 'conversion_mode', 'price_list_id'];

const IFM = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const req = (o: { manifest_id?: string; line_id?: string; headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {}) =>
  ({ params: { ...(o.manifest_id ? { manifest_id: o.manifest_id } : {}), ...(o.line_id ? { line_id: o.line_id } : {}) }, query: o.query ?? {}, headers: o.headers ?? {}, body: o.body });
type Out = { status: number; body: any; headers?: Record<string, string> };
const call = (h: (r: any, c: any) => Promise<unknown>, ctx: any, r: unknown) => (h(r, ctx) as Promise<Out>).finally(() => releaseLocks(ctx.tx)); // the fake "transaction" ends when the handler settles
const fails = async (p: Promise<unknown>, code: string, status: number) => {
  const e: any = await p.then(() => { throw new Error('expected rejection'); }, (x) => x);
  expect(e).toBeInstanceOf(LimsError); expect(e.code).toBe(code); expect(e.statusCode).toBe(status);
  return e as LimsError;
};
const mk = (over: Over = {}) => { const w = makeWorld(); return { w, ...makeCtx(w, over) }; };
const ctxFor = (w: World, over: Over = {}) => makeCtx(w, over);
const man = (w: World, mid: string) => w.manifests.find((m) => m['id'] === mid)!;
const line = (w: World, lid: string) => w.lines.find((l) => l['id'] === lid);
const untouched = (w: World, before: string) => { expect(w.writes).toEqual([]); expect(w.jobs).toEqual([]); expect(w.snapshot()).toBe(before); };
const LINE_IN = (over: Row = {}) => ({
  partner_sample_ref: 'SYN-REF-NEW', patient: { full_name: 'Synthetic Patient New', sex: 'female', age_years: 41, phone_e164: '+15555550142' }, consents: { sms: true, whatsapp: false, email: false, share_with_referrer: true },
  orderable_ids: [OR.glu, OR.cbc], priority: 'urgent', referrer_id: RF.x1, collected_at: '2026-11-12T09:30:00Z', clinical_note: 'Synthetic clinical note', ...over,
});
const keysWithin = (o: object, allowed: string[]) => { for (const k of Object.keys(o)) expect(allowed, `unexpected key ${k}`).toContain(k); };
const noLeak = (o: object) => { for (const k of LEAKY) expect(JSON.stringify(o)).not.toContain(`"${k}"`); };
const sameError = (a: any, b: any) => { expect(a.code).toBe(b.code); expect(a.statusCode).toBe(b.statusCode); expect(a.detail).toBe(b.detail); expect(a.errors).toEqual(b.errors); };
const errOf = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection'); }, (x) => x as any);
/** Either a 400 validation rejection with nothing written, or accepted with the planted fields ignored (T07 convention for mass assignment). */
async function ignoredOrRejected(w: World, p: Promise<Out>): Promise<Out | undefined> {
  const out = await p.then((r) => r, (e) => e);
  if (out instanceof LimsError) { expect(out.code).toBe('common.validation_failed'); expect(w.writes).toEqual([]); return undefined; }
  return out as Out;
}

describe('T08 wiring', () => {
  it('M1–M7, M10, P2 are wired to the handlers (T01 stubs replaced)', () => {
    const wired = { createManifest, listManifests, getManifest, updateManifest, addManifestLine, replaceManifestLine, deleteManifestLine, discardManifest, searchPartnerOrderables };
    for (const [op, h] of Object.entries(wired)) { expect(typeof h).toBe('function'); expect(manifest.handlers[op]).toBe(h); }
  });
});

describe('T08 M1 createManifest — US-04.1 numbering', () => {
  it('201: draft manifest of the caller\'s partner, manifest_no MF{yy}{seq:6} from the counter, snapshot of the partner\'s centre/mode, DTO allowlist', async () => {
    const { w, ctx } = mk();
    const r = await call(createManifest, ctx, req({ body: { notes: 'Synthetic box note', collected_on: '2026-11-12' } }));
    expect(r.status).toBe(201);
    const db = w.manifests.find((m) => m['id'] === r.body.id)!;
    expect(db['id']).toMatch(UUID);
    expect(db).toMatchObject({ tenant_id: T_A, partner_id: P.x, state: 'draft', manifest_no: 'MF26000004', version: 1, line_count: 0, notes: 'Synthetic box note', collected_on: '2026-11-12',
      receiving_branch_id: BR.a1, receiving_centre_id: CE.a1, conversion_mode: 'on_receipt', created_by: USERS.x1.actor, updated_by: USERS.x1.actor, submitted_at: null, discarded_at: null });
    expect(w.counters.find((c) => c['partner_id'] === P.x && c['yy'] === 26)!['last_seq']).toBe(4);
    expect(r.body).toMatchObject({ id: db['id'], manifest_no: 'MF26000004', state: 'draft', line_count: 0, lines_converted: 0, lines_failed: 0, version: 1, notes: 'Synthetic box note', collected_on: '2026-11-12', lines: [] });
    expect(r.body.receiving_centre).toEqual({ id: CE.a1, name: 'Synthetic Centre A1' });
    expect(r.body.created_at).toMatch(ISO);
    keysWithin(r.body, MF_KEYS); noLeak(r.body);
  });

  it('first manifest of a partner/year starts at 000001; the counter row is created; yy is the A.D. year in the TENANT timezone (Asia/Kathmandu, not UTC)', async () => {
    const { w, ctx } = mk(); w.reset();
    expect((await call(createManifest, ctx, req({ body: {} }))).body.manifest_no).toBe('MF26000001');
    // 2026-12-31T19:00Z is already 2027-01-01 00:45 in Kathmandu -> yy 27, new counter row; the 2026 counter is untouched
    const { ctx: c2 } = ctxFor(w, { now: '2026-12-31T19:00:00.000Z' });
    expect((await call(createManifest, c2, req({ body: {} }))).body.manifest_no).toBe('MF27000001');
    expect(w.counters.filter((c) => c['partner_id'] === P.x).map((c) => [c['yy'], c['last_seq']]).sort()).toEqual([[26, 1], [27, 1]]);
    // 2026-12-31T17:00Z is still 2026-12-31 22:45 in Kathmandu -> yy 26 continues
    const { ctx: c3 } = ctxFor(w, { now: '2026-12-31T17:00:00.000Z' });
    expect((await call(createManifest, c3, req({ body: {} }))).body.manifest_no).toBe('MF26000002');
  });

  it('numbering is per partner: partner Y gets its own sequence (the same number may exist for two partners); never another partner\'s counter', async () => {
    const { w } = mk(); w.reset();
    const n = async (who: 'x1' | 'y1') => (await call(createManifest, ctxFor(w, { who }).ctx, req({ body: {} }))).body.manifest_no;
    expect(await n('x1')).toBe('MF26000001'); expect(await n('y1')).toBe('MF26000001'); expect(await n('x1')).toBe('MF26000002'); expect(await n('y1')).toBe('MF26000002');
    expect(w.manifests.filter((m) => m['partner_id'] === P.y).map((m) => m['manifest_no']).sort()).toEqual(['MF26000001', 'MF26000002']);
    expect(w.counters.map((c) => [c['partner_id'], c['last_seq']])).toEqual(expect.arrayContaining([[P.x, 2], [P.y, 2]]));
  });

  it('20 parallel creates by one partner: all 201, 20 distinct well-formed manifest_no, unique per (tenant, partner), counter = highest issued (gaps allowed)', async () => {
    const { w } = mk(); w.reset();
    const res = await Promise.all(Array.from({ length: 20 }, () => call(createManifest, ctxFor(w).ctx, req({ body: {} })).then((r) => r, (e) => e)));
    for (const r of res) { expect(r).not.toBeInstanceOf(Error); expect((r as Out).status).toBe(201); }
    const nos = (res as Out[]).map((r) => r.body.manifest_no as string);
    expect(new Set(nos).size).toBe(20);
    for (const no of nos) expect(no).toMatch(/^MF26\d{6}$/);
    const seqs = nos.map((no) => Number(no.slice(4)));
    expect(w.manifests.filter((m) => m['partner_id'] === P.x)).toHaveLength(20);
    expect(w.counters.find((c) => c['partner_id'] === P.x && c['yy'] === 26)!['last_seq']).toBe(Math.max(...seqs));
    expect(new Set(w.manifests.filter((m) => m['partner_id'] === P.x).map((m) => m['id'])).size).toBe(20);
  });

  it('parallel creates by two partners at once: each partner\'s numbers are distinct and stay inside its own counter', async () => {
    const { w } = mk(); w.reset();
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => call(createManifest, ctxFor(w, { who: i % 2 ? 'x1' : 'y1' }).ctx, req({ body: {} })).then((r) => ({ who: i % 2 ? P.x : P.y, r }))));
    for (const p of [P.x, P.y]) {
      const nos = res.filter((z) => z.who === p).map((z) => z.r.body.manifest_no);
      expect(nos).toHaveLength(10); expect(new Set(nos).size).toBe(10);
      expect(w.manifests.filter((m) => m['partner_id'] === p).map((m) => m['manifest_no']).sort()).toEqual([...nos].sort());
    }
  });

  it('partner / tenant / state / number / version / snapshot columns can never be planted from the body; created_by comes from the actor', async () => {
    const { w, ctx } = mk();
    const planted = { notes: 'n', partner_id: P.y, tenant_id: id(2), state: 'submitted', manifest_no: 'MF99999999', version: 9, line_count: 5, submitted_at: '2026-01-01T00:00:00Z', receiving_centre_id: CE.a2, created_by: id(77), is_active: false };
    const r = await ignoredOrRejected(w, call(createManifest, ctx, req({ body: planted }))); if (!r) return;
    expect(r.status).toBe(201);
    expect(man(w, r.body.id)).toMatchObject({ tenant_id: T_A, partner_id: P.x, state: 'draft', version: 1, line_count: 0, submitted_at: null, receiving_centre_id: CE.a1, created_by: USERS.x1.actor, is_active: true });
    expect(man(w, r.body.id)['manifest_no']).not.toBe('MF99999999');
  });

  it('refused before any write: staff actor, partner user without partners.manifest.submit, user of a suspended partner', async () => {
    for (const [over, code, status] of [[{ who: 'staff' }, 'auth.forbidden', 403], [{ perms: [READ] }, 'auth.forbidden', 403], [{ who: 's1' }, 'partners.partner_inactive', 403]] as const) {
      const { w, ctx } = mk(over); const before = w.snapshot();
      await fails(call(createManifest, ctx, req({ body: {} })), code, status);
      untouched(w, before);
    }
  });

  it('hostile notes are only a bound parameter; no manifest_no / notes in logs; tenant B\'s partner has its own counter', async () => {
    const { w, ctx, logs } = mk(); const notes = `x'); DROP TABLE partners.manifests;--`;
    const r = await call(createManifest, ctx, req({ body: { notes } }));
    expect(r.body.notes).toBe(notes);
    for (const q of w.log) { expect(q.text).not.toMatch(/DROP\s+TABLE/i); expect(q.text).not.toContain('MF26'); }
    expect(w.log.some((q) => q.values.includes(notes))).toBe(true);
    for (const l of logs) { expect(l).not.toContain('MF26'); expect(l).not.toContain('DROP TABLE'); }
    expect((await call(createManifest, makeCtx(w, { who: 'b1' }).ctx, req({ body: {} }))).body.manifest_no).toBe('MF26000002'); // B's counter (last_seq 1), never A's
  });
});

describe('T08 M2 listManifests / M3 getManifest — own partner only', () => {
  it('M2 lists only the caller\'s partner manifests, newest first, ManifestSummary allowlist (no lines), page.limit', async () => {
    const { ctx } = mk();
    const r = await call(listManifests, ctx, req({ query: { limit: 50 } }));
    expect(r.status).toBe(200);
    expect(r.body.data.map((m: Row) => m['id'])).toEqual([M.xs, M.x2, M.x1]);
    for (const m of r.body.data) { keysWithin(m, MS_KEYS); noLeak(m); expect(m).not.toHaveProperty('lines'); expect(m.receiving_centre).toEqual({ id: CE.a1, name: 'Synthetic Centre A1' }); }
    expect(r.body.data.find((m: Row) => m['id'] === M.x1)).toMatchObject({ manifest_no: 'MF26000001', state: 'draft', line_count: 1, version: 3 });
    expect(r.body.page.limit).toBe(50);
    const y = await call(listManifests, makeCtx(makeWorld(), { who: 'y1' }).ctx, req({ query: {} }));
    expect(y.body.data.map((m: Row) => m['id'])).toEqual([M.y1]);
  });

  it('state filter (csv) and cursor round trip: no overlap, no gap, no foreign row', async () => {
    const { w } = mk();
    const c = () => ctxFor(w).ctx;
    expect((await call(listManifests, c(), req({ query: { state: 'draft' } }))).body.data.map((m: Row) => m['id']).sort()).toEqual([M.x1, M.x2].sort());
    expect((await call(listManifests, c(), req({ query: { state: 'draft,submitted' } }))).body.data).toHaveLength(3);
    expect((await call(listManifests, c(), req({ query: { state: 'withdrawn' } }))).body.data).toEqual([]);
    const p1 = await call(listManifests, c(), req({ query: { limit: 2 } }));
    expect(p1.body.data).toHaveLength(2); expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await call(listManifests, c(), req({ query: { limit: 2, cursor: p1.body.page.next_cursor } }));
    const all = [...p1.body.data, ...p2.body.data].map((m: Row) => m['id']);
    expect(all).toEqual([M.xs, M.x2, M.x1]);
    expect(p2.body.page.next_cursor).toBeUndefined();
  });

  it('M2 needs partners.order.read only; a user without it is refused; M2 never exposes another tenant\'s partner', async () => {
    await fails(call(listManifests, mk({ perms: [] }).ctx, req()), 'auth.forbidden', 403);
    const r = await call(listManifests, mk({ perms: [READ] }).ctx, req());
    expect(r.body.data).toHaveLength(3);
    const b = await call(listManifests, mk({ who: 'b1' }).ctx, req());
    expect(b.body.data.map((m: Row) => m['id'])).toEqual([M.b1]);
  });

  it('M3 returns the manifest with its lines ordered by line_no; DTO allowlists; no internal columns', async () => {
    const { w, ctx } = mk(); w.mkLine(M.x1, { id: id(8001), line_no: 2, partner_sample_ref: 'SYN-REF-2', referrer_id: RF.x1, orderable_ids: [OR.cbc], orderables_snapshot: [{ orderable_id: OR.cbc, kind: 'panel', code: 'CBC', name: 'Complete Blood Count' }] });
    man(w, M.x1)['line_count'] = 2;
    const r = await call(getManifest, ctx, req({ manifest_id: M.x1 }));
    expect(r.status).toBe(200);
    keysWithin(r.body, MF_KEYS); noLeak(r.body);
    expect(r.body).toMatchObject({ id: M.x1, manifest_no: 'MF26000001', state: 'draft', line_count: 2, notes: 'Synthetic draft note', version: 3 });
    expect(r.body.lines.map((l: Row) => l['line_no'])).toEqual([1, 2]);
    for (const l of r.body.lines) { keysWithin(l, LINE_KEYS); noLeak(l); }
    expect(r.body.lines[0]).toMatchObject({ id: L.x1, line_no: 1, state: 'draft', partner_sample_ref: 'SYN-REF-1', priority: 'routine', version: 2 });
    expect(r.body.lines[0].patient).toMatchObject({ full_name: 'Synthetic Patient 1', sex: 'female', age_years: 30 });
    expect(r.body.lines[0].consents).toEqual({ sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'partner-v1' });
    expect(r.body.lines[0].orderables).toEqual([{ orderable_id: OR.glu, kind: 'test', code: 'GLU', name: 'Glucose Fasting' }]);
    expect(r.body.lines[1].referrer).toEqual({ id: RF.x1, display_name: 'Dr Synthetic One' });
  });

  it('probe: partner X asks for a manifest of partner Y / tenant B / a random id -> identical 404 common.not_found, nothing written', async () => {
    const { w } = mk(); const before = w.snapshot();
    const errs = [];
    for (const mid of [M.y1, M.b1, id(999)]) errs.push(await fails(call(getManifest, ctxFor(w).ctx, req({ manifest_id: mid })), 'common.not_found', 404));
    sameError(errs[0], errs[2]); sameError(errs[1], errs[2]);
    for (const e of errs) { expect(JSON.stringify(e)).not.toContain(M.y1); expect(JSON.stringify(e)).not.toContain('MF26'); }
    untouched(w, before);
    expect((await call(getManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.y1 }))).body.id).toBe(M.y1); // Y itself can
    await fails(call(getManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.x1 })), 'common.not_found', 404);
  });
});

describe('T08 M4 updateManifest — If-Match, draft only', () => {
  it('200: notes + collected_on change, version +1, updated_by = actor; unset[] clears; DTO returned', async () => {
    const { w, ctx } = mk();
    const r = await call(updateManifest, ctx, req({ manifest_id: M.x1, headers: IFM(3), body: { notes: 'Changed note', collected_on: '2026-11-11' } }));
    expect(r.status).toBe(200);
    expect(man(w, M.x1)).toMatchObject({ notes: 'Changed note', collected_on: '2026-11-11', version: 4, updated_by: USERS.x1.actor, state: 'draft', partner_id: P.x });
    expect(r.body).toMatchObject({ id: M.x1, notes: 'Changed note', collected_on: '2026-11-11', version: 4 }); keysWithin(r.body, MF_KEYS);
    const r2 = await call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(4), body: { unset: ['notes'] } }));
    expect(man(w, M.x1)['notes']).toBeNull(); expect(man(w, M.x1)['version']).toBe(5); expect(r2.body).not.toHaveProperty('notes');
  });

  it('If-Match: missing 428, malformed 400, stale 409 (nothing written); two PATCHes with the same If-Match: one wins, the other 409 (no lost update)', async () => {
    const { w, ctx } = mk(); const before = w.snapshot();
    await fails(call(updateManifest, ctx, req({ manifest_id: M.x1, body: { notes: 'Nope' } })), 'common.precondition_required', 428);
    await fails(call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM('3'), body: { notes: 'Nope' } })), 'common.validation_failed', 400);
    await fails(call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(2), body: { notes: 'Nope' } })), 'common.version_conflict', 409);
    untouched(w, before);
    const res = await Promise.allSettled([1, 2].map((n) => call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: { notes: `Racer ${n}` } }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult; expect(lost.reason).toBeInstanceOf(LimsError); expect(lost.reason.code).toBe('common.version_conflict');
    expect(man(w, M.x1)['version']).toBe(4);
  });

  it('US-04.7 non-draft manifest (submitted, partially_received, received, withdrawn, discarded) -> 409 partners.manifest_not_editable, nothing written', async () => {
    for (const state of NON_DRAFT) {
      const { w, ctx } = mk(); const m = w.mkManifest({ state, version: 6 }); const before = w.snapshot();
      await fails(call(updateManifest, ctx, req({ manifest_id: m['id'], headers: IFM(6), body: { notes: 'Nope' } })), 'partners.manifest_not_editable', 409);
      untouched(w, before);
    }
  });

  it('probe: foreign manifest (Y, tenant B) with the CORRECT version -> 404, not 409/200; planted fields never applied; read-only user refused', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.y1, headers: IFM(2), body: { notes: 'Hijack' } })), 'common.not_found', 404);
    await fails(call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.b1, headers: IFM(2), body: { notes: 'Hijack' } })), 'common.not_found', 404);
    untouched(w, before);
    await fails(call(updateManifest, ctxFor(w, { perms: [READ] }).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: { notes: 'x' } })), 'auth.forbidden', 403);
    untouched(w, before);
    const r = await ignoredOrRejected(w, call(updateManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: { notes: 'ok', state: 'submitted', partner_id: P.y, manifest_no: 'MF99999999', submitted_at: '2026-01-01T00:00:00Z', received_at: '2026-01-01T00:00:00Z' } })));
    if (r) expect(man(w, M.x1)).toMatchObject({ state: 'draft', partner_id: P.x, manifest_no: 'MF26000001', submitted_at: null, received_at: null });
  });
});

describe('T08 M5 addManifestLine — US-04.2', () => {
  it('201: line stored from the body + settings (all columns), manifest version +1 and line_count +1, ETag = new manifest version, DTO = ManifestLine allowlist', async () => {
    const { w, ctx } = mk();
    const r = await call(addManifestLine, ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN() }));
    expect(r.status).toBe(201);
    const db = w.lines.find((l) => l['id'] === r.body.id)!;
    expect(db['id']).toMatch(UUID);
    expect(db).toMatchObject({ tenant_id: T_A, partner_id: P.x, manifest_id: M.x1, receiving_centre_id: CE.a1, line_no: 2, state: 'draft', partner_sample_ref: 'SYN-REF-NEW', patient_full_name: 'Synthetic Patient New',
      patient_sex: 'female', patient_age_years: 41, patient_birth_on: null, patient_phone_e164: '+15555550142', consent_attested: true, consent_sms: true, consent_whatsapp: false, consent_email: false,
      consent_share_with_referrer: true, consent_text_version: 'partner-v1', orderable_ids: [OR.glu, OR.cbc], priority: 'urgent', referrer_id: RF.x1, clinical_note: 'Synthetic clinical note', version: 1,
      order_id: null, registration_no: null, converted_at: null, failure_code: null, sample_received_at: null, created_by: USERS.x1.actor, updated_by: USERS.x1.actor });
    expect(new Date(db['collected_at']).toISOString()).toBe('2026-11-12T09:30:00.000Z');
    expect(JSON.stringify(db['orderables_snapshot'])).toContain('GLU'); expect(JSON.stringify(db['orderables_snapshot'])).toContain('Complete Blood Count');
    expect(man(w, M.x1)).toMatchObject({ version: 4, line_count: 2, updated_by: USERS.x1.actor });
    expect(r.body).toMatchObject({ id: db['id'], line_no: 2, state: 'draft', partner_sample_ref: 'SYN-REF-NEW', priority: 'urgent', version: 1, clinical_note: 'Synthetic clinical note' });
    expect(r.body.patient).toEqual({ full_name: 'Synthetic Patient New', sex: 'female', age_years: 41, phone_e164: '+15555550142' });
    expect(r.body.consents).toEqual({ sms: true, whatsapp: false, email: false, share_with_referrer: true, consent_text_version: 'partner-v1' });
    expect(r.body.orderables.map((o: Row) => o['orderable_id'])).toEqual([OR.glu, OR.cbc]);
    expect(r.body.orderables[1]).toEqual({ orderable_id: OR.cbc, kind: 'panel', code: 'CBC', name: 'Complete Blood Count' });
    expect(r.body.referrer).toEqual({ id: RF.x1, display_name: 'Dr Synthetic One' });
    keysWithin(r.body, LINE_KEYS); noLeak(r.body);
    const etag = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'etag')?.[1]; expect(String(etag)).toMatch(/^(W\/)?"?4"?$/);
  });

  it('birth_on instead of age_years is stored as such; the consent text version comes from the tenant settings; absent optional fields stay null', async () => {
    const { w, ctx } = mk(); w.setSettings(T_A, { consent_text_version: 'partner-v7' });
    const r = await call(addManifestLine, ctx, req({ manifest_id: M.x2, headers: IFM(1), body: { patient: { full_name: 'Synthetic Patient B', sex: 'male', birth_on: '1990-05-17' }, consents: { sms: false, whatsapp: false, email: false, share_with_referrer: false },
      orderable_ids: [OR.glu], priority: 'routine' } }));
    const db = w.lines.find((l) => l['id'] === r.body.id)!;
    expect(db).toMatchObject({ patient_birth_on: '1990-05-17', patient_age_years: null, patient_phone_e164: null, partner_sample_ref: null, referrer_id: null, collected_at: null, clinical_note: null, consent_text_version: 'partner-v7', line_no: 1 });
    expect(r.body.consents.consent_text_version).toBe('partner-v7'); expect(r.body.patient).toEqual({ full_name: 'Synthetic Patient B', sex: 'male', birth_on: '1990-05-17' });
  });

  it('line_no = max + 1 (a deleted number below the highest is not reused); each add bumps the manifest version', async () => {
    const { w } = mk(); const add = (v: number) => call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(v), body: LINE_IN({ partner_sample_ref: undefined }) }));
    const a = await add(1), b = await add(2);
    expect([a.body.line_no, b.body.line_no]).toEqual([1, 2]); expect(man(w, M.x2)['version']).toBe(3);
    await call(deleteManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, line_id: a.body.id, headers: IFM(1) }));
    const c = await add(man(w, M.x2)['version']);
    expect(c.body.line_no).toBe(3); expect(w.linesOf(M.x2).map((l) => l['line_no'])).toEqual([2, 3]); expect(man(w, M.x2)['line_count']).toBe(2);
  });

  it('If-Match (manifest version): missing 428, malformed 400, stale 409; nothing written', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, body: LINE_IN() })), 'common.precondition_required', 428);
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM('abc'), body: LINE_IN() })), 'common.validation_failed', 400);
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(2), body: LINE_IN() })), 'common.version_conflict', 409);
    untouched(w, before);
  });

  it('two adds with the same If-Match: exactly one 201, the other 409 common.version_conflict; one new line, unique line_no, version +1 once', async () => {
    const { w } = mk();
    const res = await Promise.allSettled([1, 2].map((n) => call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(1), body: LINE_IN({ partner_sample_ref: `SYN-RACE-${n}` }) }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult; expect(lost.reason).toBeInstanceOf(LimsError); expect(lost.reason.code).toBe('common.version_conflict');
    expect(w.linesOf(M.x2)).toHaveLength(1); expect(man(w, M.x2)).toMatchObject({ version: 2, line_count: 1 });
  });

  it('US-04.7 non-draft manifest -> 409 partners.manifest_not_editable for every state; nothing written', async () => {
    for (const state of NON_DRAFT) {
      const { w, ctx } = mk(); const m = w.mkManifest({ state, version: 6 }); const before = w.snapshot();
      await fails(call(addManifestLine, ctx, req({ manifest_id: m['id'], headers: IFM(6), body: LINE_IN() })), 'partners.manifest_not_editable', 409);
      untouched(w, before);
    }
  });

  it('US-04.3 orderable not in the partner price list -> 422 partners.orderable_not_offered, errors[] per unoffered id only, ids never echoed, nothing written', async () => {
    const { w } = mk(); const before = w.snapshot();
    const e = await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ orderable_ids: [OR.glu, OR.a1c, OR.bx, OR.none] }) })), 'partners.orderable_not_offered', 422);
    expect((e.errors ?? []).map((f) => f.path).sort()).toEqual(['/orderable_ids/1', '/orderable_ids/2', '/orderable_ids/3']);
    for (const x of [OR.a1c, OR.bx, OR.none]) expect(JSON.stringify(e)).not.toContain(x);
    expect(JSON.stringify(e)).not.toContain('HbA1c'); untouched(w, before);
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ orderable_ids: [OR.a1c] }) })), 'partners.orderable_not_offered', 422); // Y's own item is not X's
  });

  it('standard (tenant default) list items are orderable only while include_default_price_list is on; partner-source items always', async () => {
    const { w } = mk();
    expect((await call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(1), body: LINE_IN({ orderable_ids: [OR.tsh] }) }))).status).toBe(201);
    w.setSettings(T_A, { include_default_price_list: false });
    const e = await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(2), body: LINE_IN({ orderable_ids: [OR.glu, OR.tsh], partner_sample_ref: 'SYN-REF-OFF' }) })), 'partners.orderable_not_offered', 422);
    expect((e.errors ?? []).map((f) => f.path)).toEqual(['/orderable_ids/1']);
    expect((await call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(2), body: LINE_IN({ orderable_ids: [OR.glu, OR.cbc], partner_sample_ref: 'SYN-REF-ON' }) }))).status).toBe(201);
  });

  it('referrer: another partner\'s or unknown -> 404 common.not_found (never revealed), own inactive -> 422 partners.manifest_invalid; nothing written', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ referrer_id: RF.y1 }) })), 'common.not_found', 404);
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ referrer_id: RF.b1 }) })), 'common.not_found', 404);
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ referrer_id: id(998) }) })), 'common.not_found', 404);
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ referrer_id: RF.x2inactive }) })), 'partners.manifest_invalid', 422);
    untouched(w, before);
  });

  it('US-04.8 line limit: tenant max_lines_per_manifest reached -> 422 partners.manifest_invalid at /lines (exactly at the limit is fine); default 200 when no settings row', async () => {
    const { w } = mk(); w.setSettings(T_A, { max_lines_per_manifest: 2 });
    const add = (v: number, ref: string) => call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(v), body: LINE_IN({ partner_sample_ref: ref }) }));
    expect((await add(1, 'SYN-L-1')).status).toBe(201); expect((await add(2, 'SYN-L-2')).status).toBe(201);
    w.log.length = 0; w.jobs.length = 0;
    const before = w.snapshot();
    const e = await fails(add(3, 'SYN-L-3'), 'partners.manifest_invalid', 422);
    expect((e.errors ?? []).map((f) => f.path)).toContain('/lines'); untouched(w, before);

    const { w: w2 } = mk(); w2.setSettings(T_A, null);
    const m = w2.mkManifest({ line_count: 199, version: 10 }); for (let i = 0; i < 199; i++) w2.mkLine(m['id']);
    expect((await call(addManifestLine, ctxFor(w2).ctx, req({ manifest_id: m['id'], headers: IFM(10), body: LINE_IN({ partner_sample_ref: 'SYN-200' }) }))).status).toBe(201);
    expect(man(w2, m['id'])['line_count']).toBe(200);
    w2.log.length = 0; w2.jobs.length = 0;
    const before2 = w2.snapshot();
    await fails(call(addManifestLine, ctxFor(w2).ctx, req({ manifest_id: m['id'], headers: IFM(11), body: LINE_IN({ partner_sample_ref: 'SYN-201' }) })), 'partners.manifest_invalid', 422);
    untouched(w2, before2);
  });

  it('duplicate partner_sample_ref within the manifest -> 422 partners.manifest_invalid (not a raw 23505); the same ref in another manifest is fine', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ partner_sample_ref: 'SYN-REF-1' }) })), 'partners.manifest_invalid', 422);
    untouched(w, before);
    expect((await call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, headers: IFM(1), body: LINE_IN({ partner_sample_ref: 'SYN-REF-1' }) }))).status).toBe(201);
  });

  it('line-validation rules reach the API: neither / both of birth_on and age_years, birth_on in the future, 31 orderables, duplicate orderable ids -> rejected, nothing written', async () => {
    const { w } = mk(); const before = w.snapshot();
    const base = (patient: Row, extra: Row = {}) => LINE_IN({ patient: { full_name: 'Synthetic Patient V', sex: 'male', ...patient }, ...extra });
    for (const body of [base({}), base({ birth_on: '1990-01-01', age_years: 33 }), base({ birth_on: '2099-01-01' }), LINE_IN({ orderable_ids: [OR.glu, OR.glu] })]) {
      const e: any = await errOf(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3), body })));
      expect(e).toBeInstanceOf(LimsError); expect(['common.validation_failed', 'partners.manifest_invalid']).toContain(e.code); expect([400, 422]).toContain(e.statusCode);
    }
    untouched(w, before);
  });

  it('probe (partner X vs Y): foreign / unknown manifest with the CORRECT version -> 404; Y\'s data untouched; read-only user -> 403', async () => {
    const { w } = mk(); const before = w.snapshot();
    for (const [mid, v] of [[M.y1, 2], [M.b1, 2], [id(999), 1]] as const) await fails(call(addManifestLine, ctxFor(w).ctx, req({ manifest_id: mid, headers: IFM(v), body: LINE_IN() })), 'common.not_found', 404);
    await fails(call(addManifestLine, ctxFor(w, { who: 'b1' }).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN() })), 'common.not_found', 404);
    untouched(w, before);
    await fails(call(addManifestLine, ctxFor(w, { perms: [READ] }).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN() })), 'auth.forbidden', 403);
    await fails(call(addManifestLine, ctxFor(w, { who: 'staff' }).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN() })), 'auth.forbidden', 403);
    untouched(w, before);
  });

  it('AB11: server-owned columns (order_id, registration_no, state, failure_code, sample_received_at, partner_id, tenant_id, version, ...) can never be planted', async () => {
    const { w, ctx } = mk();
    const planted = LINE_IN({ order_id: id(77), registration_no: 'REG-1', state: 'converted', failure_code: 'x.y', sample_received_at: '2026-01-01T00:00:00Z', received_by: id(78), converted_at: '2026-01-01T00:00:00Z',
      partner_id: P.y, tenant_id: id(2), version: 9, line_no: 150, is_redacted: true, resolved_patient_id: id(79), conversion_attempt: 5, manifest_id: M.y1, receiving_centre_id: CE.a2, created_by: id(80) });
    const r = await ignoredOrRejected(w, call(addManifestLine, ctx, req({ manifest_id: M.x1, headers: IFM(3), body: planted }))); if (!r) return;
    expect(r.status).toBe(201);
    expect(w.lines.find((l) => l['id'] === r.body.id)).toMatchObject({ tenant_id: T_A, partner_id: P.x, manifest_id: M.x1, receiving_centre_id: CE.a1, state: 'draft', version: 1, line_no: 2, order_id: null, registration_no: null,
      failure_code: null, sample_received_at: null, received_by: null, converted_at: null, is_redacted: false, resolved_patient_id: null, conversion_attempt: 0, created_by: USERS.x1.actor });
    expect(r.body.state).toBe('draft'); expect(r.body).not.toHaveProperty('order');
  });

  it('hostile text is only a bound parameter; patient name / phone / sample ref / clinical note / manifest_no / orderable names are not logged', async () => {
    const { w, ctx, logs } = mk(); const name = `Robert'); DROP TABLE partners.manifest_lines;--`;
    const r = await call(addManifestLine, ctx, req({ manifest_id: M.x1, headers: IFM(3), body: LINE_IN({ patient: { full_name: name, sex: 'male', age_years: 7, phone_e164: '+15555550142' } }) }));
    expect(r.body.patient.full_name).toBe(name);
    for (const q of w.log) { expect(q.text).not.toMatch(/DROP\s+TABLE/i); for (const s of ['Synthetic Clinical', '+1555555', 'SYN-REF-NEW']) expect(q.text).not.toContain(s); }
    expect(w.log.some((q) => q.values.includes(name))).toBe(true);
    for (const l of logs) for (const s of [name, '+15555550142', 'SYN-REF-NEW', 'Synthetic clinical note', 'MF26000001', 'Glucose Fasting', 'DROP TABLE']) expect(l).not.toContain(s);
  });
});

describe('T08 M6 replaceManifestLine — line If-Match, draft only', () => {
  it('200: the line is replaced in place (same id and line_no), line version +1, updated_by = actor, created_by kept; own sample ref may be kept', async () => {
    const { w, ctx } = mk();
    const body = LINE_IN({ partner_sample_ref: 'SYN-REF-1', patient: { full_name: 'Synthetic Patient Replaced', sex: 'other', birth_on: '1985-03-02' }, orderable_ids: [OR.cbc], priority: 'routine', referrer_id: undefined, clinical_note: undefined, collected_at: undefined });
    const r = await call(replaceManifestLine, ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2), body }));
    expect(r.status).toBe(200);
    expect(line(w, L.x1)).toMatchObject({ id: L.x1, line_no: 1, version: 3, state: 'draft', partner_sample_ref: 'SYN-REF-1', patient_full_name: 'Synthetic Patient Replaced', patient_sex: 'other', patient_birth_on: '1985-03-02', patient_age_years: null,
      orderable_ids: [OR.cbc], priority: 'routine', referrer_id: null, clinical_note: null, updated_by: USERS.x1.actor, created_by: USERS.x1.actor, tenant_id: T_A, partner_id: P.x, manifest_id: M.x1 });
    expect(JSON.stringify(line(w, L.x1)!['orderables_snapshot'])).toContain('CBC');
    expect(r.body).toMatchObject({ id: L.x1, line_no: 1, version: 3, priority: 'routine' }); keysWithin(r.body, LINE_KEYS); noLeak(r.body);
    expect(w.lines.filter((l) => l['manifest_id'] === M.x1)).toHaveLength(1);
  });

  it('If-Match (line version): missing 428, malformed 400, stale 409; row untouched; the line limit does not block a replace', async () => {
    const { w } = mk(); const before = w.snapshot(); const b = LINE_IN({ partner_sample_ref: 'SYN-REF-1' });
    await fails(call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, body: b })), 'common.precondition_required', 428);
    await fails(call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM('x'), body: b })), 'common.validation_failed', 400);
    await fails(call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(1), body: b })), 'common.version_conflict', 409);
    untouched(w, before);
    w.setSettings(T_A, { max_lines_per_manifest: 1 }); // manifest is at its limit: replacing is not adding
    expect((await call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2), body: b }))).status).toBe(200);
  });

  it('same validations as M5: orderable not offered 422, foreign referrer 404, sample ref used by ANOTHER line 422; nothing written', async () => {
    const { w } = mk(); w.mkLine(M.x1, { id: id(8002), line_no: 2, partner_sample_ref: 'SYN-REF-2' }); man(w, M.x1)['line_count'] = 2; const before = w.snapshot();
    const h = (over: Row) => call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2), body: LINE_IN({ partner_sample_ref: 'SYN-REF-1', ...over }) }));
    await fails(h({ orderable_ids: [OR.a1c] }), 'partners.orderable_not_offered', 422);
    await fails(h({ referrer_id: RF.y1 }), 'common.not_found', 404);
    await fails(h({ partner_sample_ref: 'SYN-REF-2' }), 'partners.manifest_invalid', 422);
    untouched(w, before);
  });

  it('US-04.7 non-draft manifest -> 409 partners.manifest_not_editable; cross-manifest / foreign line ids -> 404 (the line must belong to the manifest in the path AND to this partner)', async () => {
    const { w } = mk(); const before = w.snapshot(); const b = LINE_IN({ partner_sample_ref: 'SYN-REF-1' });
    await fails(call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.xs, line_id: L.xs, headers: IFM(2), body: b })), 'partners.manifest_not_editable', 409);
    for (const [mid, lid, v] of [[M.x2, L.x1, 2], [M.x1, L.y1, 2], [M.y1, L.y1, 2], [M.x1, L.b1, 2], [M.x1, id(999), 1]] as const)
      await fails(call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: mid, line_id: lid, headers: IFM(v), body: b })), 'common.not_found', 404);
    untouched(w, before);
  });

  it('a line of a draft manifest that is not itself draft cannot be replaced (409 partners.manifest_not_editable); planted columns never applied', async () => {
    const { w } = mk(); const l = w.mkLine(M.x2, { state: 'submitted', version: 4 }); man(w, M.x2)['line_count'] = 1; const before = w.snapshot();
    await fails(call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x2, line_id: l['id'], headers: IFM(4), body: LINE_IN() })), 'partners.manifest_not_editable', 409);
    untouched(w, before);
    const r = await ignoredOrRejected(w, call(replaceManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2), body: LINE_IN({ partner_sample_ref: 'SYN-REF-1', order_id: id(77), registration_no: 'REG-1', state: 'converted', partner_id: P.y }) })));
    if (r) expect(line(w, L.x1)).toMatchObject({ order_id: null, registration_no: null, state: 'draft', partner_id: P.x });
  });
});

describe('T08 M7 deleteManifestLine — DELETE only draft', () => {
  it('204 and the line is gone; manifest line_count follows; line If-Match required (428 / 400 / 409)', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(deleteManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1 })), 'common.precondition_required', 428);
    await fails(call(deleteManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM('z') })), 'common.validation_failed', 400);
    await fails(call(deleteManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(1) })), 'common.version_conflict', 409);
    untouched(w, before);
    const r = await call(deleteManifestLine, ctxFor(w).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2) }));
    expect(r.status).toBe(204); expect(r.body).toBeUndefined();
    expect(line(w, L.x1)).toBeUndefined(); expect(man(w, M.x1)['line_count']).toBe(0); expect(w.linesOf(M.x1)).toHaveLength(0);
    expect(w.lines.some((l) => l['id'] === L.y1) && w.lines.some((l) => l['id'] === L.xs)).toBe(true);
  });

  it('US-04.7 non-draft manifest: every state -> 409 partners.manifest_not_editable and NO delete is issued; submitted lines survive', async () => {
    for (const state of NON_DRAFT) {
      const { w, ctx } = mk(); const m = w.mkManifest({ state, version: 6, line_count: 1 }); const l = w.mkLine(m['id'], { state: state === 'submitted' ? 'submitted' : 'draft', version: 3 }); const before = w.snapshot();
      await fails(call(deleteManifestLine, ctx, req({ manifest_id: m['id'], line_id: l['id'], headers: IFM(3) })), 'partners.manifest_not_editable', 409);
      untouched(w, before); expect(w.log.some((q) => /^\s*DELETE\b/i.test(q.text))).toBe(false);
    }
  });

  it('probe: Y\'s / tenant B\'s / cross-manifest / unknown line ids with the CORRECT line version -> 404, rows untouched; read-only user 403', async () => {
    const { w } = mk(); const before = w.snapshot();
    for (const [mid, lid, v] of [[M.y1, L.y1, 2], [M.x1, L.y1, 2], [M.x1, L.b1, 2], [M.b1, L.b1, 2], [M.x2, L.x1, 2], [M.x1, id(999), 1]] as const)
      await fails(call(deleteManifestLine, ctxFor(w).ctx, req({ manifest_id: mid, line_id: lid, headers: IFM(v) })), 'common.not_found', 404);
    await fails(call(deleteManifestLine, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2) })), 'common.not_found', 404);
    untouched(w, before);
    await fails(call(deleteManifestLine, ctxFor(w, { perms: [READ] }).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2) })), 'auth.forbidden', 403);
    untouched(w, before);
  });
});

describe('T08 M10 discardManifest — only a draft can be discarded', () => {
  it('200: draft -> discarded (discarded_at set, version +1, draft lines -> discarded), DTO state discarded; nothing of another partner touched', async () => {
    const { w, ctx } = mk();
    const r = await call(discardManifest, ctx, req({ manifest_id: M.x1, headers: IFM(3) }));
    expect(r.status).toBe(200);
    expect(man(w, M.x1)).toMatchObject({ state: 'discarded', version: 4, submitted_at: null, updated_by: USERS.x1.actor });
    expect(man(w, M.x1)['discarded_at']).toBeInstanceOf(Date);
    expect(w.linesOf(M.x1).every((l) => l['state'] === 'discarded')).toBe(true);
    expect(r.body).toMatchObject({ id: M.x1, state: 'discarded', version: 4 }); keysWithin(r.body, MF_KEYS);
    expect(man(w, M.y1)['state']).toBe('draft'); expect(man(w, M.xs)['state']).toBe('submitted'); expect(line(w, L.xs)!['state']).toBe('submitted'); expect(line(w, L.y1)!['state']).toBe('draft');
    await fails(call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(4) })), 'partners.manifest_invalid_transition', 409); // discarded -> *
  });

  it('every non-draft state -> 409 partners.manifest_invalid_transition; nothing written; submitted lines untouched', async () => {
    for (const state of NON_DRAFT) {
      const { w, ctx } = mk(); const m = w.mkManifest({ state, version: 6, line_count: 1 }); w.mkLine(m['id'], { state: state === 'discarded' ? 'discarded' : 'submitted' }); const before = w.snapshot();
      await fails(call(discardManifest, ctx, req({ manifest_id: m['id'], headers: IFM(6) })), 'partners.manifest_invalid_transition', 409);
      untouched(w, before);
    }
  });

  it('If-Match: missing 428, malformed 400, stale 409; two discards with the same version: one wins, the other is 409 (version_conflict or invalid_transition)', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.x1 })), 'common.precondition_required', 428);
    await fails(call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM('q') })), 'common.validation_failed', 400);
    await fails(call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(1) })), 'common.version_conflict', 409);
    untouched(w, before);
    const res = await Promise.allSettled([1, 2].map(() => call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.x1, headers: IFM(3) }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult; expect(lost.reason).toBeInstanceOf(LimsError); expect(['common.version_conflict', 'partners.manifest_invalid_transition']).toContain(lost.reason.code);
    expect(man(w, M.x1)['version']).toBe(4);
  });

  it('probe: Y\'s / tenant B\'s manifest with the CORRECT version -> 404 (still a draft afterwards); read-only user 403', async () => {
    const { w } = mk(); const before = w.snapshot();
    await fails(call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.y1, headers: IFM(2) })), 'common.not_found', 404);
    await fails(call(discardManifest, ctxFor(w).ctx, req({ manifest_id: M.b1, headers: IFM(2) })), 'common.not_found', 404);
    await fails(call(discardManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.x1, headers: IFM(3) })), 'common.not_found', 404);
    untouched(w, before);
    await fails(call(discardManifest, ctxFor(w, { perms: [READ] }).ctx, req({ manifest_id: M.x1, headers: IFM(3) })), 'auth.forbidden', 403);
    untouched(w, before);
  });
});

describe('T08 P2 searchPartnerOrderables — the partner\'s own price-list projection', () => {
  const search = (w: World, q: Row, over: Over = {}) => call(searchPartnerOrderables, ctxFor(w, over).ctx, req({ query: q }));
  it('q matches code / name of the caller\'s partner list only (partner-source + standard), PriceListItem allowlist, no internal columns', async () => {
    const { w } = mk();
    const r = await search(w, { q: 'gluc', limit: 20 });
    expect(r.status).toBe(200); expect(r.body.data.map((i: Row) => i['code'])).toEqual(['GLU']);
    const it0 = r.body.data[0]; keysWithin(it0, PRICE_KEYS); noLeak(it0);
    expect(it0).toMatchObject({ orderable_id: OR.glu, kind: 'test', code: 'GLU', name: 'Glucose Fasting', source: 'partner', price_list_version: 3 }); expect(it0.unit_price.amount_paisa).toBe(150000);
    expect((await search(w, { q: 'cbc' })).body.data.map((i: Row) => i['code'])).toEqual(['CBC']);
    expect((await search(w, { q: 'thyroid' })).body.data.map((i: Row) => [i['code'], i['source']])).toEqual([['TSH', 'standard']]);
  });

  it('probe: partner Y\'s and tenant B\'s items never appear for X (and X\'s never for Y); a standard item disappears when include_default_price_list is off', async () => {
    const { w } = mk();
    expect((await search(w, { q: 'hba' })).body.data).toEqual([]); expect((await search(w, { q: 'BX1' })).body.data).toEqual([]); expect((await search(w, { q: 'tenant b' })).body.data).toEqual([]);
    expect((await search(w, { q: 'hba' }, { who: 'y1' })).body.data.map((i: Row) => i['code'])).toEqual(['A1C']); expect((await search(w, { q: 'gluc' }, { who: 'y1' })).body.data).toEqual([]);
    w.setSettings(T_A, { include_default_price_list: false });
    expect((await search(w, { q: 'thyroid' })).body.data).toEqual([]); expect((await search(w, { q: 'gluc' })).body.data).toHaveLength(1);
  });

  it('limit is honoured; hostile q is a bound parameter only and not logged; needs partners.manifest.submit (order.read alone is refused); staff refused', async () => {
    const { w } = mk(); const q = `x'); DROP TABLE partners.price_list_items;--`;
    expect((await search(w, { q: 'o', limit: 1 })).body.data.length).toBeLessThanOrEqual(1);
    const { ctx, logs } = ctxFor(w); await call(searchPartnerOrderables, ctx, req({ query: { q } }));
    for (const x of w.log) expect(x.text).not.toMatch(/DROP\s+TABLE/i);
    expect(w.log.some((x) => x.values.some((v) => String(v).includes('DROP TABLE')))).toBe(true);
    for (const l of logs) expect(l).not.toContain('DROP TABLE');
    await fails(search(w, { q: 'gluc' }, { perms: [READ] }), 'auth.forbidden', 403); await fails(search(w, { q: 'gluc' }, { who: 'staff' }), 'auth.forbidden', 403);
    expect(w.writes).toEqual([]);
  });
});

describe('T08 cross-partner matrix (partner X vs Y ids on every id-bearing operation)', () => {
  it('X never reads or changes Y\'s manifest or line with Y\'s real ids and versions (404, snapshot identical); Y symmetrically cannot touch X\'s', async () => {
    const { w } = mk(); const before = w.snapshot();
    const ops: Array<[string, (c: any) => Promise<unknown>]> = [
      ['get', (c) => call(getManifest, c, req({ manifest_id: M.y1 }))], ['update', (c) => call(updateManifest, c, req({ manifest_id: M.y1, headers: IFM(2), body: { notes: 'Hijack' } }))],
      ['add', (c) => call(addManifestLine, c, req({ manifest_id: M.y1, headers: IFM(2), body: LINE_IN() }))], ['replace', (c) => call(replaceManifestLine, c, req({ manifest_id: M.y1, line_id: L.y1, headers: IFM(2), body: LINE_IN() }))],
      ['delete', (c) => call(deleteManifestLine, c, req({ manifest_id: M.y1, line_id: L.y1, headers: IFM(2) }))], ['discard', (c) => call(discardManifest, c, req({ manifest_id: M.y1, headers: IFM(2) }))],
    ];
    const seen: any[] = [];
    for (const [name, run] of ops) { const e = await fails(run(ctxFor(w).ctx), 'common.not_found', 404); seen.push(e); void name; }
    for (const e of seen) sameError(e, seen[0]);
    untouched(w, before);
    const sym = [call(getManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.x1 })), call(updateManifest, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.x1, headers: IFM(3), body: { notes: 'Hijack' } })),
      call(deleteManifestLine, ctxFor(w, { who: 'y1' }).ctx, req({ manifest_id: M.x1, line_id: L.x1, headers: IFM(2) }))];
    for (const p of sym) await fails(p, 'common.not_found', 404);
    untouched(w, before);
  });

  it('the permission set a partner user holds is what the handlers check (guard against checking a staff permission or none)', async () => {
    expect(PARTNER_PERMS).toContain(SUBMIT); expect(PARTNER_PERMS).toContain(READ);
    const { w, ctx, calls } = mk(); await call(createManifest, ctx, req({ body: {} })); expect(calls).toContain(`assertRole:${SUBMIT}`);
    const c2 = ctxFor(w); await call(getManifest, c2.ctx, req({ manifest_id: M.x1 })); expect(c2.calls).toContain(`assertRole:${READ}`);
    void STAFF;
  });
});
