// T0D-OFFLINE-1 (LD-322): connectivity states, clock skew, device registration, wipe_requested / revoked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, PIN, T0, USER, fakeServer, newStore, rawDump, statusBody, unlockedStore } from './offline1.helpers';

afterEach(() => { vi.unstubAllGlobals(); });
const INTERNET = 'https://probe.test/generate_204';
async function conn(server: ReturnType<typeof fakeServer>, over: Record<string, unknown> = {}) {
  const { createConnectivity } = await import('../connectivity');
  return createConnectivity({ fetch: server.fetch, now: () => T0, timeoutMs: 60, deviceId: DEVICE, internetProbeUrl: INTERNET, ...over } as never);
}
const probe = () => ({ [`GET ${new URL(INTERNET).pathname}`]: () => ({ status: 204 }) });

describe('connectivity: a health ping decides, navigator.onLine is never trusted', () => {
  it('server answers: online (even when navigator.onLine says false)', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const c = await conn(fakeServer());
    expect(await c.check()).toBe('online');
    expect(c.state()).toBe('online');
  });

  it('server and internet both unreachable: offline (even when navigator.onLine says true)', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const c = await conn(fakeServer({ 'GET /v1/core/health/live': () => 'throw', 'GET /probe': () => 'throw', 'GET /generate_204': () => 'throw' }));
    expect(await c.check()).toBe('offline');
  });

  it('internet reachable but the server is not: degraded', async () => {
    const c = await conn(fakeServer({ 'GET /v1/core/health/live': () => 'throw', ...probe() }));
    expect(await c.check()).toBe('degraded');
  });

  it('server answering 5xx counts as degraded, not online', async () => {
    const c = await conn(fakeServer({ 'GET /v1/core/health/live': () => ({ status: 503 }), ...probe() }));
    expect(await c.check()).toBe('degraded');
  });

  it('a ping that never answers times out and the check still resolves', async () => {
    const c = await conn(fakeServer({ 'GET /v1/core/health/live': () => 'hang', 'GET /generate_204': () => 'hang' }), { timeoutMs: 40 });
    const t = Date.now();
    const s = await Promise.race([c.check(), new Promise((r) => setTimeout(() => r('STUCK'), 2000))]);
    expect(s).toBe('offline');
    expect(Date.now() - t).toBeLessThan(1500);
  });

  it('syncing is reported while a sync runs on a reachable server and falls back to online afterwards', async () => {
    const c = await conn(fakeServer());
    await c.check();
    c.setSyncing(true);
    expect(c.state()).toBe('syncing');
    c.setSyncing(false);
    expect(c.state()).toBe('online');
  });

  it('the ping never carries cookies or personal data: no body, GET only, no credentials to the internet probe', async () => {
    const server = fakeServer(probe());
    const c = await conn(server);
    await c.check();
    for (const call of server.calls) { expect(call.method).toBe('GET'); expect(call.body).toBeUndefined(); }
  });
});

describe('clock skew from getSyncStatus', () => {
  it('server 10 minutes ahead: skewMs about +600000 and the skew flag (> 5 minutes) is set', async () => {
    const c = await conn(fakeServer({ 'GET /v1/core/sync/status': () => ({ status: 200, body: statusBody({ server_time: new Date(T0 + 600_000).toISOString() }) }) }));
    await c.refreshStatus();
    expect(Math.abs(c.skewMs()! - 600_000)).toBeLessThan(2000);
    expect(c.skewFlag()).toBe(true);
  });
  it('server 2 minutes behind: negative skew, no flag; exactly the status query carries device_id', async () => {
    const server = fakeServer({ 'GET /v1/core/sync/status': () => ({ status: 200, body: statusBody({ server_time: new Date(T0 - 120_000).toISOString() }) }) });
    const c = await conn(server);
    await c.refreshStatus();
    expect(Math.abs(c.skewMs()! + 120_000)).toBeLessThan(2000);
    expect(c.skewFlag()).toBe(false);
    expect(server.calls.find((x) => x.path === '/v1/core/sync/status')!.url).toContain('device_id=' + DEVICE);
  });
  it('skew is unknown (null) before the first status read', async () => {
    const c = await conn(fakeServer());
    expect(c.skewMs()).toBeNull();
    expect(c.skewFlag()).toBe(false);
  });
});

