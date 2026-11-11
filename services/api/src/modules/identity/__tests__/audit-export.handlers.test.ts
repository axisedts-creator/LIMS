// C2-T19 export handlers + contract sanity (02-TRD §5.9; contracts/openapi/identity.yaml; 08 A13 P-2, P-8, P-10).
// ASSUMED: handlers/<operationId>.ts export `<operationId>: Handler`; each calls the singleton/factory `createAuditExportService()` of ../service/audit-export.service.js
// with (ctx, input): create -> req.body as is; list -> req.query as is; get/download -> { exportId: req.params.export_id }; the service result
// ({status, body, headers?}) is returned unchanged. Without tenantId / actor.id / tx on the context -> LimsError auth.unauthenticated and NO service call.
// The core pipeline (not the handler) enforces x-permission audit.log.export and Idempotency-Key (contract tests below).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  createAuditExport: vi.fn(), listAuditExports: vi.fn(), getAuditExport: vi.fn(), downloadAuditExport: vi.fn(),
}));
vi.mock('../service/audit-export.service.js', () => ({ createAuditExportService: () => svc }));

import * as createMod from '../handlers/createAuditExport.js';
import * as listMod from '../handlers/listAuditExports.js';
import * as getMod from '../handlers/getAuditExport.js';
import * as downloadMod from '../handlers/downloadAuditExport.js';
import { handlers } from '../handlers/index.js';
import { TENANT_A, USER, MEM, REQ_ID, idN, readIdentitySpec, rejection } from './audit-export.helpers.js';

const OPS = ['createAuditExport', 'listAuditExports', 'getAuditExport', 'downloadAuditExport'] as const;
const MODS: Record<string, any> = { createAuditExport: createMod, listAuditExports: listMod, getAuditExport: getMod, downloadAuditExport: downloadMod };
const load = (op: string) => (MODS[op][op] ?? MODS[op].default) as (req: any, ctx: any) => Promise<any>;
const ctxOk = () => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, tenantId: TENANT_A, requestId: REQ_ID, tx: { name: 'tx' }, actor: { type: 'user', id: USER, membershipId: MEM }, audit: { access: async () => {} } });
const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
const EID = idN(0x1234);

beforeEach(() => { for (const f of Object.values(svc)) f.mockReset(); });

describe('contract sanity (T19 scope)', () => {
  it.each(OPS)('%s: x-permission audit.log.export, tenant context', async (op) => {
    const spec = await readIdentitySpec(); let m: any;
    for (const p of Object.values<any>(spec.paths)) for (const v of Object.values<any>(p)) if (v?.operationId === op) m = v;
    expect(m, op).toBeTruthy();
    expect(m['x-permission']).toBe('audit.log.export');
    expect(m['x-context']).toBe('tenant');
  });
  it('createAuditExport: Idempotency-Key required; declares identity.export_too_large, common.rate_limited, auth.forbidden; 202 + 422 + 429 + 403 responses', async () => {
    const spec = await readIdentitySpec(); const m = spec.paths['/v1/identity/audit-exports'].post;
    expect(m['x-idempotency']).toBe('required');
    expect(m['x-error-codes']).toEqual(expect.arrayContaining(['identity.export_too_large', 'common.rate_limited', 'auth.forbidden']));
    for (const c of ['202', '403', '422', '429']) expect(m.responses[c], c).toBeTruthy();
  });
  it('downloadAuditExport: attachment + nosniff + no-store headers declared (P-2); 404 documented', async () => {
    const spec = await readIdentitySpec(); const ok = spec.paths['/v1/identity/audit-exports/{export_id}/file'].get.responses['200'];
    expect(Object.keys(ok.headers)).toEqual(expect.arrayContaining(['Content-Disposition', 'X-Content-Type-Options', 'Cache-Control']));
    expect(ok.content['text/csv']).toBeTruthy();
  });
  it('the permission is a privileged catalog code (insider-export control)', async () => {
    const { readFileSync } = await import('node:fs'); const { join } = await import('node:path');
    const y = readFileSync(join(import.meta.dirname, '../../../../../../contracts/permissions.yaml'), 'utf8');
    expect(y).toMatch(/code:\s*audit\.log\.export,\s*privileged:\s*true/);
  });
});

