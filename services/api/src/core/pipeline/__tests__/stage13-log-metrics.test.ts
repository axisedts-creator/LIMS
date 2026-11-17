// T0D-18 stage 13 (02-TRD §6.2 row 13, CV §9.1/§9.4): exactly one log line per request and lims_http_requests_total /
// lims_http_request_duration_seconds, with the pipeline in place. Uses the ci sample module (public operations), so no database is needed:
// the pipeline must work without LIMS_CORE_DATABASE_URL for operations that never need a transaction.
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../../bootstrap.js';
import { loadConfig } from '../../config.js';
import { FIXTURES, SHARED_ROOT } from '../../__tests__/helpers.js';
import { join } from 'node:path';

const lines: string[] = [];
let app: FastifyInstance | undefined;
const boot = async () => (app ??= await bootstrap({
  config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOAD_SAMPLE_MODULE: '1', LIMS_CORE_LOG_LEVEL: 'info' }),
  repoRoot: SHARED_ROOT, modulesDir: join(FIXTURES, 'ok'), logStream: { write: (l) => { lines.push(l); } },
}));
afterAll(async () => { await app?.close(); });

const requestLines = () => lines.map((l) => { try { return JSON.parse(l); } catch { return undefined; } }).filter((o) => o?.msg === 'request');

describe('stage 13 request log + metrics', () => {
  it('one log line per request with module, operation_id, route template (no raw URL / query), status, duration_ms', async () => {
    const a = await boot();
    lines.length = 0;
    const r = await a.inject({ method: 'GET', url: '/v1/core/sample/items?limit=5' });
    expect(r.statusCode).toBe(200);
    const l = requestLines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ module: 'sample', operation_id: 'listSampleItems', route: '/v1/core/sample/items', status: 200 });
    expect(typeof l[0].duration_ms).toBe('number');
    expect(lines.join('\n')).not.toContain('limit=5');
  });

  it('a 4xx produced inside the pipeline is logged once with its status and error_code', async () => {
    const a = await boot();
    lines.length = 0;
    const r = await a.inject({ method: 'POST', url: '/v1/core/sample/items', payload: { nope: 1 } });
    expect(r.statusCode).toBe(400);
    const l = requestLines();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ operation_id: 'createSampleItem', status: 400 });
  });

  it('lims_http_requests_total and lims_http_request_duration_seconds are updated by the pipeline-wrapped route', async () => {
    const a = await boot();
    await a.inject({ method: 'GET', url: '/v1/core/sample/items' });
    const text = await a.metrics.render();
    expect(text).toMatch(/lims_http_requests_total\{[^}]*module="sample"[^}]*operation_id="listSampleItems"[^}]*status="200"[^}]*\} [1-9]/);
    expect(text).toMatch(/lims_http_request_duration_seconds_count\{[^}]*operation_id="listSampleItems"[^}]*\} [1-9]/);
  });

  it('the log line never carries the request body, the Idempotency-Key header or the Authorization header', async () => {
    const a = await boot();
    lines.length = 0;
    await a.inject({ method: 'POST', url: '/v1/core/sample/items', headers: { 'idempotency-key': 'secret-idem-key', authorization: 'Bearer secret-token' }, payload: { label: 'secret-body-label' } });
    const all = lines.join('\n');
    for (const s of ['secret-idem-key', 'secret-token', 'secret-body-label']) expect(all).not.toContain(s);
  });
});
