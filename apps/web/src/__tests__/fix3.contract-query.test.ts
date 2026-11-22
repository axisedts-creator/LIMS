// T0D-FIX-3 (LD-446, CR DEPLOY-AXIS-012 items 6a, 6b, 6c): the web must not send query parameters the contract does not have.
// The API validates the query strictly ("querystring must NOT have additional properties" -> 400 common.validation_failed), so a stray
// `limit` or `is_active` blanks the screen. serverFetch is replaced by a stand-in that does what the API does for the three operations
// involved (listCentres, listCounters, listInventoryCodedSet): every query key must be declared in contracts/openapi, else 400.
// Contract shapes are used for the answers (identity Centre = centre_id, code, name, kind, is_active).
// Unchecked (listed by the last test, extend when time allows): every other web server read.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); }, redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/',
}));

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SPEC_DIR = join(ROOT, 'contracts', 'openapi');
const specs = new Map<string, any>();
const spec = (file: string) => { if (!specs.has(file)) specs.set(file, parse(readFileSync(join(SPEC_DIR, file), 'utf8'))); return specs.get(file); };

/** Query parameter names the contract declares for GET <path>, resolving $ref to _common.yaml and local components. */
function declaredQuery(file: string, path: string): Set<string> {
  const doc = spec(file);
  const hit = Object.keys(doc.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path));
  if (!hit) throw new Error(`no contract path for ${path} in ${file}`);
  const names = new Set<string>();
  for (const p of [...(doc.paths[hit].parameters ?? []), ...(doc.paths[hit].get?.parameters ?? [])]) {
    let param = p;
    if (p.$ref) {
      const [f, ptr] = String(p.$ref).split('#');
      const target = f ? spec(f) : doc;
      param = ptr!.split('/').slice(1).reduce((o: any, k: string) => o?.[k], target);
    }
    if (param?.in === 'query') names.add(param.name);
  }
  return names;
}

const CHECKED: { re: RegExp; file: string }[] = [
  { re: /^\/v1\/identity\/centres$/, file: 'identity.yaml' },
  { re: /^\/v1\/engagement\/queue-counters$/, file: 'engagement.yaml' },
  { re: /^\/v1\/inventory\/coded-sets\/[^/]+$/, file: 'inventory.yaml' },
];

const CENTRES = [
  { centre_id: '01950c16-0000-7000-8000-000000000001', code: 'SYN-A1', name: 'Synthetic Centre A1', branch_id: '01950c16-0000-7000-8000-0000000000b1', kind: 'own', is_active: true, version: 1 },
  { centre_id: '01950c16-0000-7000-8000-000000000002', code: 'SYN-F2', name: 'Synthetic Franchise F2', branch_id: '01950c16-0000-7000-8000-0000000000b1', kind: 'franchise', is_active: true, version: 1 },
];
const COUNTERS = [
  { id: '01950c16-0000-7000-8000-0000000000c1', centre_id: CENTRES[0]!.centre_id, display_name: 'Counter 1', sort_order: 1, is_active: true, version: 1 },
  { id: '01950c16-0000-7000-8000-0000000000c2', centre_id: CENTRES[0]!.centre_id, display_name: 'Counter 2 (retired)', sort_order: 2, is_active: false, version: 1 },
];

const { calls, ApiErrorStub } = vi.hoisted(() => {
  class ApiErrorStub extends Error {
    constructor(readonly status: number, readonly problem: { code: string; status: number; title: string }) { super(`${problem.code} (${status})`); }
  }
  return { calls: [] as string[], ApiErrorStub };
});
vi.mock('@/core/api/server-fetch', () => ({
  ApiError: ApiErrorStub,
  serverFetch: async (target: string) => {
    calls.push(target);
    const [path = '', query = ''] = target.split('?');
    const rule = CHECKED.find((c) => c.re.test(path));
    if (rule) {
      const allowed = declaredQuery(rule.file, path);
      for (const k of new URLSearchParams(query).keys()) {
        if (!allowed.has(k)) throw new ApiErrorStub(400, { code: 'common.validation_failed', status: 400, title: `querystring must NOT have additional properties (${k})` });
      }
    }
    if (path === '/v1/identity/centres') return { data: CENTRES };
    if (path === '/v1/engagement/queue-counters') return { data: COUNTERS };
    if (path.startsWith('/v1/inventory/coded-sets/')) return { data: [{ code: 'x', display: 'Synthetic code', is_active: true }] };
    return { data: [] };
  },
}));

const sent = (re: RegExp) => calls.filter((c) => re.test(c));
beforeEach(() => { calls.length = 0; });

describe('the stand-in validates like the API (guards the tests themselves)', () => {
  it('the contract declares branch_id, kind, is_active on listCentres and not limit; centre_id on listCounters and not is_active', () => {
    const c = declaredQuery('identity.yaml', '/v1/identity/centres');
    expect([...c]).toEqual(expect.arrayContaining(['branch_id', 'kind', 'is_active']));
    expect(c.has('limit')).toBe(false);
    const k = declaredQuery('engagement.yaml', '/v1/engagement/queue-counters');
    expect(k.has('centre_id')).toBe(true);
    expect(k.has('is_active')).toBe(false);
    expect([...declaredQuery('inventory.yaml', '/v1/inventory/coded-sets/uom')]).toEqual(['reason_group']);
  });
});

