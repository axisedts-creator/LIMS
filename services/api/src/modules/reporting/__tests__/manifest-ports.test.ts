// WIRE-REP (C1) — the reporting manifest exports ReportingPort, NotificationPort and a LAZY RenderPort (LD-186; 02-TRD §6.3 port registry, AC-0D-6.1/6.2/6.4;
// C6 02-TRD config table l.834-835: renderer URL + token file are worker settings, optional for the API; C1 02-TRD l.535-536).
// Synthetic data only. Local 127.0.0.1 servers and temp files only; no database.
// Expected: ../index.ts `manifest.ports = { ReportingPort, NotificationPort, RenderPort }`; RenderPort = ../ports/renderPort.lazy.ts, which reads
// LIMS_REPORTING_RENDERER_URL / LIMS_REPORTING_RENDERER_TOKEN_FILE (optional in ../config.ts) on the FIRST CALL only.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORT_OWNERS, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { resolvePorts } from '../../../core/ports/registry.js';

const noop = () => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop };
const metrics = { setGauge: noop, inc: noop };
const MINE = ['ReportingPort', 'NotificationPort', 'RenderPort'];

const fakes = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, { kind: 'fake', port: p }]));
const consumers = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, ['frontdesk'] as readonly string[]]));
const otherOwners = (): Array<{ name: string; ports: Record<string, unknown> }> => {
  const byOwner = new Map<string, Record<string, unknown>>();
  for (const [port, owner] of Object.entries(PORT_OWNERS)) {
    if (owner === 'reporting') continue;
    byOwner.set(owner, { ...(byOwner.get(owner) ?? {}), [port]: { kind: 'real', port } });
  }
  return [...byOwner].map(([name, ports]) => ({ name, ports }));
};

const work = mkdtempSync(join(tmpdir(), 'wire-rep-'));
const otpKey = join(work, 'otp.key');
writeFileSync(otpKey, Buffer.alloc(32, 7));
const TOKEN = 'PLANTED-wire-rep-token-7c1d9e42b0aa5f';
const SECRET_DIR = mkdtempSync(join(work, 'secret-dir-zq81-'));   // distinctive path fragment: must never be echoed
const TOKEN_FILE = join(SECRET_DIR, 'renderer.token');
writeFileSync(TOKEN_FILE, TOKEN);                                 // no trailing newline: trimming is not specified, so it is not tested

const ctx = { actor: { type: 'system' } } as const;
const analytics = () => ({
  tenantDisplayName: 'Synthetic Test Lab', reportTitle: 'Synthetic report', periodLabelAd: '2026-11', periodLabelBs: '2083-07', scopeLabel: 'All centres',
  generatedAtLocal: '2026-11-14 10:00', exportId: '123e4567-e89b-42d3-a456-426614174000', exportedBy: 'Test Admin', freshnessNote: 'fresh', notStatutoryNote: 'not statutory',
  columns: [{ key: 'c1', label: 'Count', kind: 'count' }], rows: [{ c1: 1 }, { c1: 2 }],
});
const call = (port: any, key = 'wire-rep-1') => port.renderPdf(ctx, { templateKey: 'analytics.report', data: analytics(), idempotencyKey: key });

async function loadManifest(env: Record<string, string> = {}): Promise<any> {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (k.startsWith('LIMS_')) vi.stubEnv(k, undefined as never);
  vi.stubEnv('LIMS_CORE_ENV', 'staging');
  vi.stubEnv('LIMS_REPORTING_OTP_HMAC_KEY_FILE', otpKey);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../index.js')).manifest;
}
const setRenderer = (url?: string, file?: string) => {
  vi.stubEnv('LIMS_REPORTING_RENDERER_URL', url as never);
  vi.stubEnv('LIMS_REPORTING_RENDERER_TOKEN_FILE', file as never);
};
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
/** Everything an error can leak: message, stack, cause, own enumerable props. */
const dump = (e: any): string => [String(e?.message), String(e?.stack), JSON.stringify(e, Object.getOwnPropertyNames(e ?? {})), e?.cause ? dump(e.cause) : ''].join('\n');

