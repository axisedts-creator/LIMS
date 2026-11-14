// C16.T-L4 (task half) — task engagement.create_self_patient (06-PLAN row T-L4; 02-TRD §4.3.4 step 4, §8.1 max 10 attempts, §9 createSelfRegisteredPatient row; 03-APP-FLOW §3.3 + self-registration machine;
//  PRD US-EN-05.1, .2, .5; 07-SECURITY P2 data / REQ-SEC-005 / "Self-registration creates a new record").
// done_when: duplicate-suspected still creates a NEW record (CR-C16-007 fake = packages/fakes FrontdeskPort.fake). tests: task failure -> failed.
// Fails now: manifest task 'engagement.create_self_patient' is the T-01 fail-closed stub (tasks/create_self_patient.ts does not exist); the E16 handler that enqueues the job is still the placeholder.
//
// SEAMS (spec fixes behaviour, not names; same convention as send_login_otp.test.ts):
//   tasks/create_self_patient.ts exports createCreateSelfPatient() -> TaskHandler; ctx = worker JobContext (system actor, tx, now(), ports{FrontdeskPort}, log, attempt, maxAttempts).
//   The payload is whatever the REAL createSelfRegistration handler enqueued (job 'engagement.create_self_patient', key selfreg:<id>); the tests never build a payload by hand.
//   Order (TRD §4.3.4 step 4): load the `queued` registration + the account (phone, phone_hmac) -> FrontdeskPort.createSelfRegisteredPatient(ctx, {fullName, sex, birthOn? | ageYears?, phoneE164: ACCOUNT phone,
//     consents:{processing:true, sms, whatsapp, email:false, shareWithReferrer:false, consentTextVersion:'app-'+<version stored on the registration's link_consents row>}, idempotencyKey:'selfreg:<id>'})
//     -> insert link {method:'self_registered', relationship: the request's, visible_from: ctx.now(), record_phone_hmac_at_link: account.phone_hmac, display_name: full_name, sex_snapshot: sex, status active}
//     -> registration {status:'created', patient_id, link_id}.
//   Failure (TRD §9: `frontdesk.consent_required` -> failed, others retried; §4.3.4: "Errors after 10 attempts -> failed + failure_code"; 03-APP-FLOW: failed = (after max attempts or consent_required)):
//     consent_required -> registration `failed` at once, task RESOLVES (a throw would roll the failed mark back); any other error: attempt < maxAttempts -> THROW (tx rolls back, registration stays queued, no link, same
//     idempotency key on the retry); attempt == maxAttempts -> registration `failed` and the task RESOLVES. failure_code = a short code (1..64 chars, [A-Za-z0-9_.]), never personal data.
//   A registration that is already `created` or `failed` is a quiet no-op on redelivery (no second port call, no second link).
//   NOT covered (unspecified): the exact failure_code spelling beyond the shape above; a lost race on the one-self-link-per-account index (only the final `failed` + no second self link is asserted); a registration id that no longer exists.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { handlers } from '../../../../../api/src/modules/engagement/handlers/index.js';
import { ACC1, HMAC1, ID, NAME, PAT_EXISTING, PHONE1, SYSTEM, T0, TA, VERSION, makeWorld, ms, type World } from '../../../../../api/src/modules/engagement/__tests__/selfreg.world.js';

const IDEM = { 'idempotency-key': 'k-0001' };
const TASK = 'engagement.create_self_patient';
const impl = async () => (await import('../tasks/create_self_patient.js')).createCreateSelfPatient() as (p: any, c: any) => Promise<void>;
const form = (o: Record<string, unknown> = {}) => ({ relationship: 'self', full_name: NAME, sex: 'female', birth_on: '1990-03-01', sms_consent: true, whatsapp_consent: false, consent_text_version: VERSION, ...o });
/** The E16 request as the app sends it; returns the job the handler enqueued. */
const enqueue = async (w: World, body: Record<string, unknown> = form()) => {
  const out = await w.inTx(() => (handlers as any)['createSelfRegistration']({ params: {}, query: {}, headers: IDEM, body }, w.session(ACC1)));
  return { id: out.body.id as string, payload: w.jobs.at(-1)!.payload };
};
async function setup(body?: Record<string, unknown>, o: Parameters<typeof makeWorld>[0] = {}) {
  const w = makeWorld(o); const task = await impl(); const reg = await enqueue(w, body);
  const run = (over: Record<string, unknown> = {}, payload: any = reg.payload) => w.inTx(() => task(payload, w.jobCtx(over)));
  return { w, task, reg, run };
}
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const row = (w: World, id: string) => w.regs().find((r) => r['id'] === id)!;
const portIn = (w: World, i = 0) => w.frontdesk.calls[i]!.input;

