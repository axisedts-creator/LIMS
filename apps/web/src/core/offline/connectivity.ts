// T0D-OFFLINE-1 (LD-322; offline design section 4): connectivity is decided by a health ping with a timeout, never by
// navigator.onLine. online = server answers; degraded = internet up (or a 5xx came back) but the server is not usable;
// offline = nothing answers; syncing = online and a batch is in flight. Clock skew comes from getSyncStatus.server_time.

export type ConnState = 'online' | 'offline' | 'degraded' | 'syncing';
export const SKEW_FLAG_MS = 5 * 60_000;

export interface SyncStatusBody {
  server_time: string;
  device_status: 'active' | 'revoked' | 'wipe_requested';
  min_app_version?: string;
  limits: { max_batch_operations: number; max_batch_bytes: number };
  retry: { base_delay_ms: number; max_delay_ms: number; jitter: 'full' };
  offline_approval_allowed: boolean;
}

/** fetch with a hard timeout; resolves to the Response or null (network error, timeout). */
export async function timedFetch(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response | null> {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      f(url, { ...init, signal: ac?.signal ?? null }).catch(() => null),
      new Promise<null>((r) => { timer = setTimeout(() => { ac?.abort(); r(null); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function createConnectivity(o: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; deviceId?: string; internetProbeUrl?: string; baseUrl?: string }) {
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const now = o.now ?? Date.now;
  const ms = o.timeoutMs ?? 5000;
  const base = o.baseUrl ?? '';
  let last: Exclude<ConnState, 'syncing'> = 'offline';
  let syncing = false; let skew: number | null = null; let status: SyncStatusBody | null = null;

  return {
    async check(): Promise<ConnState> {
      const res = await timedFetch(f, `${base}/v1/core/health/live`, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }, ms);
      if (res?.ok) last = 'online';
      else if (res) last = 'degraded';
      else if (o.internetProbeUrl) {
        const probe = await timedFetch(f, o.internetProbeUrl, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }, ms);
        last = probe ? 'degraded' : 'offline';
      } else last = 'offline';
      return this.state();
    },
    state: (): ConnState => (syncing && last === 'online' ? 'syncing' : last),
    setSyncing(b: boolean) { syncing = b; },
    /** Reads getSyncStatus; skew = server_time minus the local midpoint of the request. Throws when the call fails. */
    async refreshStatus(): Promise<SyncStatusBody> {
      if (!o.deviceId) throw new Error('deviceId is required for the sync status');
      const t0 = now();
      const res = await timedFetch(f, `${base}/v1/core/sync/status?device_id=${encodeURIComponent(o.deviceId)}`, { method: 'GET', cache: 'no-store', credentials: 'same-origin' }, ms);
      if (!res?.ok) throw new Error(`sync status failed: ${res ? res.status : 'network'}`);
      const body = (await res.json()) as SyncStatusBody;
      const server = Date.parse(body.server_time);
      if (Number.isFinite(server)) skew = server - (t0 + now()) / 2;
      status = body;
      return body;
    },
    skewMs: () => skew,
    skewFlag: () => skew !== null && Math.abs(skew) > SKEW_FLAG_MS,
    lastStatus: () => status,
  };
}

export type Connectivity = ReturnType<typeof createConnectivity>;