describe('item 6a: listCounters sends only centre_id; the BFF keeps only active counters', () => {
  it('no is_active in the query, no 400, retired counter filtered out', async () => {
    const { listCounters } = await import('@/features/engagement/server/queue.server');
    const rows = await listCounters(CENTRES[0]!.centre_id);
    expect(sent(/queue-counters/)).toHaveLength(1);
    expect(sent(/queue-counters/)[0]).not.toMatch(/is_active/);
    expect(rows.map((r) => r.id)).toEqual([COUNTERS[0]!.id]);
  });
});

describe('item 6b: GET /v1/identity/centres carries no `limit` (contract has none); the centre lists are not empty', () => {
  it('billing accounts listCentres', async () => {
    const { listCentres } = await import('@/features/billing/server/accounts.server');
    const rows = await listCentres();
    expect(rows.length).toBe(2);
    expect(sent(/identity\/centres/).every((c) => !/limit/.test(c))).toBe(true);
  });
  it('billing discount slab parties include the franchise centre', async () => {
    const { listSlabParties } = await import('@/features/billing/server/discounts.server');
    const parties = await listSlabParties();
    expect(parties.filter((p) => p.kind === 'franchise').map((p) => p.name)).toEqual(['Synthetic Franchise F2']);
    expect(sent(/identity\/centres/).every((c) => !/limit/.test(c))).toBe(true);
  });
  it('micro worklist centre filter', async () => {
    const { listCentres } = await import('@/features/micro/server/listCentres.server');
    const rows = await listCentres();
    expect(rows?.map((c) => c.name)).toEqual(['Synthetic Centre A1', 'Synthetic Franchise F2']);
    expect(sent(/identity\/centres/).every((c) => !/limit/.test(c))).toBe(true);
  });
  it('engagement content: profile images (list) and profile search (action)', async () => {
    const { listProfileImages } = await import('@/features/engagement/server/content.server');
    await listProfileImages();
    const { searchProfilesAction } = await import('@/features/engagement/server/content-actions');
    const hits = await searchProfilesAction('centre', 'franchise');
    expect(hits.map((h) => h.name)).toEqual(['Synthetic Franchise F2']);
    expect(sent(/identity\/centres/)).toHaveLength(2);
    expect(sent(/identity\/centres/).every((c) => !/limit/.test(c))).toBe(true);
  });
  it('quality TAT filter options: centres present', async () => {
    const { getTatFilterOptions } = await import('@/features/quality/tat/tat.server');
    const { centres } = await getTatFilterOptions();
    expect(centres.map((c) => c.label)).toEqual(['Synthetic Centre A1', 'Synthetic Franchise F2']);
    expect(sent(/identity\/centres/).every((c) => !/limit/.test(c))).toBe(true);
  });
});

describe('item 6c: listInventoryCodedSet sends no limit (only reason_group is declared)', () => {
  it('listCodedSet(uom) has no query string and returns the codes', async () => {
    const { listCodedSet } = await import('@/features/inventory/server/read.server');
    const rows = await listCodedSet('uom');
    expect(rows).toHaveLength(1);
    expect(sent(/coded-sets/)[0]).not.toMatch(/limit/);
  });
  it('listReasons(po_cancel) sends reason_group only', async () => {
    const { listReasons } = await import('@/features/inventory/server/read.server');
    const rows = await listReasons('po_cancel');
    expect(rows).toHaveLength(1);
    const q = new URLSearchParams(sent(/coded-sets\/reasons/)[0]!.split('?')[1] ?? '');
    expect([...q.keys()]).toEqual(['reason_group']);
  });
});

describe('static guard over every web source (not only the call sites above)', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules' && n !== '.next') walk(p); }
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) files.push(p);
    }
  };
  walk(join(ROOT, 'apps', 'web', 'src'));
  const lines = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f: f.slice(ROOT.length), n: i + 1, l })));

  it('no web call to /v1/identity/centres sends limit', () => {
    expect(lines.filter(({ l }) => /\/v1\/identity\/centres\?[^'"`]*limit/.test(l)).map(({ f, n }) => `${f}:${n}`)).toEqual([]);
  });
  it('listCounters / queue-counters never sends is_active', () => {
    expect(lines.filter(({ l }) => /queue-counters\?[^'"`]*is_active/.test(l)).map(({ f, n }) => `${f}:${n}`)).toEqual([]);
  });
  it('no inventory coded-set read sends limit', () => {
    expect(lines.filter(({ l }) => /coded-sets\/[^\n]*limit\s*:/.test(l)).map(({ f, n }) => `${f}:${n}`)).toEqual([]);
  });
});
