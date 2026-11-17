// FD-T05 static/contract checks (no database). Files per 06-IMPLEMENTATION-PLAN row FD-T05; contract per contracts/openapi/frontdesk.yaml F8.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const op = (): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === 'quoteRegistration') return m; };

describe('FD-T05 files and wiring', () => {
  it('the two files of the plan row exist', () => {
    expect(existsSync(join(REPO_ROOT, F, 'service/registration.service.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, F, 'handlers/quoteRegistration.ts'))).toBe(true);
  });
  it('registration.service.ts exports quote()', async () => {
    const m = await import('../../service/registration.service.js');
    expect(m.quote).toBeTypeOf('function');
  });
  it('handlers/quoteRegistration.ts exports `handler` (like the FD-T04 handlers) and index.ts wires it as the real quoteRegistration', async () => {
    const m = await import('../../handlers/quoteRegistration.js');
    expect(m.handler).toBeTypeOf('function');
    const idx = await import('../../handlers/index.js');
    expect((idx.handlers as any).quoteRegistration).toBe(m.handler);
  });
  it('the handler is thin: it delegates to the service and does not import repositories or ports directly', () => {
    const src = text(`${F}/handlers/quoteRegistration.ts`);
    expect(src).toMatch(/registration\.service/);
    expect(src).not.toMatch(/repository\//);
  });
  it('implementation never writes: no INSERT/UPDATE/DELETE and no audit/event call in the quote path', () => {
    const src = text(`${F}/service/registration.service.ts`);
    const q = src.slice(src.search(/export (async )?function quote\b|export const quote\b/));
    expect(q.length).toBeGreaterThan(100);
    expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(q).not.toMatch(/events?\.publish|audit\.access/);
  });
});

describe('F8 contract (REQ-SEC-046: prices are server-side)', () => {
  it('operation: POST /v1/frontdesk/registrations/quote, frontdesk.registration.create, no idempotency key, RegistrationDraft -> Quote', () => {
    const o = op();
    expect(o['x-permission']).toBe('frontdesk.registration.create');
    expect(o['x-idempotency']).toBe('none');
    expect(o.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/RegistrationDraft');
    expect(o.responses['200'].content['application/json'].schema.$ref).toBe('#/components/schemas/Quote');
    expect(spec.paths['/v1/frontdesk/registrations/quote'].post).toBe(o);
  });
  it('the request carries no price, total, fingerprint or price list anywhere (draft, items, discounts)', () => {
    const s = spec.components.schemas;
    const keys = (n: string) => Object.keys(s[n].properties);
    for (const n of ['RegistrationDraft', 'RegistrationItem', 'Discount']) {
      expect(s[n].additionalProperties, n).toBe(false);
      expect(keys(n).filter((k) => /price|total|net|fingerprint|tax|vat/i.test(k)), n).toEqual([]);
    }
  });
  it('Quote requires both fingerprints (64 hex), the discount evaluation and the totals', () => {
    const q = spec.components.schemas.Quote;
    for (const k of ['quote_fingerprint', 'base_fingerprint', 'discount_evaluation', 'totals', 'lines', 'catalog_revision', 'fiscal_year_bs']) expect(q.required).toContain(k);
    expect(spec.components.schemas.Fingerprint.pattern).toBe('^[0-9a-f]{64}$');
  });
});
