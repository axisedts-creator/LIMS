// C16.T-N1 — worker side of the staff-reply notification (LD-180, 2026-11-14, founder go 19:12, CR-C16-T-N1 OPTION A): a GENERIC engagement task creates the notifications row as the system actor.
// (06-PLAN row T-N1; 05-SCHEMA line 1347 notifications INSERT is SYS only + constraint notifications__dedupe__uq; 02-TRD §4.9, §8.1; PRD US-EN-18.2; 07-SECURITY §3 no text / no PHI in a notification or a job payload.)
// Fails now: the staff reply enqueues no job, and no engagement task creates notifications from a job.
//
// SEAMS (LD-180 rules 1-3; the task NAME is the writer's choice, so it is NOT guessed here):
//   - the identifier is taken from what the API really enqueues (handlers.replyEnquiry on the enquiries world) and must be a registered, non-stub task of the engagement manifest;
//     the end-to-end test feeds that very payload to it.
//   - payload EXACTLY {tenant_id, account_id, patient_id (uuid | null), kind, entity_type, entity_id, entity_seq (integer >= 0)}: any other key (text, body, names, ..) rejects the job.
//   - tenant = job claims (ctx.tenantId) only; a payload tenant_id that differs (or is missing) rejects the job; kind must be 'enquiry_reply' (an allowlist of ONE; booking kinds are not accepted here).
//   - "rejected" = nothing is written (no INSERT into notifications at all); whether the task throws or returns quietly (like tasks/send_booking_message.ts for a bad payload) is the writer's call: both pass.
//   - the row: {tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, created_by = ctx.actor.id (the system actor), read_at null}; the INSERT carries
//     `ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING` (so redelivery inserts none and still resolves) and binds every value (no payload value inlined in the SQL text).
//   Every rejection test first runs a VALID payload (positive control), so a fail-closed stub cannot pass them by accident.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { handlers } from '../../../../../api/src/modules/engagement/handlers/index.js';
import { EQ as API_EQ, makeWorld as makeApiWorld } from '../../../../../api/src/modules/engagement/__tests__/enquiries.world.js';
import { ACCOUNT_1, ID, PATIENT, SYSTEM_ACTOR, TENANT_A, TENANT_B, makeWorld } from '../../../../../api/src/modules/engagement/__tests__/reminders.world.js';

type Job = { identifier: string; payload: Record<string, any>; jobKey: string | null };
/** What the API enqueues for a staff reply (the producer side, enquiries world). */
async function apiJob(): Promise<Job> {
  const aw = makeApiWorld(); const s = aw.session('staff');
  try { await (handlers as any).replyEnquiry({ params: { enquiry_id: API_EQ(1) }, query: {}, headers: { 'if-match': '"3"' }, body: { message: 'Synthetic reply' } }, s.ctx); } finally { s.release(); }
  const job = aw.jobs.find((j) => (j.jobKey ?? '').startsWith('notif:enquiry_reply:'));
  if (!job) throw new Error('the staff reply enqueued no notif:enquiry_reply:<enquiry_id>:<version> job (LD-180 rule 3)');
  return job;
}
async function taskOf(): Promise<(p: any, c: any) => Promise<void>> {
  const { identifier } = await apiJob();
  const t = (manifest.tasks as Record<string, unknown> | undefined)?.[identifier];
  if (typeof t !== 'function') throw new Error(`the enqueued task ${identifier} is not registered in the engagement manifest`);
  return t as (p: any, c: any) => Promise<void>;
}

const VALID = { tenant_id: TENANT_A, account_id: ACCOUNT_1, patient_id: PATIENT, kind: 'enquiry_reply', entity_type: 'enquiry', entity_id: ID(0xe91), entity_seq: 4 };
const inserts = (w: ReturnType<typeof makeWorld>) => w.stmts.filter((s) => /^\s*insert\s+into\s+engagement\.notifications\b/i.test(s.text));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
async function setup() { const w = makeWorld(); const task = await taskOf(); return { w, task }; }
/** Runs one job as the queue would (claims tenant = TENANT_A unless told otherwise); never throws: returns whether the task threw. */
async function attempt(w: ReturnType<typeof makeWorld>, task: (p: any, c: any) => Promise<void>, payload: unknown, claims: Record<string, unknown> = {}): Promise<'resolved' | 'threw'> {
  try { await w.runTask(task, payload as any, claims); return 'resolved'; } catch { return 'threw'; }
}
/** Positive control + rejection: the valid job lands once, every hostile one changes nothing. */
async function expectRejected(bad: Array<[string, unknown, Record<string, unknown>?]>) {
  const { w, task } = await setup();
  expect(await attempt(w, task, VALID), 'a valid job must be accepted (positive control)').toBe('resolved');
  expect(w.t['notifications']).toHaveLength(1);
  const before = inserts(w).length;
  for (const [label, payload, claims] of bad) {
    await attempt(w, task, payload, claims);
    expect(w.t['notifications'], label).toHaveLength(1);
    expect(inserts(w).length, `${label}: no INSERT attempted`).toBe(before);
  }
}

