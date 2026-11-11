// C7 INT-T01 (tester) — nightly E2E: simulator -> real agent binary (host-OS test build of the core) -> API -> C5 consumer (fake) -> result `resulted` within 5 s p95.
// 02-TRD §15.1 E2E row. Synthetic data only (apps/bridge-agent/testdata/e2e/scenario.json + driver goldens' shapes).
//
// What is REAL: the agent binary (`go build -tags e2e ./cmd/agent`), its ASTM and MLLP link layers, queue, uploader and HTTPS client (verified TLS); the API ingest service
//   (createIngestService + the real drivers/registry + real core createEvents); the C5 side = the REAL `LabPort` fake (`ingestInstrumentResult`) fed from `instruments.result.received.v1` events.
// What is FAKED: the DB (in-memory world of API-T09), CatalogPort (3 codes), the HTTP front (a node https server in this file that authenticates the bearer token, enforces Idempotency-Key and calls the service),
//   the event fan-out (a 100 ms poller over core.event_log stand-in; TRD §12: fan-out is C0/C5).
// The nightly compose job (TRD §15.1) runs the SAME file against the real stack by replacing the three fakes; here it runs self-contained.
//
// SEAMS the writer must provide (spec leaves the agent test-build CLI open; dispute/CR if unwanted):
//   build : `go -C apps/bridge-agent build -tags e2e -o <out> ./cmd/agent`   (never `nonprod`; Windows-only parts stubbed under the `e2e` tag on non-Windows hosts; on Windows the native build is fine)
//   run   : `<out> -config <file.json>` ; env AGENT_E2E_DEVICE_TOKEN = device token (synthetic). SIGTERM/kill = stop. Prints a line containing `READY` on stdout once every listener/connection is up.
//   config: { api_base_url:'https://127.0.0.1:<port>', tls_root_ca_pem_path, state_dir, flush_interval_ms, log_level:'info',
//             instruments:[ { instrument_id, protocol:'astm',  transport:'serial_pipe', pipe_path },        // the agent CONNECTS to the pipe the simulator serves (serial-over-pipe)
//                           { instrument_id, protocol:'hl7v2', transport:'tcp_listen', listen:'127.0.0.1:<port>' } ] }   // the agent LISTENS (MLLP), the simulator connects
//   archived raw bytes: ASTM = the record text of the message (H…L, CR-separated, no STX/ETX/checksum/frame bytes), HL7 = the message between VT and FS (no framing).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, createServer as createNet,type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { createIngestService } from '../../service/ingest.service.js';
import { INS, TENANT_A, makeIngestCtx, makeWorld, type World } from '../ingest.helpers.js';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const SCEN = JSON.parse(readFileSync(join(ROOT, 'apps/bridge-agent/testdata/e2e/scenario.json'), 'utf8'));
const ROUNDS: number = Number(process.env['E2E_ROUNDS'] ?? SCEN.rounds);
const BUDGET_MS: number = SCEN.p95_budget_ms;
const TOKEN = `e2e-${randomBytes(12).toString('hex')}`;       // synthetic, per run
const SEED = 7;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RM = { recursive: true, force: true, maxRetries: 20, retryDelay: 200 } as const;
// teardown cleanup must not fail the run (harness concern, not spec behaviour)
const rmQuiet = (p: string) => { try { rmSync(p, RM); } catch (e) { console.warn('teardown rmSync failed:', p, (e as Error).message); } };
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
const pad8 = (n: number) => String(n).padStart(8, '0');
const barcode = (base: number, n: number) => `E26${pad8(base + n)}`;
const camel = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase()), v]));

