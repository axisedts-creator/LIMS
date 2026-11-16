// T0A-CLIENTIP-1 / LD-296: apps/web/src/core/api/client-context.ts (server only helper). ASSUMED contract:
//   export async function readClientContext(): Promise<{ ip?: string; userAgent?: string }>
//   ip = first entry of x-forwarded-for, else x-real-ip; only when it is a bare IP literal (no list, no port, no zone, no CIDR). Else undefined.
//   userAgent = user-agent trimmed, at most 512 characters (longer is truncated, not dropped). Missing/blank -> undefined (the key is absent).
//   Reads next/headers only; if headers() throws (outside a request) -> {}. Never logs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ current: undefined as unknown as Headers, fail: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => {
    if (h.fail) throw new Error('headers() was called outside a request scope');
    return h.current;
  },
}));
import { readClientContext } from '../client-context';

const set = (o: Record<string, string>) => { h.current = new Headers(o); };
beforeEach(() => { h.fail = false; set({}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('client ip', () => {
  it('single x-forwarded-for literal', async () => {
    set({ 'x-forwarded-for': '203.0.113.7' });
    expect((await readClientContext()).ip).toBe('203.0.113.7');
  });
  it.each([
    ['203.0.113.7, 10.0.0.1', '203.0.113.7'],
    ['203.0.113.7,10.0.0.1,10.0.0.2', '203.0.113.7'],
    ['  203.0.113.7  , 10.0.0.1', '203.0.113.7'],
    ['2001:db8::1, 10.0.0.1', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:203.0.113.7', '::ffff:203.0.113.7'],
  ])('x-forwarded-for %j -> first entry %s only', async (xff, want) => {
    set({ 'x-forwarded-for': xff });
    expect((await readClientContext()).ip).toBe(want);
  });
  it.each(['203.0.113.7:51234', '[2001:db8::1]:443', '[2001:db8::1]', 'not-an-ip', '999.1.1.1', '1.2.3', '203.0.113.7/24', 'fe80::1%eth0',
    "203.0.113.7'--", '<script>', 'unknown', '', ' '])('junk first entry %j -> no ip (never a port, a list or text)', async (xff) => {
    set({ 'x-forwarded-for': xff });
    expect((await readClientContext()).ip).toBeUndefined();
  });
  it('junk first entry is not replaced by a LATER entry', async () => {
    set({ 'x-forwarded-for': 'unknown, 203.0.113.7' });
    expect((await readClientContext()).ip).toBeUndefined();
  });
  it('x-real-ip is the fallback when x-forwarded-for is absent', async () => {
    set({ 'x-real-ip': '198.51.100.9' });
    expect((await readClientContext()).ip).toBe('198.51.100.9');
  });
  it('x-real-ip is the fallback when x-forwarded-for is empty', async () => {
    set({ 'x-forwarded-for': '', 'x-real-ip': '198.51.100.9' });
    expect((await readClientContext()).ip).toBe('198.51.100.9');
  });
  it('x-forwarded-for wins over x-real-ip', async () => {
    set({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.9' });
    expect((await readClientContext()).ip).toBe('203.0.113.7');
  });
  it.each(['198.51.100.9:80', '198.51.100.9, 10.0.0.1', 'junk'])('x-real-ip %j that is not a bare literal -> no ip', async (v) => {
    set({ 'x-real-ip': v });
    expect((await readClientContext()).ip).toBeUndefined();
  });
  it('no headers -> no ip', async () => {
    expect((await readClientContext()).ip).toBeUndefined();
  });
});

describe('user agent', () => {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  it('passes the browser user agent through', async () => {
    set({ 'user-agent': UA });
    expect((await readClientContext()).userAgent).toBe(UA);
  });
  it('trims surrounding whitespace', async () => {
    set({ 'user-agent': `   ${UA}   ` });
    expect((await readClientContext()).userAgent).toBe(UA);
  });
  it('exactly 512 characters is kept whole', async () => {
    const ua = 'u'.repeat(512);
    set({ 'user-agent': ua });
    expect((await readClientContext()).userAgent).toBe(ua);
  });
  it('longer than 512 characters is truncated to 512 (not dropped)', async () => {
    set({ 'user-agent': 'a'.repeat(513) });
    expect((await readClientContext()).userAgent).toBe('a'.repeat(512));
    set({ 'user-agent': 'b'.repeat(5000) });
    expect((await readClientContext()).userAgent).toBe('b'.repeat(512));
  });
  it('trim happens before the cap (spaces do not eat the budget)', async () => {
    set({ 'user-agent': ` ${'c'.repeat(600)} ` });
    expect((await readClientContext()).userAgent).toBe('c'.repeat(512));
  });
  it.each(['', '   '])('blank user agent %j -> absent', async (v) => {
    set({ 'user-agent': v });
    const c = await readClientContext();
    expect(c.userAgent).toBeUndefined();
    expect(Object.keys(c)).not.toContain('userAgent');
  });
  it('missing user agent -> absent', async () => {
    expect((await readClientContext()).userAgent).toBeUndefined();
  });
});

describe('safety', () => {
  it('returns ONLY ip and userAgent: cookie, authorization and other headers are never copied', async () => {
    set({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA/1', cookie: '__Host-lims_sid=SECRET-SID', authorization: 'Bearer SECRET-JWT', 'x-lims-bff-key': 'SECRET-KEY' });
    const c = await readClientContext();
    expect(Object.keys(c).sort()).toEqual(['ip', 'userAgent']);
    expect(JSON.stringify(c)).not.toMatch(/SECRET/);
  });
  it('nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    set({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA/1', cookie: '__Host-lims_sid=SECRET-SID' });
    await readClientContext();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
  it('no headers() scope (throws) -> empty context, no throw', async () => {
    h.fail = true;
    await expect(readClientContext()).resolves.toEqual({});
  });
  it('empty context has neither key', async () => {
    expect(Object.keys(await readClientContext())).toEqual([]);
  });
});
