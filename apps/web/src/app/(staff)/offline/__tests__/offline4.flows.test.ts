// T0D-OFFLINE-4 (LD-322; done_when 1 and 5): result entry from the cached worklist as append only operations that show Pending sync, locked results refused with
// the reason, and the daily cash close with its conflict when someone else closed the day.
// Fails now because core/offline/labflows.ts and cashflows.ts do not exist.
import { describe, expect, it } from 'vitest';
import { P_ENTER, P_VERIFY, USER, USER2, cashSession, createEnv, drainAll, ops, row, rule, signoff, U } from './offline4.fixtures';

const entry = (r: { id: string; version: number }, over: Record<string, unknown> = {}) => ({ result_id: r.id, version: r.version, value_numeric: '5.40', ...over });

describe('result entry from the cached worklist (done_when 1)', () => {
  it('worklist() lists the cached rows in registration order; a row entered here shows its value, the next version and Pending sync', async () => {
    const [a, b] = [row(2), row(1)];
    const env = await createEnv({ results: [a, b] });
    const lab = env.lab(USER, P_ENTER);
    expect((await lab.worklist()).map((r: { registration_no: string }) => r.registration_no)).toEqual(['R-0001', 'R-0002']);
    expect(await env.flows.statusOf(a.id)).toBeNull();
    const out = await lab.enterResults({ entries: [entry(a), { result_id: b.id, version: b.version, value_text: 'Reactive', comment_text: 'repeat sample' }] });
    expect(out).toMatchObject({ ok: true, entered: 2 });
    const local = await lab.localResult(a.id);
    expect(local).toMatchObject({ id: a.id, version: 4, value_numeric: '5.40', entered_by_user_id: USER });
    expect(await env.flows.statusOf(a.id)).toEqual({ state: 'pending' }); // the badge reads this
    expect(await env.flows.statusOf(b.id)).toEqual({ state: 'pending' });
    expect((await lab.localResult(b.id)).value_text).toBe('Reactive');
  });

  it('one result.enter operation per call with the strict BulkEnterResultsRequest payload: no entity id, no base version, nothing else on the wire', async () => {
    const r = row(3); const env = await createEnv({ results: [r] });
    await env.lab(USER, P_ENTER).enterResults({ entries: [entry(r, { manual_abnormal: true, comment_codes: ['REPEAT'] })] });
    const [op] = await env.pendingOps();
    expect(op).toMatchObject({ op_type: 'result.enter' });
    expect(op!.entity_id).toBeUndefined(); expect(op!.base_version).toBeUndefined();
    expect(op!.payload).toEqual({ entries: [{ result_id: r.id, version: 3, value_numeric: '5.40', manual_abnormal: true, comment_codes: ['REPEAT'] }] });
  });

  it('the entry is signed at the version the user SAW: a second entry for the same result on this device uses the next version', async () => {
    const r = row(4); const env = await createEnv({ results: [r] });
    const lab = env.lab(USER, P_ENTER);
    await lab.enterResults({ entries: [entry(r)] });
    await lab.enterResults({ entries: [entry(r, { value_numeric: '5.60' })] });
    const sent = (await env.pendingOps()).map((o) => o.payload.entries[0].version);
    expect(sent).toEqual([3, 4]);
    expect((await lab.localResult(r.id)).value_numeric).toBe('5.60');
  });

  it('input that the server would refuse is refused here: no value, two values, a stray key, a bad number, a bad ordinal, 201 entries, an empty call', async () => {
    const r = row(5); const env = await createEnv({ results: [r] });
    const lab = env.lab(USER, P_ENTER);
    const bad = [
      { entries: [{ result_id: r.id, version: 3 }] }, // exactly one value field unless only comments change: comment only is fine, nothing at all is not
      { entries: [entry(r, { value_text: 'x' })] }, // two value fields
      { entries: [entry(r, { patient_name: 'x' })] }, // additionalProperties false
      { entries: [entry(r, { value_numeric: '5,4e' })] },
      { entries: [{ result_id: r.id, version: 3, ordinal_code: 'not valid!' }] },
      { entries: Array.from({ length: 201 }, () => entry(r)) },
      { entries: [] },
      { entries: [{ ...entry(r), version: -1 }] },
    ];
    for (const b of bad) await expect(lab.enterResults(b as never)).rejects.toMatchObject({ code: 'common.validation_failed' });
    expect(await env.pendingOps()).toHaveLength(0);
    expect(await lab.enterResults({ entries: [{ result_id: r.id, version: 3, comment_text: 'only a comment' }] })).toMatchObject({ ok: true });
  });

  it('permission, unknown result and locked store: auth.forbidden, common.not_found, offline.locked', async () => {
    const r = row(6); const env = await createEnv({ results: [r] });
    await expect(env.lab(USER, P_VERIFY).enterResults({ entries: [entry(r)] })).rejects.toMatchObject({ code: 'auth.forbidden' });
    await expect(env.lab(USER, P_ENTER).enterResults({ entries: [entry({ id: U(9999), version: 1 })] })).rejects.toMatchObject({ code: 'common.not_found' });
    env.store.lock();
    await expect(env.lab(USER, P_ENTER).enterResults({ entries: [entry(r)] })).rejects.toMatchObject({ code: 'offline.locked' });
  });
});

