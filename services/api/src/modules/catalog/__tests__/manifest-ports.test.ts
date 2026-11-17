// WIRE-CAT (C1) — the catalog manifest exports the real CatalogPort (LD-185; 02-TRD §6.3 port registry, AC-0D-6.1/6.2/6.4; C3 02-TRD §6.3 read cache).
// Synthetic data only. No database, no network: the port is only constructed, never called.
// Expected: ../index.ts `manifest.ports = { CatalogPort }` = createCatalogPort({ cache }) over ONE process-wide createCatalogCache(loadCatalogConfig(process.env)).
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PORT_OWNERS, REPO_ROOT, validateManifest } from '../../../core/module.js';
import { resolvePorts } from '../../../core/ports/registry.js';

const noop = () => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop };
const metrics = { setGauge: noop, inc: noop };

// Every other port as an inert marker: only CatalogPort is under test, the rest must not change its resolution.
const fakes = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, { kind: 'fake', port: p }]));
const consumers = Object.fromEntries(Object.keys(PORT_OWNERS).map((p) => [p, ['frontdesk'] as readonly string[]]));
const otherOwners = (): Array<{ name: string; ports: Record<string, unknown> }> => {
  const byOwner = new Map<string, Record<string, unknown>>();
  for (const [port, owner] of Object.entries(PORT_OWNERS)) {
    if (port === 'CatalogPort') continue;
    byOwner.set(owner, { ...(byOwner.get(owner) ?? {}), [port]: { kind: 'real', port } });
  }
  return [...byOwner].map(([name, ports]) => ({ name, ports }));
};

const METHODS = ['getTest', 'getPanel', 'resolveOrderables', 'referenceRangeFor', 'criticalLimitsFor', 'mapInstrumentCode', 'priceFor', 'getTaxRate', 'getPriceListStatus'];

async function loadManifest(env: Record<string, string> = {}): Promise<any> {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (k.startsWith('LIMS_')) vi.stubEnv(k, undefined as never);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('../index.js')).manifest;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('../cache/catalogCache.js'); vi.doUnmock('../ports/CatalogPort.impl.js'); vi.resetModules(); });

describe('catalog manifest ports (LD-185)', () => {
  it('validateManifest accepts the manifest', async () => {
    const manifest = await loadManifest();
    expect(() => validateManifest('catalog', manifest, REPO_ROOT)).not.toThrow();
  });

  it('ports keys equal exactly [CatalogPort]', async () => {
    const manifest = await loadManifest();
    expect(Object.keys(manifest.ports ?? {})).toEqual(['CatalogPort']);
  });

  it('the port has every CatalogPortV1 method the registry consumers use', async () => {
    const port = (await loadManifest()).ports?.CatalogPort;
    expect(port).toBeDefined();
    for (const m of METHODS) expect(typeof port[m], m).toBe('function');
  });

  it('two imports share one instance (one process-wide port, one cache)', async () => {
    const m1 = await loadManifest();
    const { manifest: m2 } = await import('../index.js');
    expect(m2.ports.CatalogPort).toBe(m1.ports.CatalogPort);
    expect(m1.ports.CatalogPort).toBe(m1.ports.CatalogPort); // not a getter that builds a new port per read
  });

  it('empty env works (every LIMS_* removed)', async () => {
    const manifest = await loadManifest({});
    expect(Object.keys(process.env).filter((k) => k.startsWith('LIMS_'))).toEqual([]);
    expect(manifest.ports.CatalogPort).toBeDefined();
  });
});

