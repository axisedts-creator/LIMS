// T24 dead-letter service (06 T24; 07-SECURITY D-T9, D-T10, D-T11, D-T14, D-T15, D-T16, D-T17; 08 A6.4, A8.4, A8.5, A9.1-A9.3, A10.2). Seams: dead-letter.helpers.ts header.
// The core is the C0 contract fake (version guard, notes, filters, paging, not_found); the service is the system under test.
import { describe, expect, it } from 'vitest';
import { createDeadLetterService } from '../dead-letter.service.js';
import { NOW, SECRET, STAFF_ID, STAFF_USER, TENANT_A, TENANT_B, REQ_ID, day, dl, idN, makeCore, makeCtx, rejection, type DlRow } from './dead-letter.helpers.js';

const setup = (rows: DlRow[] = [], o: { leak?: boolean } = {}, ctxO: Record<string, unknown> = {}) => {
  const core = makeCore(rows, o); const c = makeCtx(core, ctxO);
  const svc = createDeadLetterService({ platformEvents: c.platformEvents } as never) as Record<string, (ctx: any, input: any) => Promise<{ status: number; body: any; version?: number }>>;
  return { core, c, svc, call: (op: string, input: unknown) => svc[op]!(c.ctx, input) };
};
const KEYS = ['attempts', 'dead_at', 'first_failed_at', 'id', 'last_error_code', 'last_error_message_redacted', 'resolution_note', 'resolved_at', 'resolved_by', 'state', 'task_identifier', 'tenant_id', 'version'];
const code = async (p: Promise<unknown>) => (await rejection(p))?.code;
const NOTE_OK = 'x'.repeat(500);

describe('authorisation (PlatformAuthz.assertPlatform platform.dead_letter.manage; privileged => aal2); core is never reached when refused', () => {
  const OPS: Array<[string, object]> = [
    ['listDeadLetters', {}], ['getDeadLetter', { deadLetterId: idN(1) }],
    ['replayDeadLetter', { deadLetterId: idN(1), expectedVersion: 3 }], ['discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 3, reasonText: 'dup' }],
  ];
  it.each(OPS)('%s: platform_support -> auth.forbidden; superadmin on aal1 -> auth.mfa_required; tenant-style actor -> auth.forbidden; nothing read or written', async (op, input) => {
    for (const [o, want] of [[{ platformRole: 'platform_support' }, 'auth.forbidden'], [{ aal: 'aal1' }, 'auth.mfa_required'], [{ platformRole: 'tenant_admin' }, 'auth.forbidden'],
      [{ platformRole: undefined }, 'auth.forbidden'], [{ actor: { type: 'system', id: STAFF_USER } }, 'auth.forbidden']] as const) {
      const s = setup([dl({ id: idN(1) })], {}, o as Record<string, unknown>);
      expect(await code(s.call(op, input))).toBe(want);
      expect(s.core.calls).toHaveLength(0); expect(s.c.access).not.toHaveBeenCalled(); expect(s.c.platformEvents.insert).not.toHaveBeenCalled();
    }
  });
});

describe('D-T9 If-Match -> expectedVersion (08 A6.4)', () => {
  it.each(['replayDeadLetter', 'discardDeadLetter'])('%s: the handler value is passed as expectedVersion 1:1; current version -> state changes and version + 1', async (op) => {
    const row = dl({ id: idN(1), version: 7 }); const s = setup([row]);
    const r = await s.call(op, { deadLetterId: row.id, expectedVersion: 7, reasonText: 'duplicate of replayed job' });
    const c = s.core.by(op === 'replayDeadLetter' ? 'replay' : 'discard');
    expect(c).toHaveLength(1); expect(c[0]!.ctx).toBe(s.c.ctx); expect(c[0]!.input.expectedVersion).toBe(7); expect(c[0]!.input.deadLetterId).toBe(row.id);
    expect(s.core.row(row.id).state).toBe(op === 'replayDeadLetter' ? 'replayed' : 'discarded'); expect(s.core.row(row.id).version).toBe(8);
    expect(r.status).toBe(200);
  });
  it.each(['replayDeadLetter', 'discardDeadLetter'])('%s: stale If-Match -> 409 common.version_conflict, row still open, version unchanged, nothing enqueued', async (op) => {
    const row = dl({ id: idN(1), version: 7 }); const s = setup([row]);
    expect(await code(s.call(op, { deadLetterId: row.id, expectedVersion: 6, reasonText: 'dup' }))).toBe('common.version_conflict');
    expect(s.core.row(row.id)).toMatchObject({ state: 'open', version: 7, resolutionNote: null }); expect(s.core.enqueued).toHaveLength(0);
  });
  it.each(['replayDeadLetter', 'discardDeadLetter'])('%s: a second resolve of the same row (now not open) -> 409; a missing If-Match -> 428 common.precondition_required and core not called', async (op) => {
    const row = dl({ id: idN(1), version: 2 }); const s = setup([row]);
    await s.call(op, { deadLetterId: row.id, expectedVersion: 2, reasonText: 'first' });
    expect(await code(s.call(op, { deadLetterId: row.id, expectedVersion: 3, reasonText: 'second' }))).toBe('common.version_conflict');
    const t = setup([dl({ id: idN(2) })]);
    expect(await code(t.call(op, { deadLetterId: idN(2), expectedVersion: undefined, reasonText: 'x' }))).toBe('common.precondition_required'); expect(t.core.calls).toHaveLength(0);
  });
  it('a malformed If-Match (0, negative, fractional, > 2^31-1, string) -> 400 common.validation_failed, core not called', async () => {
    for (const v of [0, -1, 1.5, 2147483648, '3', NaN, null]) {
      const s = setup([dl({ id: idN(1) })]);
      expect(await code(s.call('replayDeadLetter', { deadLetterId: idN(1), expectedVersion: v }))).toBe('common.validation_failed'); expect(s.core.calls).toHaveLength(0);
    }
  });
  it('unknown dead_letter_id -> 404 common.not_found (from core); a non-uuid id -> 400/404 without a core write', async () => {
    const s = setup();
    expect(await code(s.call('replayDeadLetter', { deadLetterId: idN(404), expectedVersion: 1 }))).toBe('common.not_found');
    expect(['common.validation_failed', 'common.not_found']).toContain(await code(s.call('discardDeadLetter', { deadLetterId: "1'; DROP TABLE core.dead_letters;--", expectedVersion: 1, reasonText: 'x' })));
    expect(s.core.enqueued).toHaveLength(0);
  });
  it('core errors propagate unchanged (no wrapping, no row or payload in the error)', async () => {
    const s = setup([dl({ id: idN(1), version: 1 })]); s.core.state.fail = new Error(`db down ${SECRET}`);
    const e = await rejection(s.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 1, reasonText: 'x' }));
    expect(e).toBe(s.core.state.fail);
  });
});

