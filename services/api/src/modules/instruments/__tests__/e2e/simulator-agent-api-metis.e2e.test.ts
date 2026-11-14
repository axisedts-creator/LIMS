// C7 MET-T04 (tester) — E2E: simulator (the analyser, session files) -> real agent test build (profile getein_metis) -> API (real ingest + host query services, real getein_metis driver) -> reply back to the analyser.
// 09-ADDENDUM-GETEIN-METIS §3-§7, PRD AC-10.x / AC-10.6, LD-163 (2026-11-14; D-MET-1: only the single-barcode query is answered, range queries get QCK NF; D-MET-3: the analyser connects out to the lab PC's agent;
// offline = no reply, same decision as D-H80-1). Synthetic data only.
// The analyser's messages are read from apps/bridge-agent/testdata/sessions/metis-*.session.json (the `from: instrument` steps; the session's stub replies are NOT used: the replies here come from the real driver).
// REAL: agent binary (`go build -tags e2e ./cmd/agent`), MLLP link, queue, uploader, host-query relay + client, verified TLS; API ingest service, host query service (E05), getein_metis driver, core events.
// FAKED: DB (in-memory world), LabPort + outbound CatalogPort (fakes below), the https front, and ONE test-only override: the getein_metis driver is presented as `verified` to the host query service
//   (it is `generic` in the registry, so host query is inert there — §0/§7; hostQuery.getein_metis.test.ts does the same).
// SEAMS the writer relies on (all exist from MET-T01/H80-T05): e2e_main.go instruments[].profile = 'getein_metis' (full-form ACK, host-query relay to E05).
// KNOWN GAP (MET-T03 note, SPEC GAP 2): service/hostQuery.service.ts rejects a driver answer with zero barcodes, so the sample-range query (mode b, extractHostQueryBarcodes -> []) never reaches buildHostQueryReply and the
//   agent writes nothing. The test below pins the REQUIRED behaviour (QCK NF, §5/D-MET-1); the writer must let an empty barcode list through to the driver's NF reply (a CR if service ownership requires it).
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
import { geteinMetis } from '../../drivers/getein_metis/index.js';
import { createHostQueryService } from '../../service/hostQuery.service.js';
import { createIngestService } from '../../service/ingest.service.js';
import { AN, TEST, defaultInstruments, hqRepo, makeLab, makeOutboundCatalog } from '../hostQuery.helpers.js';
import { INS, makeIngestCtx, makeWorld, type World } from '../ingest.helpers.js';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
const SESS = join(ROOT, 'apps/bridge-agent/testdata/sessions');
const TOKEN = `e2e-${randomBytes(12).toString('hex')}`;       // synthetic, per run
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rmQuiet = (p: string) => { try { rmSync(p, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch (e) { console.warn('teardown rmSync failed:', p, (e as Error).message); } };
const VT = 0x0b, FS = 0x1c;
const PHI = ['MT2600000042', 'MT2600000043', 'MT2600000099', 'Test Patient', 'V000123', '19880912'];      // planted sentinels: never in agent output

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
  const world = makeWorld({ instruments: defaultInstruments().map((i) => ({ ...i, driver_code: 'getein_metis', protocol: 'hl7v2' })) });   // INS(2): live hl7v2, host query on
  const ingest = createIngestService({ repo: world.repo, getDriver } as never);
  const verifiedInTestOnly = (c: string) => (c === 'getein_metis' ? { ...geteinMetis, status: 'verified' as const } : getDriver(c));
  const hostQuery = createHostQueryService({ repo: hqRepo(world), getDriver: verifiedInTestOnly as never });
  const lab = makeLab({
    MT2600000042: { sex: 'female', ageDays: 13000, tests: [{ testId: TEST.glu, analyteIds: [AN.glu] }] },     // pending test, mapped outbound -> QCK OK + DSR
  });                                                                                                          // MT2600000099 is not registered at all -> lab.specimen_not_found -> NF
  const catalog = makeOutboundCatalog({ [AN.glu]: '100' });
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
      } catch (e: any) { (isHq ? hq : batches).push({ status: e?.status ?? 500, at: Date.now() } as never); send(e?.status ?? 500, { error: { code: e?.code ?? 'common.internal' } }); }
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
  instruments: [{ instrument_id: INS(2), protocol: 'hl7v2', transport: 'tcp_listen', listen: `127.0.0.1:${listen}`, profile: 'getein_metis' }],
});
const waitFor = async (cond: () => boolean, ms = 15_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await sleep(100); };

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'met-t04-'));
  bin = join(work, process.platform === 'win32' ? 'agent-e2e.exe' : 'agent-e2e');
  const b = spawnSync('go', ['-C', join(ROOT, 'apps/bridge-agent'), 'build', '-tags', 'e2e', '-o', bin, './cmd/agent'], { encoding: 'utf8' });
  if (b.status !== 0) throw new Error(`agent test build failed: ${b.stderr || b.error}`);
  stack = await startStack(work);
  port = await freePort();
  agent = await startAgent(bin, work, cfgFor(stack.url, stack.caPath, port));
}, 300_000);                                                       // a cold Go build cache on Windows takes > 90 s (seen: the hook timed out at 90 s)
afterAll(async () => { await agent?.stop(); await stack?.close(); if (work) rmQuiet(work); });