describe('a locked result is refused with the reason and nothing is queued (done_when 6)', () => {
  it('verified or approved on the server: sync.result_locked, naming the result; the call queues nothing even when other entries are fine', async () => {
    const ok = row(7); const verified = row(8, { status: 'verified', signoff_count: 1, signoffs: [signoff(USER2)] }); const approved = row(9, { status: 'approved' });
    const env = await createEnv({ results: [ok, verified, approved] });
    const lab = env.lab(USER, P_ENTER);
    const out = await lab.enterResults({ entries: [entry(ok), entry(verified), entry(approved)] });
    expect(out).toMatchObject({ ok: false, code: 'sync.result_locked', result_ids: [verified.id, approved.id] });
    expect(typeof out.message).toBe('string'); expect(out.message.length).toBeGreaterThan(10);
    expect(out.message).not.toMatch(/sync\.result_locked/);
    expect(await env.pendingOps()).toHaveLength(0);
  });

  it('a sign off already queued on this device locks the result for entry too', async () => {
    const r = row(10); const env = await createEnv({ results: [r], policies: [{ id: U(700), scope: 'lab', required_verifiers: 1, require_pathologist: false, allow_enterer_verify: false, active: true, version: 1, updated_at: '2026-11-01T00:00:00.000Z' }] });
    await env.lab(USER2, P_VERIFY).verifyResult({ result_id: r.id });
    expect(await env.lab(USER, P_ENTER).enterResults({ entries: [entry(r)] })).toMatchObject({ ok: false, code: 'sync.result_locked' });
  });

  it('the server says locked at sync (a result verified elsewhere meanwhile): the op needs attention with the code and the record shows it', async () => {
    const r = row(11); const env = await createEnv({ results: [r] });
    rule(env, (op) => (op.op_type === 'result.enter' ? { error_code: 'sync.result_locked' } : undefined));
    await env.lab(USER, P_ENTER).enterResults({ entries: [entry(r)] });
    await env.drain();
    expect(await env.outbox.count()).toBe(0);
    expect((await env.outbox.needsAttention()).map((a: { code: string; op_type: string }) => [a.op_type, a.code])).toEqual([['result.enter', 'sync.result_locked']]);
    expect(await env.flows.statusOf(r.id)).toEqual({ state: 'rejected', code: 'sync.result_locked' });
  });
});