describe('D-T10 discard note (08 A8.4)', () => {
  it('discard with reason_text + current version -> state discarded, resolution_note = text, passed as reasonText; get and list return it as resolution_note', async () => {
    const row = dl({ id: idN(1), version: 4 }); const s = setup([row]);
    const r = await s.call('discardDeadLetter', { deadLetterId: row.id, expectedVersion: 4, reasonText: 'duplicate of replayed job' });
    expect(s.core.by('discard')[0]!.input).toEqual({ deadLetterId: row.id, expectedVersion: 4, reasonText: 'duplicate of replayed job' });
    expect(s.core.row(row.id)).toMatchObject({ state: 'discarded', resolutionNote: 'duplicate of replayed job' });
    expect(r.status).toBe(200);
    expect((await s.call('getDeadLetter', { deadLetterId: row.id })).body).toMatchObject({ state: 'discarded', resolution_note: 'duplicate of replayed job', version: 5 });
    expect((await s.call('listDeadLetters', { state: 'discarded' })).body.data[0]).toMatchObject({ resolution_note: 'duplicate of replayed job' });
  });
  it('reason_text 500 chars is accepted; 0, 501 chars, absent, whitespace-only, non-string -> 400 common.validation_failed and the row is unchanged', async () => {
    const ok = setup([dl({ id: idN(1), version: 1 })]);
    expect((await ok.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 1, reasonText: NOTE_OK })).status).toBe(200);
    for (const bad of ['', 'x'.repeat(501), undefined, '   ', 5, null, {}, ['x']]) {
      const s = setup([dl({ id: idN(1), version: 1 })]);
      expect(await code(s.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 1, reasonText: bad }))).toBe('common.validation_failed');
      expect(s.core.row(idN(1))).toMatchObject({ state: 'open', version: 1, resolutionNote: null });
    }
  });
  it('the note is characters not UTF-16 units: 500 astral characters pass, 501 fail', async () => {
    const pass = setup([dl({ id: idN(1), version: 1 })]);
    expect((await pass.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 1, reasonText: '😀'.repeat(500) })).status).toBe(200);
    const fail = setup([dl({ id: idN(1), version: 1 })]);
    expect(await code(fail.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 1, reasonText: '😀'.repeat(501) }))).toBe('common.validation_failed');
  });
  it('the note is not written to the logger (free text may hold identifiers)', async () => {
    const s = setup([dl({ id: idN(1), version: 1 })]);
    await s.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 1, reasonText: 'PLANTED-NOTE-1234' });
    for (const l of ['info', 'warn', 'error'] as const) expect(JSON.stringify(s.c.log[l].mock.calls)).not.toContain('PLANTED-NOTE-1234');
  });
});