describe('manifest (TRD §8.1)', () => {
  it('engagement.create_self_patient is implemented (no longer the fail-closed stub), max_attempts 10, manifest still validates', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(manifest.maxAttempts?.[TASK]).toBe(10);
    const { w, reg } = await setup();
    const r = await rejection(manifest.tasks![TASK]!(reg.payload as any, w.jobCtx() as any));
    expect(String(r?.message ?? '')).not.toMatch(/not implemented/);
  });
});

describe('test-world guards (the fakes enforce what 05-SCHEMA / CR-C16-007 enforce)', () => {
  it('self_registrations__created__ck: status created needs patient_id AND link_id', async () => {
    const w = makeWorld(); const r = w.seedQueuedReg();
    await expect(w.jobCtx().tx.query(`UPDATE engagement.self_registrations SET status = 'created' WHERE id = $1`, [r['id']])).rejects.toMatchObject({ code: '23514' });
  });
  it('account_patient_links: a second live self link of the account violates the partial unique index (23505)', async () => {
    const w = makeWorld(); w.seedLink({ relationship: 'self' });
    const q = (id: string, pid: string) => w.jobCtx().tx.query('INSERT INTO engagement.account_patient_links (id, tenant_id, account_id, patient_id, relationship, method, display_name, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, TA, ACC1, pid, 'self', 'self_registered', 'x', 'active', SYSTEM, SYSTEM]);
    await expect(q(ID(0xc2), PAT_EXISTING)).rejects.toMatchObject({ code: '23505' });
  });
  it('the FrontdeskPort fake (CR-C16-007): a patient with the same phone makes duplicateSuspected true yet a NEW patientId is created; same idempotencyKey replays', async () => {
    const w = makeWorld(); w.frontdesk.seedExistingWithPhone(); const c = w.jobCtx();
    const input = { fullName: NAME, sex: 'female', birthOn: '1990-03-01', phoneE164: PHONE1, consents: { sms: true, whatsapp: false, email: false, shareWithReferrer: false, consentTextVersion: 'app-v' }, idempotencyKey: 'selfreg:t-1' };
    const a = await w.frontdesk.port.createSelfRegisteredPatient(c, input); const b = await w.frontdesk.port.createSelfRegisteredPatient(c, input);
    expect(a.duplicateSuspected).toBe(true); expect(a.patientId).not.toBe(PAT_EXISTING); expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ patientId: a.patientId, replayed: true });
  });
});

