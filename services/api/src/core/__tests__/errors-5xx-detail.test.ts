// SEC-ERR-1 (LD-236, audit 5.6): a response with status >= 500 never carries LimsError.detail; the real detail stays in the log.
// Problem.detail is optional in contracts/openapi/_common.yaml, so it is OMITTED on 5xx. 4xx is unchanged. Reuses the T0D-04 errors fixture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';
import { REPO_ROOT } from '../module.js';
import { LimsError, toProblem } from '../errors.js';

interface Entry { code: string; http: number; title: string }
const REGISTRY = parse(readFileSync(join(REPO_ROOT, 'contracts', 'errors.yaml'), 'utf8')) as Entry[];
const FIVE_XX = REGISTRY.filter((e) => e.http >= 500);
const FOUR_XX = REGISTRY.filter((e) => e.http >= 400 && e.http < 500);
const INTERNAL = 'identity: token encryption key invalid'; // the real example from the audit (identity/repository/mfa.repo.ts)
const RID = '0190a000-0000-7000-8000-0000000000b1';

describe('toProblem (unit)', () => {
  it('the registry has 5xx and 4xx codes to test', () => {
    expect(FIVE_XX.length).toBeGreaterThan(0);
    expect(FOUR_XX.length).toBeGreaterThan(0);
  });

  it.each(FIVE_XX.map((e) => [e.code, e.http]))('5xx %s (%i): detail omitted, code/status/title/type/request_id unchanged', (code, http) => {
    const reg = FIVE_XX.find((e) => e.code === code)!;
    const p = toProblem(new LimsError(code as string, INTERNAL), '/v1/x', RID) as any;
    expect(JSON.stringify(p)).not.toContain(INTERNAL);
    expect(p.detail).toBeUndefined();
    expect(p).toMatchObject({ code, status: http, title: reg.title, type: `urn:lims:error:${code}`, instance: '/v1/x', request_id: RID });
  });

  it.each(FOUR_XX.map((e) => [e.code, e.http]))('4xx %s (%i): detail unchanged', (code) => {
    expect((toProblem(new LimsError(code as string, 'Specimen not found'), '/v1/x', RID) as any).detail).toBe('Specimen not found');
  });

  it('a 4xx with detail and errors[] is untouched (validation_failed keeps both)', () => {
    const fe = [{ path: '/name', code: 'common.field_required', message: 'Field required' }];
    expect(toProblem(new LimsError('common.validation_failed', 'Request validation failed', fe), '/v1/x', RID))
      .toMatchObject({ status: 400, detail: 'Request validation failed', errors: fe });
  });

  it('a non-LimsError (plain Error) still yields a 500 without any message text', () => {
    const p = toProblem(new Error(INTERNAL), '/v1/x', RID) as any;
    expect(p.status).toBe(500);
    expect(JSON.stringify(p)).not.toContain(INTERNAL);
  });
});

describe('real bootstrap: handler throws LimsError with an internal detail', () => {
  const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'errors');
  const lines: string[] = [];
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await bootstrap({
      config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOG_LEVEL: 'info' }),
      repoRoot: join(ROOT, 'root'), modulesDir: join(ROOT, 'modules'), logStream: { write: (l: string) => { lines.push(l); } },
    });
  }, 30000);
  afterAll(async () => { await app?.close(); });
  const get = (code: string, rid = RID) => app.inject({ method: 'GET', url: `/v1/catalog/internal/${code}`, headers: { 'x-request-id': rid } });

  it.each(FIVE_XX.map((e) => [e.code, e.http]))('5xx %s: body has no internal text and no detail key; the log line keeps it', async (code, http) => {
    lines.length = 0;
    const res = await get(code as string);
    expect(res.statusCode).toBe(http);
    expect(res.body).not.toContain(INTERNAL);
    const b = JSON.parse(res.body);
    expect('detail' in b).toBe(false);
    expect(b).toMatchObject({ code, status: http, request_id: RID, instance: `/v1/catalog/internal/${code}` });
    expect(String(res.headers['content-type'])).toMatch(/^application\/problem\+json\b/);
    // the real detail is in the (scrubbed) request_failed log line, and only there
    const failed = lines.filter((l) => l.includes('request_failed'));
    expect(failed.length, 'a request_failed log line').toBeGreaterThan(0);
    expect(failed.some((l) => l.includes(INTERNAL)), 'real detail in the request_failed line').toBe(true);
  });

  it('4xx unchanged: 404 keeps its detail and logs no request_failed', async () => {
    lines.length = 0;
    const res = await get('common.not_found');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).detail).toBe(INTERNAL);
    expect(lines.some((l) => l.includes('request_failed'))).toBe(false);
  });

  it('4xx unchanged: every 4xx registry code returns the detail it was thrown with', async () => {
    for (const e of FOUR_XX) {
      const res = await get(e.code);
      expect(res.statusCode, e.code).toBe(e.http);
      expect(JSON.parse(res.body).detail, e.code).toBe(INTERNAL);
    }
  }, 30000);

  it('adversarial: a detail that looks like a secret/SQL on a 5xx never reaches the body, whichever 5xx code', async () => {
    for (const e of FIVE_XX) expect((await get(e.code)).body, e.code).not.toMatch(/token encryption|identity:/);
  });
});