describe('D-T16 replay note (08 A9.3)', () => {
  it('replay with reason_text -> replayed, resolution_note = text, reasonText passed, enqueued once; get returns it', async () => {
    const row = dl({ id: idN(1), version: 2 }); const s = setup([row]);
    await s.call('replayDeadLetter', { deadLetterId: row.id, expectedVersion: 2, reasonText: 're-run after provider fix' });
    expect(s.core.by('replay')[0]!.input).toEqual({ deadLetterId: row.id, expectedVersion: 2, reasonText: 're-run after provider fix' });
    expect(s.core.row(row.id)).toMatchObject({ state: 'replayed', resolutionNote: 're-run after provider fix', version: 3 }); expect(s.core.enqueued).toHaveLength(1);
    expect((await s.call('getDeadLetter', { deadLetterId: row.id })).body.resolution_note).toBe('re-run after provider fix');
  });
  it('replay without reason_text -> resolution_note NULL (key absent in the response) and reasonText is omitted from the core call', async () => {
    const row = dl({ id: idN(1), version: 2 }); const s = setup([row]);
    await s.call('replayDeadLetter', { deadLetterId: row.id, expectedVersion: 2 });
    expect(s.core.by('replay')[0]!.input).toEqual({ deadLetterId: row.id, expectedVersion: 2 });
    expect(s.core.row(row.id).resolutionNote).toBeNull();
    expect('resolution_note' in (await s.call('getDeadLetter', { deadLetterId: row.id })).body).toBe(false);
  });
  it('0 or 501 chars -> 400 common.validation_failed, row still open, nothing enqueued; 500 accepted', async () => {
    for (const bad of ['', 'x'.repeat(501)]) {
      const s = setup([dl({ id: idN(1), version: 2 })]);
      expect(await code(s.call('replayDeadLetter', { deadLetterId: idN(1), expectedVersion: 2, reasonText: bad }))).toBe('common.validation_failed');
      expect(s.core.row(idN(1))).toMatchObject({ state: 'open', version: 2 }); expect(s.core.enqueued).toHaveLength(0);
    }
    const ok = setup([dl({ id: idN(1), version: 2 })]);
    expect((await ok.call('replayDeadLetter', { deadLetterId: idN(1), expectedVersion: 2, reasonText: NOTE_OK })).status).toBe(200);
  });
});

