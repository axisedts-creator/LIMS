// patientPreAuth security handler (core/openapi.ts securityHandlers): the credential comes from the scheme's own header, runs through
// CoreAuth.preAuth.authenticate, and the returned claims reach the pipeline. Everything else fails closed with auth.unauthenticated.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from '../auth/errors.js';
import { genReqId, installErrorHandlers, sendProblem } from '../errors.js';
import { installRouteHooks, mountSpec, schemaController, type CoreAuth } from '../openapi.js';

const SPEC = {
  openapi: '3.0.3', info: { title: 't', version: '1' },
  components: {
    securitySchemes: {
      patientPreAuth: { type: 'apiKey', in: 'header', name: 'X-Lims-Patient-PreAuth' },
      portalSession: { type: 'apiKey', in: 'header', name: 'X-Lims-Portal-Credential' },
    },
  },
  paths: {
    '/v1/engagement/app/config': {
      get: {
        operationId: 'getPatientAppConfig', security: [{ patientPreAuth: [] }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
      },
    },
    '/v1/reporting/portal': {
      get: {
        operationId: 'getPortal', security: [{ portalSession: [] }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } },
      },
    },
  },
};
const CLAIMS = { sub: '0190a000-0000-7000-8000-00000000c001', actor_type: 'patient', tenant_id: '0190a000-0000-7000-8000-00000000aaaa' };

const open: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

async function mk(moduleName: string, preAuth: CoreAuth['preAuth'] | undefined, spec: any = SPEC) {
  const app = Fastify({ schemaController, genReqId, frameworkErrors: (e, req, reply) => { sendProblem(e, req, reply); } });
  open.push(app);
  installErrorHandlers(app);
  const auth: CoreAuth = { bff: { verify: () => undefined } as any, clientIp: (() => '203.0.113.7') as any, ...(preAuth ? { preAuth } : {}) };
  installRouteHooks(app, { responseValidation: false, auth });
  const seen: any[] = [];
  const pipeline = { run: async (c: any) => { seen.push(c); return { status: 200, body: { claims: c.claims ?? null } }; } } as any;
  await mountSpec(app, moduleName, spec, { getPatientAppConfig: async () => ({ status: 200, body: {} }), getPortal: async () => ({ status: 200, body: {} }) }, auth, pipeline);
  await app.ready();
  return { app, seen };
}
const okAuth = (calls: any[] = []): NonNullable<CoreAuth['preAuth']> => ({
  schemes: new Set(['patientPreAuth']),
  authenticate: async (i) => { calls.push(i); return CLAIMS as any; },
});
const get = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers });
const code = (res: { body: string }) => JSON.parse(res.body).code;

