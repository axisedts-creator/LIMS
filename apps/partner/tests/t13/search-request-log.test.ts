// C13.T13 — US-07.8 / REQ-SEC-098: a patient-name search goes out as POST /v1/partners/orders/search with the term in the BODY; no PHI in any URL the BFF requests.
// Asserted on the BFF's outbound request log (every fetch the BFF makes: full URL incl. query string, method, headers, body). Uses the T05 harness (fake next/*, fetch fake for the API).
// NOTE: regression guard over the existing partnerApi (apps/partner/src/core/api.ts); the search screen / action itself is a later UI task and is not asserted here (no name is invented for it).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API, AUTH, json, reply, resetApi, resolved, restoreFetch, installFetch, seen, setEnv } from '../t05/harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => (await import('../t05/harness')).navigationMock);

const PHI_TERM = 'Synthetic Binita Test';
const urls: string[] = [];
let P: typeof import('../../src/core/api');
beforeAll(async () => {
  setEnv();
  installFetch();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { urls.push(new Request(input as never, init).url); return inner(input, init); }) as typeof fetch;
  P = await import('../../src/core/api');
});
afterAll(() => restoreFetch());
beforeEach(() => { resetApi(); urls.length = 0; reply[`${AUTH}/session/resolve`] = () => json(200, resolved('active')); });

describe('BFF request log: patient search (US-07.8)', () => {
  it('POST /v1/partners/orders/search carries q in the JSON body only: URL has no query string and no term (also not percent-encoded); headers carry no term', async () => {
    reply['/v1/partners/orders/search'] = () => json(200, { data: [] });
    const r = await P.partnerApi('/v1/partners/orders/search', { method: 'POST', body: { q: PHI_TERM, limit: 20 } });
    expect(r).toMatchObject({ ok: true, status: 200 });
    const call = seen.find((s) => s.path === '/v1/partners/orders/search')!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ q: PHI_TERM, limit: 20 });
    const wire = urls.filter((u) => u.startsWith(API));
    expect(wire.length).toBeGreaterThan(0);
    for (const u of wire) {
      expect(new URL(u).search, u).toBe('');
      for (const form of [PHI_TERM, encodeURIComponent(PHI_TERM), PHI_TERM.replace(/ /g, '+'), 'Binita']) expect(u).not.toContain(form);
    }
    for (const [name, value] of call.headers.entries()) { expect(value, name).not.toContain('Binita'); expect(name).not.toContain('binita'); }
    expect(wire.filter((u) => u.endsWith('/v1/partners/orders/search'))).toHaveLength(1);
  });
  it('the order and report list requests the BFF makes carry no free-text / patient term in their URLs', async () => {
    reply['/v1/partners/orders'] = () => json(200, { data: [], page: { limit: 50 } });
    reply['/v1/partners/reports'] = () => json(200, { data: [], page: { limit: 50 } });
    await P.partnerApi('/v1/partners/orders?tracking_status=in_lab&limit=50');
    await P.partnerApi('/v1/partners/reports?is_new=true');
    for (const u of urls.filter((x) => x.startsWith(API))) expect(u).not.toMatch(/[?&](q|search|name|patient[a-z_]*|full_name|partner_sample_ref|registration_no)=/i);
  });
});
