// SEC-AUTHZ-2 (LD-261, LD-277; CR .orchestra/cr/SEC-AUTHZ-1.1.nonblocking.md; C0 02-TRD 6.2 stage 8a + 9; 07-SECURITY AB-5):
// central authorization stage 8a, after stage 7 and before the handler, for every operation that is not x-public and not bffSession.
//
// INTERFACE THE TESTS PIN (the spec fixes behaviour, not names; the writer may dispute a name in .orchestra/notes/SEC-AUTHZ-2-dispute-*.md):
//   core/pipeline/index.ts   PipelineOp gains   permission?: string   (the contract x-permission)
//                                               scheme?: string       (first security scheme of the operation: bearerJwt | bffSession | deviceToken | ...)
//                            PipelineDeps gains authzMode?: 'shadow' | 'enforce'                    (absent = shadow, LD-261 DEFAULT MODE)
//                                               systemPermissions?: Readonly<Record<module, readonly string[]>>   (manifest systemPermissions)
//                                               authzExceptions?: readonly { operationId; handlerPermission; reason }[]
//   core/pipeline/authz-central.ts  export validateAuthzExceptions(entries: unknown, operationIds: ReadonlySet<string>): void  (throws on a bad entry)
//   device actors: the verified claim `credential_permission` is the credential's own permission.
//   log: { event: 'authz_central_deny', operation_id, actor_type, permission, mode }; metric lims_core_authz_central_deny_total{operation_id}.
// The central stage calls assertRole through the request guard wrapper (RequestAuthz.identity(port)), so stage 9 records it.
import { describe, expect, it } from 'vitest';
import { DEVICE, denies, notAsserted, rejects, rig, staffOp, SUB, TENANT_A, user } from './authz-central-rig.js';

const PERM = 'frontdesk.order.create';

describe('stage 8a: enforce, user actor', () => {
  it('user WITHOUT the permission: auth.forbidden, handler and repository never called, assertRole asked for exactly the x-permission', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: ['frontdesk.order.read'] } });
    const e = await rejects(r.run());
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
    expect(r.asserted).toEqual([{ permission: PERM }]);
  });

  it('deny is logged as authz_central_deny with operation_id, actor_type, permission, mode; metric counted with operation_id only', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    await rejects(r.run());
    const l = denies(r);
    expect(l).toHaveLength(1);
    expect(l[0]!.obj).toMatchObject({ event: 'authz_central_deny', operation_id: 'createThing', actor_type: 'user', permission: PERM, mode: 'enforce' });
    expect(r.incs).toContainEqual(['lims_core_authz_central_deny_total', { operation_id: 'createThing' }]);
  });

  it('no token, email, person id or tenant id in the deny log line or the metric labels', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    expect((await rejects(r.run())).code).toBe('auth.forbidden');
    expect(denies(r)).toHaveLength(1);
    const text =JSON.stringify([denies(r).map((c) => c.obj), r.incs.filter(([n]) => n === 'lims_core_authz_central_deny_total')]);
    expect(text).not.toContain(SUB);
    expect(text).not.toContain(TENANT_A);
    expect(text).not.toMatch(/@|bearer|eyJ/i);
  });

  it('user with exactly the permission reaches the handler; nothing logged or counted', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [PERM] } });
    const res = await r.run();
    expect(res.status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
    expect(denies(r)).toEqual([]);
    expect(r.incs.filter(([n]) => n === 'lims_core_authz_central_deny_total')).toEqual([]);
  });

  it('mfa_pending session: auth.mfa_required before the handler; password_setup: auth.forbidden', async () => {
    const a = rig({ mode: 'enforce', profile: { permissions: [PERM], state: 'mfa_pending' } });
    expect((await rejects(a.run())).code).toBe('auth.mfa_required');
    expect(a.handlerCalls).toEqual([]);
    const b = rig({ mode: 'enforce', profile: { permissions: [PERM], state: 'password_setup' } });
    expect((await rejects(b.run())).code).toBe('auth.forbidden');
    expect(b.handlerCalls).toEqual([]);
  });

  it('identity.support_session_required from assertRole passes through unchanged (no new error code)', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [PERM], state: 'support_missing' } });
    expect((await rejects(r.run())).code).toBe('identity.support_session_required');
    expect(r.handlerCalls).toEqual([]);
  });

  it('assertRole is called without centre or branch (baseline check)', async () => {
    const seen: any[] = [];
    const r = rig({ mode: 'enforce', profile: { permissions: [PERM] } });
    const orig = r.asserted.push.bind(r.asserted);
    r.asserted.push = ((...a: any[]) => { seen.push(...a); return orig(...a); }) as any;
    await r.run();
    expect(Object.keys(seen[0])).toEqual(['permission']);
  });

  it('a denied request rolls back and leaves no committed work', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    expect((await rejects(r.run())).code).toBe('auth.forbidden');
    const last =[...r.fake.texts()].reverse().find((t) => /^(COMMIT|ROLLBACK)$/i.test(t));
    expect(last?.toUpperCase()).toBe('ROLLBACK');
  });
});

