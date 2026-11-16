// T0B-ADMINFIX-1 (LD-301; live 2026-11-17 00:29 NPT, tenant metrolabs, administrator): listAccessLogEntries and listAuditExports answered
// 500 common.internal on staging although T0C-AUDIT-WIRE-1 is done. Those tests call the handlers with a hand made ctx whose ports.IdentityPort exists;
// this one runs the REAL chain (core/pipeline createPipeline + the real PORT_CONSUMERS registry + the real IdentityPort), where for module identity
// ctx.ports.IdentityPort is not readable (identity is not a consumer of its own port). See audit.chain.helpers.ts.
// Seven operations x { shadow, enforce } (LIMS_CORE_AUTHZ_MODE; shadow is the default of every environment, LD-261):
//   - an administrator holding audit.log.read and audit.log.export: 200 (createAuditExport 202 or 201), body valid against the contract;
//   - the permission of the contract is asserted exactly once per request (enforce: stage 8a is the only asserter);
//   - a user without it still gets auth.forbidden (403), in shadow too (the deployed default), with no read and no write behind it;
//   - the audit.log.export holder without audit.log.read sees only own exports (P-10), never everyone's: no widening.
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { OPS, EXPORT_ID, makeAuditChain, type OpRow, type Persona } from './audit.chain.helpers.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'identity.yaml'));
const factory = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => ((v: unknown) => boolean) & { errors?: any[] };
const compile = factory({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false, keywords: [...AJV_OPTIONS.keywords, 'components'] } });
function operation(id: string): any {
  for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'put', 'post', 'delete', 'patch']) if (item?.[m]?.operationId === id) return item[m];
  throw new Error(`no operation ${id}`);
}
const violations = (id: string, status: number, body: unknown): any[] => {
  const v = compile({ schema: { components: spec.components, ...operation(id).responses[String(status)].content['application/json'].schema } });
  return v(body) ? [] : [...(v.errors ?? [])];
};
const fail = async (p: Promise<unknown>): Promise<any> => p.then(() => undefined, (e) => e);
const MODES = ['shadow', 'enforce'] as const;
const VIEW = OPS.filter((o) => o.perm === 'audit.log.read');
const EXPORT = OPS.filter((o) => o.perm === 'audit.log.export');
const okStatus = (o: OpRow) => (o.op === 'createAuditExport' ? [201, 202] : [200]);

describe('the contract names what the chain below asserts', () => {
  it.each(OPS)('$op: x-permission $perm, tenant context, idempotency $idem', ({ op, perm, idem, method }) => {
    const o = operation(op);
    expect(o['x-permission']).toBe(perm);
    expect(o['x-context']).toBe('tenant');
    expect(o['x-idempotency']).toBe(idem);
    expect(Object.keys(spec.paths).some((p) => spec.paths[p]?.[method.toLowerCase()]?.operationId === op)).toBe(true);
  });
});

describe('control: the fixtures are sound (identity listed as a consumer of IdentityPort, which staging lacks): the only fault left is port visibility', () => {
  it('real PORT_CONSUMERS does not list identity for IdentityPort (the staging fact)', async () => {
    const { PORT_CONSUMERS } = await import('../../../../../../../contracts/ports/generated/port-consumers.js');
    expect(PORT_CONSUMERS.IdentityPort).not.toContain('identity');
  });
  it.each(OPS)('$op answers 2xx for the administrator', async (row) => {
    const r = await makeAuditChain({ authzMode: 'enforce', identityIsConsumer: true }).run(row, 'admin');
    expect(okStatus(row)).toContain(r.status);
    expect(violations(row.op, r.status, r.body)).toEqual([]);
  });
});