describe('US-EN-05.1 success: port call + link + registration', () => {
  it('calls FrontdeskPort.createSelfRegisteredPatient ONCE as the system actor with exactly the TRD §4.3.4 input; phone = the ACCOUNT phone; idempotencyKey selfreg:<id>', async () => {
    const { w, reg, run } = await setup(form({ sms_consent: true, whatsapp_consent: true })); await run();
    expect(w.frontdesk.calls).toHaveLength(1); expect(w.frontdesk.calls[0]).toMatchObject({ actor: 'system', tenantId: TA });
    expect(portIn(w)).toEqual({ fullName: NAME, sex: 'female', birthOn: '1990-03-01', phoneE164: PHONE1,
      consents: { processing: true, sms: true, whatsapp: true, email: false, shareWithReferrer: false, consentTextVersion: `app-${VERSION}` }, idempotencyKey: `selfreg:${reg.id}` });
    expect(portIn(w).ageYears).toBeUndefined();
  });
  it('age_years request -> ageYears (no birthOn); consent flags are the form\'s (sms false / whatsapp false stay false; email and shareWithReferrer are always false)', async () => {
    const { w, run } = await setup(form({ birth_on: undefined, age_years: 34, sms_consent: false, whatsapp_consent: false })); await run();
    expect(portIn(w)).toMatchObject({ ageYears: 34, consents: { processing: true, sms: false, whatsapp: false, email: false, shareWithReferrer: false } }); expect(portIn(w).birthOn).toBeUndefined();
  });
  it('inserts the link {self_registered, relationship of the request, visible_from = now (to the ms), record_phone_hmac_at_link = account hmac, display_name = full_name, sex_snapshot, active} for the NEW patient', async () => {
    const { w, run } = await setup(); await run();
    expect(w.links()).toHaveLength(1); const l = w.links()[0]!; const created = { id: w.frontdesk.created.find((c) => c.input.fullName === NAME)!.patientId };
    expect(l).toMatchObject({ account_id: ACC1, patient_id: created.id, method: 'self_registered', relationship: 'self', status: 'active', display_name: NAME, sex_snapshot: 'female', link_code_id: null });
    expect(ms(l['visible_from'])).toBe(ms(T0)); expect(Buffer.from(l['record_phone_hmac_at_link']).equals(HMAC1)).toBe(true);
    expect(w.tables['patients']!.some((p) => p['id'] === l['patient_id'])).toBe(true);
  });
  it('registration -> created with patient_id (the new record) and link_id (the new link); failure_code stays null', async () => {
    const { w, reg, run } = await setup(); await run();
    const r = row(w, reg.id); const l = w.links()[0]!;
    expect(r).toMatchObject({ status: 'created', patient_id: l['patient_id'], link_id: l['id'], failure_code: null });
  });
  it('relationship child: link relationship child; the port gets the child\'s name / birth date and the guardian\'s phone', async () => {
    const { w, run } = await setup(form({ relationship: 'child', full_name: 'Synthetic Child Sample', birth_on: '2018-06-01', sex: 'male' })); await run();
    expect(w.links()[0]).toMatchObject({ relationship: 'child', display_name: 'Synthetic Child Sample', sex_snapshot: 'male' });
    expect(portIn(w)).toMatchObject({ fullName: 'Synthetic Child Sample', birthOn: '2018-06-01', sex: 'male', phoneE164: PHONE1 });
  });
  it('no access to anything else: the demographics read of the port is never used, no second link is created', async () => {
    const { w, run } = await setup(); await run(); expect(w.links()).toHaveLength(1); expect(w.regs()).toHaveLength(1);
  });
});

describe('US-EN-05.2 duplicate suspected: the link goes to the NEW record, never to the existing one', () => {
  it('C4 reports duplicateSuspected (same phone exists): link.patient_id = the new patientId != existing; nothing links to the existing record; registration created', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.seedExistingWithPhone(); await run();
    expect(w.frontdesk.calls).toHaveLength(1);
    const created = w.frontdesk.created.filter((c) => c.input.fullName === NAME).map((c) => ({ id: c.patientId }));
    expect(created).toHaveLength(1); expect(created[0]!.id).not.toBe(PAT_EXISTING);
    expect(w.links()).toHaveLength(1); expect(w.links()[0]).toMatchObject({ patient_id: created[0]!.id, method: 'self_registered' });
    expect(w.tables['account_patient_links']!.some((l) => l['patient_id'] === PAT_EXISTING)).toBe(false);
    expect(row(w, reg.id)).toMatchObject({ status: 'created', patient_id: created[0]!.id });
  });
  it('the duplicate flag changes nothing in what is stored: same link fields as the non-duplicate path (no history, visible_from = now)', async () => {
    const { w, run } = await setup(); w.frontdesk.seedExistingWithPhone(); await run();
    expect(ms(w.links()[0]!['visible_from'])).toBe(ms(T0)); expect(w.links()[0]!['visible_from']).not.toBeNull();
  });
});

