// C7 H80-T05 (tester) — E2E: simulator (the analyser, session files) -> real agent test build (profile truth_h80e) -> API (real ingest + host query services, real truth_h80e driver) -> reply back to the analyser.
// 08-ADDENDUM-TRUTH-H80E §5-§8, PRD AC-10.x / AC-10.6, LD-139 (2026-11-13: the analyser is a TCP client of the lab PC's agent; host query is answered QCK OK + DSR / QCK NF; offline = no reply, D-H80-1). Synthetic data only.
// The analyser's messages are read from apps/bridge-agent/testdata/sessions/h80e-*.session.json (the `from: instrument` steps; the session's stub replies are NOT used: the replies here come from the real driver).
// REAL: agent binary (`go build -tags e2e ./cmd/agent`), MLLP link, queue, uploader, host-query relay + client, verified TLS; API ingest service, host query service (E05), truth_h80e driver, core events.
// FAKED: DB (in-memory world), LabPort + outbound CatalogPort (fakes below), the https front, and ONE test-only override: the truth_h80e driver is presented as `verified` to the host query service
//   (it is `generic` in the registry, so host query is inert there — §0/§6.6; hostQuery.truth_h80e.test.ts does the same).
// SEAMS the writer must provide (the e2e config of apps/bridge-agent/cmd/agent/e2e_main.go; same build/run/READY contract as simulator-agent-api-c5.e2e.test.ts):
//   instruments[i].profile = 'truth_h80e' (optional string): the test build takes the SessionProfile of that code (internal/drivers: HostQueryMessageTypes, ReplyAckPolicy, ExpectAckOnReply, ReplyTimeout)
//   and wires mllp.Config.HostQuery to hostquery.Relay -> POST /v1/instruments/agent/host-queries (E05, same https client / bearer token / Idempotency-Key as the uploader).
//   Without `profile` nothing changes (the C5 e2e keeps passing). The relay's reply messages are written to the analyser as MLLP frames in order; unreachable API => nothing written (AC-10.6).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, createServer as createNet, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDriver } from '../../drivers/registry.js';
import { truthH80e } from '../../drivers/truth_h80e/index.js';
import { createHostQueryService } from '../../service/hostQuery.service.js';
import { createIngestService } from '../../service/ingest.service.js';
import { AN, TEST, defaultInstruments, hqRepo, makeLab, makeOutboundCatalog } from '../hostQuery.helpers.js';
import { INS, makeIngestCtx, makeWorld, type World } from '../ingest.helpers.js';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const SESS = join(ROOT, 'apps/bridge-agent/testdata/sessions');
const TOKEN = `e2e-${randomBytes(12).toString('hex')}`;       // synthetic, per run
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rmQuiet = (p: string) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch (e) { console.warn('teardown rmSync failed:', p, (e as Error).message); } };
const VT = 0x0b, FS = 0x1c, CR = 0x0d;
const PHI = ['E2600000042', 'E2600000043', 'E2600000099', 'Test Patient', 'P0000123'];      // planted sentinels: never in agent output

// ------------------------------------------------------------------------------------------------ session files = the analyser's script
const wire = (s: string) => Buffer.from(s.replace(/<VT>/g, '\x0b').replace(/<FS>/g, '\x1c').replace(/<CR>/g, '\r'), 'utf8');
/** the framed messages the analyser sends in a session file, in order */
function analyserSends(name: string): Buffer[] {
  const j = JSON.parse(readFileSync(join(SESS, `${name}.session.json`), 'utf8'));
  return j.steps.filter((s: { from?: string }) => s.from === 'instrument').map((s: { bytes: string }) => wire(s.bytes));
}
const text = (framed: Buffer) => framed.toString('utf8').replace(/[\x0b\x1c]/g, '');
const seg = (m: string) => m.split('\r').filter((s) => s.length > 0);
const field = (m: string, name: string, n: number) => seg(m).find((s) => s.startsWith(name + '|'))?.split('|')[name === 'MSH' ? n - 1 : n];