describe('manifest: the notification task the staff reply enqueues is registered and implemented (LD-180 rule 1)', () => {
  it('the identifier the API enqueues is a registered engagement task, not the fail-closed stub, and the manifest still validates', async () => {
    const job = await apiJob();
    expect(job.identifier).toMatch(/^engagement\.[a-z][a-z0-9_]*$/);
    expect(() => validateManifests([manifest])).not.toThrow();
    expect(typeof manifest.tasks?.[job.identifier]).toBe('function');
    const w = makeWorld();
    await expect(manifest.tasks![job.identifier]!(VALID as any, w.jobCtx())).resolves.toBeUndefined(); // a stub throws `<id> not implemented`
  });
});

describe('end to end: the payload the API enqueues becomes exactly one notifications row, created by the system actor', () => {
  it('replyEnquiry job -> task: one row {tenant, account, patient, enquiry_reply, enquiry:<id>, entity_seq = new version}, no text, created_by = the job actor; read_at null', async () => {
    const job = await apiJob(); const task = await taskOf(); const w = makeWorld();
    await w.runTask(task, job.payload, { tenantId: job.payload['tenant_id'] });
    expect(w.t['notifications']).toHaveLength(1);
    expect(w.t['notifications']![0]).toMatchObject({ tenant_id: job.payload['tenant_id'], account_id: job.payload['account_id'], patient_id: job.payload['patient_id'], kind: 'enquiry_reply', entity_type: 'enquiry', entity_id: job.payload['entity_id'], entity_seq: job.payload['entity_seq'], created_by: SYSTEM_ACTOR, read_at: null });
    expect(JSON.stringify(w.t['notifications'])).not.toContain('Synthetic reply'); // no text, no PHI (07-SECURITY §3)
  });
});