describe.each(MODES)('real pipeline chain, authz mode %s: the administrator (audit.log.read + audit.log.export)', (mode) => {
  it.each(OPS)('$op answers 2xx, not 500 common.internal, and the body validates against the contract', async (row) => {
    const c = makeAuditChain({ authzMode: mode });
    const r = await c.run(row, 'admin');
    expect(okStatus(row)).toContain(r.status);
    expect(violations(row.op, r.status, r.body)).toEqual([]);
  });

  it.each(OPS)('$op asserts its x-permission exactly once per request (enforce) / at most twice, never zero (shadow: stage 8a logs, the handler decides)', async (row) => {
    const c = makeAuditChain({ authzMode: mode });
    await c.run(row, 'admin');
    const n = c.asserted.filter((p) => p === row.perm).length;
    // ruling T0B-ADMINFIX-1: stage 8a asserts in both modes and the handler asserts too, so 1..2 in both modes.
    expect(n, `assertRole calls for ${row.perm}: ${JSON.stringify(c.asserted)}`).toBeGreaterThanOrEqual(1);
    expect(n, `assertRole calls for ${row.perm}: ${JSON.stringify(c.asserted)}`).toBeLessThanOrEqual(2);
  });

  it('the viewer operations ask for no other permission than audit.log.read; the export ones only add the P-10 audit.log.read widening check', async () => {
    for (const row of OPS) {
      const c = makeAuditChain({ authzMode: mode });
      await c.run(row, 'admin');
      const extra = [...new Set(c.asserted)].filter((p) => p !== row.perm);
      const allowed = ['listAuditExports', 'getAuditExport'].includes(row.op) ? ['audit.log.read'] : [];
      expect(extra, row.op).toEqual(extra.filter((p) => allowed.includes(p)));
    }
  });

  it('listAuditExports as the administrator returns the tenant\'s exports (P-10 widening still works) and getAuditExport finds one by id', async () => {
    const c = makeAuditChain({ authzMode: mode });
    const list = await c.run(OPS.find((o) => o.op === 'listAuditExports')!, 'admin');
    expect((list.body as any).data.map((d: any) => d.export_id)).toContain(EXPORT_ID);
    const one = await c.run(OPS.find((o) => o.op === 'getAuditExport')!, 'admin');
    expect((one.body as any).export_id).toBe(EXPORT_ID);
  });

  it('createAuditExport stores one export row and its access-log row (the write path is not skipped by the fix)', async () => {
    const c = makeAuditChain({ authzMode: mode });
    const before = c.exports.length;
    const r = await c.run(OPS.find((o) => o.op === 'createAuditExport')!, 'admin');
    expect(okStatus(OPS.find((o) => o.op === 'createAuditExport')!)).toContain(r.status);
    expect(c.exports.length).toBe(before + 1);
    expect(c.env.accessWrites.filter((w) => w.action === 'data.export')).toHaveLength(1);
  });
});

describe.each(MODES)('real pipeline chain, authz mode %s: nobody gets in without the permission (no widening)', (mode) => {
  const DENIED: Array<[OpRow, Persona]> = [
    ...VIEW.flatMap((o) => (['exporter', 'nobody'] as Persona[]).map((p): [OpRow, Persona] => [o, p])),
    ...EXPORT.flatMap((o) => (['reader', 'nobody'] as Persona[]).map((p): [OpRow, Persona] => [o, p])),
  ];
  it.each(DENIED.map(([o, p]) => [o.op, p, o] as const))('%s as %s: auth.forbidden (403), nothing read, nothing written', async (_op, who, row) => {
    const c = makeAuditChain({ authzMode: mode });
    const e = await fail(c.run(row, who));
    expect(e?.code).toBe('auth.forbidden');
    expect(e?.statusCode).toBe(403);
    expect(c.env.stmts.filter((s) => /audit\.audit_log|audit\.access_log|identity\.auth_events/i.test(s.text) && !/^\s*insert/i.test(s.text))).toHaveLength(0);
    expect(c.env.accessWrites.filter((w) => w.action === 'data.export' || w.action === 'audit_entry.view')).toHaveLength(0);
    expect(c.rig.find(/identity\.audit_exports/i), 'no export statement runs before the denial').toHaveLength(0);
  });

  it('createAuditExport denied: no export row is stored', async () => {
    const c = makeAuditChain({ authzMode: mode });
    const before = c.exports.length;
    expect((await fail(c.run(OPS.find((o) => o.op === 'createAuditExport')!, 'reader')))?.code).toBe('auth.forbidden');
    expect(c.exports.length).toBe(before);
  });

  it('P-10: the audit.log.export holder without audit.log.read lists only OWN exports (200, empty) and cannot read another member\'s export (404)', async () => {
    const c = makeAuditChain({ authzMode: mode });
    const list = await c.run(OPS.find((o) => o.op === 'listAuditExports')!, 'exporter');
    expect(list.status).toBe(200);
    expect((list.body as any).data).toEqual([]);
    const e = await fail(c.run(OPS.find((o) => o.op === 'getAuditExport')!, 'exporter'));
    expect(e?.code).toBe('common.not_found');
  });
});