// ------------------------------------------------------------------------------------------------ the API under test
interface Stack { url: string; caPath: string; world: World; hq: { status: number; at: number }[]; batches: { status: number }[]; close(): Promise<void> }
async function startStack(dir: string): Promise<Stack> {
  const key = join(dir, 'srv.key'), crt = join(dir, 'srv.crt');
  const args = ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'];
  let ossl = spawnSync('openssl', args, { encoding: 'utf8' });
  if (ossl.status !== 0) ossl = spawnSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe', args, { encoding: 'utf8' });
  if (ossl.status !== 0) throw new Error(`openssl (needed for the throwaway test CA) failed: ${ossl.stderr || ossl.error}`);
  const world = makeWorld({ instruments: defaultInstruments().map((i) => ({ ...i, driver_code: 'truth_h80e', protocol: 'hl7v2' })) });   // INS(2): live hl7v2, host query on
  const ingest = createIngestService({ repo: world.repo } as never);
  const verifiedInTestOnly = (c: string) => (c === 'truth_h80e' ? { ...truthH80e, status: 'verified' as const } : getDriver(c));
  const hostQuery = createHostQueryService({ repo: hqRepo(world), getDriver: verifiedInTestOnly as never });
  const lab = makeLab({
    E2600000042: { sex: 'female', ageDays: 14000, tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }] },     // pending HbA1c, mapped outbound -> QCK OK + DSR
    E2600000043: { tests: [{ testId: TEST.glu, analyteIds: [AN.k] }] },                                      // registered, but its analyte has no mapping for this instrument -> NF
  });                                                                                                         // E2600000099 is not registered at all -> lab.specimen_not_found -> NF
  const catalog = makeOutboundCatalog({ [AN.glu]: 'HbA1c_NGSP' });
  const hq: Stack['hq'] = []; const batches: Stack['batches'] = [];
  const replay = new Map<string, { status: number; body: unknown }>();
  const server: HttpsServer = createHttps({ key: readFileSync(key), cert: readFileSync(crt), minVersion: 'TLSv1.2' }, (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const isHq = req.url === '/v1/instruments/agent/host-queries', isBatch = req.url === '/v1/instruments/agent/message-batches';
    if (req.method !== 'POST' || (!isHq && !isBatch)) return send(404, { error: 'not_found' });
    if (req.headers['authorization'] !== `Bearer ${TOKEN}`) return send(401, { error: { code: 'auth.unauthenticated' } });
    const idem = String(req.headers['idempotency-key'] ?? '');
    if (!idem) return send(400, { error: { code: 'common.idempotency_key_required' } });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const prev = replay.get(`${req.url}|${idem}`); if (prev) return send(prev.status, prev.body);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const { ctx } = makeIngestCtx(world);
        let out: any;
        if (isHq) {
          Object.assign(ctx, { commitOnError: () => {}, ports: { CatalogPort: { mapInstrumentCode: catalog.mapInstrumentCode }, LabPort: lab.port } });
          out = await hostQuery.submitHostQuery(ctx, { body });
          hq.push({ status: out.status, at: Date.now() });
        } else { out = await ingest.submitMessageBatch(ctx, { body }); batches.push({ status: out.status }); }
        replay.set(`${req.url}|${idem}`, { status: out.status, body: out.body }); send(out.status, out.body);
      } catch (e: any) { (isHq ? hq : batches).push({ status: 500, at: Date.now() } as never); send(e?.status ?? 500, { error: { code: e?.code ?? 'common.internal' } }); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `https://127.0.0.1:${port}`, caPath: crt, world, hq, batches, async close() { await new Promise((r) => server.close(r)); } };
}

// ------------------------------------------------------------------------------------------------ the analyser (MLLP client of the agent)
class Reader {
  private buf: number[] = []; private waiters: Array<() => void> = [];
  constructor(sock: Socket) { sock.on('data', (d) => { this.buf.push(...d); this.waiters.splice(0).forEach((w) => w()); }); }
  private async byte(ms: number): Promise<number | undefined> {
    const end = Date.now() + ms;
    while (!this.buf.length) { const left = end - Date.now(); if (left <= 0) return undefined; await new Promise<void>((r) => { const t = setTimeout(r, left); this.waiters.push(() => { clearTimeout(t); r(); }); }); }
    return this.buf.shift()!;
  }
  /** one MLLP frame (VT ... FS CR) as text, or undefined if nothing complete arrives within ms */
  async frame(ms = 5000): Promise<string | undefined> {
    const out: number[] = [];
    for (;;) {
      const b = await this.byte(ms); if (b === undefined) return undefined;
      if (b === VT) continue;
      if (b === FS) { await this.byte(ms); return Buffer.from(out).toString('utf8'); }
      out.push(b);
    }
  }
}
const connect = (port: number): Promise<{ sock: Socket; rd: Reader }> => new Promise((res, rej) => { const s = netConnect(port, '127.0.0.1', () => res({ sock: s, rd: new Reader(s) })); s.once('error', rej); });
const freePort = () => new Promise<number>((r) => { const p = createNet(); p.listen(0, '127.0.0.1', () => { const x = (p.address() as { port: number }).port; p.close(() => r(x)); }); });

