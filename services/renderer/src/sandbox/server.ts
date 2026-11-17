// PDF sandbox HTTP server (02-TRD §5.2; REQ-SEC-083/087): POST /internal/sanitize, POST /internal/assemble, GET /internal/health.
// Bearer token (constant-time) on both POST routes; health is open and returns only a status word.
// qpdf is spawned with an argument array (never a shell). No outbound client, no Chromium. Options: see ./DECISIONS.md.
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, rgb, StandardFonts, type PDFObject } from '@cantoo/pdf-lib';

const run = promisify(execFile);

const MAX_FILE = 15 * 1024 * 1024; // 02-TRD §5.2 "file ≤ 15 MB"
const MAX_JSON = 64 * 1024 * 1024; // [CONV] assemble body cap (512 MB container); ponytail: raise if many 15 MB parts are needed
const MAX_PARTS = 50; // [CONV]
const MAX_PAGES = 200; // [CONV] 02-TRD §5.2 step 5
const JOB_TIMEOUT_MS = 60_000; // [CONV] per-call wall clock
const QPDF_TIMEOUT_MS = 30_000; // [CONV] per qpdf process
const MARGIN_PT = 28; // [CONV] stamp inset from the page edge (footer_right / NOT RELEASED at footer left)
const KINDS = new Set(['main', 'outsourced', 'instrument_pdf']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ASCII_LABEL = /^[\x20-\x7e]{1,64}$/;

// Names that make an untrusted PDF active or fetch/launch something (07-SECURITY A12). Names are normalised by the parser,
// so `/#4AS` style escapes cannot hide them.
const ACTIVE_NAMES = new Set([
  '/JavaScript', '/JS', '/Launch', '/EmbeddedFile', '/EmbeddedFiles', '/EF', '/RichMedia', '/OpenAction', '/URI',
  '/GoToR', '/GoToE', '/SubmitForm', '/ImportData', '/Rendition', '/Movie', '/Sound',
  '/XFA', // review C6-T12 item 3: XFA forms carry scripts with no /JS name
]);

type Reason = 'encrypted' | 'malformed' | 'too_many_pages' | 'timeout' | 'not_pdf';
// Erasable TypeScript only (no parameter properties): the image runs this file with Node's built-in type stripping.
class Reject extends Error {
  readonly reason: Reason;
  constructor(reason: Reason) {
    super(reason);
    this.reason = reason;
  }
}
class BadRequest extends Error {}

type Job = { dir: string; deadline: number; qpdfTimeoutMs: number };

const digest = (s: string) => createHash('sha256').update(s).digest();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function qpdf(job: Job, args: string[]): Promise<{ code: number; stdout: string }> {
  const left = job.deadline - Date.now();
  if (left <= 0) throw new Reject('timeout');
  try {
    const r = await run('qpdf', args, {
      cwd: job.dir,
      timeout: Math.min(job.qpdfTimeoutMs, left),
      killSignal: 'SIGKILL',
      maxBuffer: 1 << 20,
      windowsHide: true,
    });
    return { code: 0, stdout: String(r.stdout) };
  } catch (e) {
    const err = e as { killed?: boolean; code?: unknown; stdout?: unknown };
    if (err.killed) throw new Reject('timeout');
    if (typeof err.code === 'number') return { code: err.code, stdout: String(err.stdout ?? '') }; // qpdf exit 2 = error, 3 = warnings
    throw e; // qpdf missing etc. → 500, nothing on the wire
  }
}

function hasActiveContent(doc: PDFDocument): boolean {
  const stack: PDFObject[] = [];
  for (const [, o] of doc.context.enumerateIndirectObjects()) stack.push(o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFName) {
      if (ACTIVE_NAMES.has(o.asString())) return true;
    } else if (o instanceof PDFArray) {
      for (const x of o.asArray()) stack.push(x);
    } else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) stack.push(k, v);
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  return false;
}

/** Sanitise profile (02-TRD §5.2): magic → encrypted → structural → page count → rewrite + linearise → (strict) active content. */
async function sanitizeBytes(job: Job, bytes: Buffer, strict: boolean): Promise<{ pdf: Buffer; pages: number }> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Reject('not_pdf');
  const inp = join(job.dir, 'in.pdf');
  const out = join(job.dir, 'out.pdf');
  await writeFile(inp, bytes, { mode: 0o600 });
  if ((await qpdf(job, ['--is-encrypted', inp])).code === 0) throw new Reject('encrypted');
  // Any non-zero exit (2 error, 3 warnings = qpdf had to repair) is malformed: a recovered file is not trusted.
  if ((await qpdf(job, ['--check', inp])).code !== 0) throw new Reject(/\/Encrypt\b/.test(bytes.toString('latin1')) ? 'encrypted' : 'malformed');
  const np = await qpdf(job, ['--show-npages', inp]);
  const pages = Number(np.stdout.trim());
  if (np.code !== 0 || !Number.isInteger(pages) || pages < 1) throw new Reject('malformed');
  if (pages > MAX_PAGES) throw new Reject('too_many_pages');
  const rw = await qpdf(job, ['--linearize', '--object-streams=disable', '--stream-data=preserve', inp, out]);
  if (rw.code !== 0) throw new Reject('malformed');
  const pdf = await readFile(out);
  if (strict) {
    let active: boolean;
    try {
      active = hasActiveContent(await PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: false }));
    } catch {
      throw new Reject('malformed');
    }
    if (active) throw new Reject('malformed');
  }
  return { pdf, pages };
}