describe('D-T11 response shape (08 A8.5): DeadLetterRow snake_case with version, never job_payload', () => {
  it.each([false, true])('get and list items carry exactly the contract keys and the row version; no job_payload / jobPayload / SECRET anywhere (core leaks payload: %s)', async (leak) => {
    const rows = [dl({ id: idN(1), version: 9 }), dl({ id: idN(2), tenantId: null, taskIdentifier: 'core.retention_purge', state: 'discarded', resolvedBy: STAFF_USER, resolvedAt: NOW.toISOString(), resolutionNote: 'n', version: 4 })];
    const s = setup(rows, { leak });
    const g = await s.call('getDeadLetter', { deadLetterId: idN(1) });
    expect(g.status).toBe(200); expect(g.body.version).toBe(9); expect(g.version).toBe(9);
    expect(Object.keys(g.body).sort()).toEqual(KEYS.filter((k) => !['resolution_note', 'resolved_at', 'resolved_by'].includes(k)));
    const l = await s.call('listDeadLetters', { platformRows: true });
    expect(Object.keys(l.body.data[0]).sort()).toEqual(KEYS.filter((k) => k !== 'tenant_id')); expect(l.body.data[0].version).toBe(4);
    const all = JSON.stringify([g.body, l.body, (await s.call('listDeadLetters', {})).body]);
    expect(all).not.toMatch(/job_?payload/i); expect(all).not.toContain(SECRET);
    for (const b of [g.body, ...l.body.data]) for (const v of Object.values(b)) expect(v).not.toBeNull();
  });
  it('replay / discard responses are the resolved DeadLetterRow (version + 1, new state) with an ETag source; still no payload', async () => {
    for (const [op, state] of [['replayDeadLetter', 'replayed'], ['discardDeadLetter', 'discarded']] as const) {
      const s = setup([dl({ id: idN(1), version: 5 })], { leak: true });
      const r = await s.call(op, { deadLetterId: idN(1), expectedVersion: 5, reasonText: 'n' });
      expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: idN(1), state, version: 6, resolved_by: STAFF_USER, resolution_note: 'n' }); expect(r.version).toBe(6);
      expect(JSON.stringify(r.body)).not.toMatch(/job_?payload/i); expect(JSON.stringify(r.body)).not.toContain(SECRET);
      expect(Object.keys(r.body).every((k) => KEYS.includes(k))).toBe(true);
    }
  });
});

describe('D-T14 detail via ctx.core.deadLetters.get (08 A9.1)', () => {
  it('calls get(ctx, { deadLetterId }) once with the path id, returns its row; no list call', async () => {
    const row = dl({ id: idN(1) }); const s = setup([row]);
    const r = await s.call('getDeadLetter', { deadLetterId: row.id });
    expect(s.core.by('get')).toHaveLength(1); expect(s.core.by('get')[0]!.ctx).toBe(s.c.ctx); expect(s.core.by('get')[0]!.input).toEqual({ deadLetterId: row.id });
    expect(s.core.by('list')).toHaveLength(0); expect(r.body).toMatchObject({ id: row.id, task_identifier: 'billing.recompute_balance', state: 'open' });
  });
  it('unknown id -> common.not_found and NO dead_letter.view access-log entry and no dead_letter_viewed event', async () => {
    const s = setup([dl({ id: idN(1) })]);
    expect(await code(s.call('getDeadLetter', { deadLetterId: idN(999) }))).toBe('common.not_found');
    expect(s.c.access).not.toHaveBeenCalled(); expect(s.c.platformEvents.insert).not.toHaveBeenCalled(); expect(s.c.trail).toHaveLength(0); expect(s.c.events).toHaveLength(0);
  });
  it('tenant row -> exactly one access-log dead_letter.view (entity dead_letter) written inside withTenantScope(row tenant), outcome allowed, no platform event', async () => {
    const row = dl({ id: idN(1), tenantId: TENANT_B }); const s = setup([row]);
    await s.call('getDeadLetter', { deadLetterId: row.id });
    expect(s.c.withTenantScope).toHaveBeenCalledTimes(1); expect(s.c.withTenantScope.mock.calls[0]![1]).toBe(TENANT_B);
    expect(s.c.trail).toHaveLength(1); expect(s.c.trail[0]!.scope).toBe(TENANT_B);
    expect(s.c.trail[0]!.entry).toMatchObject({ action: 'dead_letter.view', entityType: 'dead_letter', entityId: row.id, outcome: 'allowed' });
    expect(JSON.stringify(s.c.trail[0]!.entry)).not.toContain(SECRET); expect(s.c.events).toHaveLength(0);
  });
  it('NULL-tenant row -> platform_events dead_letter_viewed (non-PHI detail, staff id, request id), no access-log and no tenant scope', async () => {
    const row = dl({ id: idN(1), tenantId: null, taskIdentifier: 'core.retention_purge' }); const s = setup([row]);
    await s.call('getDeadLetter', { deadLetterId: row.id });
    expect(s.c.events).toHaveLength(1);
    expect(s.c.events[0]).toMatchObject({ eventType: 'dead_letter_viewed', targetType: 'dead_letter', targetId: row.id, targetTenantId: null, actorPlatformStaffId: STAFF_ID, requestId: REQ_ID });
    expect(JSON.stringify(s.c.events[0])).not.toContain(SECRET); expect(s.c.access).not.toHaveBeenCalled(); expect(s.c.withTenantScope).not.toHaveBeenCalled();
  });
  it('a failing view trail fails the request (no unlogged read of a tenant dead letter)', async () => {
    const s = setup([dl({ id: idN(1) })]); s.c.access.mockRejectedValueOnce(new Error('audit down'));
    await rejection(s.call('getDeadLetter', { deadLetterId: idN(1) }));
  });
  it('a non-uuid id -> common.not_found / validation_failed, no core row read, no trail', async () => {
    const s = setup([dl({ id: idN(1) })]);
    expect(['common.not_found', 'common.validation_failed']).toContain(await code(s.call('getDeadLetter', { deadLetterId: 'not-a-uuid' })));
    expect(s.c.trail).toHaveLength(0);
  });
});