describe('registry resolution (02-TRD §6.3)', () => {
  const resolve = (env: string, mods: unknown[], forceFake?: string[]) =>
    resolvePorts({ env, modules: mods as never, forceFake, fakes, stubs: {}, phaseStubs: [], owners: PORT_OWNERS, consumers, log, metrics });

  it('staging, PORT_OWNERS, no fakes forced: CatalogPort resolves real', async () => {
    const manifest = await loadManifest();
    const { resolution } = resolve('staging', [{ name: 'catalog', ports: manifest.ports }, ...otherOwners()]);
    expect(resolution.CatalogPort).toBe('real');
  });

  it('staging: the exported port is the one handed to a listed consumer', async () => {
    const manifest = await loadManifest();
    const { portsFor } = resolve('staging', [{ name: 'catalog', ports: manifest.ports }, ...otherOwners()]);
    expect((portsFor('frontdesk') as any).CatalogPort).toBe(manifest.ports.CatalogPort);
  });

  it.each(['dev', 'ci'])('%s: real beats the fake once the owner exports it', async (env) => {
    const manifest = await loadManifest();
    const { resolution } = resolve(env, [{ name: 'catalog', ports: manifest.ports }]);
    expect(resolution.CatalogPort).toBe('real');
  });

  it('dev/ci: LIMS_CORE_FAKE_PORTS=CatalogPort still forces the fake (registry not weakened)', async () => {
    const manifest = await loadManifest();
    const { resolution } = resolve('ci', [{ name: 'catalog', ports: manifest.ports }], ['CatalogPort']);
    expect(resolution.CatalogPort).toBe('fake');
  });

  it('staging/production: forcing the fake is still a boot failure', async () => {
    const manifest = await loadManifest();
    expect(() => resolve('production', [{ name: 'catalog', ports: manifest.ports }, ...otherOwners()], ['CatalogPort'])).toThrow(/not allowed in production/);
  });

  it('staging without the catalog module still fails (the manifest line is the only thing that fixes CatalogPort)', () => {
    expect(() => resolve('staging', otherOwners())).toThrow(/CatalogPort: owner module catalog not loaded/);
  });
});

describe('construction (LD-185 rule 2: no I/O, no env var, one cache from loadCatalogConfig)', () => {
  async function withSpies(env: Record<string, string>) {
    const cache = { get: noop, set: noop, getOrLoad: noop, size: 0, clear: noop };
    const createCatalogCache = vi.fn(() => cache);
    const createCatalogPort = vi.fn(() => ({ fake: 'port' }));
    vi.resetModules();
    vi.doMock('../cache/catalogCache.js', async (orig) => ({ ...(await orig<object>()), createCatalogCache }));
    vi.doMock('../ports/CatalogPort.impl.js', async (orig) => ({ ...(await orig<object>()), createCatalogPort }));
    for (const k of Object.keys(process.env)) if (k.startsWith('LIMS_')) vi.stubEnv(k, undefined as never);
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const manifest = (await import('../index.js')).manifest as any;
    void manifest.ports.CatalogPort; // construction may be eager or lazy; reading it must trigger it by now
    const again = (await import('../index.js')).manifest as any;
    void again.ports.CatalogPort;
    return { manifest, cache, createCatalogCache, createCatalogPort };
  }

  it('no env: default cache bounds (50000 entries, 600 s), cache built once, port built once over that same cache', async () => {
    const { manifest, cache, createCatalogCache, createCatalogPort } = await withSpies({});
    expect(createCatalogCache).toHaveBeenCalledTimes(1);
    expect(createCatalogCache).toHaveBeenCalledWith(expect.objectContaining({ maxEntries: 50000, ttlSeconds: 600 }));
    expect(createCatalogPort).toHaveBeenCalledTimes(1);
    expect(createCatalogPort).toHaveBeenCalledWith({ cache });
    expect(manifest.ports.CatalogPort).toEqual({ fake: 'port' });
  });

  it('LIMS_CATALOG_CACHE_MAX_ENTRIES / _TTL_SECONDS are read from process.env (loadCatalogConfig)', async () => {
    const { createCatalogCache } = await withSpies({ LIMS_CATALOG_CACHE_MAX_ENTRIES: '123', LIMS_CATALOG_CACHE_TTL_SECONDS: '7' });
    expect(createCatalogCache).toHaveBeenCalledWith(expect.objectContaining({ maxEntries: 123, ttlSeconds: 7 }));
  });

  it('importing the manifest and reading the port opens no socket and makes no fetch', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const manifest = await loadManifest({});
    void manifest.ports.CatalogPort;
    expect(connect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