describe('daily cash close offline (done_when 5)', () => {
  const counted = [{ method_code: 'cash', amount_paisa: 249500 }, { method_code: 'card', amount_paisa: 80000 }];

  it('queues one daily_cash.close op: entity = the cash session, base version = the version the user saw, strict CloseCashSessionRequest payload; shows the variance and Pending sync', async () => {
    const s = cashSession(1); const env = await createEnv({ sessions: [s] });
    const out = await env.cash().closeDay({ session_id: s.id, counted, note: 'short by 5 rupees' });
    expect(out).toMatchObject({ ok: true, queued: true });
    expect(out.variance).toEqual([{ method_code: 'cash', expected_paisa: 250000, counted_paisa: 249500, variance_paisa: -500 }, { method_code: 'card', expected_paisa: 80000, counted_paisa: 80000, variance_paisa: 0 }]);
    expect(await env.pendingOps()).toMatchObject([{ op_type: 'daily_cash.close', entity_id: s.id, base_version: 5, payload: { counted, note: 'short by 5 rupees' } }]);
    expect(await env.flows.statusOf(s.id)).toEqual({ state: 'pending' });
  });

  it('closing the same session twice queues once (idempotent per centre and day); the second call answers duplicate', async () => {
    const s = cashSession(2); const env = await createEnv({ sessions: [s] });
    const cash = env.cash();
    await cash.closeDay({ session_id: s.id, counted });
    expect(await cash.closeDay({ session_id: s.id, counted })).toMatchObject({ ok: true, queued: false, duplicate: true });
    expect(await env.pendingOps()).toHaveLength(1);
  });

  it('a session the cache already holds as closed is refused with common.immutable_record; the tenant step up for closing is online only (sync.offline_not_allowed)', async () => {
    const closed = cashSession(3, { status: 'closed' }); const open = cashSession(4); const env = await createEnv({ sessions: [closed, open] });
    expect(await env.cash().closeDay({ session_id: closed.id, counted })).toMatchObject({ ok: false, code: 'common.immutable_record' });
    const stepUp = await env.cash({ requiresStepUp: () => true }).closeDay({ session_id: open.id, counted });
    expect(stepUp).toMatchObject({ ok: false, code: 'sync.offline_not_allowed' });
    expect(stepUp.message).toMatch(/online|internet|connection/i);
    expect(await env.pendingOps()).toHaveLength(0);
  });

  it('input, permission and store: counted rows are validated like CloseCashSessionRequest', async () => {
    const s = cashSession(5); const env = await createEnv({ sessions: [s] });
    const cash = env.cash();
    for (const bad of [[], [{ method_code: '', amount_paisa: 1 }], [{ method_code: 'cash', amount_paisa: -1 }], [{ method_code: 'cash', amount_paisa: 1.5 }],
      Array.from({ length: 21 }, (_v, i) => ({ method_code: `m${i}`, amount_paisa: 0 })), [{ method_code: 'cash', amount_paisa: 1, extra: 1 }]]) {
      await expect(cash.closeDay({ session_id: s.id, counted: bad })).rejects.toMatchObject({ code: 'common.validation_failed' });
    }
    await expect(cash.closeDay({ session_id: s.id, counted, note: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'common.validation_failed' });
    await expect(cash.closeDay({ session_id: U(9999), counted })).rejects.toMatchObject({ code: 'common.not_found' });
    await expect(env.cash(['sync.use']).closeDay({ session_id: s.id, counted })).rejects.toMatchObject({ code: 'auth.forbidden' });
    env.store.lock();
    await expect(cash.closeDay({ session_id: s.id, counted })).rejects.toMatchObject({ code: 'offline.locked' });
  });

  it('someone else closed the day meanwhile: the server answers conflict and the screen shows the conflict with its code and id (never a silent overwrite)', async () => {
    const s = cashSession(6); const env = await createEnv({ sessions: [s] });
    rule(env, (op) => (op.op_type === 'daily_cash.close' ? { status: 'conflict', conflict_id: U(7001), error_code: 'common.immutable_record' } : undefined));
    await env.cash().closeDay({ session_id: s.id, counted });
    await drainAll(env);
    expect(await env.outbox.count()).toBe(0);
    expect((await env.outbox.conflicts()).map((c: { conflict_id: string; code?: string }) => [c.conflict_id, c.code])).toEqual([[U(7001), 'common.immutable_record']]);
    expect(await env.flows.statusOf(s.id)).toEqual({ state: 'conflict', code: 'common.immutable_record', conflict_id: U(7001) });
    expect(ops(env, 'daily_cash.close')).toHaveLength(1);
  });
});