describe('the task (LD-180 rule 2)', () => {
  it('exactly ONE row per job; the INSERT is parameterised and ends with ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING', async () => {
    const { w, task } = await setup();
    expect(await attempt(w, task, VALID)).toBe('resolved');
    expect(w.t['notifications']).toHaveLength(1);
    expect(w.t['notifications']![0]).toMatchObject({ tenant_id: TENANT_A, account_id: ACCOUNT_1, patient_id: PATIENT, kind: 'enquiry_reply', entity_type: 'enquiry', entity_id: ID(0xe91), entity_seq: 4, created_by: SYSTEM_ACTOR });
    const ins = inserts(w); expect(ins).toHaveLength(1);
    expect(norm(ins[0]!.text)).toMatch(/ON CONFLICT ON CONSTRAINT notifications__dedupe__uq DO NOTHING$/i);
    for (const v of [ACCOUNT_1, PATIENT, ID(0xe91), TENANT_A]) expect(ins[0]!.text, 'values are bound, never inlined').not.toContain(v);
  });

  it('redelivery of the same job inserts none and still resolves (at-least-once queue); the next version is a new row', async () => {
    const { w, task } = await setup();
    expect(await attempt(w, task, VALID)).toBe('resolved');
    expect(await attempt(w, task, { ...VALID })).toBe('resolved'); // the same job again
    expect(await attempt(w, task, { ...VALID })).toBe('resolved');
    expect(w.t['notifications']).toHaveLength(1);
    expect(await attempt(w, task, { ...VALID, entity_seq: 5 })).toBe('resolved'); // a second staff reply
    expect(w.t['notifications']!.map((n) => n['entity_seq']).sort()).toEqual([4, 5]);
  });

  it('an enquiry without a profile (patient_id null) still notifies the account', async () => {
    const { w, task } = await setup();
    expect(await attempt(w, task, { ...VALID, patient_id: null })).toBe('resolved');
    expect(w.t['notifications']).toHaveLength(1);
    expect(w.t['notifications']![0]).toMatchObject({ account_id: ACCOUNT_1, patient_id: null, kind: 'enquiry_reply' });
  });

  it('a kind outside the allowlist (only enquiry_reply today) is rejected: booking kinds, other names, case / whitespace variants, non-strings', async () => {
    await expectRejected(['booking_confirmed', 'booking_cancelled', 'report_ready', 'ENQUIRY_REPLY', 'enquiry_reply ', ' enquiry_reply', 'enquiry', '', '__proto__', 'constructor', 7, null, undefined, ['enquiry_reply']]
      .map((kind) => [`kind=${JSON.stringify(kind)}`, { ...VALID, kind }, undefined] as [string, unknown]));
  });

  it('a payload tenant that differs from the job claims is rejected (both directions, and missing); nothing is written under either tenant', async () => {
    await expectRejected([
      ['payload tenant B, claims tenant A', { ...VALID, tenant_id: TENANT_B }],
      ['payload tenant A, claims tenant B', VALID, { tenantId: TENANT_B }],
      ['payload tenant missing', (({ tenant_id, ...rest }) => rest)(VALID)],
      ['payload tenant null', { ...VALID, tenant_id: null }],
      ['claims without a tenant', VALID, { tenantId: undefined }],
      ['claims tenant not a string', VALID, { tenantId: 7 }],
    ]);
    const { w, task } = await setup();
    await attempt(w, task, { ...VALID, tenant_id: TENANT_B }, { tenantId: TENANT_B }); // the claims decide: a job of tenant B for tenant B's own payload is legitimate
    expect(w.t['notifications']!.every((n) => n['tenant_id'] === TENANT_B)).toBe(true);
    expect(w.t['notifications']!.some((n) => n['tenant_id'] === TENANT_A)).toBe(false);
  });

  it('the payload shape is strict: unknown keys (text, body, names, ids), missing keys, non-uuid ids and a bad entity_seq are rejected; no text can ride along', async () => {
    const drop = (k: string) => (({ [k]: _x, ...rest }: Record<string, unknown>) => rest)(VALID as any);
    await expectRejected([
      ['extra key message', { ...VALID, message: 'Synthetic reply text' }],
      ['extra key body', { ...VALID, body: 'x' }],
      ['extra key patient_name', { ...VALID, patient_name: 'Synthetic Name' }],
      ['extra key created_by (mass assignment)', { ...VALID, created_by: ID(0x1) }],
      ['extra key id', { ...VALID, id: ID(0x2) }],
      ['extra key expires_at', { ...VALID, expires_at: '2099-01-01T00:00:00.000Z' }],
      ['missing account_id', drop('account_id')], ['missing entity_id', drop('entity_id')], ['missing entity_seq', drop('entity_seq')], ['missing kind', drop('kind')], ['missing entity_type', drop('entity_type')],
      ['account_id not a uuid', { ...VALID, account_id: 'not-a-uuid' }], ['entity_id not a uuid', { ...VALID, entity_id: "x'; DROP TABLE engagement.notifications;--" }], ['patient_id not a uuid', { ...VALID, patient_id: 'p1' }],
      ['entity_seq negative', { ...VALID, entity_seq: -1 }], ['entity_seq fractional', { ...VALID, entity_seq: 1.5 }], ['entity_seq string', { ...VALID, entity_seq: '4' }], ['entity_seq NaN', { ...VALID, entity_seq: NaN }],
      ['payload null', null], ['payload array', [VALID]], ['payload string', JSON.stringify(VALID)], ['payload empty', {}],
    ]);
  });

  it('a rejected job logs no payload value (no ids, no text)', async () => {
    const { w, task } = await setup();
    const lines: unknown[][] = [];
    const log = { info: (...a: unknown[]) => { lines.push(a); }, warn: (...a: unknown[]) => { lines.push(a); }, error: (...a: unknown[]) => { lines.push(a); } };
    await attempt(w, task, { ...VALID, kind: 'booking_confirmed', message: 'SECRET-Synthetic-text-7731' }, { log });
    await attempt(w, task, { ...VALID, tenant_id: TENANT_B }, { log });
    expect(JSON.stringify(lines)).not.toMatch(/SECRET-Synthetic-text-7731/);
    expect(JSON.stringify(lines)).not.toContain(ACCOUNT_1);
  });
});
