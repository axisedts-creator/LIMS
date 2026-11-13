// C16.T-R1 — staff reminders R1 listReminders, R2 createReminder, R3 cancelReminder (06-PLAN row T-R1; 02-TRD §4.11, §5 R1-R3; 05-SCHEMA reminders; PRD US-EN-23.1/23.4; 07-SECURITY
// reminders row of the abuse table: "reminder floods -> staff-created only + system rules", REQ-SEC-017 tenant isolation).
// Fails now: handlers/index.ts maps listReminders/createReminder/cancelReminder to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (same convention as settings.handlers.test.ts / queue.handlers.test.ts):
//   handlers[op](req:{params,query,headers,body}, ctx) -> {status, body, headers?}; ctx = {tenantId, actor, tx, now(), ports:{IdentityPort}}; errors are thrown LimsError(code).
//   Permission = ctx.ports.IdentityPort.assertRole(ctx,{permission}) BEFORE any tx.query: R1 engagement.reminder.read, R2/R3 engagement.reminder.manage.
//   R2: Idempotency-Key header 'idempotency-key' (pipeline owns replay; handler needs no more than the key present - absent -> 400 common.idempotency_key_required is the pipeline's, not re-tested);
//       validates body itself: patient_id uuid, reason_code in cs_reminder_reasons (coded set), due_at >= ctx.now() + 1 h, no unknown keys, source_ref_id uuid -> else 400 common.validation_failed + ZERO writes.
//       Creates kind 'custom', source 'staff', status 'scheduled'; with source_ref_id (follow-up from a smart summary) kind 'follow_up', source 'staff'; 201 body = Reminder schema (no tenant_id/created_by).
//   R3: If-Match raw '"<version>"' (key 'if-match'): absent -> 428 common.precondition_required before any DB access; row of another tenant / unknown -> 404 common.not_found (no write);
//       status != scheduled -> 409 engagement.reminder_invalid_transition; stale version -> 409 common.version_conflict; ok -> 200 Reminder status 'cancelled', version + 1.
//   R1: due_from/due_to required, window <= 92 d (else 400 common.validation_failed), status enum, only the session tenant's rows (RLS), body {data:[Reminder], page:{limit, next_cursor?}}.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, PATIENT, TENANT_A, TENANT_B, makeWorld, type World } from '../../__tests__/reminders.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const READ = 'engagement.reminder.read', MANAGE = 'engagement.reminder.manage';
const HOUR = 3_600_000, DAY = 24 * HOUR;
const call = (op: string, w: World, req: Record<string, any>, over: Record<string, any> = {}) => (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined, ...req }, w.staffCtx(over));
const code = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'RESOLVED'; };
const inHours = (w: World, h: number) => new Date(Date.parse(w.now()) + h * HOUR).toISOString();
const create = (w: World, body: Record<string, any>, headers: Record<string, string> = { 'idempotency-key': 'k-0001' }) => call('createReminder', w, { body, headers });
const validBody = (w: World, over: Record<string, any> = {}) => ({ patient_id: PATIENT, reason_code: 'follow_up_test', due_at: inHours(w, 48), ...over });

describe('contract sanity (spec is the source of the permissions)', () => {
  it('x-permission floors', () => { expect(opOf('listReminders')['x-permission']).toBe(READ); expect(opOf('createReminder')['x-permission']).toBe(MANAGE); expect(opOf('cancelReminder')['x-permission']).toBe(MANAGE); });
});