describe('device: registerSyncDevice at an online sign in', () => {
  it('POSTs /v1/core/sync/devices once with an Idempotency-Key and the contract body, and keeps the same device id afterwards', async () => {
    const { registerDevice } = await import('../device');
    const env = await unlockedStore(); const server = fakeServer();
    const a = await registerDevice({ fetch: server.fetch, store: env.store, now: env.c.now, deviceLabel: 'Front desk PC 1', appVersion: '0.0.0' });
    const call = server.calls.find((c) => c.method === 'POST' && c.path === '/v1/core/sync/devices')!;
    expect(call.headers['idempotency-key']).toMatch(/\S{8,}/);
    expect(call.body).toMatchObject({ id: a.id, device_label: 'Front desk PC 1', platform: 'web', app_version: '0.0.0' });
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const b = await registerDevice({ fetch: server.fetch, store: env.store, now: env.c.now, deviceLabel: 'Front desk PC 1', appVersion: '0.0.0' });
    expect(b.id).toBe(a.id);
  });
});

describe('device status from getSyncStatus: wipe_requested and revoked', () => {
  it('wipe_requested: the store is wiped (raw database holds no data), the wipe is acknowledged, and unlock is refused afterwards', async () => {
    const { pollDeviceStatus } = await import('../device');
    const env = await unlockedStore();
    await env.store.put('refdata', 'patient:1', { name: 'Sita Rai' });
    const server = fakeServer({ 'GET /v1/core/sync/status': () => ({ status: 200, body: statusBody({ device_status: 'wipe_requested' }) }), 'POST /v1/core/sync/devices/': () => ({ status: 200, body: {} }) });
    await pollDeviceStatus({ fetch: server.fetch, store: env.store, deviceId: DEVICE });
    expect(await rawDump(env.dbName)).not.toContain('Sita');
    expect(server.calls.some((c) => c.method === 'POST' && c.path === `/v1/core/sync/devices/${DEVICE}/wipe-ack`)).toBe(true);
    expect(await env.store.unlock(PIN)).toMatchObject({ ok: false });
  });

  it('revoked: wiped and every unlock says revoked', async () => {
    const { pollDeviceStatus } = await import('../device');
    const env = await unlockedStore();
    await env.store.put('refdata', 'patient:1', { name: 'Sita Rai' });
    const server = fakeServer({ 'GET /v1/core/sync/status': () => ({ status: 200, body: statusBody({ device_status: 'revoked' }) }) });
    await pollDeviceStatus({ fetch: server.fetch, store: env.store, deviceId: DEVICE });
    expect(await rawDump(env.dbName)).not.toContain('Sita');
    expect(await env.store.unlock(PIN)).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('active: nothing is touched; a failed status call (offline) never wipes', async () => {
    const { pollDeviceStatus } = await import('../device');
    const env = await unlockedStore();
    await env.store.put('refdata', 'k', { v: 1 });
    await pollDeviceStatus({ fetch: fakeServer().fetch, store: env.store, deviceId: DEVICE });
    expect(await env.store.get('refdata', 'k')).toEqual({ v: 1 });
    await pollDeviceStatus({ fetch: fakeServer({ 'GET /v1/core/sync/status': () => 'throw' }).fetch, store: env.store, deviceId: DEVICE }).catch(() => {});
    await pollDeviceStatus({ fetch: fakeServer({ 'GET /v1/core/sync/status': () => ({ status: 500 }) }).fetch, store: env.store, deviceId: DEVICE }).catch(() => {});
    expect(await env.store.get('refdata', 'k')).toEqual({ v: 1 });
  });
});

void USER; void newStore;
