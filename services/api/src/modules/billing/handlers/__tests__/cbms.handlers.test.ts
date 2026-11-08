// BL-T14 handlers B30 listCbmsDocuments / B31 retryCbmsDocument (02-TRD §5.2; REQ-SEC-099 no 2xx stub; 07-SECURITY §"settings / CBMS retry": 403 auth.forbidden / 403 auth.mfa_required).
// Fails now: handlers/index.ts maps both operationIds to the BL-T01 stub (common.service_unavailable, 503).
// Handler contract (same as credit.handlers.test.ts): (req:{params,query,headers,body}, ctx) -> {status, body}; needs ctx.tenantId + ctx.actor.id + ctx.tx else auth.unauthenticated.
// Permission / privileged-aal2 / Idempotency-Key / schema are enforced by the core pipeline from contracts/openapi/billing.yaml + contracts/permissions.yaml — pinned statically below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { handlers } from '../index.js';

const ROOT = join(import.meta.dirname, '../../../../../../..');
const OPS = ['listCbmsDocuments', 'retryCbmsDocument'] as const;
const DOC = '01a1a98a-ac40-7000-8000-000000e00001';
const req = (op: (typeof OPS)[number], over: Record<string, unknown> = {}) => ({
  params: op === 'retryCbmsDocument' ? { document_kind: 'invoice', document_id: DOC } : {}, query: {}, headers: { 'idempotency-key': 'bl14-h-1' }, body: undefined, ...over }) as never;
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected rejection'); };
const run = (op: (typeof OPS)[number], r: unknown, c: unknown) => (handlers[op] as any)(r, c);
const emptyCtx = () => ({ operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} }, ...makeCtxFor()('A', { tx: { async query() { return { rows: [] }; } } } as never) }) as never;

describe('B30 / B31 are real handlers, not the BL-T01 stub (REQ-SEC-099)', () => {
  for (const op of OPS) {
    it(`${op}: ctx without tenantId/actor/tx -> auth.unauthenticated (the stub answers common.service_unavailable)`, async () => {
      const bare = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
      expect((await fail(run(op, req(op), bare))).code).toBe('auth.unauthenticated');
    });
  }
  it('both are functions distinct from the shared stub', () => {
    const stub = (handlers as any).getBillingExportContent; // still the BL-T01 stub in this task
    for (const op of OPS) { expect(typeof handlers[op], op).toBe('function'); expect(handlers[op], op).not.toBe(stub); }
  });
});

describe('answers over an empty database', () => {
  it('B30: 200 with { data: [], page } and no internals', async () => {
    const out = await run('listCbmsDocuments', req('listCbmsDocuments'), emptyCtx());
    expect(out.status).toBe(200); expect(out.body.data).toEqual([]); expect(out.body.page).toBeTypeOf('object');
    expect(JSON.stringify(out.body)).not.toMatch(/tenant_id|created_by|updated_by|stack/);
  });
  it('B31: unknown document -> 404 common.not_found (no 2xx, no existence oracle beyond the tenant)', async () => {
    const e = await fail(run('retryCbmsDocument', req('retryCbmsDocument'), emptyCtx()));
    expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
  });
  it('B31: path document_kind outside the three kinds / document_id not a uuid -> common.validation_failed', async () => {
    for (const params of [{ document_kind: 'receipt', document_id: DOC }, { document_kind: 'invoice', document_id: 'not-a-uuid' }]) {
      expect((await fail(run('retryCbmsDocument', req('retryCbmsDocument', { params }), emptyCtx()))).code, JSON.stringify(params)).toBe('common.validation_failed');
    }
  });
  it('B30: ?state and ?document_kind outside their enums -> common.validation_failed', async () => {
    for (const query of [{ state: 'synchronised' }, { document_kind: 'receipt' }]) {
      expect((await fail(run('listCbmsDocuments', req('listCbmsDocuments', { query }), emptyCtx()))).code, JSON.stringify(query)).toBe('common.validation_failed');
    }
  });
});

describe('contract pins the pipeline relies on (guard: these hold today and must keep holding)', () => {
  const yaml = readFileSync(join(ROOT, 'contracts/openapi/billing.yaml'), 'utf8');
  const op = (id: string) => { const i = yaml.indexOf(`operationId: ${id}`); return yaml.slice(i, i + 900); };
  it('B30 needs billing.invoice.read; B31 needs billing.settings.manage and a required Idempotency-Key', () => {
    expect(op('listCbmsDocuments')).toMatch(/x-permission: billing\.invoice\.read/);
    expect(op('retryCbmsDocument')).toMatch(/x-permission: billing\.settings\.manage/);
    expect(op('retryCbmsDocument')).toMatch(/x-idempotency: required/);
  });
  it('billing.settings.manage is privileged (aal2) for tenant_admin and finance only — a front-desk user cannot retry', () => {
    const perms = readFileSync(join(ROOT, 'contracts/permissions.yaml'), 'utf8');
    const row = perms.split('\n').find((l) => l.includes('code: billing.settings.manage')) ?? '';
    expect(row).toMatch(/privileged:\s*true/); expect(row).toMatch(/roles:\s*\[tenant_admin,\s*finance\]/);
  });
});
