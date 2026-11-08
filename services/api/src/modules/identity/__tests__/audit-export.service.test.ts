// C2-T19 audit exports - service behaviour (01-PRD AC-D4.1..D4.5; 02-TRD §5.9, §8; 03-APP-FLOW §2.7, §7.2; 07-SECURITY A-7, D-T22, P-3, P-10).
// Seams: audit-export.helpers.ts header. Fails now because ../service/audit-export.service.js does not exist.
import { describe, expect, it } from 'vitest';
import { createAuditExportService } from '../service/audit-export.service.js';
import { CSV_BYTES, DAY, H, MEM, MEM2, NOW, TENANT_A, TENANT_B, USER, exRow, idN, makeEnv, readyRow, rejection, validBody } from './audit-export.helpers.js';

const svcOf = (e: ReturnType<typeof makeEnv>) => createAuditExportService(e.deps);
const SCHEMA_KEYS = ['export_id', 'source', 'status', 'requested_by_membership_id', 'range_from', 'range_to', 'row_count', 'ready_at', 'expires_at', 'downloads_remaining', 'error_code', 'created_at', 'version'];

describe('createAuditExport - happy path (AC-D4.2)', () => {
  it('202 + AuditExport{queued}; inserts under ctx tenant/actor, writes access log data.export, notice, job, metric - all on ctx.tx', async () => {
    const e = makeEnv(); const r = await svcOf(e).createAuditExport(e.ctx, validBody());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ source: 'audit_log', status: 'queued', requested_by_membership_id: MEM, downloads_remaining: 3, version: 1, range_from: '2026-10-01T00:00:00.000Z', range_to: '2026-10-31T00:00:00.000Z' });
    expect(r.body.export_id).toBe(e.repo.rows[0]!.id);
    expect(Object.keys(r.body).every((k) => SCHEMA_KEYS.includes(k))).toBe(true);   // additionalProperties:false: no object_path/sha256/filters/tenant_id
    expect(Object.values(r.body).some((v) => v === null)).toBe(false);
    const ins = e.repo.inserted();
    expect(ins).toHaveLength(1);
    expect(ins[0]!.tenantId).toBe(TENANT_A);
    expect(ins[0]!.args[0]).toMatchObject({ membershipId: MEM, source: 'audit_log', filters: { table: 'core.roles' }, actorId: USER });
    expect(e.accessWrites).toEqual([expect.objectContaining({ action: 'data.export', entityType: 'audit_export', entityId: r.body.export_id, outcome: 'allowed' })]);
    for (const c of e.repo.calls) expect(c.tx, c.method).toBe(e.tx);
    for (const c of e.repo.calls.filter((x) => x.method !== 'enqueueJob')) expect(c.tenantId, c.method).toBe(TENANT_A);
  });
  it('enqueues identity.build_audit_export with ONLY {tenant_id, export_id} and job_key export:<id> (no filters in the payload)', async () => {
    const e = makeEnv(); const r = await svcOf(e).createAuditExport(e.ctx, validBody());
    expect(e.repo.jobs).toEqual([{ taskIdentifier: 'identity.build_audit_export', payload: { tenant_id: TENANT_A, export_id: r.body.export_id }, jobKey: `export:${r.body.export_id}` }]);
  });
  it('notice for the OTHER admins: kind audit_export_created, subject audit_export/<id>, requester excluded, no PHI', async () => {
    const e = makeEnv(); const r = await svcOf(e).createAuditExport(e.ctx, validBody());
    expect(e.repo.notices).toEqual([{ tenantId: TENANT_A, kind: 'audit_export_created', subjectType: 'audit_export', subjectId: r.body.export_id, excludeMembershipId: MEM, actorId: USER }]);
  });
  it('increments lims_identity_audit_exports_total{tenant_id,source} once; works without a metrics sink', async () => {
    const e = makeEnv(); await svcOf(e).createAuditExport(e.ctx, validBody({ source: 'auth_events', filters: { event_type: 'login_failed' } }));
    expect(e.metricCalls).toEqual([['lims_identity_audit_exports_total', { tenant_id: TENANT_A, source: 'auth_events' }]]);
    const n = makeEnv([], { metrics: false }); expect((await svcOf(n).createAuditExport(n.ctx, validBody())).status).toBe(202);
  });
  it('order: lock -> quota counts -> row estimate -> insert -> access log -> notice -> enqueue (no job before the row exists)', async () => {
    const e = makeEnv(); await svcOf(e).createAuditExport(e.ctx, validBody());
    const ev = e.repo.events; const at = (s: string) => ev.indexOf(s);
    expect(at('lockQuota')).toBeGreaterThanOrEqual(0);
    expect(at('lockQuota')).toBeLessThan(at('countSince'));
    expect(at('countSince')).toBeLessThan(at('estimateRows'));
    expect(at('estimateRows')).toBeLessThan(at('insert'));
    expect(at('insert')).toBeLessThan(at('enqueueJob'));
    expect(at('insert')).toBeLessThan(at('access:data.export'));
  });
  it('accepts a body per source with that source\'s filters (access_log, auth_events)', async () => {
    for (const b of [validBody({ source: 'access_log', filters: { action: 'audit_entry.view', outcome: 'allowed' } }), validBody({ source: 'auth_events', filters: { event_type: 'login_failed', membership_id: MEM2 } }), validBody({ filters: undefined })]) {
      const e = makeEnv(); expect((await svcOf(e).createAuditExport(e.ctx, b)).status).toBe(202);
    }
  });
  it('access-log failure fails the request (no 202); the job is not enqueued before the log write succeeded', async () => {
    const e = makeEnv([], { failAccess: true });
    await rejection(svcOf(e).createAuditExport(e.ctx, validBody()));
    expect(e.repo.jobs).toHaveLength(0);
  });
  it('a repository failure while inserting propagates (no job, no notice, no metric)', async () => {
    const e = makeEnv(); e.repo.failOn = 'insert';
    await rejection(svcOf(e).createAuditExport(e.ctx, validBody()));
    expect([e.repo.jobs.length, e.repo.notices.length, e.metricCalls.length]).toEqual([0, 0, 0]);
  });
});

