// T-19 (C3) — `quotePrices` (#82) HTTP contract: the handler is real (no longer a CR-C3-008 stub) and its answers validate against catalog.yaml PriceQuotes.
// Spec: 06-PLAN T-19; 02-TRD §5 row 82 (POST /v1/catalog/prices/quote, catalog.price_list.read, no If-Match, no Idempotency-Key: read-only POST), §6.2; 07-SECURITY REQ-SEC-046, S-4, S-5, AB-10.
// Same harness conventions as surchargeTax.handlers.test.ts (T-18): handler driven with a request-shaped object + the HandlerContext subset from the composite fake (helpers/quoteDb.ts).
// Handler status: 200 for any well-formed request (per-item errors are in the body); body validation / auth / x-permission are the core pipeline's and are only DECLARED here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { READ, TENANT_A, actorIdentity, defaultList, dept, makeQuoteDb, orderable, pitem, pver, srule, trule } from '../helpers/quoteDb.js';

const T = 20_000;
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ } });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const at = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const A = TENANT_A;

const D1 = dept(1, A); const O1 = orderable(1, A, { code: 'CBC', department_id: D1.id }); const O2 = orderable(2, A, { code: 'FBS', department_id: D1.id });
const DEF = defaultList(1, A); const V1 = pver(1, A, DEF.id as string, 1, { status: 'published' });
const mk = () => makeQuoteDb({ rows: {
  departments: [D1], orderables: [O1, O2], price_lists: [DEF], price_list_versions: [V1], price_list_items: [pitem(1, A, V1.id as string, O1.id as string, 90_000)],
  tax_rules: [trule(1, A)], surcharge_rules: [srule(1, A, { scope: 'department', department_id: D1.id, amount_kind: 'percent', amount_paisa: null, percent_bp: 5_000 })],
} as never });
const call = (db: ReturnType<typeof mk>, r: ReturnType<typeof req>, perms: readonly string[] = [READ]) =>
  db.run((ctx) => H['quotePrices']!(r, ctx), { at, ctx: { ports: { IdentityPort: actorIdentity(perms) } } });

describe('quotePrices in the contract and the manifest (S-4)', () => {
  it('operationId exists; the manifest serves the real handler (not the stub)', () => {
    expect(operationIds(spec)).toContain('quotePrices');
    expect(typeof (manifest.handlers as any)['quotePrices']).toBe('function');
    expect((manifest.handlers as any)['quotePrices']).toBe(H['quotePrices']);
  });
  it('POST /v1/catalog/prices/quote: catalog.price_list.read, no idempotency, no If-Match, closed request schema without any price / tenant field (REQ-SEC-046, S-5)', () => {
    const op = opOf('quotePrices');
    expect(op['x-permission']).toBe('catalog.price_list.read');
    expect(op['x-idempotency']).toBe('none');
    expect(JSON.stringify(op.parameters ?? [])).not.toContain('IfMatch');
    const s = spec.components.schemas;
    expect(s['PriceQuoteRequest'].additionalProperties).toBe(false);
    expect(s['PriceQuoteRequest'].properties.items.maxItems).toBe(50);
    expect(s['PriceQuoteRequest'].properties.items.minItems).toBe(1);
    expect(Object.keys(s['PriceQuoteRequest'].properties.items.items.properties).sort()).toEqual(['orderable_id', 'priority']);
    expect(Object.keys(s['PriceQuoteRequest'].properties.context.properties).sort()).toEqual(['centre_id', 'credit_party_id', 'price_list_id', 'referrer_id']);
    for (const k of ['tenant_id', 'unit_price', 'status', 'revision', 'created_by']) expect(Object.keys(s['PriceQuoteRequest'].properties), k).not.toContain(k);
  });
});

describe('probes (CR-C3-008): the quotePrices stub is gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('quotePrices is no longer listed in probes/pending.json', () => {
    expect(pending).not.toContain('quotePrices');
  });
  it('does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async () => {
    const e = await call(mk(), req({ body: { items: [{ orderable_id: O1.id, priority: 'routine' }], context: {} } })).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('POST /v1/catalog/prices/quote — handler over the service, validated against the OpenAPI schemas', () => {
  const quotesOk = validatorFor('PriceQuotes');
  it('200 PriceQuotes: a priced urgent item with surcharge + tax, and per-item errors, all schema-valid', { timeout: T }, async () => {
    const db = mk();
    const r = await call(db, req({ body: { items: [{ orderable_id: O1.id, priority: 'urgent' }, { orderable_id: O2.id, priority: 'routine' }], context: {} } }));
    expect(r.status).toBe(200);
    expect(quotesOk(r.body)).toEqual([]);
    expect(r.body.quotes[0]).toEqual({ orderable_id: O1.id, price_list_id: DEF.id, price_list_version: 1, source: 'tenant_default', unit_price: { amount_paisa: 90_000, currency: 'NPR' }, urgent_surcharge: { amount_paisa: 45_000, currency: 'NPR' }, tax: { vat: 'exempt' } });
    expect(r.body.quotes[1]).toEqual({ orderable_id: O2.id, error_code: 'catalog.no_price' });
    expect(db.writes).toEqual([]);
  });
  it('`at` in the body is honoured (before the list existed -> no_price) and the schema still holds', { timeout: T }, async () => {
    const r = await call(mk(), req({ body: { items: [{ orderable_id: O1.id, priority: 'routine' }], context: {}, at: '2025-01-01T00:00:00.000Z' } }));
    expect(r.status).toBe(200); expect(quotesOk(r.body)).toEqual([]);
    expect(r.body.quotes).toEqual([{ orderable_id: O1.id, error_code: 'catalog.no_price' }]);
  });
  it('an unknown explicit list -> 404 common.not_found; a body with a client price -> 400 (AB-10)', { timeout: T }, async () => {
    const nf = await rejection(call(mk(), req({ body: { items: [{ orderable_id: O1.id, priority: 'routine' }], context: { price_list_id: '0190c300-0000-7000-8000-0000000ffff9' } } })));
    expect(isLimsError(nf, 'common.not_found')).toBe(true); expect(nf.statusCode).toBe(404);
    const bad = await rejection(call(mk(), req({ body: { items: [{ orderable_id: O1.id, priority: 'routine', unit_price: { amount_paisa: 1, currency: 'NPR' } }], context: {} } })));
    expect(isLimsError(bad)).toBe(true); expect(bad.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(bad.code);
  });
  it('fails closed without an authenticated request context (no tenant / actor / tx)', { timeout: T }, async () => {
    const e = await rejection(H['quotePrices']!(req({ body: { items: [{ orderable_id: O1.id, priority: 'routine' }], context: {} } }), { operationId: 'quotePrices', log: { info() {}, warn() {}, error() {} } }));
    expect(isLimsError(e, 'auth.unauthenticated')).toBe(true);
  });
});