type Stamp = { fmt: string; size: number; notReleased: boolean };

function parseAssemble(raw: string): { parts: { kind: string; pdf: Buffer }[]; stamp: Stamp } {
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    throw new BadRequest();
  }
  const { parts, stamp } = (b ?? {}) as Record<string, unknown>;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_PARTS) throw new BadRequest();
  const s = (stamp ?? {}) as Record<string, unknown>;
  const m = (s.markers ?? {}) as Record<string, unknown>;
  if (
    typeof s.page_label_format !== 'string' || !ASCII_LABEL.test(s.page_label_format) || // the stamper writes ASCII only
    s.position !== 'footer_right' ||
    typeof s.font_size_pt !== 'number' || !(s.font_size_pt >= 4 && s.font_size_pt <= 24) ||
    typeof m.plain !== 'boolean' || typeof m.not_released !== 'boolean'
  ) throw new BadRequest();
  return {
    parts: parts.map((p) => {
      const { kind, pdf_base64, sha256: want } = (p ?? {}) as Record<string, unknown>;
      if (typeof kind !== 'string' || !KINDS.has(kind)) throw new BadRequest();
      if (typeof pdf_base64 !== 'string' || pdf_base64.length % 4 !== 0 || !BASE64.test(pdf_base64)) throw new BadRequest();
      const pdf = Buffer.from(pdf_base64, 'base64');
      if (typeof want !== 'string' || want.toLowerCase() !== sha256(pdf)) throw new BadRequest();
      return { kind, pdf };
    }),
    stamp: { fmt: s.page_label_format, size: s.font_size_pt, notReleased: m.not_released },
  };
}

async function assemble(job: Job, parts: { kind: string; pdf: Buffer }[], stamp: Stamp): Promise<{ pdf: Uint8Array; pages: number }> {
  // Every part is re-parsed here, inside the sandbox. `main` is our own Chromium output: structure/encryption are checked, but
  // its link annotations are legitimate, so the active-content scan applies to outsourced / instrument parts only.
  const files: string[] = [];
  for (const [i, p] of parts.entries()) {
    const sub: Job = { ...job, dir: join(job.dir, `p${i}`) };
    mkdirSync(sub.dir, { recursive: true });
    const { pdf } = await sanitizeBytes(sub, p.pdf, p.kind !== 'main');
    const f = join(job.dir, `part${i}.pdf`);
    await writeFile(f, pdf, { mode: 0o600 });
    files.push(f);
  }
  const merged = join(job.dir, 'merged.pdf');
  const r = await qpdf(job, ['--empty', '--object-streams=disable', '--stream-data=preserve', '--pages', ...files, '--', merged]);
  if (r.code !== 0) throw new Reject('malformed');

  const doc = await PDFDocument.load(await readFile(merged), { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    const label = stamp.fmt.replaceAll('{n}', String(i + 1)).replaceAll('{m}', String(pages.length));
    // Review C6-T12 item 2: anchor to the visible box (CropBox, else MediaBox) and its /Rotate, so the stamp sits upright at
    // the bottom of the page as displayed, whatever the box origin.
    const { x: x0, y: y0, width: w, height: h } = page.getCropBox();
    const r = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    const W = r === 90 || r === 270 ? h : w;
    // display point (sx, sy; origin bottom-left as shown) → user space; text rotated by r keeps it upright on screen
    const at = (sx: number, sy: number) =>
      r === 90 ? { x: x0 + w - sy, y: y0 + sx }
      : r === 180 ? { x: x0 + w - sx, y: y0 + h - sy }
      : r === 270 ? { x: x0 + sy, y: y0 + h - sx }
      : { x: x0 + sx, y: y0 + sy };
    const tw = font.widthOfTextAtSize(label, stamp.size);
    page.drawText(label, { ...at(Math.max(MARGIN_PT, W - MARGIN_PT - tw), MARGIN_PT), rotate: degrees(r), size: stamp.size, font });
    if (stamp.notReleased) page.drawText('NOT RELEASED', { ...at(MARGIN_PT, MARGIN_PT), rotate: degrees(r), size: stamp.size, font: bold, color: rgb(0.75, 0, 0) });
  });
  // classic xref: the shared test extractor does not read object streams
  return { pdf: await doc.save({ useObjectStreams: false }), pages: pages.length };
}