describe('createAuditExport - centre scope [CONV] (D-T22)', () => {
  it('membership with all_centres = false -> 403 auth.forbidden, NO export row, no estimate, no job, no access log', async () => {
    const e = makeEnv([], { centreAll: false });
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('auth.forbidden');
    expect(e.repo.rows).toHaveLength(0);
    expect(e.repo.inserted()).toHaveLength(0);
    expect(e.repo.jobs).toHaveLength(0);
    expect(e.accessWrites).toHaveLength(0);
    expect(e.repo.calls.some((c) => c.method === 'estimateRows')).toBe(false);
  });
  it('the scope check comes first: out-of-scope + too-large range is 403, never 422/429/400', async () => {
    const e = makeEnv([], { centreAll: false });
    for (const b of [validBody({ occurred_at_to: '2027-01-01T00:00:00.000Z' }), validBody({ format: 'xlsx' })]) expect((await rejection(svcOf(e).createAuditExport(e.ctx, b))).code).toBe('auth.forbidden');
  });
  it('only an explicit true counts: a missing / non-boolean flag is refused', async () => {
    const e = makeEnv(); e.actor.profile = { centreScope: { all: 'true' as any, centreIds: [] } };
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('auth.forbidden');
    e.actor.profile = {};
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('auth.forbidden');
    e.actor.profile = undefined;
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('auth.forbidden');
    expect(e.repo.rows).toHaveLength(0);
  });
  it('scope comes from IdentityPort.getActor, not ctx; a getActor failure propagates and nothing reaches the repo', async () => {
    const e = makeEnv(); e.actor.error = new Error('identity port down');
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).message).toBe('identity port down');
    expect(e.ctx.ports.IdentityPort.getActor).toHaveBeenCalledWith(e.ctx);
    expect(e.repo.calls).toHaveLength(0);
    expect(e.accessWrites).toHaveLength(0);
  });
  it('IC clock shape: ctx.now() returning an ISO string works (202, 24 h window anchored on that instant)', async () => {
    const e = makeEnv([], { isoClock: true });
    expect((await svcOf(e).createAuditExport(e.ctx, validBody())).status).toBe(202);
    expect(e.repo.rows).toHaveLength(1);
  });
});

