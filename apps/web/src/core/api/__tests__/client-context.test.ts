// T0A-CLIENTIP-1 / LD-296, amended by SEC-ABUSE-1 / LD-237 (audit 2.4): apps/web/src/core/api/client-context.ts (server only helper, the ONE helper every BFF call uses).
//   export async function readClientContext(): Promise<{ ip?: string; userAgent?: string }>
//   ip = x-vercel-forwarded-for (set by the Vercel edge, cannot be supplied by the client), else x-real-ip, else NOTHING (key absent: no header is sent,
//        and the API then sees the connection address of its peer). Only a bare IP literal (no list, no port, no zone, no CIDR) is ever accepted.
//   The client-supplied x-forwarded-for is NEVER read: its first element is attacker-chosen (the old behaviour; each request could pick its own counter key).
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
import { clientContextHeaders, readClientContext } from '../client-context';

const set = (o: Record<string, string>) => { h.current = new Headers(o); };
beforeEach(() => { h.fail = false; set({}); });
afterEach(() => { vi.restoreAllMocks(); });

const V = 'x-vercel-forwarded-for', R = 'x-real-ip', X = 'x-forwarded-for';

describe('client ip: header combinations (SEC-ABUSE-1 table)', () => {
  it.each([
    // [name, incoming headers, expected ip]
    ['vercel header only', { [V]: '203.0.113.7' }, '203.0.113.7'],
    ['vercel header, IPv6', { [V]: '2001:db8::1' }, '2001:db8::1'],
    ['vercel header, IPv4-mapped IPv6', { [V]: '::ffff:203.0.113.7' }, '::ffff:203.0.113.7'],
    ['vercel header with surrounding spaces', { [V]: '  203.0.113.7  ' }, '203.0.113.7'],
    ['vercel header wins over x-real-ip', { [V]: '203.0.113.7', [R]: '198.51.100.9' }, '203.0.113.7'],
    ['vercel header wins over a spoofed x-forwarded-for', { [V]: '203.0.113.7', [X]: '6.6.6.6' }, '203.0.113.7'],
    ['vercel header wins over a spoofed x-forwarded-for list', { [V]: '203.0.113.7', [X]: '6.6.6.6, 203.0.113.7' }, '203.0.113.7'],
    ['all three: vercel header', { [V]: '203.0.113.7', [R]: '198.51.100.9', [X]: '6.6.6.6' }, '203.0.113.7'],
    ['x-real-ip when no vercel header', { [R]: '198.51.100.9' }, '198.51.100.9'],
    ['x-real-ip when the vercel header is empty', { [V]: '', [R]: '198.51.100.9' }, '198.51.100.9'],
    ['x-real-ip wins over a spoofed x-forwarded-for', { [R]: '198.51.100.9', [X]: '6.6.6.6, 10.0.0.1' }, '198.51.100.9'],
    ['x-forwarded-for ALONE is never used (single value)', { [X]: '6.6.6.6' }, undefined],
    ['x-forwarded-for ALONE is never used (list, first element)', { [X]: '6.6.6.6, 203.0.113.7' }, undefined],
    ['x-forwarded-for ALONE is never used (IPv6)', { [X]: '2001:db8::1' }, undefined],
    ['x-forwarded-for with an empty x-real-ip is still nothing', { [X]: '6.6.6.6', [R]: '' }, undefined],
    ['no headers at all -> connection address (nothing sent)', {}, undefined],
  ] as Array<[string, Record<string, string>, string | undefined]>)('%s', async (_n, hdrs, want) => {
    set(hdrs);
    expect((await readClientContext()).ip).toBe(want);
  });

  it.each(['203.0.113.7:51234', '[2001:db8::1]:443', '[2001:db8::1]', 'not-an-ip', '999.1.1.1', '1.2.3', '203.0.113.7/24', 'fe80::1%eth0',
    "203.0.113.7'--", '<script>', 'unknown', '203.0.113.7, 10.0.0.1', '203.0.113.7,10.0.0.1'])('junk or list in x-vercel-forwarded-for %j -> no ip (never a port, a list or text)', async (v) => {
    set({ [V]: v });
    expect((await readClientContext()).ip).toBeUndefined();
  });
  it.each(['198.51.100.9:80', '198.51.100.9, 10.0.0.1', 'junk', 'fe80::1%eth0', '198.51.100.9/32'])('x-real-ip %j that is not a bare literal -> no ip', async (v) => {
    set({ [R]: v });
    expect((await readClientContext()).ip).toBeUndefined();
  });
  it('a junk vercel header is never replaced by the spoofable x-forwarded-for', async () => {
    set({ [V]: 'junk', [X]: '6.6.6.6' });
    expect((await readClientContext()).ip).toBeUndefined();
  });
});

describe('outgoing headers (what every BFF call sends to the API)', () => {
  it('x-forwarded-for carries the trusted address only; a missing address sends no x-forwarded-for at all', async () => {
    set({ [V]: '203.0.113.7', [X]: '6.6.6.6', 'user-agent': 'UA/1' });
    expect(await clientContextHeaders()).toEqual({ 'x-forwarded-for': '203.0.113.7', 'user-agent': 'UA/1' });
    set({ [X]: '6.6.6.6', 'user-agent': 'UA/1' });
    expect(await clientContextHeaders()).toEqual({ 'user-agent': 'UA/1' });
    set({});
    expect(await clientContextHeaders()).toEqual({});
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
    set({ [V]: '203.0.113.7', 'user-agent': 'UA/1', cookie: '__Host-lims_sid=SECRET-SID', authorization: 'Bearer SECRET-JWT', 'x-lims-bff-key': 'SECRET-KEY' });
    const c = await readClientContext();
    expect(Object.keys(c).sort()).toEqual(['ip', 'userAgent']);
    expect(JSON.stringify(c)).not.toMatch(/SECRET/);
  });
  it('nothing is logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    set({ [V]: '203.0.113.7', 'user-agent': 'UA/1', cookie: '__Host-lims_sid=SECRET-SID' });
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