describe.each(OPS)('%s handler', (op) => {
  it('is a function exported from handlers/<op>.ts and wired in handlers/index.ts (not the common.internal stub)', () => {
    expect(typeof load(op)).toBe('function');
    expect((handlers as any)[op]).toBe(load(op));
  });
  it('fails closed without tenant / actor / tx: auth.unauthenticated, no service call, input never reflected', async () => {
    const planted = 'PLANTED-TOKEN-91ab';
    const e = await rejection(load(op)({ params: { export_id: planted }, query: { cursor: planted }, headers: {}, body: { source: planted } }, bare));
    expect(e.code).toBe('auth.unauthenticated');
    expect(String(e.message)).not.toContain(planted);
    for (const f of Object.values(svc)) expect(f).not.toHaveBeenCalled();
  });
});

describe('handlers drive the service', () => {
  it('createAuditExport passes ctx and the raw body; returns the service result (202) unchanged', async () => {
    const body = { source: 'audit_log', occurred_at_from: 'a', occurred_at_to: 'b', format: 'csv' }; const result = { status: 202, body: { export_id: EID } };
    svc.createAuditExport.mockResolvedValue(result); const c = ctxOk();
    const r = await load('createAuditExport')({ params: {}, query: {}, headers: { 'idempotency-key': 'k' }, body }, c);
    expect(svc.createAuditExport).toHaveBeenCalledTimes(1);
    expect(svc.createAuditExport.mock.calls[0]![0]).toBe(c); expect(svc.createAuditExport.mock.calls[0]![1]).toBe(body);
    expect(r).toMatchObject(result);
  });
  it('listAuditExports passes ctx and the query; returns 200 body', async () => {
    svc.listAuditExports.mockResolvedValue({ status: 200, body: { data: [], page: { limit: 50 } } }); const c = ctxOk(); const query = { limit: '10' };
    const r = await load('listAuditExports')({ params: {}, query, headers: {} }, c);
    expect(svc.listAuditExports.mock.calls[0]![0]).toBe(c); expect(svc.listAuditExports.mock.calls[0]![1]).toBe(query);
    expect(r.status).toBe(200); expect(r.body).toEqual({ data: [], page: { limit: 50 } });
  });
  it('getAuditExport reads params.export_id', async () => {
    svc.getAuditExport.mockResolvedValue({ status: 200, body: { export_id: EID } });
    const r = await load('getAuditExport')({ params: { export_id: EID }, query: {}, headers: {} }, ctxOk());
    expect(svc.getAuditExport.mock.calls[0]![1]).toEqual({ exportId: EID }); expect(r.status).toBe(200);
  });
  it('downloadAuditExport reads params.export_id and forwards status, headers and bytes untouched (P-2 headers come from the core helper)', async () => {
    const out = { status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="x.csv"', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }, body: new Uint8Array([1, 2, 3]) };
    svc.downloadAuditExport.mockResolvedValue(out);
    const r = await load('downloadAuditExport')({ params: { export_id: EID }, query: {}, headers: {} }, ctxOk());
    expect(svc.downloadAuditExport.mock.calls[0]![1]).toEqual({ exportId: EID });
    expect(r.status).toBe(200); expect(r.headers).toEqual(out.headers); expect(r.body).toBe(out.body);
  });
  it('service errors (429 / 422 / 404 / 403) propagate as-is', async () => {
    const { LimsError } = await import('../../../core/errors.js');
    for (const [op, code] of [['createAuditExport', 'common.rate_limited'], ['createAuditExport', 'identity.export_too_large'], ['createAuditExport', 'auth.forbidden'], ['downloadAuditExport', 'common.not_found']] as const) {
      (svc as any)[op].mockRejectedValueOnce(new LimsError(code));
      expect((await rejection(load(op)({ params: { export_id: EID }, query: {}, headers: {}, body: {} }, ctxOk()))).code).toBe(code);
    }
  });
});