describe('stage 8a: shadow (and the default)', () => {
  it.each(['shadow', 'unset'] as const)('mode %s: user without the permission is NOT blocked, authz_central_deny logged with mode shadow, metric counted', async (mode) => {
    const r = rig({ mode, profile: { permissions: [] } });
    const res = await r.run();
    expect(res.status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
    const l = denies(r);
    expect(l).toHaveLength(1);
    expect(l[0]!.obj).toMatchObject({ operation_id: 'createThing', actor_type: 'user', permission: PERM, mode: 'shadow' });
    expect(r.incs).toContainEqual(['lims_core_authz_central_deny_total', { operation_id: 'createThing' }]);
  });

  it('shadow: user with the permission reaches the handler and nothing is logged', async () => {
    const r = rig({ mode: 'shadow', profile: { permissions: [PERM] } });
    expect((await r.run()).status).toBe(200);
    expect(denies(r)).toEqual([]);
  });

  it('shadow: mfa_pending and password_setup are logged, never blocked', async () => {
    const a = rig({ mode: 'shadow', profile: { permissions: [PERM], state: 'mfa_pending' } });
    expect((await a.run()).status).toBe(200);
    expect(denies(a)).toHaveLength(1);
    const b = rig({ mode: 'shadow', profile: { permissions: [PERM], state: 'password_setup' } });
    expect((await b.run()).status).toBe(200);
    expect(denies(b)).toHaveLength(1);
  });

  it('the default mode is shadow in EVERY environment, production included (LD-261)', async () => {
    for (const env of ['dev', 'ci', 'staging', 'production']) {
      const r = rig({ env, mode: 'unset', profile: { permissions: [] } });
      expect((await r.run()).status, env).toBe(200);
      expect(denies(r), env).toHaveLength(1);
    }
  });
});

describe('stage 8a: operations that are skipped', () => {
  it('x-public operation: no central check', async () => {
    const r = rig({ mode: 'enforce' });
    const res = await r.run({ op: staffOp({ public: true, permission: undefined, scheme: undefined, context: undefined }), claims: undefined });
    expect(res.status).toBe(200);
    expect(r.asserted).toEqual([]);
    expect(denies(r)).toEqual([]);
  });

  it('bffSession operation (identity session flow): no central check', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] }, handler: undefined });
    const res = await r.run({ op: staffOp({ module: 'identity', operationId: 'resolveSession', scheme: 'bffSession', permission: undefined }), claims: user, handler: async () => ({ status: 200, body: {} }) });
    expect(res.status).toBe(200);
    expect(r.asserted).toEqual([]);
    expect(denies(r)).toEqual([]);
  });

  it('platform.* operation is skipped with a documented reason (SEC-AUTHZ-3): no assertRole, no deny, even in enforce', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    const platformClaims = { sub: SUB, actor_type: 'user', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' } as any;
    const res = await r.run({
      op: staffOp({ module: 'identity', operationId: 'listTenants', permission: 'platform.tenant.read', context: 'platform' }),
      claims: platformClaims,
      handler: async () => ({ status: 200, body: {} }),
    }).catch((e: any) => e);
    // the central stage must not have asked IdentityPort (assertRole rejects platform.*); stage 9 (LD-271) still applies to the handler result
    expect(r.asserted).toEqual([]);
    expect(denies(r)).toEqual([]);
    expect(res?.code === 'common.internal' || res?.status === 200).toBe(true);
  });

  it('a non-public operation with no permission is never asserted with undefined (assertRole would answer unknown_permission)', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    await r.run({ op: staffOp({ permission: undefined }) }).catch(() => undefined);
    expect(r.asserted.every((a) => typeof a.permission === 'string' && a.permission.length > 0)).toBe(true);
  });
});