describe('patientPreAuth security handler', () => {
  it('runs the resolver with the header credential and hands the claims to the pipeline', async () => {
    const calls: any[] = [];
    const { app, seen } = await mk('engagement', okAuth(calls));
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a', 'user-agent': 'vitest' });
    expect(res.statusCode).toBe(200);
    expect(seen[0].claims).toEqual(CLAIMS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      scheme: 'patientPreAuth', credential: 't.tenant_a', clientIp: '203.0.113.7', userAgent: 'vitest',
      operation: { module: 'engagement', operationId: 'getPatientAppConfig' },
    });
  });

  it('missing header -> 401 auth.unauthenticated, resolver never called', async () => {
    const calls: any[] = [];
    const { app } = await mk('engagement', okAuth(calls));
    const res = await get(app, '/v1/engagement/app/config');
    expect([res.statusCode, code(res)]).toEqual([401, 'auth.unauthenticated']);
    expect(calls).toHaveLength(0);
  });

  it('empty header -> 401', async () => {
    const calls: any[] = [];
    const { app } = await mk('engagement', okAuth(calls));
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': '' });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('resolver says unauthenticated -> 401, the handler never runs', async () => {
    const { app, seen } = await mk('engagement', { schemes: new Set(['patientPreAuth']), authenticate: async () => { throw new AuthError('auth.unauthenticated'); } });
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.nobody' });
    expect([res.statusCode, code(res)]).toEqual([401, 'auth.unauthenticated']);
    expect(seen).toHaveLength(0);
  });

  it('resolver blows up -> never a 200 and never claims', async () => {
    const { app, seen } = await mk('engagement', { schemes: new Set(['patientPreAuth']), authenticate: async () => { throw new Error('db down'); } });
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a' });
    expect(res.statusCode).toBeGreaterThanOrEqual(401);
    expect(seen).toHaveLength(0);
  });

  it('no preAuth configured (no database / not wired) -> fails closed 401', async () => {
    const { app, seen } = await mk('engagement', undefined);
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a' });
    expect(res.statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('a module that does not own the scheme cannot use it -> 401', async () => {
    const calls: any[] = [];
    const { app } = await mk('reporting', okAuth(calls));
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a' });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('schemes outside PRE_AUTH_SCHEMES stay fail-closed (portalSession): resolver not invoked', async () => {
    const calls: any[] = [];
    const { app } = await mk('reporting', { schemes: new Set(['patientPreAuth']), authenticate: async (i) => { calls.push(i); return CLAIMS as any; } });
    const res = await get(app, '/v1/reporting/portal', { 'x-lims-portal-credential': 'link.abc' });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('the credential is read from the header only (a cookie is ignored)', async () => {
    const calls: any[] = [];
    const { app } = await mk('engagement', okAuth(calls));
    const res = await app.inject({ method: 'GET', url: '/v1/engagement/app/config', headers: { cookie: 'x-lims-patient-preauth=t.tenant_a' } });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('real-world spec shape: no components.securitySchemes after bundling', () => {
  const { securitySchemes: _drop, ...componentsWithout } = SPEC.components;
  const BARE = { ...SPEC, components: componentsWithout };

  it('still authenticates through the reviewed header table', async () => {
    const calls: any[] = [];
    const { app, seen } = await mk('engagement', okAuth(calls), BARE);
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a' });
    expect(res.statusCode).toBe(200);
    expect(seen[0].claims).toEqual(CLAIMS);
    expect(calls[0]).toMatchObject({ scheme: 'patientPreAuth', credential: 't.tenant_a' });
  });

  it('missing header -> 401, resolver not called', async () => {
    const calls: any[] = [];
    const { app } = await mk('engagement', okAuth(calls), BARE);
    expect((await get(app, '/v1/engagement/app/config')).statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('a spec that declares the scheme differently (other header) stays fail-closed', async () => {
    const calls: any[] = [];
    const odd = { ...SPEC, components: { securitySchemes: { patientPreAuth: { type: 'apiKey', in: 'header', name: 'X-Other' } } } };
    const { app } = await mk('engagement', okAuth(calls), odd);
    const res = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a' });
    expect(res.statusCode).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('real contracts/openapi/engagement.yaml (bundled by loadSpec)', () => {
  it('patientPreAuth operations authenticate through the handler; the credential header is the contract header', async () => {
    const { loadSpec } = await import('../module.js');
    const { join } = await import('node:path');
    const real = loadSpec(join(import.meta.dirname, '../../../../../contracts/openapi/engagement.yaml'));
    const handlers: Record<string, any> = {};
    for (const item of Object.values<any>(real.paths)) for (const op of Object.values<any>(item)) if (op?.operationId) handlers[op.operationId] = async () => ({ status: 200, body: {} });
    const calls: any[] = [];
    const app = Fastify({ schemaController, genReqId, frameworkErrors: (e, req, reply) => { sendProblem(e, req, reply); } });
    open.push(app);
    installErrorHandlers(app);
    const auth: CoreAuth = { bff: { verify: () => undefined } as any, clientIp: (() => '203.0.113.7') as any, preAuth: okAuth(calls), verifier: { verify: async () => { throw new Error('unused'); } } as any };
    installRouteHooks(app, { responseValidation: false, auth });
    const seen: any[] = [];
    await mountSpec(app, 'engagement', real, handlers, auth, { run: async (c: any) => { seen.push(c); return { status: 200, body: {} }; } } as any);
    await app.ready();
    const ok = await get(app, '/v1/engagement/app/config', { 'x-lims-patient-preauth': 't.tenant_a', 'x-lims-app-version': '0.1.0', 'x-lims-app-platform': 'android' });
    expect(ok.statusCode).toBe(200);
    expect(seen[0].claims).toEqual(CLAIMS);
    expect(calls[0]).toMatchObject({ scheme: 'patientPreAuth', credential: 't.tenant_a', operation: { module: 'engagement', operationId: 'getPatientAppConfig' } });
    const none = await get(app, '/v1/engagement/app/config', { 'x-lims-app-version': '0.1.0', 'x-lims-app-platform': 'android' });
    expect(none.statusCode).toBe(401);
  });
});