// ------------------------------------------------------------------------------------------------ C5 fake consumer (real LabPort fake) + catalog
const ANALYTE: Record<string, { analyteId: string; testId: string }> = {
  GLU: { analyteId: idFor(SEED, 0x6001), testId: idFor(SEED, 0x5001) },
  NA: { analyteId: idFor(SEED, 0x6002), testId: idFor(SEED, 0x5002) },
  HBSAG: { analyteId: idFor(SEED, 0x6003), testId: idFor(SEED, 0x5003) },
};
const catalogPort = {
  async mapInstrumentCode(_ctx: unknown, input: Record<string, unknown>) {
    const m = ANALYTE[String(input['instrumentCode'])];
    if (!m) throw Object.assign(new Error('catalog.instrument_code_unmapped'), { code: 'catalog.instrument_code_unmapped' });
    return { mappingId: idFor(SEED, 0xb100), instrumentId: input['instrumentId'], instrumentCode: input['instrumentCode'], ...m };
  },
};
function labFixtures(rounds: number) {
  const f = { orders: [] as any[], items: [] as any[], specimens: [] as any[], results: [] as any[] };
  const mk = (idx: number, bc: string, codes: string[]) => {
    const base = 0x100000 + idx * 0x100;
    f.orders.push({ id: idFor(SEED, base + 1), tenantId: TENANT_A, patientId: idFor(SEED, base + 2), centreId: idFor(SEED, base + 3), priority: 'routine', patient: { sex: 'female', ageDays: 12000 } });
    f.items.push({ id: idFor(SEED, base + 4), tenantId: TENANT_A, orderId: idFor(SEED, base + 1), testId: ANALYTE[codes[0]!]!.testId, departmentId: idFor(SEED, base + 5), workflowType: 'standard' });
    f.specimens.push({ id: idFor(SEED, base + 6), tenantId: TENANT_A, orderId: idFor(SEED, base + 1), barcode: bc, specimenTypeCode: 'BLOOD', status: 'received', itemIds: [idFor(SEED, base + 4)], receivedAt: '2026-11-07T03:00:00.000Z', isActive: true, version: 1 });
    codes.forEach((c, i) => f.results.push({ id: idFor(SEED, base + 0x10 + i), tenantId: TENANT_A, orderItemId: idFor(SEED, base + 4), testId: ANALYTE[c]!.testId, analyteId: ANALYTE[c]!.analyteId, versionNo: 1, status: 'pending', origin: 'manual', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false }));
  };
  for (let n = 0; n < rounds + 1; n++) { mk(n, barcode(SCEN.astm.barcode_base, n), ['GLU', 'NA']); mk(1000 + n, barcode(SCEN.hl7.barcode_base, n), ['GLU', 'HBSAG']); }
  return f;
}