const servers: Server[] = [];
async function startRenderer(status = 200) {
  const seen: Array<{ method?: string; url?: string; authorization?: string; body: any }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: any; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (status !== 200) { res.writeHead(status).end(); return; }
      res.writeHead(200, { 'content-type': 'application/pdf', 'x-page-count': '3' }).end(Buffer.from('%PDF-1.7\n%wire-rep stub\n%%EOF\n'));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
async function deadUrl(): Promise<string> {
  const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(async () => {
  vi.unstubAllEnvs(); vi.resetModules();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); })));
});

describe('reporting manifest ports (LD-186)', () => {
  it('validateManifest accepts the manifest', async () => {
    const manifest = await loadManifest();
    expect(() => validateManifest('reporting', manifest, REPO_ROOT)).not.toThrow();
  });

  it('ports keys equal exactly ReportingPort, NotificationPort, RenderPort', async () => {
    const manifest = await loadManifest();
    expect(Object.keys(manifest.ports ?? {}).sort()).toEqual([...MINE].sort());
  });

  it('PORT_OWNERS lists exactly these three for reporting (the manifest covers every port it owns)', () => {
    expect(Object.entries(PORT_OWNERS).filter(([, o]) => o === 'reporting').map(([p]) => p).sort()).toEqual([...MINE].sort());
  });

  it('facade methods equal the RenderPort interface: exactly renderPdf, as a function', async () => {
    const port = (await loadManifest()).ports.RenderPort;
    expect(Object.keys(port)).toEqual(['renderPdf']);
    expect(typeof port.renderPdf).toBe('function');
  });

  it('ReportingPort and NotificationPort expose their impl methods', async () => {
    const { ports } = await loadManifest();
    for (const m of ['getReleasedReports', 'openReleasedReportFile', 'redeemPortalLinkForApp']) expect(typeof ports.ReportingPort[m], m).toBe('function');
    for (const m of ['sendSms', 'sendWhatsAppTemplate', 'sendEmailLink']) expect(typeof ports.NotificationPort[m], m).toBe('function');
  });

  it('the ports are stable instances (not getters that build a new port per read)', async () => {
    const m1 = await loadManifest();
    const { manifest: m2 } = await import('../index.js');
    for (const p of MINE) { expect(m2.ports[p]).toBe(m1.ports[p]); expect(m1.ports[p]).toBe(m1.ports[p]); }
  });
});

describe('registry resolution (02-TRD §6.3)', () => {
  const resolve = (env: string, mods: unknown[], forceFake?: string[]) =>
    resolvePorts({ env, modules: mods as never, forceFake, fakes, stubs: {}, phaseStubs: [], owners: PORT_OWNERS, consumers, log, metrics });

  it('staging, PORT_OWNERS, no fakes forced: all three resolve real', async () => {
    const manifest = await loadManifest();
    const { resolution } = resolve('staging', [{ name: 'reporting', ports: manifest.ports }, ...otherOwners()]);
    for (const p of MINE) expect(resolution[p], p).toBe('real');
  });

  it('staging: the exported ports are the ones handed to a listed consumer', async () => {
    const manifest = await loadManifest();
    const { portsFor } = resolve('staging', [{ name: 'reporting', ports: manifest.ports }, ...otherOwners()]);
    for (const p of MINE) expect((portsFor('frontdesk') as any)[p], p).toBe(manifest.ports[p]);
  });

  it.each(['dev', 'ci'])('%s: real beats the fake once the owner exports it', async (env) => {
    const manifest = await loadManifest();
    const { resolution } = resolve(env, [{ name: 'reporting', ports: manifest.ports }]);
    for (const p of MINE) expect(resolution[p], p).toBe('real');
  });

  it('dev/ci: LIMS_CORE_FAKE_PORTS still forces the fake (registry not weakened)', async () => {
    const manifest = await loadManifest();
    expect(resolve('ci', [{ name: 'reporting', ports: manifest.ports }], [...MINE]).resolution).toMatchObject({ ReportingPort: 'fake', NotificationPort: 'fake', RenderPort: 'fake' });
  });

  it('staging/production: forcing a fake is still a boot failure', async () => {
    const manifest = await loadManifest();
    expect(() => resolve('production', [{ name: 'reporting', ports: manifest.ports }, ...otherOwners()], ['RenderPort'])).toThrow(/not allowed in production/);
  });

  it('staging without the reporting module still fails (the manifest line is the only thing that fixes these ports)', () => {
    expect(() => resolve('staging', otherOwners())).toThrow(/owner module reporting not loaded/);
  });
});