describe('stage 8a: other actor kinds', () => {
  it.each(['patient', 'partner', 'portal'] as const)('%s actor on a bearerJwt staff operation: auth.forbidden before the handler (enforce)', async (actor_type) => {
    const r = rig({ mode: 'enforce', profile: { permissions: [PERM] } });
    const e = await rejects(r.run({ claims: { sub: SUB, tenant_id: TENANT_A, actor_type } }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
    expect(r.repoCalls).toEqual([]);
    expect(denies(r)[0]!.obj).toMatchObject({ actor_type, mode: 'enforce', permission: PERM });
  });

  it.each(['patient', 'partner', 'portal'] as const)('%s actor in shadow: logged, not blocked', async (actor_type) => {
    const r = rig({ mode: 'shadow' });
    const res = await r.run({ claims: { sub: SUB, tenant_id: TENANT_A, actor_type } });
    expect(res.status).toBe(200);
    expect(denies(r)).toHaveLength(1);
    expect(denies(r)[0]!.obj).toMatchObject({ actor_type, mode: 'shadow' });
  });

  it('system actor: permission in the module manifest systemPermissions reaches the handler', async () => {
    const r = rig({ mode: 'enforce', system: { frontdesk: [PERM] } });
    const res = await r.run({ claims: { sub: SUB, tenant_id: TENANT_A, actor_type: 'system' } });
    expect(res.status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
    expect(r.asserted).toEqual([]); // system actors are decided from the manifest, not from IdentityPort
  });

  it('system actor: permission NOT in systemPermissions (or no manifest entry) is denied before the handler', async () => {
    for (const system of [{ frontdesk: ['frontdesk.order.read'] }, {}] as Array<Record<string, string[]>>) {
      const r = rig({ mode: 'enforce', system });
      const e = await rejects(r.run({ claims: { sub: SUB, tenant_id: TENANT_A, actor_type: 'system' } }));
      expect(e.code).toBe('auth.forbidden');
      expect(r.handlerCalls).toEqual([]);
      expect(denies(r)[0]!.obj).toMatchObject({ actor_type: 'system', permission: PERM });
    }
  });

  it('system actor: another module\'s systemPermissions do not count', async () => {
    const r = rig({ mode: 'enforce', system: { billing: [PERM] } });
    expect((await rejects(r.run({ claims: { sub: SUB, tenant_id: TENANT_A, actor_type: 'system' } }))).code).toBe('auth.forbidden');
  });

  it('device actor: the credential\'s own permission equal to the x-permission reaches the handler', async () => {
    const r = rig({ mode: 'enforce' });
    const res = await r.run({
      op: staffOp({ module: 'instruments', operationId: 'ingestResult', scheme: 'deviceToken', permission: 'instruments.result.ingest' }),
      claims: { sub: DEVICE, tenant_id: TENANT_A, actor_type: 'device', credential_permission: 'instruments.result.ingest' },
    });
    expect(res.status).toBe(200);
    expect(r.handlerCalls).toEqual(['handler']);
  });

  it('device actor: a credential with another permission, or none, is denied before the handler', async () => {
    for (const extra of [{ credential_permission: 'instruments.result.read' }, {}]) {
      const r = rig({ mode: 'enforce' });
      const e = await rejects(r.run({
        op: staffOp({ module: 'instruments', operationId: 'ingestResult', scheme: 'deviceToken', permission: 'instruments.result.ingest' }),
        claims: { sub: DEVICE, tenant_id: TENANT_A, actor_type: 'device', ...extra },
      }));
      expect(e.code).toBe('auth.forbidden');
      expect(r.handlerCalls).toEqual([]);
    }
  });

  it('a stray credential_permission claim on a USER actor never grants anything', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [] } });
    const e = await rejects(r.run({ claims: { ...user, credential_permission: PERM } }));
    expect(e.code).toBe('auth.forbidden');
  });
});

describe('stage 8a: exception file entries (handler deliberately checks another permission)', () => {
  const exceptions = [{ operationId: 'createThing', handlerPermission: 'frontdesk.order.manage', reason: 'handler needs the manage code for this read path' }];

  it('a listed operation is asserted with handlerPermission, not x-permission', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: ['frontdesk.order.manage'] }, exceptions });
    const res = await r.run();
    expect(res.status).toBe(200);
    expect(r.asserted[0]).toEqual({ permission: 'frontdesk.order.manage' });
  });

  it('a listed operation: user holding only x-permission is denied (no silent allow)', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: [PERM] }, exceptions });
    expect((await rejects(r.run())).code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
  });

  it('an operation that is NOT listed is checked against its x-permission even if another operation is listed', async () => {
    const r = rig({ mode: 'enforce', profile: { permissions: ['frontdesk.order.manage'] }, exceptions: [{ ...exceptions[0], operationId: 'otherOp' }] });
    expect((await rejects(r.run())).code).toBe('auth.forbidden');
  });
});