describe('MET-T04 simulator -> agent -> API -> analyser (Getein Metis)', () => {
  it('ORU patient (metis-oru-patient): agent ACKs AA in the §6 form (LIS/LIMS, MSH-10/12/16 echoed), uploaded, archived once, one result event, no PHI in it', async () => {
    const { sock, rd } = await connect(port);
    const [oru] = analyserSends('metis-oru-patient'); sock.write(oru!);
    const ack = await rd.frame(); expect(ack, 'agent ACK').toBeTruthy();
    expect(field(ack!, 'MSH', 3)).toBe('LIS'); expect(field(ack!, 'MSH', 4)).toBe('LIMS');
    expect(field(ack!, 'MSH', 9)).toBe('ACK^R01'); expect(field(ack!, 'MSH', 10)).toBe(field(text(oru!), 'MSH', 10));
    expect(field(ack!, 'MSH', 12)).toBe('2.3.1'); expect(field(ack!, 'MSH', 16)).toBe('0'); expect(field(ack!, 'MSH', 18)).toBe('UTF8');
    expect(field(ack!, 'MSA', 1)).toBe('AA'); expect(field(ack!, 'MSA', 2)).toBe(field(text(oru!), 'MSH', 10));
    await waitFor(() => stack.world.eventsOf('instruments.result.received.v1').length >= 1);
    const ev = stack.world.eventsOf('instruments.result.received.v1');
    expect(ev).toHaveLength(1);
    expect(ev[0]!['payload']).toMatchObject({ sample_barcode: 'MT2600000042', protocol: 'hl7v2', instrument_id: INS(2), value_raw: '31.2' });
    for (const s of ['Test Patient', '19880912', 'V000123']) expect(JSON.stringify(stack.world.events), `event must not carry ${s.slice(0, 3)}…`).not.toContain(s);
    expect(stack.world.messages.filter((m) => Buffer.from(m['raw_bytes'] as Buffer).toString('utf8').includes('ORU^R01'))).toHaveLength(1);
    expect(stack.hq).toHaveLength(0);                                       // a result is never a host query
    sock.destroy();
  }, 40_000);

  it('ORU QC (metis-oru-qc): ACK echoes MSH-16 = 2; two QC records (one per control level), no patient result event', async () => {
    const eventsBefore = stack.world.eventsOf('instruments.result.received.v1').length;
    const { sock, rd } = await connect(port);
    const [oru] = analyserSends('metis-oru-qc'); sock.write(oru!);
    const ack = await rd.frame(); expect(ack, 'agent ACK').toBeTruthy();
    expect(field(ack!, 'MSA', 1)).toBe('AA'); expect(field(ack!, 'MSA', 2)).toBe(field(text(oru!), 'MSH', 10)); expect(field(ack!, 'MSH', 16)).toBe('2');
    await waitFor(() => stack.world.records.filter((r) => r['record_class'] === 'qc').length >= 2);
    const qc = stack.world.records.filter((r) => r['record_class'] === 'qc');
    expect(qc).toHaveLength(2);
    expect(qc.map((r) => r['control_id_raw']).sort()).toEqual(['QCSYN1', 'QCSYN2']);
    expect(qc.map((r) => r['control_level']).sort()).toEqual(['high', 'low']);       // qc_level_map default L/H -> contract words
    expect(stack.world.eventsOf('instruments.result.received.v1')).toHaveLength(eventsBefore);   // QC is not a patient result
    sock.destroy();
  }, 40_000);

  it('QRY found (metis-qry-found): QCK OK then DSR in that order, written back-to-back; DSP-21 echoes the tube; ACK^Q03 is consumed (not archived, not answered)', async () => {
    const [qry, ackQ03] = analyserSends('metis-qry-found');
    const { sock, rd } = await connect(port);
    sock.write(qry!);
    const qck = await rd.frame(); const dsr = await rd.frame(2000);
    expect(qck, 'QCK').toBeTruthy(); expect(dsr, 'DSR').toBeTruthy();
    expect(field(qck!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(qck!, 'QAK', 1)).toBe('SR'); expect(field(qck!, 'QAK', 2)).toBe('OK'); expect(field(qck!, 'MSA', 2)).toBe(field(text(qry!), 'MSH', 10));
    expect(field(dsr!, 'MSH', 9)).toBe('DSR^Q03'); expect(field(dsr!, 'MSA', 2)).toBe(field(text(qry!), 'MSH', 10));
    expect(seg(dsr!).find((s) => s.startsWith('DSP|21|'))?.split('|')[3]).toBe('MT2600000042');
    expect(seg(dsr!).some((s) => s.startsWith('DSP|29|') && s.split('|')[3]!.startsWith('100'))).toBe(true);          // the mapped test id, id_only detail
    for (const s of ['Test Patient', '19880912', 'V000123']) expect(dsr!, `DSR must not carry ${s.slice(0, 3)}…`).not.toContain(s);   // PHI minimisation: no registered name / DOB / id
    expect(dsr!.endsWith('|\r') || dsr!.endsWith('|')).toBe(true);                                                      // trailing pipe on every segment
    sock.write(ackQ03!);                                                         // MSA-2 = the query id, not the DSR id (§6): accepted
    expect(await rd.frame(1000), 'nothing is answered to the analyser ACK^Q03').toBeUndefined();
    expect(stack.hq.at(-1)?.status).toBe(200);
    sock.destroy();
  }, 40_000);

  it('QRY not found (metis-qry-not-found): ONE message, QCK NF, no DSR', async () => {
    const [qry] = analyserSends('metis-qry-not-found');
    const { sock, rd } = await connect(port);
    sock.write(qry!);
    const qck = await rd.frame(); expect(qck, 'QCK').toBeTruthy();
    expect(field(qck!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(qck!, 'QAK', 2)).toBe('NF'); expect(field(qck!, 'MSA', 2)).toBe(field(text(qry!), 'MSH', 10));
    expect(await rd.frame(1000), 'no DSR after QCK NF').toBeUndefined();
    sock.destroy();
  }, 40_000);

  it('QRY sample-number range (metis-qry-sample-range-nf, D-MET-1): answered QCK NF, no DSR, no lab lookup is needed', async () => {
    const [qry] = analyserSends('metis-qry-sample-range-nf');
    const { sock, rd } = await connect(port);
    sock.write(qry!);
    const qck = await rd.frame(); expect(qck, 'QCK NF (see KNOWN GAP in the header if this is missing)').toBeTruthy();
    expect(field(qck!, 'MSH', 9)).toBe('QCK^Q02'); expect(field(qck!, 'QAK', 2)).toBe('NF'); expect(field(qck!, 'MSA', 2)).toBe(field(text(qry!), 'MSH', 10));
    expect(await rd.frame(1000), 'no DSR after QCK NF').toBeUndefined();
    sock.destroy();
  }, 40_000);

  it('archive: each query is archived exactly once as host_query (E05 + later batch upload dedupe), the ACK^Q03 never; no raw barcode / name in agent output (PHI)', async () => {
    await sleep(2500);                                                           // > flush interval: the queued host_query items have been uploaded
    const hqMsgs = stack.world.messages.filter((m) => m['message_kind'] === 'host_query');
    expect(hqMsgs).toHaveLength(3);                                              // found, not found, sample range
    expect(stack.world.messages.some((m) => Buffer.from(m['raw_bytes'] as Buffer).toString('utf8').includes('ACK^Q03'))).toBe(false);
    expect(stack.hq.every((h) => h.status === 200)).toBe(true);
    expect(stack.batches.every((b) => b.status === 200)).toBe(true);
    const log = agent.out.join('');
    for (const s of PHI) expect(log, `agent output must not contain ${s.slice(0, 3)}…`).not.toContain(s);
  }, 20_000);

  it('API unreachable (D-MET-3 / AC-10.6): the agent sends NO reply and keeps the session; a result is still ACKed locally (queued for later upload)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'met-t04-down-'));
    try {
      const dead = await freePort();                                             // nothing listens here
      const p = await freePort();
      const bad = await startAgent(bin, dir, cfgFor(`https://127.0.0.1:${dead}`, stack.caPath, p));
      const { sock, rd } = await connect(p);
      sock.write(analyserSends('metis-qry-found')[0]!);
      expect(await rd.frame(4000), 'no QCK, no DSR, no ACK while the API is unreachable').toBeUndefined();
      sock.write(analyserSends('metis-oru-patient')[0]!);
      const ack = await rd.frame(); expect(ack && field(ack, 'MSA', 1)).toBe('AA');
      sock.destroy(); await bad.stop();
    } finally { rmQuiet(dir); }
  }, 60_000);
});
