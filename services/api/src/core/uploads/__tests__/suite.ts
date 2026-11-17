// T0D-17 ctx.files.scan contract (API and worker). Prescribed API: createFiles({ env, log?, metrics? }) -> { scan(bytes) } (uploads/index.ts).
// Scanner = ClamAV INSTREAM over TCP: LIMS_CORE_SCANNER_URL (default tcp://clamd:3310), LIMS_CORE_SCANNER_TIMEOUT_MS (default 30000).
// scan() never throws and never returns 'clean' unless clamd answered "stream: OK" (fail closed).
import net from 'node:net';
import { describe, expect, it } from 'vitest';

type Load = () => Promise<{ createFiles: (o: any) => { scan(b: Uint8Array): Promise<string> } }>;

/** Minimal clamd: parses zINSTREAM/nINSTREAM framing, records the payload, replies with reply(payload). */
export function fakeClamd(reply: (payload: Buffer) => string | null, opts: { hang?: boolean } = {}) {
  const received: Buffer[] = []; const heads: string[] = []; let conns = 0;
  const server = net.createServer((sock) => {
    conns++; let buf = Buffer.alloc(0); let started = false; const parts: Buffer[] = [];
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const m = /^(zINSTREAM\0|nINSTREAM\n)/.exec(buf.toString('latin1', 0, 10));
        if (!m) return; heads.push(m[1]!.replace('\0', '\\0').replace('\n', '\\n')); buf = buf.subarray(m[1]!.length); started = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          const payload = Buffer.concat(parts); received.push(payload);
          if (opts.hang) return;
          const r = reply(payload); if (r === null) sock.destroy(); else sock.end(r);
          return;
        }
        if (buf.length < 4 + n) return;
        parts.push(buf.subarray(4, 4 + n)); buf = buf.subarray(4 + n);
      }
    });
  });
  return new Promise<{ url: string; received: Buffer[]; heads: string[]; conns: () => number; close(): Promise<void> }>((res) =>
    server.listen(0, '127.0.0.1', () => res({
      url: `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, received, heads, conns: () => conns,
      close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
    })));
}

export function scanSuite(name: string, load: Load): void {
  const scanner = async (url: string | undefined, timeoutMs = '400') => {
    const { createFiles } = await load();
    return createFiles({ env: { ...(url ? { LIMS_CORE_SCANNER_URL: url } : {}), LIMS_CORE_SCANNER_TIMEOUT_MS: timeoutMs } });
  };
  const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_v, i) => (i * 31 + 7) & 0xff));

  describe(`${name}: ctx.files.scan (clamd INSTREAM)`, () => {
    it.each([
      ['stream: OK\0', 'clean'],
      ['stream: Eicar-Test-Signature FOUND\0', 'infected'],
      ['stream: OKAY.Signature FOUND\0', 'infected'],
      ['INSTREAM size limit exceeded. ERROR\0', 'unavailable'],
      ['stream: lstat() failed. ERROR\0', 'unavailable'],
      ['', 'unavailable'],
      ['garbage', 'unavailable'],
      ['OK', 'unavailable'],
    ])('reply %j => %s', async (r, want) => {
      const c = await fakeClamd(() => r);
      try { expect(await (await scanner(c.url)).scan(bytes(10))).toBe(want); } finally { await c.close(); }
    });
    it('sends INSTREAM framing with the exact bytes (multi-chunk, 3 MiB) and a zero-length terminator', async () => {
      const c = await fakeClamd(() => 'stream: OK\0'); const data = bytes(3 * 1024 * 1024 + 5);
      try {
        expect(await (await scanner(c.url, '5000')).scan(data)).toBe('clean');
        expect(c.heads).toHaveLength(1); expect(Buffer.compare(c.received[0]!, data)).toBe(0);
      } finally { await c.close(); }
    });
    it('connection dropped mid-scan / refused / hung scanner / bad scheme / unresolvable host => unavailable, never clean, bounded by the timeout', async () => {
      const drop = await fakeClamd(() => null); const hang = await fakeClamd(() => 'stream: OK\0', { hang: true });
      const dead = await fakeClamd(() => 'stream: OK\0'); const deadUrl = dead.url; await dead.close();
      try {
        for (const [url, label] of [[drop.url, 'drop'], [hang.url, 'hang'], [deadUrl, 'refused'], ['http://127.0.0.1:3310', 'scheme'],
          ['tcp://', 'empty'], ['not a url', 'junk'], [undefined, 'default clamd host']] as const) {
          const t0 = Date.now(); const out = await (await scanner(url as string | undefined)).scan(bytes(8));
          expect(out, label).toBe('unavailable'); expect(Date.now() - t0, label).toBeLessThan(4000);
        }
      } finally { await drop.close(); await hang.close(); }
    });
    it('concurrent scans do not cross results', async () => {
      const c = await fakeClamd((p) => (p.includes('EICAR-MARK') ? 'stream: Bad.Sig FOUND\0' : 'stream: OK\0'));
      try {
        const s = await scanner(c.url, '5000');
        const jobs = Array.from({ length: 20 }, (_v, i) => ({ bad: i % 3 === 0, b: Buffer.from(i % 3 === 0 ? `EICAR-MARK-${i}` : `fine-${i}`) }));
        const out = await Promise.all(jobs.map((j) => s.scan(j.b)));
        expect(out).toEqual(jobs.map((j) => (j.bad ? 'infected' : 'clean')));
      } finally { await c.close(); }
    });
    it('does not leak scanned bytes into log or metric calls', async () => {
      const c = await fakeClamd(() => 'stream: OK\0'); const lines: unknown[] = [];
      const sink = (...a: unknown[]) => { lines.push(a); };
      try {
        const { createFiles } = await load();
        await createFiles({ env: { LIMS_CORE_SCANNER_URL: c.url, LIMS_CORE_SCANNER_TIMEOUT_MS: '2000' }, log: { info: sink, warn: sink, error: sink, debug: sink },
          metrics: { inc: sink, set: sink, observe: sink } }).scan(Buffer.from('SENTINEL-PHI-Sita-Karki'));
        expect(JSON.stringify(lines)).not.toContain('SENTINEL-PHI');
      } finally { await c.close(); }
    });
  });
}