describe('createAuditExport - range (AC-D4.3)', () => {
  it('exactly 31 days is allowed; 31 days + 1 ms -> 422 identity.export_too_large (no row, no job)', async () => {
    const ok = makeEnv(); expect((await svcOf(ok).createAuditExport(ok.ctx, validBody({ occurred_at_from: '2026-10-01T00:00:00.000Z', occurred_at_to: '2026-11-01T00:00:00.000Z' }))).status).toBe(202);
    const e = makeEnv();
    const err = await rejection(svcOf(e).createAuditExport(e.ctx, validBody({ occurred_at_from: '2026-10-01T00:00:00.000Z', occurred_at_to: '2026-11-01T00:00:00.001Z' })));
    expect(err.code).toBe('identity.export_too_large');
    expect(err.statusCode).toBe(422);
    expect(e.repo.rows).toHaveLength(0); expect(e.repo.jobs).toHaveLength(0);
  });
  it('a one-year range -> 422 identity.export_too_large before any row estimate', async () => {
    const e = makeEnv();
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody({ occurred_at_from: '2025-11-01T00:00:00.000Z', occurred_at_to: '2026-11-01T00:00:00.000Z' })))).code).toBe('identity.export_too_large');
    expect(e.repo.calls.some((c) => c.method === 'estimateRows')).toBe(false);
  });
  it('from >= to, malformed or missing instants -> 400 common.validation_failed with a pointer; nothing is written', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ occurred_at_to: '2026-10-01T00:00:00.000Z' }, '/occurred_at_to'],
      [{ occurred_at_to: '2026-09-01T00:00:00.000Z' }, '/occurred_at_to'],
      [{ occurred_at_from: 'yesterday' }, '/occurred_at_from'],
      [{ occurred_at_from: undefined }, '/occurred_at_from'],
      [{ occurred_at_to: undefined }, '/occurred_at_to'],
    ];
    for (const [over, path] of cases) {
      const e = makeEnv(); const err = await rejection(svcOf(e).createAuditExport(e.ctx, validBody(over)));
      expect(err.code, path).toBe('common.validation_failed');
      expect(JSON.stringify(err.fieldErrors ?? err.errors ?? err.details ?? [])).toContain(path);
      expect(e.repo.rows).toHaveLength(0);
    }
  });
});