// ------------------------------------------------------------------------------------------------ the agent process
interface Agent { out: string[]; stop(): Promise<void> }
async function startAgent(bin: string, dir: string, cfg: Record<string, unknown>): Promise<Agent> {
  mkdirSync(join(dir, 'state'), { recursive: true });
  const file = join(dir, 'agent-e2e.json'); writeFileSync(file, JSON.stringify({ ...cfg, state_dir: join(dir, 'state') }));
  const proc: ChildProcess = spawn(bin, ['-config', file], { env: { ...process.env, AGENT_E2E_DEVICE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = []; let exited: number | null | undefined;
  proc.stdout!.on('data', (d) => out.push(String(d))); proc.stderr!.on('data', (d) => out.push(String(d)));
  proc.on('exit', (c) => { exited = c; });
  const end = Date.now() + 15000;
  while (!out.join('').includes('READY')) {
    if (exited !== undefined) throw new Error(`agent exited early (code ${exited}): ${out.join('').slice(0, 400)}`);
    if (Date.now() > end) { proc.kill(); throw new Error(`agent did not print READY within 15 s: ${out.join('').slice(0, 400)}`); }
    await sleep(50);
  }
  return { out, async stop() { if (exited === undefined) { const done = new Promise<void>((r) => proc.once('exit', () => r())); proc.kill(); await Promise.race([done, sleep(5000)]); } } };
}

// ------------------------------------------------------------------------------------------------ suite
let work: string, bin: string, stack: Stack, agent: Agent, port: number;
const cfgFor = (url: string, ca: string, listen: number) => ({
  api_base_url: url, tls_root_ca_pem_path: ca, flush_interval_ms: 250, log_level: 'info',
  instruments: [{ instrument_id: INS(2), protocol: 'hl7v2', transport: 'tcp_listen', listen: `127.0.0.1:${listen}`, profile: 'truth_h80e' }],
});

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'h80-t05-'));
  bin = join(work, process.platform === 'win32' ? 'agent-e2e.exe' : 'agent-e2e');
  const b = spawnSync('go', ['-C', join(ROOT, 'apps/bridge-agent'), 'build', '-tags', 'e2e', '-o', bin, './cmd/agent'], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`agent test build failed: ${b.stderr || b.error}`);
  stack = await startStack(work);
  port = await freePort();
  agent = await startAgent(bin, work, cfgFor(stack.url, stack.caPath, port));
}, 90_000);
afterAll(async () => { await agent?.stop(); await stack?.close(); if (work) rmQuiet(work); });