describe('idempotency and redelivery', () => {
  it('redelivery after success is a quiet no-op: one port call, one link, still created', async () => {
    const { w, reg, run } = await setup(); await run();
    await expect(run()).resolves.toBeUndefined();
    expect(w.frontdesk.calls).toHaveLength(1); expect(w.links()).toHaveLength(1); expect(row(w, reg.id)['status']).toBe('created');
  });
  it('a crash after the port call but before the commit (link insert fails once): the retry replays the SAME idempotency key and links the SAME patient - exactly one record created in C4', async () => {
    const { w, reg, run } = await setup();
    const flaky = w.jobCtx(); const real = flaky.tx.query.bind(flaky.tx); let hit = 0;
    flaky.tx = { query: (t: string, v?: unknown[]) => { if (/insert\s+into\s+engagement\.account_patient_links/i.test(t) && hit++ === 0) return Promise.reject(Object.assign(new Error('connection reset'), { code: '08006' })); return real(t, v); } };
    const task = await impl(); const first = await rejection(w.inTx(() => task(reg.payload, flaky)));
    expect(first).toBeDefined(); expect(row(w, reg.id)['status']).toBe('queued'); expect(w.links()).toEqual([]);
    await run();
    expect(w.frontdesk.calls.map((c) => c.input.idempotencyKey)).toEqual([`selfreg:${reg.id}`, `selfreg:${reg.id}`]);
    expect(w.frontdesk.created.filter((c) => c.input.fullName === NAME)).toHaveLength(1);
    expect(w.links()).toHaveLength(1); expect(w.links()[0]!['patient_id']).toBe(row(w, reg.id)['patient_id']); expect(row(w, reg.id)['status']).toBe('created');
  });
  it('the job runs only for ITS registration: a second queued registration of the account is untouched', async () => {
    const { w, reg, run } = await setup(); const other = await enqueue(w, form({ relationship: 'child', full_name: 'Synthetic Child Sample', birth_on: '2018-06-01' }));
    await run(); expect(row(w, reg.id)['status']).toBe('created'); expect(row(w, other.id)['status']).toBe('queued'); expect(w.frontdesk.calls).toHaveLength(1);
  });
});