describe('createAuditExport - row cap (AC-D4.3)', () => {
  it('estimate 500000 passes; 500001 -> 422 identity.export_too_large, no row, no job, no notice', async () => {
    const ok = makeEnv(); ok.repo.estimate = 500_000; expect((await svcOf(ok).createAuditExport(ok.ctx, validBody())).status).toBe(202);
    const e = makeEnv(); e.repo.estimate = 500_001;
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('identity.export_too_large');
    expect([e.repo.rows.length, e.repo.jobs.length, e.repo.notices.length, e.accessWrites.length, e.metricCalls.length]).toEqual([0, 0, 0, 0, 0]);
  });
  it('the estimate is bounded (cap = 500000, LIMIT cap+1) and scoped to the caller tenant, source, range and the validated filters', async () => {
    const e = makeEnv(); await svcOf(e).createAuditExport(e.ctx, validBody());
    const c = e.repo.calls.find((x) => x.method === 'estimateRows')!;
    expect(c.tenantId).toBe(TENANT_A);
    expect(c.args[0]).toMatchObject({ source: 'audit_log', from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', filters: { table: 'core.roles' }, cap: 500_000 });
  });
});

describe('createAuditExport - quotas (AC-D4.4, A-7)', () => {
  const mine = (n: number, age = H) => Array.from({ length: n }, () => exRow({ created_at: new Date(NOW.getTime() - age) }));
  it('5 earlier exports by this user in 24 h -> the 6th is 429 common.rate_limited; 4 earlier -> the 5th is accepted', async () => {
    const ok = makeEnv(mine(4)); expect((await svcOf(ok).createAuditExport(ok.ctx, validBody())).status).toBe(202);
    const e = makeEnv(mine(5));
    const err = await rejection(svcOf(e).createAuditExport(e.ctx, validBody()));
    expect(err.code).toBe('common.rate_limited'); expect(err.statusCode).toBe(429);
    expect(e.repo.rows).toHaveLength(5); expect(e.repo.jobs).toHaveLength(0); expect(e.repo.notices).toHaveLength(0); expect(e.accessWrites).toHaveLength(0);
  });
  it('the window is a sliding 24 h: an export 24 h + 1 s old does not count, one 23 h 59 min old does', async () => {
    const old = makeEnv([...mine(4), ...mine(1, DAY + 1000)]); expect((await svcOf(old).createAuditExport(old.ctx, validBody()))).toMatchObject({ status: 202 });
    const recent = makeEnv([...mine(4), ...mine(1, DAY - 60_000)]);
    expect((await rejection(svcOf(recent).createAuditExport(recent.ctx, validBody()))).code).toBe('common.rate_limited');
    const since = (old.repo.calls.find((c) => c.method === 'countSince')!.args[0] as any).since as Date;
    expect(NOW.getTime() - since.getTime()).toBe(DAY);
  });
  it('failed and expired exports still count towards the quota', async () => {
    const e = makeEnv([exRow({ status: 'failed' }), exRow({ status: 'expired' }), exRow({ status: 'ready' }), exRow({ status: 'queued' }), exRow({ status: 'building' })]);
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('common.rate_limited');
  });
  it('tenant quota: 20 earlier exports in the tenant (by others) -> the 21st is 429; 19 -> accepted; another tenant\'s rows do not count', async () => {
    const others = (n: number, t = TENANT_A) => Array.from({ length: n }, (_, i) => exRow({ tenant_id: t, requested_by_membership_id: idN(0x900 + (i % 10)), created_at: new Date(NOW.getTime() - H) }));
    const ok = makeEnv([...others(19), ...others(40, TENANT_B)]); expect((await svcOf(ok).createAuditExport(ok.ctx, validBody())).status).toBe(202);
    const e = makeEnv(others(20));
    expect((await rejection(svcOf(e).createAuditExport(e.ctx, validBody()))).code).toBe('common.rate_limited');
    expect(e.repo.jobs).toHaveLength(0);
  });
  it('another user\'s exports do not use up MY per-user quota', async () => {
    const e = makeEnv(Array.from({ length: 5 }, () => exRow({ requested_by_membership_id: MEM2 })));
    expect((await svcOf(e).createAuditExport(e.ctx, validBody())).status).toBe(202);
  });
  it('concurrency: the quota check runs under a per-requester lock (lockQuota before countSince) so parallel requests cannot all pass', async () => {
    const e = makeEnv(); await svcOf(e).createAuditExport(e.ctx, validBody());
    const lock = e.repo.calls.find((c) => c.method === 'lockQuota')!;
    expect(lock.tenantId).toBe(TENANT_A); expect(lock.args[0]).toBe(MEM); expect(lock.tx).toBe(e.tx);
    expect(e.repo.events.indexOf('lockQuota')).toBeLessThan(e.repo.events.indexOf('countSince'));
  });
});

describe('createAuditExport - input validation (trust boundary)', () => {
  const bad = async (b: unknown, path?: string) => {
    const e = makeEnv(); const err = await rejection(svcOf(e).createAuditExport(e.ctx, b as any));
    expect(err.code).toBe('common.validation_failed');
    if (path) expect(JSON.stringify(err.fieldErrors ?? err.errors ?? err.details ?? [])).toContain(path);
    expect(e.repo.rows).toHaveLength(0); expect(e.repo.jobs).toHaveLength(0);
    return err;
  };
  it('format other than csv, bad source, unknown top-level key, non-object body', async () => {
    await bad(validBody({ format: 'xlsx' }), '/format');
    await bad(validBody({ format: undefined }), '/format');
    await bad(validBody({ source: 'users' }), '/source');
    await bad(validBody({ tenant_id: TENANT_B }));          // additionalProperties:false - tenant never comes from the body
    await bad(validBody({ requested_by_membership_id: MEM2 }));
    await bad(null); await bad('x'); await bad([]);
  });
  it('filters: unknown key, filter of another source, malformed uuid / enum, non-string value', async () => {
    await bad(validBody({ filters: { tenant_id: TENANT_B } }), '/filters');
    await bad(validBody({ source: 'auth_events', filters: { table: 'core.roles' } }), '/filters/table');
    await bad(validBody({ filters: { actor_id: 'not-a-uuid' } }), '/filters/actor_id');
    await bad(validBody({ source: 'auth_events', filters: { event_type: 'nope' } }), '/filters/event_type');
    await bad(validBody({ source: 'access_log', filters: { outcome: 'maybe' } }), '/filters/outcome');
    await bad(validBody({ filters: { table: { $ne: 1 } } }), '/filters/table');
    await bad(validBody({ filters: 'x' }), '/filters');
  });
  it('error text never echoes a planted input value', async () => {
    const err = await bad(validBody({ source: 'PLANTED-TOKEN-91ab' }));
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('PLANTED-TOKEN-91ab');
  });
});

describe('getAuditExport (AC-D4.5 download-count visibility)', () => {
  it('own export -> 200 with status, row_count, expires_at, downloads_remaining; nothing outside the AuditExport schema', async () => {
    const row = readyRow({ downloads_remaining: 2 });
    const e = makeEnv([row]); const r = await svcOf(e).getAuditExport(e.ctx, { exportId: row.id });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ export_id: row.id, status: 'ready', row_count: 2, downloads_remaining: 2, expires_at: row.expires_at!.toISOString(), ready_at: row.ready_at!.toISOString(), version: 3 });
    expect(Object.keys(r.body).every((k) => SCHEMA_KEYS.includes(k))).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(row.object_path!);
  });
  it('unknown id, malformed id and another tenant\'s export -> 404 common.not_found / 400; repo reads are tenant-scoped', async () => {
    const other = readyRow({ tenant_id: TENANT_B });
    const e = makeEnv([other]);
    expect((await rejection(svcOf(e).getAuditExport(e.ctx, { exportId: other.id }))).code).toBe('common.not_found');
    expect((await rejection(svcOf(e).getAuditExport(e.ctx, { exportId: idN(0xfffff) }))).code).toBe('common.not_found');
    expect((await rejection(svcOf(e).getAuditExport(e.ctx, { exportId: 'nope' }))).code).toBe('common.validation_failed');
    for (const c of e.repo.calls) expect(c.tenantId).toBe(TENANT_A);
  });
  it('failed export exposes error_code only; omitted nulls', async () => {
    const row = exRow({ status: 'failed', error_code: 'identity.export_too_large' });
    const e = makeEnv([row]); const b = (await svcOf(e).getAuditExport(e.ctx, { exportId: row.id })).body;
    expect(b.error_code).toBe('identity.export_too_large'); expect('row_count' in b).toBe(false); expect('expires_at' in b).toBe(false);
  });
  it('P-10 consistency: another requester\'s export is 404 without audit.log.read, 200 with it', async () => {
    const row = readyRow({ requested_by_membership_id: MEM2 });
    const no = makeEnv([row]); expect((await rejection(svcOf(no).getAuditExport(no.ctx, { exportId: row.id }))).code).toBe('common.not_found');
    const yes = makeEnv([row], { readGrant: 'yes' }); expect((await svcOf(yes).getAuditExport(yes.ctx, { exportId: row.id })).status).toBe(200);
  });
});

