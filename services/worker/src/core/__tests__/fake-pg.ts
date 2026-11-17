// T0B-ASYNC-3 helper: a tiny fake Postgres (wire protocol v3, trust auth) that records every statement it receives. Synthetic, no database.
import { createServer, type Server, type Socket } from 'node:net';

const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type: string, body: Buffer = Buffer.alloc(0)) => {
  const h = Buffer.alloc(5);
  h.write(type, 0, 'latin1');
  h.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([h, body]);
};
const ready = msg('Z', Buffer.from('I'));
const complete = (tag: string) => msg('C', cstr(tag));
const errorResponse = (code: string, message: string) => msg('E', Buffer.concat([Buffer.from('S'), cstr('ERROR'), Buffer.from('C'), cstr(code), Buffer.from('M'), cstr(message), Buffer.from([0])]));

export interface Fake { server: Server; port: number; statements: string[]; logins: string[]; close(): Promise<void> }

// failOn: a statement matching this makes the server answer ErrorResponse (42501) instead of success.
export async function fakePostgres(failOn?: RegExp): Promise<Fake> {
  const statements: string[] = [];
  const logins: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    let buf = Buffer.alloc(0);
    let started = false;
    let pending: { sql: string } | undefined;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) { sock.write('N'); continue; }                 // SSLRequest: refuse, the client may continue in clear
          started = true;
          sock.write(Buffer.concat([msg('R', Buffer.from([0, 0, 0, 0])), msg('S', Buffer.concat([cstr('server_version'), cstr('17.0')])), msg('K', Buffer.alloc(8)), ready]));
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0]!);
        const len = buf.readInt32BE(1);
        if (buf.length < len + 1) return;
        const body = buf.subarray(5, len + 1);
        buf = buf.subarray(len + 1);
        if (type === 'X') { sock.end(); return; }
        if (type === 'Q') {
          const sql = body.toString('utf8').replace(/\0$/, '');
          statements.push(sql.replace(/\s+/g, ' ').trim());
          if (failOn?.test(sql)) { sock.write(Buffer.concat([errorResponse('42501', 'permission denied (fake)'), ready])); continue; }
          const verb = sql.trim().split(/\s+/)[0]!.toUpperCase();
          sock.write(Buffer.concat([complete(verb === 'SELECT' ? 'SELECT 0' : verb === 'SET' ? 'SET' : verb), ready]));
        } else if (type === 'P') {            // Parse: name\0 query\0 ...
          const name = body.indexOf(0);
          const q = body.subarray(name + 1, body.indexOf(0, name + 1)).toString('utf8');
          statements.push(q.replace(/\s+/g, ' ').trim());
          pending = { sql: q };
        } else if (type === 'S') {            // Sync: answer the whole Parse/Bind/Describe/Execute batch
          if (pending && failOn?.test(pending.sql)) sock.write(Buffer.concat([errorResponse('42501', 'permission denied (fake)'), ready]));
          else sock.write(Buffer.concat([msg('1'), msg('2'), msg('n'), complete(/^\s*INSERT/i.test(pending?.sql ?? '') ? 'INSERT 0 1' : /^\s*UPDATE/i.test(pending?.sql ?? '') ? 'UPDATE 0' : 'SELECT 0'), ready]));
          pending = undefined;
        }
        // B, D, E, H, C: nothing to answer before Sync
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { server, port, statements, logins, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}