// ------------------------------------------------------------------------------------------------ the API under test (https front + real service) and the C5 consumer loop
interface Stack { url: string; caPath: string; world: World; applied: Map<string, number[]>; batches: { key: string; status: number; at: number }[]; close(): Promise<void> }
async function startStack(dir: string, rounds: number): Promise<Stack> {
  const key = join(dir, 'srv.key'), crt = join(dir, 'srv.crt');
  const ossl = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  if (ossl.status !== 0) throw new Error(`openssl (needed for the throwaway test CA) failed: ${ossl.stderr || ossl.error}`);
  const world = makeWorld();
  const service = createIngestService({ repo: world.repo } as any);
  const lab = createFakeLabPort({ seed: SEED, fixtures: labFixtures(rounds) });
  const applied = new Map<string, number[]>();             // barcode -> epoch ms of each `applied` outcome (C5: result is now `resulted`)
  const batches: Stack['batches'] = [];
  const replay = new Map<string, { status: number; body: unknown }>();
  let consumed = 0, busy = false;
  const timer = setInterval(async () => {                  // C5 consumer: event -> LabPort.ingestInstrumentResult (X2 canonical bulk path is the event)
    if (busy) return; busy = true;
    try {
      const evs = world.events;
      while (consumed < evs.length) {
        const env = evs[consumed++]!;
        if (env['event_type'] !== 'instruments.result.received.v1') continue;
        const input = { ...camel(env['payload'] as Record<string, unknown>), idempotencyKey: String(env['idempotency_key']) } as any;
        const out: any = await (lab as any).ingestInstrumentResult({ tenantId: env['tenant_id'], actor: { type: 'system', id: idFor(SEED, 0xc5) }, now: () => new Date().toISOString() }, input);
        if (out.outcome === 'applied') { const a = applied.get(input.sampleBarcode) ?? []; a.push(Date.now()); applied.set(input.sampleBarcode, a); }
      }
    } finally { busy = false; }
  }, 100);
  const server: HttpsServer = createHttps({ key: readFileSync(key), cert: readFileSync(crt), minVersion: 'TLSv1.2' }, (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.url !== '/v1/instruments/agent/message-batches') return send(404, { error: 'not_found' });
    if (req.headers['authorization'] !== `Bearer ${TOKEN}`) return send(401, { error: { code: 'auth.unauthenticated' } });
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!idem) return send(400, { error: { code: 'common.idempotency_key_required' } });
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 4 * 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      const prev = replay.get(idem); if (prev) { batches.push({ key: idem, status: prev.status, at: Date.now() }); return send(prev.status, prev.body); }
      try {
        const { ctx } = makeIngestCtx(world, { catalog: { mapInstrumentCode: catalogPort.mapInstrumentCode, calls: [] } });
        const out: any = await service.submitMessageBatch(ctx, { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        replay.set(idem, { status: out.status, body: out.body }); batches.push({ key: idem, status: out.status, at: Date.now() }); send(out.status, out.body);
      } catch (e: any) { batches.push({ key: idem, status: 500, at: Date.now() }); send(500, { error: { code: e?.code ?? 'common.internal' } }); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `https://127.0.0.1:${port}`, caPath: crt, world, applied, batches, async close() { clearInterval(timer); await new Promise((r) => server.close(r)); } };
}

// ------------------------------------------------------------------------------------------------ the simulator (instrument side): ASTM over a pipe the agent connects to, HL7/MLLP over TCP the agent listens on
class Reader {
  private buf: number[] = []; private waiters: Array<() => void> = [];
  constructor(sock: Socket) { sock.on('data', (d) => { this.buf.push(...d); this.waiters.splice(0).forEach((w) => w()); }); }
  async byte(ms = 5000): Promise<number> {
    const end = Date.now() + ms;
    while (!this.buf.length) { const left = end - Date.now(); if (left <= 0) throw new Error('simulator: timed out waiting for the agent'); await new Promise<void>((r) => { const t = setTimeout(r, left); this.waiters.push(() => { clearTimeout(t); r(); }); }); }
    return this.buf.shift()!;
  }
  async until(stop: number, ms = 5000): Promise<Buffer> { const out: number[] = []; for (;;) { const b = await this.byte(ms); out.push(b); if (b === stop) return Buffer.from(out); } }
}
const ENQ = 0x05, ACK = 0x06, EOT = 0x04, STX = 0x02, ETX = 0x03, VT = 0x0b, FS = 0x1c, CR = 0x0d, LF = 0x0a;
const astmChecksum = (b: Buffer) => (b.reduce((s, x) => (s + x) & 0xff, 0)).toString(16).toUpperCase().padStart(2, '0');
function astmFrame(n: number, text: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(String(n % 8)), text, Buffer.from([ETX])]);
  return Buffer.concat([Buffer.from([STX]), body, Buffer.from(astmChecksum(body)), Buffer.from([CR, LF])]);
}
const astmText = (n: number) => Buffer.from(SCEN.astm.lines.map((l: string) => l.replace('{barcode}', barcode(SCEN.astm.barcode_base, n))).join('\r') + '\r', 'latin1');
const hl7Text = (n: number) => Buffer.from(SCEN.hl7.segments.map((l: string) => l.replace('{barcode}', barcode(SCEN.hl7.barcode_base, n)).replace('{msgid}', pad8(n))).join('\r') + '\r', 'latin1');

async function astmSend(sock: Socket, rd: Reader, text: Buffer): Promise<void> {
  if (text.length > 240) throw new Error('test fixture: ASTM text must fit one frame (<= 240 bytes)');
  sock.write(Buffer.from([ENQ])); expect(await rd.byte()).toBe(ACK);
  sock.write(astmFrame(1, text)); expect(await rd.byte()).toBe(ACK);
  sock.write(Buffer.from([EOT]));
}
async function hl7Send(sock: Socket, rd: Reader, msg: Buffer): Promise<string> {
  sock.write(Buffer.concat([Buffer.from([VT]), msg, Buffer.from([FS, CR])]));
  const ack = await rd.until(FS, 5000); expect(await rd.byte()).toBe(CR);   // VT MSH<CR>MSA<CR> FS CR
  return ack.toString('latin1');
}