describe('listAuditExports - P-10 branch', () => {
  const rows = () => [readyRow({ created_at: new Date(NOW.getTime() - 3 * H) }), exRow({ requested_by_membership_id: MEM2, created_at: new Date(NOW.getTime() - 2 * H) }), exRow({ requested_by_membership_id: MEM2, created_at: new Date(NOW.getTime() - H) }), exRow({ tenant_id: TENANT_B, created_at: new Date(NOW.getTime() - 30 * 60_000) })];
  it('without audit.log.read: ONLY my exports; assertRole asked for audit.log.read; auth.forbidden from it is not an error', async () => {
    const e = makeEnv(rows(), { readGrant: 'no' }); const r = await svcOf(e).listAuditExports(e.ctx, {});
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data.every((d: any) => d.requested_by_membership_id === MEM)).toBe(true);
    expect(e.asserted).toEqual([{ permission: 'audit.log.read' }]);
    expect(e.repo.calls.find((c) => c.method === 'list')!.args[0].membershipId).toBe(MEM);
  });
  it('with audit.log.read: every requester\'s metadata of THIS tenant (never tenant B), newest first; repo filter not narrowed to me', async () => {
    const e = makeEnv(rows(), { readGrant: 'yes' }); const r = await svcOf(e).listAuditExports(e.ctx, {});
    expect(r.body.data).toHaveLength(3);
    expect(r.body.data.map((d: any) => d.requested_by_membership_id)).toEqual([MEM2, MEM2, MEM]);
    expect(e.repo.calls.find((c) => c.method === 'list')!.args[0].membershipId).toBeUndefined();
    expect(e.repo.calls.find((c) => c.method === 'list')!.tenantId).toBe(TENANT_A);
  });
  it('any other assertRole failure fails closed (no rows, no silent downgrade to own rows)', async () => {
    const e = makeEnv(rows(), { readGrant: new Error('identity down') });
    await rejection(svcOf(e).listAuditExports(e.ctx, {}));
    expect(e.repo.calls.some((c) => c.method === 'list')).toBe(false);
  });
  it('items carry no object_path / sha256 / filters / tenant_id', async () => {
    const e = makeEnv(rows(), { readGrant: 'yes' }); const r = await svcOf(e).listAuditExports(e.ctx, {});
    for (const d of r.body.data) expect(Object.keys(d).every((k) => SCHEMA_KEYS.includes(k))).toBe(true);
  });
  it('keyset paging: limit 2 -> page.limit 2 + next_cursor; following it returns the rest once; no cursor on the last page; bad limit / cursor -> 400', async () => {
    const e = makeEnv(rows(), { readGrant: 'yes' }); const s = svcOf(e);
    const p1 = await s.listAuditExports(e.ctx, { limit: '2' });
    expect(p1.body.data).toHaveLength(2); expect(p1.body.page.limit).toBe(2); expect(typeof p1.body.page.next_cursor).toBe('string');
    const p2 = await s.listAuditExports(e.ctx, { limit: '2', cursor: p1.body.page.next_cursor });
    expect(p2.body.data).toHaveLength(1); expect(p2.body.page.next_cursor).toBeUndefined();
    expect([...p1.body.data, ...p2.body.data].map((d: any) => d.export_id)).toEqual(e.repo.rows.filter((r) => r.tenant_id === TENANT_A).sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).map((r) => r.id));
    for (const q of [{ limit: '0' }, { limit: '201' }, { limit: 'x' }, { cursor: '!!!' }]) expect((await rejection(s.listAuditExports(e.ctx, q as any))).code, JSON.stringify(q)).toBe('common.validation_failed');
  });
  it('empty tenant -> 200 {data: [], page:{limit:50}}', async () => {
    const e = makeEnv(); const r = await svcOf(e).listAuditExports(e.ctx, {});
    expect(r.body).toEqual({ data: [], page: { limit: 50 } });
  });
});