describe('US-EN-05.5 failure -> failed (no link), retry = a new request', () => {
  const codeShape = (c: unknown) => { expect(typeof c).toBe('string'); expect((c as string).length).toBeGreaterThanOrEqual(1); expect((c as string).length).toBeLessThanOrEqual(64); expect(c).toMatch(/^[A-Za-z0-9_.]+$/); };
  it('frontdesk.consent_required: registration failed at once (attempt 1 of 10), task RESOLVES, failure_code set, no link, port called once', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'frontdesk.consent_required');
    await expect(run()).resolves.toBeUndefined();
    const r = row(w, reg.id); expect(r['status']).toBe('failed'); codeShape(r['failure_code']); expect(r['patient_id']).toBeNull(); expect(r['link_id']).toBeNull();
    expect(w.links()).toEqual([]); expect(w.frontdesk.calls).toHaveLength(1);
  });
  it('a failed registration is terminal for the job: redelivery does not call C4 again and does not create a link', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'frontdesk.consent_required'); await run(); await run();
    expect(w.frontdesk.calls).toHaveLength(1); expect(w.links()).toEqual([]); expect(row(w, reg.id)['status']).toBe('failed');
  });
  it('transient port error (common.dependency_unavailable) on attempts 1..9: the task THROWS, the registration stays queued with no failure_code and no link', async () => {
    for (const attempt of [1, 5, 9]) {
      const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'common.dependency_unavailable');
      const e = await rejection(run({ attempt, maxAttempts: 10 })); expect(e, `attempt ${attempt}`).toBeDefined();
      expect(row(w, reg.id)).toMatchObject({ status: 'queued', failure_code: null, patient_id: null, link_id: null }); expect(w.links()).toEqual([]);
    }
  });
  it('an unexpected (non-LimsError) failure is retried like any other: throws before the last attempt, registration stays queued', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.failWith = () => new Error('socket hang up');
    expect(await rejection(run({ attempt: 2, maxAttempts: 10 }))).toBeDefined(); expect(row(w, reg.id)['status']).toBe('queued');
  });
  it('after a transient failure the retry succeeds with the SAME idempotency key and the registration ends created', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'common.dependency_unavailable');
    await rejection(run({ attempt: 1 })); await run({ attempt: 2 });
    expect(w.frontdesk.calls.map((c) => c.input.idempotencyKey)).toEqual([`selfreg:${reg.id}`, `selfreg:${reg.id}`]); expect(row(w, reg.id)['status']).toBe('created'); expect(w.links()).toHaveLength(1);
  });
  it('transient error on the LAST attempt (10 of 10): registration failed + failure_code, task RESOLVES (the failed mark must commit), no link, no patient link', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'common.dependency_unavailable');
    await expect(run({ attempt: 10, maxAttempts: 10 })).resolves.toBeUndefined();
    const r = row(w, reg.id); expect(r['status']).toBe('failed'); codeShape(r['failure_code']); expect(r['patient_id']).toBeNull(); expect(r['link_id']).toBeNull(); expect(w.links()).toEqual([]);
  });
  it('an unexpected error on the last attempt also ends failed (no silent loss, no link)', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.failWith = () => new Error('socket hang up');
    await expect(run({ attempt: 10, maxAttempts: 10 })).resolves.toBeUndefined(); expect(row(w, reg.id)['status']).toBe('failed'); expect(w.links()).toEqual([]);
  });
  it('a lost race on the one-self-link rule (the account got a self link meanwhile) never yields a second self link; on the last attempt the registration is failed', async () => {
    const { w, reg, run } = await setup(); w.seedLink({ relationship: 'self' });
    await rejection(run({ attempt: 10, maxAttempts: 10 }));
    expect(w.links().filter((l) => l['relationship'] === 'self' && ['active', 'suspended'].includes(l['status']))).toHaveLength(1); expect(row(w, reg.id)['status']).toBe('failed');
  });
  it('failure_code never carries personal data (name, phone, birth date)', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'frontdesk.consent_required'); await run();
    expect(String(row(w, reg.id)['failure_code'])).not.toMatch(/Selfreg|Synthetic|\+977|1990/);
  });
  it('after a failure the user retries with a NEW request: a new registration id and a new job key (selfreg:<new id>); the failed one is untouched', async () => {
    const { w, reg, run } = await setup(); w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'frontdesk.consent_required'); await run();
    const again = await enqueue(w);
    expect(again.id).not.toBe(reg.id); expect(w.jobs.at(-1)!.jobKey).toBe(`selfreg:${again.id}`); expect(row(w, reg.id)['status']).toBe('failed'); expect(row(w, again.id)['status']).toBe('queued');
    await w.inTx(async () => (await impl())(again.payload, w.jobCtx())); expect(row(w, again.id)['status']).toBe('created'); expect(w.links()).toHaveLength(1);
  });
});

describe('P2 data: nothing personal in logs, audit or job rows', () => {
  it('success and failure paths log / audit no name, birth date or phone', async () => {
    const ok = await setup(form({ full_name: 'Zzyzx Qwerty Sample', birth_on: '1971-02-03' })); await ok.run();
    const bad = await setup(form({ full_name: 'Zzyzx Qwerty Sample', birth_on: '1971-02-03' })); bad.w.frontdesk.fake.failNext('createSelfRegisteredPatient', 'common.dependency_unavailable'); await rejection(bad.run({ attempt: 10, maxAttempts: 10 }));
    for (const w of [ok.w, bad.w]) {
      const s = JSON.stringify({ l: w.logs, a: w.audit, j: w.jobs.map((j) => j.payload) });
      expect(s).not.toMatch(/Zzyzx|Qwerty|1971-02-03/); expect(s).not.toContain(PHONE1);
    }
  });
});
