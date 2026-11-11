// ctx.files.scan (03-IC §13.6; 08 A25 D-209): ClamAV INSTREAM over TCP at LIMS_CORE_SCANNER_URL (default tcp://clamd:3310),
// bounded by LIMS_CORE_SCANNER_TIMEOUT_MS (default 30000). Never throws; 'clean' only on an exact "stream: OK" reply (fail closed).
// Shared by API and worker (worker re-exports this file; A17 P-19 re-scan jobs).
import net from 'node:net';

export type ScanResult = 'clean' | 'infected' | 'unavailable';
type LogFn = (obj: object, msg?: string) => void;
export interface FilesOptions { readonly env?: Readonly<Record<string, string | undefined>>; readonly log?: { warn: LogFn } }

const DEFAULT_URL = 'tcp://clamd:3310';
const DEFAULT_TIMEOUT_MS = 30000;
const CHUNK = 64 * 1024;

function target(raw: string): { host: string; port: number } | undefined {
  try {
    const u = new URL(raw);
    const port = Number(u.port || 3310);
    if (u.protocol !== 'tcp:' || !u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
  } catch { return undefined; }
}

export function parseReply(reply: string): ScanResult {
  const r = reply.replace(/[\0\s]+$/, '');
  if (r === 'stream: OK') return 'clean';
  if (/^stream: \S.* FOUND$/.test(r)) return 'infected';
  return 'unavailable';
}

export function createFiles(o: FilesOptions = {}) {
  const env = o.env ?? process.env;
  const to = target(env.LIMS_CORE_SCANNER_URL || DEFAULT_URL);
  const t = Number(env.LIMS_CORE_SCANNER_TIMEOUT_MS);
  const timeoutMs = Number.isInteger(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;
  const unavailable = (reason: string): ScanResult => { o.log?.warn({ event: 'scan_unavailable', reason }, 'scan_unavailable'); return 'unavailable'; };

  return {
    scan(bytes: Uint8Array): Promise<ScanResult> {
      if (!to) return Promise.resolve(unavailable('bad_url'));
      if (!(bytes instanceof Uint8Array)) return Promise.resolve(unavailable('bad_input'));
      return new Promise<ScanResult>((resolve) => {
        const chunks: Buffer[] = [];
        let done = false;
        const finish = (r: ScanResult) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); resolve(r); };
        const timer = setTimeout(() => finish(unavailable('timeout')), timeoutMs);
        const sock = net.connect({ host: to.host, port: to.port });
        sock.on('error', () => finish(unavailable('connection')));
        sock.on('data', (d: Buffer) => { chunks.push(d); });
        sock.on('end', () => { const r = parseReply(Buffer.concat(chunks).toString('latin1')); finish(r === 'unavailable' ? unavailable('reply') : r); });
        sock.on('close', () => finish(unavailable('closed')));
        sock.on('connect', () => {
          sock.write('zINSTREAM\0');
          for (let i = 0; i < bytes.length; i += CHUNK) {
            const part = bytes.subarray(i, i + CHUNK);
            const len = Buffer.alloc(4); len.writeUInt32BE(part.length);
            sock.write(len); sock.write(part);
          }
          sock.write(Buffer.alloc(4));
        });
      });
    },
  };
}