describe('downloadAuditExport (AC-D4.5)', () => {
  const setup = (o: Parameters<typeof readyRow>[0] = {}, env: Parameters<typeof makeEnv>[1] = {}) => {
    const row = readyRow(o);
    const e = makeEnv([row], { ...env, files: { [row.object_path!]: CSV_BYTES } });
    return { row, e, s: svcOf(e) };
  };
  it('200 text/csv attachment with nosniff + no-store; body = the stored bytes; reads bucket identity-exports under the tenant prefix', async () => {
    const { row, e, s } = setup(); const r = await s.downloadAuditExport(e.ctx, { exportId: row.id });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body).equals(Buffer.from(CSV_BYTES))).toBe(true);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(/^attachment;/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(e.reads).toEqual([{ bucket: 'identity-exports', path: row.object_path }]);
  });
  it('every successful download writes an access_log entry audit_export.download (entity audit_export/<id>) and decrements downloads_remaining', async () => {
    const { row, e, s } = setup();
    for (let i = 1; i <= 3; i++) {
      await s.downloadAuditExport(e.ctx, { exportId: row.id });
      expect(e.accessWrites.filter((w) => w.action === 'audit_export.download')).toHaveLength(i);
      expect(e.repo.rows[0]!.downloads_remaining).toBe(3 - i);
    }
    for (const w of e.accessWrites) expect(w).toMatchObject({ action: 'audit_export.download', entityType: 'audit_export', entityId: row.id, outcome: 'allowed' });
    expect((await s.getAuditExport(e.ctx, { exportId: row.id })).body.downloads_remaining).toBe(0);
  });
  it('the 4th download -> 404 common.not_found, no bytes read, no access-log row, counter stays 0 (never negative)', async () => {
    const { row, e, s } = setup({ downloads_remaining: 1 });
    await s.downloadAuditExport(e.ctx, { exportId: row.id });
    const reads = e.reads.length; const logs = e.accessWrites.length;
    expect((await rejection(s.downloadAuditExport(e.ctx, { exportId: row.id }))).code).toBe('common.not_found');
    expect(e.reads.length).toBe(reads); expect(e.accessWrites.length).toBe(logs); expect(e.repo.rows[0]!.downloads_remaining).toBe(0);
  });
  it('after 24 h (expires_at <= now) -> 404, also at the exact boundary; before it -> 200', async () => {
    const at = setup({ expires_at: new Date(NOW) }); expect((await rejection(at.s.downloadAuditExport(at.e.ctx, { exportId: at.row.id }))).code).toBe('common.not_found');
    const past = setup({ expires_at: new Date(NOW.getTime() - 1) }); expect((await rejection(past.s.downloadAuditExport(past.e.ctx, { exportId: past.row.id }))).code).toBe('common.not_found');
    const ok = setup({ expires_at: new Date(NOW.getTime() + 1) }); expect((await ok.s.downloadAuditExport(ok.e.ctx, { exportId: ok.row.id })).status).toBe(200);
  });
  it('not ready (queued / building / failed / expired) -> 404, nothing read or logged', async () => {
    for (const status of ['queued', 'building', 'failed', 'expired'] as const) {
      const { row, e, s } = setup({ status, object_path: null, expires_at: null });
      expect((await rejection(s.downloadAuditExport(e.ctx, { exportId: row.id }))).code, status).toBe('common.not_found');
      expect(e.reads).toHaveLength(0); expect(e.accessWrites).toHaveLength(0);
    }
  });
  it('requester only: another admin (even with audit.log.read) gets 404 and no decrement; unknown id and other tenant\'s export are 404', async () => {
    const { row, e, s } = setup({ requested_by_membership_id: MEM2 }, { readGrant: 'yes' });
    expect((await rejection(s.downloadAuditExport(e.ctx, { exportId: row.id }))).code).toBe('common.not_found');
    expect(e.repo.rows[0]!.downloads_remaining).toBe(3); expect(e.accessWrites).toHaveLength(0);
    const foreign = readyRow({ tenant_id: TENANT_B }); const f = makeEnv([foreign], { files: { [foreign.object_path!]: CSV_BYTES } });
    expect((await rejection(svcOf(f).downloadAuditExport(f.ctx, { exportId: foreign.id }))).code).toBe('common.not_found');
    expect((await rejection(s.downloadAuditExport(e.ctx, { exportId: idN(0xfffff) }))).code).toBe('common.not_found');
  });
  it('concurrency: 6 parallel downloads with 3 left -> exactly 3 succeed, 3 are 404, the counter ends at 0', async () => {
    const { row, e, s } = setup();
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => s.downloadAuditExport(e.ctx, { exportId: row.id })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(res.filter((r) => r.status === 'rejected').every((r: any) => r.reason.code === 'common.not_found')).toBe(true);
    expect(e.repo.rows[0]!.downloads_remaining).toBe(0);
    expect(e.accessWrites).toHaveLength(3);
  });
  it('storage failure -> the request fails, no access-log row claims a delivery', async () => {
    const row = readyRow(); const e = makeEnv([row]);   // object missing in storage
    await rejection(svcOf(e).downloadAuditExport(e.ctx, { exportId: row.id }));
    expect(e.accessWrites).toHaveLength(0);
  });
  it('access-log failure -> no bytes are returned', async () => {
    const { row, e, s } = setup({}, { failAccess: true });
    await rejection(s.downloadAuditExport(e.ctx, { exportId: row.id }));
  });
});