describe('R2 createReminder', () => {
  it('201: custom/staff/scheduled row, schema-valid Reminder, tenant-scoped, one INSERT', async () => {
    const w = makeWorld(); const body = validBody(w); const res = await create(w, body);
    expect(res.status).toBe(201); expect(schemaErrors('Reminder', res.body)).toEqual([]);
    expect(res.body).toMatchObject({ patient_id: PATIENT, kind: 'custom', reason_code: 'follow_up_test', source: 'staff', status: 'scheduled', version: 1 });
    expect(Date.parse(res.body.due_at)).toBe(Date.parse(body.due_at)); expect(res.body).not.toHaveProperty('tenant_id');
    expect(w.t['reminders']).toHaveLength(1); expect(w.t['reminders']![0]).toMatchObject({ tenant_id: TENANT_A, status: 'scheduled', kind: 'custom' });
    expect(w.identity.asserted[0]).toMatchObject({ permission: MANAGE }); expect(w.identity.asserted[0]!.at).toBe(0);               // authorised before any query
    expect(w.notif.calls).toEqual([]);                                                                                                // creating never sends (the dispatcher does)
  });
  it('source_ref_id (follow-up from a suggestion) -> kind follow_up, source_ref_id kept; same (kind, source_ref_id) twice -> one row (409/400 or the same row, never two)', async () => {
    const w = makeWorld(); const body = validBody(w, { source_ref_id: ID(0x5ee) });
    const r1 = await create(w, body); expect(r1.status).toBe(201); expect(w.t['reminders']![0]).toMatchObject({ kind: 'follow_up', source_ref_id: ID(0x5ee) });
    await code(create(w, body, { 'idempotency-key': 'k-0002' })); expect(w.t['reminders']).toHaveLength(1);
  });
  it('due_at must be >= now + 1 h: 59 min and the past -> 400 common.validation_failed, zero writes; exactly 1 h is accepted', async () => {
    const w = makeWorld();
    for (const due of [inHours(w, 0.98), inHours(w, -24), w.now()]) expect(await code(create(w, validBody(w, { due_at: due })))).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]); expect((await create(w, validBody(w, { due_at: inHours(w, 1) }))).status).toBe(201);
  });
  it('reason_code outside the coded set (cs_reminder_reasons) / bad pattern -> 400, zero writes', async () => {
    const w = makeWorld();
    for (const reason of ['not_a_reason', 'UPPER', "x'; DROP TABLE engagement.reminders;--", '', 'a'.repeat(65)]) expect(await code(create(w, validBody(w, { reason_code: reason })))).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]);
  });
  it('body validation: missing/extra/mistyped fields -> 400 (mass assignment: status, tenant_id, version, sent_at are never accepted)', async () => {
    const w = makeWorld();
    for (const bad of [{ ...validBody(w), status: 'sent' }, { ...validBody(w), tenant_id: TENANT_B }, { ...validBody(w), version: 9 }, { ...validBody(w), sent_at: w.now() }, { reason_code: 'follow_up_test', due_at: inHours(w, 48) },
      { ...validBody(w), patient_id: 'not-a-uuid' }, { ...validBody(w), due_at: 'tomorrow' }, { ...validBody(w), due_at: 12345 }, validBody(w, { source_ref_id: 'nope' }), null, 'x'])
      expect(await code(create(w, bad as any)), JSON.stringify(bad)).toBe('common.validation_failed');
    expect(w.writes()).toEqual([]);
  });
  it('permission: assertRole(engagement.reminder.manage) refused -> auth.forbidden and not a single statement ran', async () => {
    const w = makeWorld(); w.identity.deny.add(MANAGE); expect(await code(create(w, validBody(w)))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
  });
});

