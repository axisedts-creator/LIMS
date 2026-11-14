// C6-T05 — renderer HTTP server (02-TRD §5.1): POST /internal/render, GET /internal/health, GET /internal/metrics, bearer auth, bad bundle.
// ASSUMED API (spec names no signatures):
//   server.ts: startServer({ pool, token: string, port?: number /*0 = ephemeral*/, host?: string }): Promise<{ url: string; close(): Promise<void> }>
//   (the token is passed as a string; reading LIMS_RENDERER_TOKEN_FILE happens in the process entry, not here)
//   Metric text is Prometheus exposition format; names from 02-TRD §12.
//   render.ts: render(templateId, data, assets?) — only the unknown-template failure is asserted here (templates arrive in later tasks).
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../pool.js';
import { render } from '../render.js';
import { startServer } from '../server.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
let pool: Awaited<ReturnType<typeof createPool>>;
let srv: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  pool = await createPool({ contexts: 2 });
  srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await srv?.close();
  await pool?.close();
});

const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  return fetch(srv.url + path, {
    ...rest,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), 'content-type': 'application/json', ...(rest.headers as object) },
  });
};

describe('auth (constant-time bearer, 02-TRD §5.1)', () => {
  it.each([
    ['POST', '/internal/render'],
    ['GET', '/internal/metrics'],
  ])('%s %s without token → 401', async (method, path) => {
    expect((await call(path, { method, token: null, body: method === 'POST' ? '{}' : undefined })).status).toBe(401);
  });

  it.each([
    ['wrong', 'x'.repeat(TOKEN.length)],
    ['shorter', 'x'],
    ['prefix', TOKEN.slice(0, -1)],
    ['longer', TOKEN + 'x'],
    ['empty', ''],
  ])('%s token → 401 (no exception, no 500)', async (_n, t) => {
    expect((await call('/internal/metrics', { token: t })).status).toBe(401);
  });

  it('non-Bearer scheme → 401', async () => {
    const r = await fetch(srv.url + '/internal/metrics', { headers: { authorization: `Basic ${TOKEN}` } });
    expect(r.status).toBe(401);
  });

  it('/internal/health needs no secret and reveals nothing sensitive', async () => {
    const r = await fetch(srv.url + '/internal/health');
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(TOKEN);
  });
});

describe('bad bundle → 400 (never 500, never a stack trace)', () => {
  const post = (body: string) => call('/internal/render', { method: 'POST', body });

  it('malformed JSON', async () => {
    const r = await post('{not json');
    expect(r.status).toBe(400);
    expect(await r.text()).not.toMatch(/at .*\(.*:\d+:\d+\)/);
  });
  it('missing template_id', async () => expect((await post('{}')).status).toBe(400));
  it('unknown template_id', async () => expect((await post(JSON.stringify({ template_id: 'no-such-template', data: {}, assets: {} }))).status).toBe(400));
  it('template_id that tries path/URL traversal', async () => {
    for (const id of ['../../etc/passwd', 'http://169.254.169.254/', 'file:///etc/passwd'])
      expect((await post(JSON.stringify({ template_id: id, data: {}, assets: {} }))).status).toBe(400);
  });
  it('asset with a non-image mime type is rejected', async () => {
    const r = await post(JSON.stringify({ template_id: 'no-such-template', data: {}, assets: { a: { mime_type: 'text/html', base64: 'PGI+' } } }));
    expect(r.status).toBe(400);
  });
  it('body over 20 MB is rejected (400 or 413) without crashing the server', async () => {
    const big = JSON.stringify({ template_id: 'x', data: { pad: 'a'.repeat(21 * 1024 * 1024) } });
    const r = await post(big).catch(() => null); // connection reset on early reject is acceptable
    if (r) expect([400, 413]).toContain(r.status);
    expect((await fetch(srv.url + '/internal/health')).status).toBe(200);
  });
});

describe('render()', () => {
  it('unknown templateId rejects (does not return a PDF)', async () => {
    await expect(render('no-such-template', {}, {})).rejects.toBeTruthy();
  });
});

describe('metrics (02-TRD §12) — names exact, behind the bearer token', () => {
  it('exposes the lims_renderer_* series incl. blocked requests and recycles', async () => {
    await pool.renderHtml('<img src="http://169.254.169.254/"><p>m</p>');
    const t = await (await call('/internal/metrics')).text();
    for (const n of [
      'lims_renderer_render_duration_seconds',
      'lims_renderer_contexts_busy',
      'lims_renderer_rss_bytes',
      'lims_renderer_browser_recycles_total',
      'lims_renderer_blocked_requests_total',
    ])
      expect(t, n).toContain(n);
    expect(t).toMatch(/# TYPE lims_renderer_blocked_requests_total counter/);
    expect(t).toMatch(/# TYPE lims_renderer_render_duration_seconds histogram/);
    const m = /^lims_renderer_blocked_requests_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/m.exec(t);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(1);
  });

  it('blocked-request counter increases with each blocked request (AC-03.8 metric)', async () => {
    const read = async () =>
      Number(/^lims_renderer_blocked_requests_total(?:\{[^}]*\})?\s+(\d+(?:\.\d+)?)/m.exec(await (await call('/internal/metrics')).text())?.[1]);
    const a = await read();
    await pool.renderHtml('<img src="http://169.254.169.254/"><img src="file:///etc/passwd"><p>m</p>');
    expect(await read()).toBeGreaterThanOrEqual(a + 2);
  });
});

describe('server only listens where told', () => {
  it('bound to the requested host (127.0.0.1), not all interfaces', async () => {
    expect(new URL(srv.url).hostname).toBe('127.0.0.1');
    await new Promise<void>((res, rej) => http.get(srv.url + '/internal/health', () => res()).on('error', rej));
  });
});