describe('stage 9 interaction (LD-277): the central stage asserts through the request guard wrapper', () => {
  it('staging, handler never calls assertRole, user WITH the permission: 2xx and no authz_not_asserted (shadow and enforce)', async () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      const r = rig({ env: 'staging', mode, profile: { permissions: [PERM] } });
      const res = await r.run();
      expect(res.status, mode).toBe(200);
      expect(notAsserted(r), mode).toEqual([]);
      expect(r.incs.filter(([n]) => n === 'lims_core_authz_not_asserted_total'), mode).toEqual([]);
    }
  });

  it('staging shadow, user WITHOUT the permission: not blocked, authz_central_deny logged, 2xx, NO authz_not_asserted', async () => {
    const r = rig({ env: 'staging', mode: 'shadow', profile: { permissions: [] } });
    const res = await r.run();
    expect(res.status).toBe(200);
    expect(denies(r)).toHaveLength(1);
    expect(notAsserted(r)).toEqual([]);
  });

  it('staging enforce, user WITHOUT the permission: denied before the handler (auth.forbidden, not common.internal)', async () => {
    const r = rig({ env: 'staging', mode: 'enforce', profile: { permissions: [] } });
    const e = await rejects(r.run());
    expect(e.code).toBe('auth.forbidden');
    expect(r.handlerCalls).toEqual([]);
  });

  it.each(['dev', 'ci', 'staging', 'production'])('%s shadow: a checked operation never produces authz_not_asserted', async (env) => {
    const r = rig({ env, mode: 'shadow', profile: { permissions: [] } });
    await r.run();
    expect(notAsserted(r)).toEqual([]);
  });

  it('a SKIPPED operation (platform.*) still gets the stage 9 500 on staging when the handler asserts nothing', async () => {
    const r = rig({ env: 'staging', mode: 'enforce' });
    const platformClaims = { sub: SUB, actor_type: 'user', scope: 'platform', platform_role: 'platform_superadmin', aal: 'aal2' } as any;
    const e = await rejects(r.run({ op: staffOp({ module: 'identity', operationId: 'listTenants', permission: 'platform.tenant.read', context: 'platform' }), claims: platformClaims, handler: async () => ({ status: 200, body: {} }) }));
    expect(e.code).toBe('common.internal');
    expect(notAsserted(r)).toHaveLength(1);
  });

  it('an exception-listed operation keeps the stage 9 behaviour: handler that asserts nothing -> 500 on staging', async () => {
    const r = rig({ env: 'staging', mode: 'enforce', profile: { permissions: ['frontdesk.order.manage'] }, exceptions: [{ operationId: 'createThing', handlerPermission: 'frontdesk.order.manage', reason: 'handler checks the manage code' }] });
    const e = await rejects(r.run());
    expect(e.code).toBe('common.internal');
    expect(notAsserted(r)).toHaveLength(1);
  });

  it('x-public operation on staging: unchanged, no assertion needed', async () => {
    const r = rig({ env: 'staging', mode: 'enforce' });
    const res = await r.run({ op: staffOp({ public: true, permission: undefined, scheme: undefined, context: undefined }), claims: undefined });
    expect(res.status).toBe(200);
    expect(notAsserted(r)).toEqual([]);
  });
});

describe('stage 8a: ordering and failure of the dependency', () => {
  it('runs after stage 7 (inside the request transaction) and before the handler', async () => {
    const order: string[] = [];
    const r = rig({ mode: 'enforce', profile: { permissions: [PERM] } });
    const res = await r.run({ handler: async (_q: any, ctx: any) => { order.push(`handler:tx=${ctx.tx ? 'yes' : 'no'}`); return { status: 200, body: {} }; } });
    expect(res.status).toBe(200);
    expect(order).toEqual(['handler:tx=yes']);
    expect(r.asserted).toEqual([{ permission: PERM }]); // asserted exactly once, already when the handler ran
  });

  it('IdentityPort.assertRole failing with a non-auth error in enforce: handler not called, error propagates (fail closed)', async () => {
    const boom = Object.assign(new Error('db down'), { code: 'common.dependency_unavailable', statusCode: 503 });
    const r = rig({ mode: 'enforce' });
    r.state.profile = new Proxy({ permissions: [] }, { get() { throw boom; } }) as any;
    const e = await rejects(r.run());
    expect(e.code).toBe('common.dependency_unavailable');
    expect(r.handlerCalls).toEqual([]);
  });
});
