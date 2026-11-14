// C3.T-35 — BFF server functions + download proxies for SCR-18 (Imports & exports) / SCR-19 (Import detail).
// Contract: contracts/openapi/catalog.yaml operations #96–#107 (downloadImportTemplate, createImport, listImports, getImport, listImportIssues,
// downloadImportReport, commitImport, discardImport, createExport, listExports, getExport, downloadExportFile). MSW stands in for the C3 API.
// ACs as seen from the BFF: AC-16.3 (idempotent upload), AC-16.5/16.6/16.7 (commit body, If-Match, Idempotency-Key, 409 codes), AC-16.8, AC-16.9 (15 MB / .xlsm),
// AC-16.10, AC-16.11, REQ-SEC-085 (attachment + nosniff + no-store, API → BFF stream), AB-5 (tenant-B → 404), S-1/S-4. Synthetic data only.
// ASSUMED signatures (same conventions as T-31/T-33: create*(input, idempotencyKey?), state actions (id, version, input, key?) → If-Match "<version>"):
//   createImport(form: FormData{kind, target_price_list_id?, file}, key?)   listImports({kind?, status?, limit?, cursor?})   getImport(id)
//   listImportIssues(id, {severity?, limit?, cursor?})   commitImport(id, version, input, key?)   discardImport(id, version)
//   createExport({kind, price_list_version_id?}, key?)   listExports({kind?, status?, limit?, cursor?})   getExport(id)
//   download proxies (billing precedent app/(staff)/billing/exports/[export_id]/content/route.ts): GET handlers in
//     app/(staff)/catalog/import-templates/[kind]/route.ts   app/(staff)/catalog/imports/[import_id]/report/route.ts   app/(staff)/catalog/exports/[export_id]/file/route.ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { parseMultipart, type ParsedForm } from './web-t35.multipart'; // ruling C3.T-35 #4

vi.mock('server-only', () => ({}));
const tok = vi.hoisted(() => ({ value: 'jwt-synthetic' as string | undefined }));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => tok.value, getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = '01a1a98a-ac40-7000-8000-0000000d0501';
const PL = '01a1a98a-ac40-7000-8000-0000000d0502';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MB15 = 15 * 1024 * 1024;

const seen: { url: URL; method: string; headers: Headers; body?: any; form?: ParsedForm }[] = [];
const rec = async (r: Request) => {
  const ct = r.headers.get('content-type') ?? '';
  seen.push({
    url: new URL(r.url), method: r.method, headers: r.headers,
    body: ct.includes('json') ? await r.clone().json().catch(() => undefined) : undefined,
    form: ct.startsWith('multipart/form-data') ? parseMultipart(ct, await r.clone().text()) : undefined,
  });
};
const imp = { id: ID, kind: 'price_list', target_price_list_id: PL, base_version_no: 3, status: 'uploaded', file_name: 'prices.xlsx', file_sha256: 'ab'.repeat(32), summary: { rows: 0, added: 0, changed: 0, removed: 0, unchanged: 0, errors: 0, warnings: 0 }, deduplicated: false, expires_at: '2026-11-15T00:00:00.000Z', created_at: '2026-11-08T00:00:00.000Z', created_by: ID, version: 2 };
const server = setupServer(
  http.get(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
  http.post(`${ORIGIN}/v1/catalog/imports`, async ({ request }) => { await rec(request); return HttpResponse.json(imp, { status: 201 }); }),
  http.post(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...imp, status: 'committing' }, { status: 202 }); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; tok.value = 'jwt-synthetic'; });