describe('D-T15 list filters + paging (08 A9.2)', () => {
  const F = { state: 'open', tenantId: TENANT_A, taskIdentifier: 'billing.recompute_balance', deadAtFrom: day(2).toISOString(), deadAtTo: day(9).toISOString(), cursor: 'c-1', limit: 10 };
  it('all filters are passed 1:1 (camelCase) to core list(ctx, ...); platformRows defaults to false', async () => {
    const s = setup(); await s.call('listDeadLetters', F);
    expect(s.core.by('list')).toHaveLength(1); expect(s.core.by('list')[0]!.ctx).toBe(s.c.ctx); expect(s.core.by('list')[0]!.input).toEqual({ ...F, platformRows: false });
  });
  it('no filters -> { platformRows: false } only (no invented defaults such as limit or state); body page.limit = 50', async () => {
    const s = setup(); const r = await s.call('listDeadLetters', {});
    expect(s.core.by('list')[0]!.input).toEqual({ platformRows: false }); expect(r.body).toEqual({ data: [], page: { limit: 50 } });
  });
  const seed = () => [
    dl({ id: idN(1), deadAt: day(2).toISOString() }), dl({ id: idN(2), deadAt: day(3).toISOString(), state: 'replayed', resolvedBy: STAFF_USER, resolvedAt: NOW.toISOString(), version: 4 }),
    dl({ id: idN(3), deadAt: day(4).toISOString(), tenantId: TENANT_B }), dl({ id: idN(4), deadAt: day(5).toISOString(), taskIdentifier: 'catalog.publish_revision' }),
    dl({ id: idN(5), deadAt: day(6).toISOString(), tenantId: null, taskIdentifier: 'core.retention_purge' }),
  ];
  const ids = (r: { body: any }) => r.body.data.map((x: any) => x.id);
  it('each filter alone and combined returns only matching rows; platform rows only with platform_rows', async () => {
    const s = setup(seed());
    expect(ids(await s.call('listDeadLetters', {}))).toEqual([idN(4), idN(3), idN(2), idN(1)]);
    expect(ids(await s.call('listDeadLetters', { state: 'replayed' }))).toEqual([idN(2)]);
    expect(ids(await s.call('listDeadLetters', { tenantId: TENANT_B }))).toEqual([idN(3)]);
    expect(ids(await s.call('listDeadLetters', { taskIdentifier: 'catalog.publish_revision' }))).toEqual([idN(4)]);
    expect(ids(await s.call('listDeadLetters', { state: 'open', tenantId: TENANT_A, taskIdentifier: 'catalog.publish_revision' }))).toEqual([idN(4)]);
    expect(ids(await s.call('listDeadLetters', { state: 'discarded' }))).toEqual([]);
  });
  it('dead_at_from is inclusive and dead_at_to exclusive', async () => {
    const s = setup(seed());
    expect(ids(await s.call('listDeadLetters', { deadAtFrom: day(3).toISOString(), deadAtTo: day(5).toISOString() }))).toEqual([idN(3), idN(2)]);
    expect(ids(await s.call('listDeadLetters', { deadAtFrom: day(5).toISOString() }))).toEqual([idN(4)]);
  });
  it('paging: limit 2 over 4 rows returns every row exactly once, next_cursor present until the last page; limit echoed in page.limit', async () => {
    const s = setup(seed()); const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const r = await s.call('listDeadLetters', { limit: 2, ...(cursor ? { cursor } : {}) }); pages++;
      expect(r.body.page.limit).toBe(2); expect(r.body.data.length).toBeLessThanOrEqual(2); seen.push(...ids(r)); cursor = r.body.page.next_cursor;
      if (cursor === undefined) expect('next_cursor' in r.body.page).toBe(false);
    } while (cursor && pages < 10);
    expect(seen).toEqual([idN(4), idN(3), idN(2), idN(1)]); expect(pages).toBe(2);
  });
  it('invalid filters -> 400 common.validation_failed and core NOT called: limit 0 / 201 / 1.5 / "10", state "bogus", tenant_id not a uuid, malformed dates, over-long task_identifier', async () => {
    for (const bad of [{ limit: 201 }, { limit: 0 }, { limit: 1.5 }, { limit: '10' }, { limit: -1 }, { state: 'bogus' }, { state: 'OPEN' }, { tenantId: 'x' }, { tenantId: "' OR 1=1" },
      { deadAtFrom: 'yesterday' }, { deadAtTo: '2026-11-08' }, { taskIdentifier: 'x'.repeat(201) }, { cursor: 'x'.repeat(513) }, { cursor: 5 }]) {
      const s = setup(seed());
      expect(await code(s.call('listDeadLetters', bad))).toBe('common.validation_failed'); expect(s.core.calls).toHaveLength(0);
    }
  });
  it('limit 200 and 1 are accepted', async () => {
    for (const limit of [1, 200]) { const s = setup(seed()); expect((await s.call('listDeadLetters', { limit })).status).toBe(200); expect(s.core.by('list')[0]!.input.limit).toBe(limit); }
  });
  it('an invalid cursor from core (common.invalid_cursor) propagates unchanged', async () => {
    const s = setup(seed()); s.core.state.fail = Object.assign(new Error('x'), { code: 'common.invalid_cursor' });
    expect((await rejection(s.call('listDeadLetters', { cursor: 'zzz' }))).code).toBe('common.invalid_cursor');
  });
});