// ------------------------------------------------------------------------------------------------ the agent process
interface Agent { proc: ChildProcess; out: string[]; stop(): Promise<void> }
async function startAgent(bin: string, dir: string, cfg: Record<string, unknown>): Promise<Agent> {
  mkdirSync(join(dir, 'state'), { recursive: true });
  const file = join(dir, 'agent-e2e.json'); writeFileSync(file, JSON.stringify({ ...cfg, state_dir: join(dir, 'state') }));
  const proc = spawn(bin, ['-config', file], { env: { ...process.env, AGENT_E2E_DEVICE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = []; let exited: number | null | undefined;
  proc.stdout!.on('data', (d) => out.push(String(d))); proc.stderr!.on('data', (d) => out.push(String(d)));
  proc.on('exit', (c) => { exited = c; });
  const end = Date.now() + 15000;
  while (!out.join('').includes('READY')) {
    if (exited !== undefined) throw new Error(`agent exited early (code ${exited}): ${out.join('').slice(0, 400)}`);
    if (Date.now() > end) { proc.kill(); throw new Error(`agent did not print READY within 15 s: ${out.join('').slice(0, 400)}`); }
    await sleep(50);
  }
  return { proc, out, async stop() { if (exited === undefined) { const done = new Promise<void>((r) => proc.once('exit', () => r())); proc.kill(); await Promise.race([done, sleep(5000)]); } } };
}

// ------------------------------------------------------------------------------------------------ suite
let work: string, bin: string, stack: Stack, agent: Agent, pipeServer: NetServer, pipeSock: Promise<Socket>, pipePath: string, hl7Port: number;
const sentAt = new Map<string, number>();            // barcode -> epoch ms the simulator finished sending
const sentRaw = new Map<string, Buffer>();           // barcode -> exact message bytes (no framing)

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'int-t01-'));
  const exe = process.platform === 'win32' ? 'agent-e2e.exe' : 'agent-e2e';
  bin = join(work, exe);
  const b = spawnSync('go', ['-C', join(ROOT, 'apps/bridge-agent'), 'build', '-tags', 'e2e', '-o', bin, './cmd/agent'], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`agent test build failed: ${b.stderr || b.error}`);
  stack = await startStack(work, ROUNDS);
  pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\lims-int-t01-${process.pid}` : join(work, 'astm.sock');
  pipeServer = createNet(); pipeSock = new Promise<Socket>((r) => pipeServer.once('connection', r));
  await new Promise<void>((r) => pipeServer.listen(pipePath, r));
  const probe = createNet(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r)); hl7Port = (probe.address() as { port: number }).port; await new Promise((r) => probe.close(r));
  agent = await startAgent(bin, work, {
    api_base_url: stack.url, tls_root_ca_pem_path: stack.caPath, flush_interval_ms: SCEN.flush_interval_ms, log_level: 'info',
    instruments: [
      { instrument_id: INS(1), protocol: 'astm', transport: 'serial_pipe', pipe_path: pipePath },
      { instrument_id: INS(2), protocol: 'hl7v2', transport: 'tcp_listen', listen: `127.0.0.1:${hl7Port}` },
    ],
  });
}, 90_000);

afterAll(async () => {
  await agent?.stop(); await stack?.close(); await new Promise((r) => pipeServer?.close(r));
  if (work) rmQuiet(work);
});

describe('INT-T01 simulator -> agent -> API -> C5 (fake) -> resulted', () => {
  it('ASTM serial-over-pipe and HL7 TCP: every result is `resulted` in C5, p95 (instrument done -> resulted) <= 5 s', async () => {
    const astmSock = await pipeSock; const astmRd = new Reader(astmSock);
    const hl7Sock: Socket = await new Promise((res, rej) => { const s = netConnect(hl7Port, '127.0.0.1', () => res(s)); s.once('error', rej); }); const hl7Rd = new Reader(hl7Sock);
    const acks: string[] = [];
    for (let n = 0; n < ROUNDS; n++) {
      const a = astmText(n); await astmSend(astmSock, astmRd, a);
      sentAt.set(barcode(SCEN.astm.barcode_base, n), Date.now()); sentRaw.set(barcode(SCEN.astm.barcode_base, n), a);
      const h = hl7Text(n); const ack = await hl7Send(hl7Sock, hl7Rd, h);
      sentAt.set(barcode(SCEN.hl7.barcode_base, n), Date.now()); sentRaw.set(barcode(SCEN.hl7.barcode_base, n), h); acks.push(ack);
      await sleep(250);                                      // steady trickle, like a lab (TRD §12: ~2 msg/s at N=10), not a burst
    }
    // every HL7 message is ACKed (AA) by the agent, quoting its MSH-10, before any upload is needed (AC-02.x: ack on durable queue write)
    acks.forEach((a, n) => expect(a).toContain(`MSA|AA|MSG${pad8(n)}`));
    // wait for C5 (bounded): every barcode applied
    const want = [...sentAt.keys()]; const deadline = Date.now() + 30_000;
    while (want.some((b) => (stack.applied.get(b)?.length ?? 0) < 2) && Date.now() < deadline) await sleep(100);
    const lat: number[] = [];
    for (const b of want) {
      const got = stack.applied.get(b) ?? [];
      expect(got.length, `C5 applied results for ${b}`).toBe(2);                    // ASTM: GLU+NA, HL7: GLU+HBSAG — exactly once each (no duplicate application)
      lat.push(Math.max(...got) - sentAt.get(b)!);
    }
    expect(lat).toHaveLength(ROUNDS * 2);
    expect(p95(lat), `p95 latency ms (all=${lat.join(',')})`).toBeLessThanOrEqual(BUDGET_MS);
  }, 120_000);

  it('archive count = instrument count; raw bytes are archived exactly as sent (no loss, no duplicate, no mutation)', () => {
    const msgs = stack.world.messages;
    expect(msgs).toHaveLength(ROUNDS * 2);
    for (const [bc, raw] of sentRaw) {
      const hit = msgs.filter((m) => sha256(Buffer.from(m['raw_bytes'] as Buffer)) === sha256(raw));
      expect(hit, `archived message for ${bc}`).toHaveLength(1);
    }
    // one `instruments.result.received.v1` per record: ASTM 2 + HL7 2 per round (AC-11.1 through the whole chain)
    expect(stack.world.eventsOf('instruments.result.received.v1')).toHaveLength(ROUNDS * 4);
    // every agent upload was accepted by the API
    expect(stack.batches.length).toBeGreaterThan(0);
    expect(stack.batches.every((b) => b.status === 200)).toBe(true);
  });

  it('an HL7 retransmission (same bytes, same MSH-10) is ACKed but neither archived twice nor applied twice (AC-09.x dedupe, end to end)', async () => {
    const hl7Sock: Socket = await new Promise((res, rej) => { const s = netConnect(hl7Port, '127.0.0.1', () => res(s)); s.once('error', rej); }); const rd = new Reader(hl7Sock);
    const ack = await hl7Send(hl7Sock, rd, hl7Text(0)); expect(ack).toContain(`MSA|AA|MSG${pad8(0)}`);
    await sleep(2500);                                                   // > flush interval + poller
    expect(stack.world.messages).toHaveLength(ROUNDS * 2);
    expect(stack.applied.get(barcode(SCEN.hl7.barcode_base, 0))).toHaveLength(2);
    hl7Sock.destroy();
  }, 30_000);

  it('SEC: an agent that does not trust the API certificate uploads nothing (verified TLS, no fallback) — REQ-SEC TLS', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'int-t01-tls-'));
    try {
      const other = await startStack(dir, 1);                              // a second API with its own throwaway cert
      const before = stack.batches.length;
      const port = await new Promise<number>((r) => { const p = createNet(); p.listen(0, '127.0.0.1', () => { const x = (p.address() as { port: number }).port; p.close(() => r(x)); }); });
      const bad = await startAgent(bin, dir, { api_base_url: other.url, tls_root_ca_pem_path: stack.caPath /* the WRONG CA for `other` */, flush_interval_ms: 200, log_level: 'info',
        instruments: [{ instrument_id: INS(2), protocol: 'hl7v2', transport: 'tcp_listen', listen: `127.0.0.1:${port}` }] });
      const s: Socket = await new Promise((res, rej) => { const c = netConnect(port, '127.0.0.1', () => res(c)); c.once('error', rej); });
      await hl7Send(s, new Reader(s), hl7Text(ROUNDS + 1));                // the agent still ACKs locally (durable queue), but must not deliver
      await sleep(3000);
      expect(other.batches).toHaveLength(0);
      expect(other.world.messages).toHaveLength(0);
      expect(stack.batches.length).toBe(before);
      s.destroy(); await bad.stop(); await other.close();
    } finally { rmQuiet(dir); }
  }, 60_000);
});