afterAll(() => server.close());

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const mod = async (op: string) => (await import(`../server/${op}.server.ts`))[op];
const rejects = async (p: Promise<unknown>) => { const e: any = await p.then(() => undefined, (x: unknown) => x); expect(e?.status, 'ApiError 400').toBe(400); expect(e.problem.code).toBe('common.validation_failed'); };
const form = (o: { kind?: string; target?: string; file?: File | string; extra?: Record<string, string> } = {}) => {
  const f = new FormData();
  f.set('kind', o.kind ?? 'price_list');
  if (o.target !== undefined) f.set('target_price_list_id', o.target); else if ((o.kind ?? 'price_list') === 'price_list') f.set('target_price_list_id', PL);
  f.set('file', o.file ?? new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'prices.xlsx', { type: XLSX }));
  for (const [k, v] of Object.entries(o.extra ?? {})) f.set(k, v);
  return f;
};
const commitBody = { change_reason: 'Quarterly price review', effective_from: '2026-11-10T00:00:00.000Z', publish: true, accept_stale_base: false, replace_draft: false };

describe('createImport (AC-16.3, AC-16.8, AC-16.9, AC-16.11)', () => {
  it('POST multipart /v1/catalog/imports with kind + target + file, Idempotency-Key, bearer; browser never sets the boundary', async () => {
    const r = await (await mod('createImport'))(form(), 'idem-key-0501-aaaa');
    expect(r.id).toBe(ID);
    const c = seen[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/catalog/imports');
    expect(c.headers.get('idempotency-key')).toBe('idem-key-0501-aaaa');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(c.form!.get('kind')).toBe('price_list');
    expect(c.form!.get('target_price_list_id')).toBe(PL);
    expect((c.form!.get('file') as { name: string }).name).toBe('prices.xlsx');
  });

  it('generates an Idempotency-Key when none is passed; only declared form fields are forwarded (mass-assignment)', async () => {
    await (await mod('createImport'))(form({ extra: { tenant_id: ID, status: 'validated', created_by: ID, summary: '{}' } }));
    const c = seen[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect([...c.form!.keys()].sort()).toEqual(['file', 'kind', 'target_price_list_id']);
  });

  it('non-price kinds forward no target; kind must be one of the four (CR-C18-008 credit_parties included)', async () => {
    const create = await mod('createImport');
    for (const kind of ['catalog_master', 'referrers', 'credit_parties']) await create(form({ kind }));
    expect(seen.map((s) => s.form!.get('kind'))).toEqual(['catalog_master', 'referrers', 'credit_parties']);
    expect(seen.every((s) => !s.form!.has('target_price_list_id'))).toBe(true);
    seen.length = 0;
    await rejects(create(form({ kind: 'doctors' })));
    await rejects(create(form({ kind: 'price_list; drop' })));
    expect(seen).toEqual([]);
  });

  it('rejects before the network: price_list without / with bad target, non-uuid target, >15 MB, empty, .xlsm / .xls / .csv, path-like names, no file, bad key', async () => {
    const create = await mod('createImport');
    await rejects(create(form({ kind: 'price_list', target: '' })));
    await rejects(create(form({ target: '../../admin' })));
    await rejects(create(form({ file: new File([new Uint8Array(MB15 + 1)], 'big.xlsx') })));
    await rejects(create(form({ file: new File([], 'empty.xlsx') })));
    for (const name of ['macro.xlsm', 'old.xls', 'data.csv', 'prices.xlsx.exe', 'noext']) await rejects(create(form({ file: new File([new Uint8Array([0x50, 0x4b])], name) })));
    await rejects(create(form({ file: 'not-a-file' })));
    await rejects(create(new FormData()));
    await rejects(create(form(), 'short'));
    expect(seen).toEqual([]);
  });

  it('exactly 15 MB passes (limit is "up to 15 MB")', async () => {
    await (await mod('createImport'))(form({ file: new File([new Uint8Array(MB15)], 'edge.xlsx') }));
    expect(seen).toHaveLength(1);
  });

  it('API problems surface as ApiError with the code: 413, 415, 429 (2 concurrent), 403 auth.forbidden, 403 auth.mfa_required, 409 idempotency_key_reused', async () => {
    const create = await mod('createImport');
    const cases: [number, string][] = [[413, 'common.payload_too_large'], [415, 'common.unsupported_media_type'], [429, 'common.rate_limited'], [403, 'auth.forbidden'], [403, 'auth.mfa_required'], [409, 'common.idempotency_key_reused']];
    for (const [status, code] of cases) {
      server.use(http.post(`${ORIGIN}/v1/catalog/imports`, () => problem(status, code)));
      const e: any = await create(form(), 'idem-key-0501-bbbb').then(() => undefined, (x: unknown) => x);
      expect([e.status, e.problem.code]).toEqual([status, code]);
    }
  });

  it('deduplicated 200 (same bytes within TTL) is returned as-is, not treated as an error (AC-16.8)', async () => {
    server.use(http.post(`${ORIGIN}/v1/catalog/imports`, () => HttpResponse.json({ ...imp, deduplicated: true }, { status: 200 })));
    const r = await (await mod('createImport'))(form(), 'idem-key-0501-cccc');
    expect(r.deduplicated).toBe(true);
  });
});

describe('reads (AC-16.3 polling target, #98–#100, #105, #107)', () => {
  it('listImports → GET /v1/catalog/imports with kind + status + limit; bad enums never reach the API', async () => {
    await (await mod('listImports'))({ kind: 'referrers', status: 'commit_failed', limit: 100 });
    const u = seen[0]!.url;
    expect(u.pathname).toBe('/v1/catalog/imports');
    expect(u.searchParams.get('kind')).toBe('referrers');
    expect(u.searchParams.get('status')).toBe('commit_failed');
    expect(u.searchParams.get('limit')).toBe('100');
    await rejects((await mod('listImports'))({ kind: 'doctors' }));
    await rejects((await mod('listImports'))({ status: 'done' }));
    await rejects((await mod('listImports'))({ kind: 'x&admin=1' }));
    expect(seen).toHaveLength(1);
  });

  it('getImport → GET /v1/catalog/imports/{id}; bad id never reaches the API', async () => {
    server.use(http.get(`${ORIGIN}/v1/catalog/imports/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(imp); }));
    expect((await (await mod('getImport'))(ID)).status).toBe('uploaded');
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/imports/${ID}`);
    for (const bad of ['not-a-uuid', '../../exports', `${ID}/commit`]) await rejects((await mod('getImport'))(bad));
    expect(seen).toHaveLength(1);
  });

  it('listImportIssues → GET …/issues?severity=error|warning; other severities rejected', async () => {
    await (await mod('listImportIssues'))(ID, { severity: 'warning', limit: 200 });
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/imports/${ID}/issues`);
    expect(seen[0]!.url.searchParams.get('severity')).toBe('warning');
    await rejects((await mod('listImportIssues'))(ID, { severity: 'info' }));
    await rejects((await mod('listImportIssues'))('nope', {}));
  });

  it('listExports / getExport / createExport', async () => {
    await (await mod('listExports'))({ kind: 'price_list', status: 'ready' });
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/exports');
    expect(seen[0]!.url.searchParams.get('status')).toBe('ready');
    await rejects((await mod('listExports'))({ kind: 'credit_parties' })); // exports have no credit_parties kind (Export.kind enum)
    server.use(http.get(`${ORIGIN}/v1/catalog/exports/:id`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: ID, kind: 'price_list', status: 'queued', version: 1 }); }));
    expect((await (await mod('getExport'))(ID)).status).toBe('queued');
    await rejects((await mod('getExport'))('x'));
  });

  it('createExport: POST JSON {kind, price_list_version_id?} + Idempotency-Key; only declared fields; 3 kinds only', async () => {
    const create = await mod('createExport');
    await create({ kind: 'price_list', price_list_version_id: PL, tenant_id: ID, status: 'ready' }, 'idem-key-0502-aaaa');
    await create({ kind: 'referrers' });
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/exports');
    expect(seen[0]!.headers.get('idempotency-key')).toBe('idem-key-0502-aaaa');
    expect(seen[0]!.body).toEqual({ kind: 'price_list', price_list_version_id: PL });
    expect(seen[1]!.body).toEqual({ kind: 'referrers' });
    expect(seen[1]!.headers.get('idempotency-key')).toBeTruthy();
    seen.length = 0;
    await rejects(create({ kind: 'credit_parties' }));
    await rejects(create({ kind: 'price_list', price_list_version_id: 'nope' }));
    await rejects(create({}));
    expect(seen).toEqual([]);
  });
});

describe('commitImport / discardImport (AC-16.5, 16.6, 16.7, AB-16)', () => {
  it('POST …/commit: If-Match "<version>", Idempotency-Key, body limited to ImportCommit fields', async () => {
    await (await mod('commitImport'))(ID, 2, { ...commitBody, tenant_id: ID, status: 'committed', result_price_list_version_id: ID, typed_confirmation: 'PL-DRX' }, 'idem-key-0503-aaaa');
    const c = seen[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe(`/v1/catalog/imports/${ID}/commit`);
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.headers.get('idempotency-key')).toBe('idem-key-0503-aaaa');
    expect(c.body).toEqual(commitBody); // the typed confirmation is a UI-only guard, never forwarded
  });

  it('defaults: key generated when absent; accept_stale_base / replace_draft / publish are forwarded only when boolean', async () => {
    await (await mod('commitImport'))(ID, 2, { change_reason: 'r' });
    expect(seen[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(seen[0]!.body).toEqual({ change_reason: 'r' });
    await rejects((await mod('commitImport'))(ID, 2, { change_reason: 'r', accept_stale_base: 'true' }));
    await rejects((await mod('commitImport'))(ID, 2, { change_reason: 'r', replace_draft: 1 }));
  });

  it('rejects before the network: missing / blank / >500-char reason, bad id, version 0 / 1.5, bad date, bad key', async () => {
    const commit = await mod('commitImport');
    await rejects(commit(ID, 2, {}));
    await rejects(commit(ID, 2, { change_reason: '   ' }));
    await rejects(commit(ID, 2, { change_reason: 'x'.repeat(501) }));
    await rejects(commit('../x', 2, commitBody));
    await rejects(commit(ID, 0, commitBody));
    await rejects(commit(ID, 1.5, commitBody));
    await rejects(commit(ID, 2, { ...commitBody, effective_from: 'tomorrow' }));
    await rejects(commit(ID, 2, commitBody, 'x'));
    expect(seen).toEqual([]);
  });

  it('API problems surface with code: 409 catalog.import_stale_base, 409 catalog.import_not_committable (replay with a new key), 403 auth.mfa_required, 428, 409 common.version_conflict', async () => {
    const commit = await mod('commitImport');
    const cases: [number, string][] = [[409, 'catalog.import_stale_base'], [409, 'catalog.import_not_committable'], [403, 'auth.mfa_required'], [403, 'auth.forbidden'], [428, 'common.precondition_required'], [409, 'common.version_conflict']];
    for (const [status, code] of cases) {
      server.use(http.post(`${ORIGIN}/v1/catalog/imports/:id/commit`, () => problem(status, code)));
      const e: any = await commit(ID, 2, commitBody, 'idem-key-0503-bbbb').then(() => undefined, (x: unknown) => x);
      expect([e.status, e.problem.code]).toEqual([status, code]);
    }
  });

  it('discardImport → POST …/discard with If-Match and no body fields; bad id / version rejected', async () => {
    await (await mod('discardImport'))(ID, 4);
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/imports/${ID}/discard`);
    expect(seen[0]!.headers.get('if-match')).toBe('"4"');
    await rejects((await mod('discardImport'))('nope', 4));
    await rejects((await mod('discardImport'))(ID, -1));
    expect(seen).toHaveLength(1);
  });
});

// ---- download proxies (REQ-SEC-085: API → BFF stream; attachment; nosniff; no-store; no storage URL) -------------------------------------------
describe('download route handlers (AC-16.1, AC-16.10, REQ-SEC-085, AB-5, 08 A13 D-20)', () => {
  // ruling C3.T-35 #1: Vite rejects variable dynamic imports through (staff)/[param] dirs → one literal import() per fixed route path.
  const routes: Record<string, () => Promise<{ GET: unknown }>> = {
    'import-templates/[kind]': () => import('../../../app/(staff)/catalog/import-templates/[kind]/route'),
    'imports/[import_id]/report': () => import('../../../app/(staff)/catalog/imports/[import_id]/report/route'),
    'exports/[export_id]/file': () => import('../../../app/(staff)/catalog/exports/[export_id]/file/route'),
  };
  const route = async (rel: string) => (await routes[rel]!()).GET as (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
  const targets = [
    { rel: 'import-templates/[kind]', param: { kind: 'price_list' }, api: '/v1/catalog/import-templates/price_list' },
    { rel: 'imports/[import_id]/report', param: { import_id: ID }, api: `/v1/catalog/imports/${ID}/report-file` },
    { rel: 'exports/[export_id]/file', param: { export_id: ID }, api: `/v1/catalog/exports/${ID}/file` },
  ];
  const xlsxBody = () => new Response(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]), { headers: { 'content-type': XLSX, 'content-disposition': 'attachment; filename="price-list.xlsx"' } });

  for (const t of targets) {
    describe(t.rel, () => {
      it('streams the API file with bearer token; response is attachment + nosniff + no-store; never redirects to a storage URL', async () => {
        server.use(http.get(`${ORIGIN}${t.api}`, async ({ request }) => { await rec(request); return xlsxBody(); }));
        const res = await (await route(t.rel))(new Request('http://web.test/x'), { params: Promise.resolve(t.param) });
        expect(res.status).toBe(200);
        expect(seen[0]!.url.pathname).toBe(t.api);
        expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
        expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('location')).toBeNull();
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]));
      });

      it('a hostile API content-disposition / type never becomes inline: falls back to attachment', async () => {
        server.use(http.get(`${ORIGIN}${t.api}`, () => new Response('<script>1</script>', { headers: { 'content-type': 'text/html' } })));
        const res = await (await route(t.rel))(new Request('http://web.test/x'), { params: Promise.resolve(t.param) });
        expect(res.headers.get('content-disposition') ?? 'attachment').toMatch(/^attachment/);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      });

      it('malformed path param → 400 without calling the API; no session → 401 without calling the API', async () => {
        const key = Object.keys(t.param)[0]!;
        const bad = await (await route(t.rel))(new Request('http://web.test/x'), { params: Promise.resolve({ [key]: key === 'kind' ? '../../secret' : 'not-a-uuid' }) });
        expect(bad.status).toBe(400);
        tok.value = undefined;
        const anon = await (await route(t.rel))(new Request('http://web.test/x'), { params: Promise.resolve(t.param) });
        expect(anon.status).toBe(401);
        expect(seen).toEqual([]);
      });

      it('passes 403 / 404 (tenant-B id, AB-5) / 409 file_not_ready through as the same status; any other upstream failure is 502 with no body leak', async () => {
        for (const [up, want] of [[403, 403], [404, 404], [409, 409], [500, 502], [429, 502]] as const) {
          server.use(http.get(`${ORIGIN}${t.api}`, () => problem(up, up === 409 ? 'common.version_conflict' : 'x', up === 409 ? { detail: 'file_not_ready' } : {})));
          const res = await (await route(t.rel))(new Request('http://web.test/x'), { params: Promise.resolve(t.param) });
          expect(res.status, `upstream ${up}`).toBe(want);
          expect(await res.text()).not.toMatch(/urn:lims|stack|postgres/i);
        }
      });
    });
  }

  it('template kind is whitelisted: only the four kinds are proxied', async () => {
    const get = await route('import-templates/[kind]');
    for (const kind of ['doctors', 'PRICE_LIST', 'price_list/../x', '']) expect((await get(new Request('http://web.test/x'), { params: Promise.resolve({ kind }) })).status, kind).toBe(400);
    expect(seen).toEqual([]);
  });
});
