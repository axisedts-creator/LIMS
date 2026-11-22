// T0D-FIX-2 (LD-446, CR DEPLOY-AXIS-012 item 3, done_when 4): GET listPartyDiscountSlabs, listUserDiscountLimits and listDiscountAuthorities with limit=200
// (what the web always sends) pass the contract validator. They failed with 400 "querystring must NOT have additional properties" because the YAML
// aliases (*a1, *a2) lost Cursor and Limit when the spec was loaded. The probe mounts the real billing.yaml through core/module.ts loadSpec and
// fastify-openapi-glue with the API's own ajv (core/openapi.ts schemaController) and the same O2 rule (unknown query parameter -> 400).
// Handler stubs answer 200; the pipeline (auth, permissions, db) is not part of this probe, only the request validation.
import { join } from 'node:path';
import Fastify from 'fastify';
import openapiGlue from 'fastify-openapi-glue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schemaController } from '../../../../core/openapi.js';
import { loadSpec, REPO_ROOT } from '../../../../core/module.js';

const PATH: Record<string, string> = {
  listPartyDiscountSlabs: '/v1/billing/party-discount-slabs',
  listUserDiscountLimits: '/v1/billing/user-discount-limits',
  listDiscountAuthorities: '/v1/billing/discount-authorities',
};
const IDS = Object.keys(PATH);
const seen: Record<string, any> = {};
const app = Fastify({ schemaController });

beforeAll(async () => {
  const spec: any = structuredClone(loadSpec(join(REPO_ROOT, 'contracts/openapi/billing.yaml')));
  delete spec.security;
  const paths: Record<string, string> = {};
  for (const [p, item] of Object.entries<any>(spec.paths)) for (const op of Object.values<any>(item)) {
    if (op?.operationId) { delete op.security; paths[op.operationId] = p; }
  }
  for (const id of IDS) expect(paths[id], `${id} is in billing.yaml`).toBeDefined();
  app.setSerializerCompiler(() => (d) => JSON.stringify(d));
  app.addHook('onRoute', (route) => { // O2 of core/openapi.ts installRouteHooks: unknown query parameters answer 400
    const s = route.schema as any;
    if (!s?.operationId) return;
    if (s.querystring && typeof s.querystring === 'object') s.querystring.additionalProperties = false;
    else s.querystring = { type: 'object', properties: {}, additionalProperties: false };
  });
  await app.register(openapiGlue, {
    specification: spec,
    operationResolver: (operationId: string) => async (req: any, reply: any) => { seen[operationId] = req.query; return reply.code(200).send({ ok: true }); },
  });
  await app.ready();
  // the URL of each operation comes from the spec itself (no hand-written route)
  for (const id of IDS) PATH[id] = paths[id]!.replace(/\{[^}]+\}/g, '00000000-0000-7000-8000-000000000000');
});
afterAll(async () => { await app.close(); });

const get = (id: string, qs: string) => app.inject({ method: 'GET', url: `${PATH[id]}${qs}` });

describe('T0D-FIX-2: the three billing list operations accept limit and cursor (CR item 3)', () => {
  it.each(IDS)('%s: limit=200 passes validation and reaches the handler as the number 200', async (id) => {
    const r = await get(id, '?limit=200');
    expect(r.statusCode, `${id} -> ${r.body}`).toBe(200);
    expect(seen[id]?.limit).toBe(200);
  });
  it.each(IDS)('%s: limit=200 with a cursor passes', async (id) => {
    const r = await get(id, '?limit=200&cursor=abc_DEF-123');
    expect(r.statusCode, `${id} -> ${r.body}`).toBe(200);
    expect(seen[id]?.cursor).toBe('abc_DEF-123');
  });
  it.each(IDS)('%s: no limit takes the contract default 50', async (id) => {
    const r = await get(id, '');
    expect(r.statusCode, `${id} -> ${r.body}`).toBe(200);
    expect(seen[id]?.limit).toBe(50);
  });
  it.each(IDS)('%s: the contract bounds still hold (limit 201 and limit 0 answer 400, an unknown query parameter answers 400)', async (id) => {
    expect((await get(id, '?limit=201')).statusCode, `${id} limit=201`).toBe(400);
    expect((await get(id, '?limit=0')).statusCode, `${id} limit=0`).toBe(400);
    expect((await get(id, '?no_such_param=1')).statusCode, `${id} unknown param`).toBe(400);
  });
  it.each(IDS)('%s: a malformed cursor answers 400 (injection characters are not accepted)', async (id) => {
    expect((await get(id, `?cursor=${encodeURIComponent("a'; drop table x;--")}`)).statusCode, id).toBe(400);
  });
});