export async function startServer(o: { token: string; port?: number; host?: string; workDir?: string; qpdfTimeoutMs?: number }) {
  if (!o.token) throw new Error('sandbox token is empty');
  const want = digest(o.token);
  const workDir = o.workDir ?? tmpdir();
  mkdirSync(workDir, { recursive: true });
  const authed = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    return timingSafeEqual(digest(tok), want) && tok.length > 0;
  };
  const send = (res: http.ServerResponse, status: number, body: string | Buffer = '', type = 'text/plain; charset=utf-8', extra: http.OutgoingHttpHeaders = {}) =>
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra }).end(body);
  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), 'application/json');

  /** Per-job scratch dir, removed (and awaited) before the response is sent. */
  async function withJob<T>(fn: (job: Job) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(workDir, 'job-'));
    try {
      return await fn({ dir, deadline: Date.now() + JOB_TIMEOUT_MS, qpdfTimeoutMs: o.qpdfTimeoutMs ?? QPDF_TIMEOUT_MS });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }

  const readBody = (req: http.IncomingMessage, max: number) =>
    new Promise<Buffer | undefined>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (c: Buffer) => {
        size += c.length;
        if (size <= max) return void chunks.push(c);
        req.off('data', onData);
        resolve(undefined);
      };
      req.on('data', onData);
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  const tooBig = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('connection', 'close'); // answer, then drain; requestTimeout bounds a client that keeps streaming
    send(res, 413);
    req.resume();
  };

  const server = http.createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/internal/health') return send(res, 200, 'ok');
      if (path !== '/internal/sanitize' && path !== '/internal/assemble') return send(res, 404);
      if (!authed(req)) return send(res, 401);
      if (req.method !== 'POST') return send(res, 405);

      if (path === '/internal/sanitize') {
        const max = MAX_FILE + 1024 * 1024; // multipart framing
        if (Number(req.headers['content-length'] ?? 0) > max) return tooBig(req, res);
        const raw = await readBody(req, max);
        if (!raw) return tooBig(req, res);
        let file: unknown;
        try {
          file = (await new Response(new Uint8Array(raw), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData()).get('file');
        } catch {
          return send(res, 400);
        }
        if (!(file instanceof Blob)) return send(res, 400);
        if (file.size > MAX_FILE) return send(res, 413);
        const bytes = Buffer.from(await file.arrayBuffer());
        try {
          const { pdf, pages } = await withJob((job) => sanitizeBytes(job, bytes, true));
          return sendJson(res, 200, { ok: true, page_count: pages, sha256: sha256(pdf), pdf_base64: pdf.toString('base64') });
        } catch (e) {
          if (e instanceof Reject) return sendJson(res, 422, { ok: false, reason: e.reason });
          throw e;
        }
      }

      if (Number(req.headers['content-length'] ?? 0) > MAX_JSON) return tooBig(req, res);
      const raw = await readBody(req, MAX_JSON);
      if (!raw) return tooBig(req, res);
      try {
        const { parts, stamp } = parseAssemble(raw.toString('utf8'));
        const { pdf, pages } = await withJob((job) => assemble(job, parts, stamp));
        return send(res, 200, Buffer.from(pdf), 'application/pdf', { 'x-page-count': String(pages) });
      } catch (e) {
        if (e instanceof BadRequest) return send(res, 400);
        if (e instanceof Reject) return sendJson(res, 422, { ok: false, reason: e.reason });
        throw e;
      }
    } catch {
      // Never a stack trace, path or qpdf stderr on the wire.
      if (!res.headersSent) send(res, 500);
      else res.destroy();
    }
  });
  server.requestTimeout = JOB_TIMEOUT_MS;
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', r));
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Process entry: `node dist/sandbox/server.js`. Token from LIMS_RENDER_SANDBOX_TOKEN_FILE (02-TRD §5.2, 08 A27.3).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tokenFile = process.env.LIMS_RENDER_SANDBOX_TOKEN_FILE;
  if (!tokenFile) throw new Error('LIMS_RENDER_SANDBOX_TOKEN_FILE is required');
  const token = readFileSync(tokenFile, 'utf8').trim();
  // ponytail: port 8080 and the /work tmpfs are fixed [CONV]; spec names no port key — C1 wires the network to it.
  const srv = await startServer({ token, port: 8080, host: '0.0.0.0', workDir: '/work' });
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