describe('D-T17 platform_rows (08 A10.2)', () => {
  const rows = () => [dl({ id: idN(1) }), dl({ id: idN(2), tenantId: TENANT_B }), dl({ id: idN(3), tenantId: null, taskIdentifier: 'core.retention_purge' })];
  it('without platformRows -> core gets platformRows:false and only tenant rows come back', async () => {
    const s = setup(rows()); const r = await s.call('listDeadLetters', {});
    expect(s.core.by('list')[0]!.input.platformRows).toBe(false); expect(r.body.data.map((x: any) => x.id).sort()).toEqual([idN(1), idN(2)]);
    expect(r.body.data.every((x: any) => typeof x.tenant_id === 'string')).toBe(true);
  });
  it('platformRows:true -> core gets true; only tenant_id-NULL rows come back (tenant_id key absent)', async () => {
    const s = setup(rows()); const r = await s.call('listDeadLetters', { platformRows: true });
    expect(s.core.by('list')[0]!.input.platformRows).toBe(true); expect(r.body.data.map((x: any) => x.id)).toEqual([idN(3)]); expect('tenant_id' in r.body.data[0]).toBe(false);
  });
  it('platformRows:true together with tenantId -> 400 common.validation_failed and ctx.core.deadLetters.list is NOT called', async () => {
    const s = setup(rows());
    expect(await code(s.call('listDeadLetters', { platformRows: true, tenantId: TENANT_A }))).toBe('common.validation_failed');
    expect(s.core.spies.list).not.toHaveBeenCalled(); expect(s.core.calls).toHaveLength(0);
  });
  it('platformRows:false with tenantId is a normal tenant filter; a non-boolean platformRows -> 400 common.validation_failed', async () => {
    const s = setup(rows()); expect((await s.call('listDeadLetters', { platformRows: false, tenantId: TENANT_B })).body.data.map((x: any) => x.id)).toEqual([idN(2)]);
    for (const bad of ['true', 'yes', 1, 0, null, {}]) { const t = setup(rows()); expect(await code(t.call('listDeadLetters', { platformRows: bad }))).toBe('common.validation_failed'); expect(t.core.calls).toHaveLength(0); }
  });
});

describe('no direct data path: only ctx.core.deadLetters', () => {
  it('read operations do not touch ctx.tx beyond handing it to core/withTenantScope (no query method used)', async () => {
    const s = setup([dl({ id: idN(1) })]); (s.c.tx as any).query = () => { throw new Error('service queried the tx directly'); };
    await s.call('listDeadLetters', {}); await s.call('getDeadLetter', { deadLetterId: idN(1) }); await s.call('discardDeadLetter', { deadLetterId: idN(1), expectedVersion: 3, reasonText: 'x' });
  });
});