describe('R3 cancelReminder (US-EN-23.4)', () => {
  const cancel = (w: World, id: string, headers: Record<string, string> = { 'if-match': '"1"' }) => call('cancelReminder', w, { params: { reminder_id: id }, headers });
  it('scheduled + current If-Match -> 200 cancelled, version 2, schema-valid; the dispatcher then ignores it', async () => {
    const w = makeWorld(); const r = w.reminder({ due_at: inHours(w, 2) }); const res = await cancel(w, r['id']);
    expect(res.status).toBe(200); expect(schemaErrors('Reminder', res.body)).toEqual([]); expect(res.body).toMatchObject({ id: r['id'], status: 'cancelled', version: 2 });
    expect(w.get(r['id'])).toMatchObject({ status: 'cancelled', version: 2 }); expect(w.identity.asserted[0]).toMatchObject({ permission: MANAGE });
    const { createDispatchDueReminders } = await import('../../../../../../worker/src/jobs/engagement/tasks/dispatch_due_reminders.js');
    w.advance(3 * HOUR); await w.runTask(createDispatchDueReminders(), { tenant_id: TENANT_A }); expect(w.jobs('engagement.send_reminder')).toEqual([]);
  });
  it('If-Match absent -> 428 common.precondition_required before any DB access; stale version -> 409 common.version_conflict, row unchanged', async () => {
    const w = makeWorld(); const r = w.reminder();
    expect(await code(cancel(w, r['id'], {}))).toBe('common.precondition_required'); expect(w.stmts.filter((s) => /engagement\./i.test(s.text))).toEqual([]);
    expect(await code(cancel(w, r['id'], { 'if-match': '"7"' }))).toBe('common.version_conflict'); expect(w.get(r['id'])).toMatchObject({ status: 'scheduled', version: 1 });
  });
  it('already sent / suppressed / failed / cancelled -> 409 engagement.reminder_invalid_transition, row unchanged', async () => {
    for (const status of ['sent', 'suppressed', 'failed', 'cancelled']) {
      const w = makeWorld(); const r = w.reminder({ status, ...(status === 'sent' ? { sent_at: w.now() } : {}) });
      expect(await code(cancel(w, r['id'])), status).toBe('engagement.reminder_invalid_transition'); expect(w.get(r['id'])['status']).toBe(status);
    }
  });
  it('unknown id and a TENANT B reminder -> 404 common.not_found (never 409/403), nothing written', async () => {
    const w = makeWorld(); const other = w.reminder({ tenant_id: TENANT_B });
    expect(await code(cancel(w, other['id']))).toBe('common.not_found'); expect(await code(cancel(w, ID(0xdead)))).toBe('common.not_found'); expect(w.get(other['id'])['status']).toBe('scheduled'); expect(w.writes()).toEqual([]);
  });
  it('permission refused -> auth.forbidden, no statement; malformed id -> 400/404, never a write', async () => {
    const w = makeWorld(); const r = w.reminder(); w.identity.deny.add(MANAGE); expect(await code(cancel(w, r['id']))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
    const w2 = makeWorld(); expect(['common.validation_failed', 'common.not_found']).toContain(await code(cancel(w2, "1'; DROP TABLE x;--"))); expect(w2.writes()).toEqual([]);
  });
});

describe('R1 listReminders', () => {
  const list = (w: World, query: Record<string, any>) => call('listReminders', w, { query });
  const win = (w: World, over: Record<string, any> = {}) => ({ due_from: inHours(w, -24), due_to: inHours(w, 24 * 7), ...over });
  it('200 {data, page}: schema-valid Reminders of the session tenant only; filters patient_id and status', async () => {
    const w = makeWorld(); const a = w.reminder({ due_at: inHours(w, 2) }); w.reminder({ status: 'cancelled' }); w.reminder({ tenant_id: TENANT_B, patient_id: ID(0x5b1) }); w.reminder({ patient_id: ID(0x5c1) });
    const all = await list(w, win(w)); expect(all.status).toBe(200); expect(all.body.data.every((x: any) => schemaErrors('Reminder', x).length === 0)).toBe(true);
    expect(all.body.data.some((x: any) => x.id === a['id'])).toBe(true); expect(all.body.data).toHaveLength(3); expect(all.body.page).toHaveProperty('limit');
    expect(w.identity.asserted[0]).toMatchObject({ permission: READ });
    const sched = await list(w, win(w, { status: 'scheduled', patient_id: PATIENT })); expect(sched.body.data.map((x: any) => x.id)).toEqual([a['id']]);
  });
  it('window > 92 days, missing due_from/due_to, due_to < due_from, bad status/uuid -> 400 common.validation_failed', async () => {
    const w = makeWorld();
    for (const q of [{ due_from: inHours(w, 0), due_to: inHours(w, 93 * 24) }, { due_from: inHours(w, 0) }, { due_to: inHours(w, 24) }, { due_from: inHours(w, 48), due_to: inHours(w, 24) }, win(w, { status: 'bogus' }), win(w, { patient_id: 'x' })])
      expect(await code(list(w, q as any)), JSON.stringify(q)).toBe('common.validation_failed');
    expect((await list(w, { due_from: inHours(w, 0), due_to: inHours(w, 92 * 24) })).status).toBe(200);
  });
  it('permission refused -> auth.forbidden before any statement; list never writes; page is bounded (limit <= 200)', async () => {
    const w = makeWorld(); w.identity.deny.add(READ); expect(await code(list(w, win(w)))).toBe('auth.forbidden'); expect(w.stmts).toEqual([]);
    const w2 = makeWorld(); for (let i = 0; i < 3; i++) w2.reminder({ due_at: inHours(w2, i + 1) }); const res = await list(w2, win(w2, { limit: 2 }));
    expect(res.body.data.length).toBeLessThanOrEqual(2); expect(w2.writes()).toEqual([]);
    expect(await code(list(w2, win(w2, { limit: 201 })))).toBe('common.validation_failed');
  });
});
