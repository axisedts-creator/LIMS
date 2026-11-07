// C2-T18 — the four viewer handlers (02-TRD §5.9): listAuditEntries, getAuditEntry, listAccessLogEntries, listAuthEvents.
// Schema/auth/x-permission are enforced by the core pipeline from contracts/openapi/identity.yaml; the handlers map request -> service and fail closed
// without an authenticated request context (same convention as reporting/handlers/settings.handlers.ts).
// ASSUMED: services/api/src/modules/identity/handlers/<operationId>.ts exports `<operationId>: Handler` (named; a default export is also accepted);
// HandlerContext carries tenantId, requestId, actor, centreScope, tx, audit (helpers.ts). Business behaviour: audit-view.service.test.ts.
import { describe, expect, it } from 'vitest';
import * as listAuditEntriesMod from '../handlers/listAuditEntries.js';
import * as getAuditEntryMod from '../handlers/getAuditEntry.js';
import * as listAccessLogEntriesMod from '../handlers/listAccessLogEntries.js';
import * as listAuthEventsMod from '../handlers/listAuthEvents.js';
import { CENTRE_A1, FROM, PHI_SENTINEL, TENANT_A, TO, USER_A, auditRow, accessRow, authRow, idN, makeEnv, readIdentitySpec } from './audit-view.helpers.js';

const OPS = ['listAuditEntries', 'getAuditEntry', 'listAccessLogEntries', 'listAuthEvents'] as const;
const spec: any = readIdentitySpec();
const MODS: Record<string, any> = { listAuditEntries: listAuditEntriesMod, getAuditEntry: getAuditEntryMod, listAccessLogEntries: listAccessLogEntriesMod, listAuthEvents: listAuthEventsMod };
const load = async (op: string) => { const m = MODS[op]; return (m[op] ?? m.default) as (req: any, ctx: any) => Promise<any>; };
const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
const opMeta = (op: string) => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === op) return m; };
const seed = () => ({ audit_log: [auditRow(1), auditRow(2, { centre_id: CENTRE_A1 })], access_log: [accessRow(1)], auth_events: [authRow(1)] });
const rejects = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };

describe('contract sanity (T18 scope)', () => {
  it.each(OPS)('%s exists, requires audit.log.read in tenant context', (op) => {
    const m = opMeta(op);
    expect(m, op).toBeTruthy();
    expect(m['x-permission']).toBe('audit.log.read');
    expect(m['x-context']).toBe('tenant');
  });
});

describe.each(OPS)('%s handler', (op) => {
  it('is a function exported from handlers/%s.ts', async () => { expect(typeof (await load(op))).toBe('function'); });
  it('fails closed without tenant / actor / tx (never 2xx, never reflects input)', async () => {
    const h = await load(op); const planted = 'PLANTED-TOKEN-91ab';
    const e = await rejects(h({ params: { audit_id: planted }, query: { occurred_at_from: planted, occurred_at_to: planted, actor_id: planted }, headers: {}, body: undefined }, bare));
    expect(e, 'must throw without a request context').toBeTruthy();
    expect(e.code ?? e.statusCode).toBeTruthy();
    expect(String(e.message)).not.toContain(planted);
    expect(e.code).toBe('auth.unauthenticated');
  });
});

describe('handlers drive the service (end to end over the fake transaction)', () => {
  it('listAuditEntries -> 200 {data,page}; snake_case query reaches the service (filter + range)', async () => {
    const h = await load('listAuditEntries'); const env = makeEnv(seed());
    const r = await h({ params: {}, query: { occurred_at_from: FROM, occurred_at_to: TO, centre_id: CENTRE_A1, limit: 10 }, headers: {} }, env.ctx());
    expect(r.status).toBe(200);
    expect(r.body.data.map((d: any) => d.audit_id)).toEqual([idN(0x1000 + 2)]);
    expect(r.body.page.limit).toBe(10);
    expect(JSON.stringify(r.body)).not.toContain(PHI_SENTINEL);
  });
  it('listAuditEntries with a missing range -> common.validation_failed', async () => {
    const h = await load('listAuditEntries'); const env = makeEnv(seed());
    expect((await rejects(h({ params: {}, query: {}, headers: {} }, env.ctx())))?.code).toBe('common.validation_failed');
  });
  it('getAuditEntry reads params.audit_id -> 200 with values and writes the audit_entry.view access log', async () => {
    const h = await load('getAuditEntry'); const env = makeEnv(seed());
    const r = await h({ params: { audit_id: idN(0x1000 + 1) }, query: {}, headers: {} }, env.ctx());
    expect(r.status).toBe(200);
    expect(r.body.audit_id).toBe(idN(0x1000 + 1));
    expect(r.body.old_values).toContain(PHI_SENTINEL);
    expect(env.viewWrites().length).toBe(1);
    expect(env.viewWrites()[0]).toMatchObject({ action: 'audit_entry.view', entity_type: 'audit_entry', entity_id: idN(0x1000 + 1), outcome: 'allowed' });
  });
  it('getAuditEntry: access-log failure -> the handler throws, no body, no values in the error (D-T3)', async () => {
    const h = await load('getAuditEntry'); const env = makeEnv(seed(), { failAccess: true });
    const e = await rejects(h({ params: { audit_id: idN(0x1000 + 1) }, query: {}, headers: {} }, env.ctx()));
    expect(e).toBeTruthy();
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e))).not.toContain(PHI_SENTINEL);
  });
  it('getAuditEntry: unknown id -> common.not_found', async () => {
    const h = await load('getAuditEntry'); const env = makeEnv(seed());
    expect((await rejects(h({ params: { audit_id: idN(0x1fff) }, query: {}, headers: {} }, env.ctx())))?.code).toBe('common.not_found');
  });
  it('listAccessLogEntries / listAuthEvents -> 200 pages for the caller tenant', async () => {
    const q = { occurred_at_from: FROM, occurred_at_to: TO };
    const a = await (await load('listAccessLogEntries'))({ params: {}, query: q, headers: {} }, makeEnv(seed()).ctx());
    expect(a.status).toBe(200); expect(a.body.data.length).toBe(1);
    const b = await (await load('listAuthEvents'))({ params: {}, query: { ...q, event_type: 'login_succeeded' }, headers: {} }, makeEnv(seed()).ctx());
    expect(b.status).toBe(200); expect(b.body.data.length).toBe(1);
  });
  it('tenant comes from the context, never from the request (a tenant_id query/param is ignored)', async () => {
    const h = await load('listAuditEntries');
    const env = makeEnv({ audit_log: [auditRow(1), auditRow(2, { tenant_id: '0190a000-0000-7000-8000-00000000bbbb' })] });
    const r = await h({ params: { tenant_id: '0190a000-0000-7000-8000-00000000bbbb' }, query: { occurred_at_from: FROM, occurred_at_to: TO, tenant_id: '0190a000-0000-7000-8000-00000000bbbb' }, headers: {} }, env.ctx({ tenantId: TENANT_A }));
    expect(r.body.data.map((d: any) => d.audit_id)).toEqual([idN(0x1000 + 1)]);
    expect(USER_A).toBeTruthy();
  });
});
