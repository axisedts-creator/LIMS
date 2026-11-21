// T0D-OFFLINE-1 (LD-322 decision 4): device registry client. registerSyncDevice at an online sign in (the device id is
// kept in the encrypted meta store); getSyncStatus drives remote wipe (wipe, then ackDeviceWipe) and revoke.
// A failed status call never wipes.
import { timedFetch, type SyncStatusBody } from './connectivity';
import type { OfflineStore } from './store';

interface Ctx { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number }
const f = (c: Ctx) => c.fetch ?? globalThis.fetch.bind(globalThis);

async function problem(res: Response | null, what: string): Promise<Error> {
  const body = res ? ((await res.json().catch(() => null)) as { code?: string } | null) : null;
  return Object.assign(new Error(`${what} failed: ${res ? res.status : 'network'}`), { code: body?.code, status: res?.status });
}

export async function registerDevice(c: Ctx & { store: OfflineStore; now?: () => number; deviceLabel: string; appVersion: string }): Promise<{ id: string }> {
  const saved = await c.store.get<{ id: string }>('meta', 'device');
  const id = saved?.id ?? globalThis.crypto.randomUUID();
  if (!saved) await c.store.put('meta', 'device', { id });
  const res = await timedFetch(f(c), `${c.baseUrl ?? ''}/v1/core/sync/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': globalThis.crypto.randomUUID() },
    body: JSON.stringify({ id, device_label: c.deviceLabel, platform: 'web', app_version: c.appVersion }),
    credentials: 'same-origin',
  }, c.timeoutMs ?? 15_000);
  if (!res?.ok) throw await problem(res, 'registerSyncDevice');
  return { id };
}

export async function pollDeviceStatus(c: Ctx & { store: OfflineStore; deviceId: string }): Promise<SyncStatusBody> {
  const base = c.baseUrl ?? '';
  const ms = c.timeoutMs ?? 15_000;
  const res = await timedFetch(f(c), `${base}/v1/core/sync/status?device_id=${encodeURIComponent(c.deviceId)}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }, ms);
  if (!res?.ok) throw await problem(res, 'getSyncStatus');
  const body = (await res.json()) as SyncStatusBody;
  if (body.device_status === 'revoked') await c.store.markRevoked();
  else if (body.device_status === 'wipe_requested') {
    await c.store.wipe('wiped');
    // ack after the wipe; a lost ack is repeated on the next poll (the wipe is idempotent)
    await timedFetch(f(c), `${base}/v1/core/sync/devices/${encodeURIComponent(c.deviceId)}/wipe-ack`, { method: 'POST', credentials: 'same-origin' }, ms);
  }
  return body;
}