describe('H80-T05 simulator -> agent -> API -> analyser (Truth-H80E)', () => {
  it('ORU result (h80e-oru-patient): ACKed AA with the ORU MSH-10 by the agent, uploaded, archived once, one result event', async () => {
    const { sock, rd } = await connect(port);
    const [oru] = analyserSends('h80e-oru-patient'); sock.write(oru!);
    const ack = await rd.frame(); expect(ack, 'agent ACK').toBeTruthy();
    expect(field(ack!, 'MSA', 1)).toBe('AA'); expect(field(ack!, 'MSA', 2)).toBe(field(text(oru!), 'MSH', 10));
    const end = Date.now() + 15_000;
    while (stack.world.eventsOf('instruments.result.received.v1').length < 1 && Date.now() < end) await sleep(100);
    expect(stack.world.eventsOf('instruments.result.received.v1')).toHaveLength(1);
    expect(stack.world.messages.filter((m) => Buffer.from(m['raw_bytes'] as Buffer).toString('utf8').includes('ORU^R01'))).toHaveLength(1);
    expect(stack.hq).toHaveLength(0);                                       // a result is never a host query
    sock.destroy();
  }, 40_000);

  it('QRY found (h80e-qry-found): QCK OK then DSR in that order, written back-to-back; DSP-21 echoes the tube; ACK^Q03 is consumed (not archived, not answered)', async () => {
    const [qry, ackQ03] = analyserSends('h80e-qry-found');
    const { sock, rd } = await connect(port);
    sock.write(qry!);
    const qck = await rd.frame(); const dsr = await rd.frame(2000);
    expect(qck, 'QCK').toBeTruthy(); expect(dsr, 'DSR').toBeTruthy();
    expect(field(qck!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(qck!, 'QAK', 2)).toBe('OK'); expect(field(qck!, 'MSA', 2)).toBe(field(text(qry!), 'MSH', 10));
    expect(field(dsr!, 'MSH', 9)).toBe('DSR^Q03'); expect(seg(dsr!).find((s) => s.startsWith('DSP|21|'))?.split('|')[3]).toBe('E2600000042');
    expect(seg(dsr!).some((s) => /^(OBR|OBX|ORC|TQ1)\|/.test(s))).toBe(false);    // the manual's DSR has no test list (LD-139)
    sock.write(ackQ03!);                                                         // MSA-2 = the query id, not the DSR id (§6): accepted
    expect(await rd.frame(1000), 'nothing is answered to the analyser ACK^Q03').toBeUndefined();
    expect(stack.hq.at(-1)?.status).toBe(200);
    sock.destroy();
  }, 40_000);

  it('QRY not found (h80e-qry-not-found): ONE message, QCK NF, no DSR', async () => {
    const [qry] = analyserSends('h80e-qry-not-found');
    const { sock, rd } = await connect(port);
    sock.write(qry!);
    const qck = await rd.frame(); expect(qck, 'QCK').toBeTruthy();
    expect(field(qck!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(qck!, 'QAK', 2)).toBe('NF'); expect(field(qck!, 'MSA', 2)).toBe(field(text(qry!), 'MSH', 10));
    expect(await rd.frame(1000), 'no DSR after QCK NF').toBeUndefined();
    sock.destroy();
  }, 40_000);

  it('QRY, tube registered but no pending HbA1c order mapped to this instrument (h80e-qry-no-order-nf): QCK NF only', async () => {
    const [qry] = analyserSends('h80e-qry-no-order-nf');
    const { sock, rd } = await connect(port);
    sock.write(qry!);
    const qck = await rd.frame(); expect(qck, 'QCK').toBeTruthy();
    expect(field(qck!, 'QAK', 2)).toBe('NF');
    expect(await rd.frame(1000), 'no DSR after QCK NF').toBeUndefined();
    sock.destroy();
  }, 40_000);

  it('archive: each query is archived exactly once as host_query (E05 + later batch upload dedupe), the ACK^Q03 never; no raw barcode / name in agent output (PHI)', async () => {
    await sleep(2500);                                                           // > flush interval: the queued host_query items have been uploaded
    const hqMsgs = stack.world.messages.filter((m) => m['message_kind'] === 'host_query');
    expect(hqMsgs).toHaveLength(3);                                              // found, not found, no order
    expect(stack.world.messages.some((m) => Buffer.from(m['raw_bytes'] as Buffer).toString('utf8').includes('ACK^Q03'))).toBe(false);
    expect(stack.hq.every((h) => h.status === 200)).toBe(true);
    expect(stack.batches.every((b) => b.status === 200)).toBe(true);
    const log = agent.out.join('');
    for (const s of PHI) expect(log, `agent output must not contain ${s.slice(0, 3)}…`).not.toContain(s);
  }, 20_000);

  it('API unreachable (D-H80-1, AC-10.6): the agent sends NO reply and keeps the session; the analyser then times out on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h80-t05-down-'));
    try {
      const dead = await freePort();                                             // nothing listens here
      const p = await freePort();
      const bad = await startAgent(bin, dir, cfgFor(`https://127.0.0.1:${dead}`, stack.caPath, p));
      const { sock, rd } = await connect(p);
      sock.write(analyserSends('h80e-qry-found')[0]!);
      expect(await rd.frame(4000), 'no QCK, no DSR, no ACK while the API is unreachable').toBeUndefined();
      sock.write(analyserSends('h80e-oru-patient')[0]!);                         // the session is alive: a result is still ACKed locally (queued for later upload)
      const ack = await rd.frame(); expect(ack && field(ack, 'MSA', 1)).toBe('AA');
      sock.destroy(); await bad.stop();
    } finally { rmQuiet(dir); }
  }, 60_000);
});