describe('config: renderer settings are optional and additive (LD-186 rule 2)', () => {
  const base = { LIMS_CORE_ENV: 'staging', LIMS_REPORTING_OTP_HMAC_KEY_FILE: otpKey };
  it('loads with neither renderer variable set (the API does not require them)', async () => {
    const { loadReportingConfig } = await import('../config.js');
    expect(() => loadReportingConfig(base)).not.toThrow();
  });
  it('loads with both set to valid values, without reading the token file at load', async () => {
    const { loadReportingConfig } = await import('../config.js');
    const missing = join(work, 'not-there', 'renderer.token');
    expect(() => loadReportingConfig({ ...base, LIMS_REPORTING_RENDERER_URL: 'https://renderer.invalid', LIMS_REPORTING_RENDERER_TOKEN_FILE: missing })).not.toThrow();
  });
  it('an invalid renderer URL fails like the other loaders: names the key, never echoes the value', async () => {
    const { loadReportingConfig } = await import('../config.js');
    const bad = 'not a url PLANTED-url-value';
    let err: any; try { loadReportingConfig({ ...base, LIMS_REPORTING_RENDERER_URL: bad }); } catch (e) { err = e; }
    expect(err, 'must throw').toBeDefined();
    expect(String(err.message)).toContain('LIMS_REPORTING_RENDERER_URL');
    expect(String(err.message)).not.toContain('PLANTED-url-value');
  });
  it('existing keys unchanged: the OTP key file is still required', async () => {
    const { loadReportingConfig } = await import('../config.js');
    expect(() => loadReportingConfig({ LIMS_CORE_ENV: 'staging' })).toThrow(/LIMS_REPORTING_OTP_HMAC_KEY_FILE/);
  });
});

describe('RenderPort is lazy: nothing read, built or contacted at import or boot', () => {
  it('import with the renderer variables pointing at nothing does not throw, read the file, open a socket or call fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const net = await import('node:net');
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const ghost = join(work, 'never-created', 'ghost.token');
    const manifest = await loadManifest({ LIMS_REPORTING_RENDERER_URL: 'https://renderer.invalid', LIMS_REPORTING_RENDERER_TOKEN_FILE: ghost });
    void manifest.ports.RenderPort;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    // ghost is never created: an import-time read of it would have thrown inside loadManifest above.
  });

  it('variables are read at the first call, not at import: set after import, the call uses them', async () => {
    const manifest = await loadManifest();           // nothing set at import
    const r = await startRenderer();
    setRenderer(r.url, TOKEN_FILE);
    const out = await call(manifest.ports.RenderPort);
    expect(out.pageCount).toBe(3);
    expect(r.seen).toHaveLength(1);
  });
});

