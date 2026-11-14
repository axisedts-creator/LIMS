// PG-T17 shared fixtures: KEK files, payments config, gateway fetch simulators, planted secrets, console/stdout spies. Synthetic data only.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { loadPaymentsConfig, type PaymentsConfig } from '../../config.js';
import { loadKek, type Kek } from '../../service/credentials.js';
import testEnv from '../test-env.js';

const dir = mkdtempSync(join(tmpdir(), 'lims-pg-t17-'));
let n = 0;
/** Writes a KEK file and loads it through the real PG-T03 loader. */
export function makeKek(active: string, ids: string[] = [active]): Kek {
  const p = join(dir, `kek-${n++}.json`);
  writeFileSync(p, JSON.stringify({ keys: Object.fromEntries(ids.map((i) => [i, randomBytes(32).toString('base64')])), active }), { mode: 0o600 });
  return loadKek(p);
}
/** Same key bytes as `base`, but a different active id (a KEK rotation: the file keeps the old key, the active one changes). */
export function rotateKek(base: Kek, newId: string): Kek {
  const keys = Object.fromEntries([...base.keys].map(([k, v]) => [k, v.toString('base64')]));
  keys[newId] = randomBytes(32).toString('base64');
  const p = join(dir, `kek-${n++}.json`);
  writeFileSync(p, JSON.stringify({ keys, active: newId }), { mode: 0o600 });
  return loadKek(p);
}
/** A KEK holding only `id`'s key (as the file would after the old key is retired). */
export function onlyKey(kek: Kek, id: string): Kek {
  const p = join(dir, `kek-${n++}.json`);
  writeFileSync(p, JSON.stringify({ keys: { [id]: kek.keys.get(id)!.toString('base64') }, active: id }), { mode: 0o600 });
  return loadKek(p);
}

export const uatConfig = (extra: Record<string, string> = {}): PaymentsConfig => loadPaymentsConfig({ ...testEnv, ...extra });
export const prodConfig = (extra: Record<string, string> = {}): PaymentsConfig => loadPaymentsConfig({
  ...testEnv, NODE_ENV: 'production', LIMS_PAYMENTS_GATEWAY_ENV: 'production',
  LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://epay.esewa.com.np/api/epay/main/v2/form', ...extra,
});

/** Random planted secret: unique per call so a leak anywhere is attributable. */
export const plantSecret = (tag = 'sk'): string => `${tag}_${randomBytes(16).toString('hex')}`;
export const variants = (secret: string): string[] => [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), encodeURIComponent(secret)];

// ---------------------------------------------------------------- gateway simulators (fetch)
export interface Call { url: string; method: string; headers: string; body: string; signal?: AbortSignal }
export type FetchSim = ((input: unknown, init?: any) => Promise<Response>) & { calls: Call[] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const record = (calls: Call[], input: unknown, init: any): Call => {
  const c: Call = {
    url: typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url, method: init?.method ?? 'GET',
    headers: JSON.stringify(init?.headers instanceof Headers ? [...init.headers] : (init?.headers ?? {})), body: typeof init?.body === 'string' ? init.body : JSON.stringify(init?.body ?? ''), signal: init?.signal,
  };
  calls.push(c); return c;
};
/** Khalti sim: the lookup answers `404 {"detail":"Not found."}` when the account's secret appears in the request headers, else `401 Invalid token.`. */
export const khaltiSim = (validSecret: string): FetchSim => {
  const calls: Call[] = [];
  const f = (async (input: unknown, init?: any) => {
    const c = record(calls, input, init);
    return c.headers.includes(validSecret) ? json(404, { detail: 'Not found.', error_key: 'validation_error' }) : json(401, { detail: 'Invalid token.', status_code: 401 });
  }) as FetchSim;
  f.calls = calls; return f;
};
/** eSewa sim: the status check needs no secret and answers a documented JSON body (`status` or `code`). */
export const esewaSim = (shape: 'status' | 'code' = 'status'): FetchSim => {
  const calls: Call[] = [];
  const f = (async (input: unknown, init?: any) => { record(calls, input, init); return json(200, shape === 'status' ? { status: 'NOT_FOUND' } : { code: 0, error_message: 'Not found' }); }) as FetchSim;
  f.calls = calls; return f;
};
export const failingSim = (err: Error): FetchSim => {
  const calls: Call[] = [];
  const f = (async (input: unknown, init?: any) => { record(calls, input, init); throw err; }) as FetchSim;
  f.calls = calls; return f;
};
/** Never answers; rejects only when the caller's AbortSignal fires (proves the call is time-bounded). */
export const hangingSim = (): FetchSim => {
  const calls: Call[] = [];
  const f = ((input: unknown, init?: any) => {
    const c = record(calls, input, init);
    return new Promise<Response>((_res, rej) => { c.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  }) as FetchSim;
  f.calls = calls; return f;
};

/** Captures everything written through console and stdout/stderr while a scenario runs. */
export function captureOutput() {
  const chunks: string[] = [];
  const push = (...a: unknown[]) => { chunks.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); };
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(push as never));
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => { push(Buffer.isBuffer(c) ? c.toString('utf8') : c); return true; }) as never);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { push(Buffer.isBuffer(c) ? c.toString('utf8') : c); return true; }) as never);
  return { text: () => chunks.join('\n'), restore: () => { for (const s of [...spies, out, err]) s.mockRestore(); } };
}