describe('no renderer settings: a call rejects with reporting.render_unavailable and leaks nothing', () => {
  const cases: Array<[string, () => void]> = [
    ['neither set', () => setRenderer(undefined, undefined)],
    ['only the URL set', () => setRenderer('https://renderer.invalid/PLANTED-url-path', undefined)],
    ['only the token file set', () => setRenderer(undefined, TOKEN_FILE)],
  ];
  it.each(cases)('%s', async (_name, arrange) => {
    const manifest = await loadManifest();
    arrange();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const e = await rejection(call(manifest.ports.RenderPort));
    expect(e.code).toBe('reporting.render_unavailable');
    const text = dump(e);
    for (const secret of [TOKEN, TOKEN_FILE, SECRET_DIR, 'secret-dir-zq81', 'renderer.invalid', 'PLANTED-url-path', 'http://', 'https://']) expect(text, secret).not.toContain(secret);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a second call after the variables appear works (an unset setting is not cached as a permanent failure)', async () => {
    const manifest = await loadManifest();
    setRenderer(undefined, undefined);
    expect((await rejection(call(manifest.ports.RenderPort, 'wire-rep-a'))).code).toBe('reporting.render_unavailable');
    const r = await startRenderer();
    setRenderer(r.url, TOKEN_FILE);
    expect((await call(manifest.ports.RenderPort, 'wire-rep-b')).pageCount).toBe(3);
  });

  it('a token file that cannot be read rejects and the error holds no path, URL or token', async () => {
    const manifest = await loadManifest();
    const gone = join(SECRET_DIR, 'gone.token');
    setRenderer('https://renderer.invalid', gone);
    const e = await rejection(call(manifest.ports.RenderPort));
    const text = dump(e);
    for (const secret of [gone, 'secret-dir-zq81', 'gone.token', 'renderer.invalid']) expect(text, secret).not.toContain(secret);
  });
});

describe('with a local 127.0.0.1 renderer and a temp token file: the real createRenderPort does the call', () => {
  it('posts /internal/render with the bearer token and maps the PDF result', async () => {
    const manifest = await loadManifest();
    const r = await startRenderer();
    setRenderer(r.url, TOKEN_FILE);
    const out = await call(manifest.ports.RenderPort);
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]!.method).toBe('POST');
    expect(r.seen[0]!.url).toBe('/internal/render');
    expect(r.seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.seen[0]!.body.template_id).toBe('analytics.report');
    const bytes = Buffer.from(out.contentBase64, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out).toEqual({ contentBase64: out.contentBase64, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), byteSize: bytes.length, pageCount: 3 });
  });

  it('keeps the real impl guards: a non-system actor is auth.forbidden and the renderer is not called', async () => {
    const manifest = await loadManifest();
    const r = await startRenderer();
    setRenderer(r.url, TOKEN_FILE);
    const e = await rejection(manifest.ports.RenderPort.renderPdf({ actor: { type: 'user' } }, { templateKey: 'analytics.report', data: analytics(), idempotencyKey: 'wire-rep-u' }));
    expect(e.code).toBe('auth.forbidden');
    expect(r.seen).toHaveLength(0);
  });

  it('renderer 503 → reporting.render_unavailable (the facade adds no error mapping of its own)', async () => {
    const manifest = await loadManifest();
    const r = await startRenderer(503);
    setRenderer(r.url, TOKEN_FILE);
    expect((await rejection(call(manifest.ports.RenderPort))).code).toBe('reporting.render_unavailable');
  });
});

describe('log scan: token, token path and URL are never logged or echoed', () => {
  it('planted token: nothing written to console/stdout/stderr on success, renderer error or unreachable renderer, and no error carries it', async () => {
    const out: string[] = [];
    const grab = (...a: unknown[]) => { out.push(a.map((x) => (typeof x === 'string' ? x : x instanceof Uint8Array ? Buffer.from(x).toString() : JSON.stringify(x))).join(' ')); return true; };
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(grab as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(grab as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(grab as never);

    const manifest = await loadManifest();
    const ok = await startRenderer(); const fail = await startRenderer(500); const dead = await deadUrl();
    const errors: unknown[] = [];
    for (const url of [ok.url, fail.url, dead]) {
      setRenderer(url, TOKEN_FILE);
      try { await call(manifest.ports.RenderPort, `wire-rep-${errors.length}`); } catch (e) { errors.push(e); }
    }
    setRenderer(undefined, undefined);
    try { await call(manifest.ports.RenderPort, 'wire-rep-unset'); } catch (e) { errors.push(e); }
    expect(errors).toHaveLength(3);                       // renderer 500, dead renderer, unset

    const everything = out.join('\n') + '\n' + errors.map(dump).join('\n');
    for (const secret of [TOKEN, TOKEN_FILE, SECRET_DIR, 'secret-dir-zq81', ok.url, fail.url, dead]) expect(everything, secret).not.toContain(secret);
  });
});
