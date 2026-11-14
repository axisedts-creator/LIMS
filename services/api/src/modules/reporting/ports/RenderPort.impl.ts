// RenderPort (03-IC §4.16, 02-TRD §7.4, 08 R12c) — real C6 implementation. System actors only; data validated against
// contracts/render/<templateKey>.schema.json before the renderer is called; bytes are returned to the caller and kept nowhere (08 R26).
// Errors carry a stable code only: never the token, the data or the response body (the data can hold PHI and the access-slip portalUrl).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT } from '../../../core/module.js';
import { IDEMPOTENCY_KEY_RE, portalReportUrlOk } from '../domain/messages.js';

// [CONV] ajv is not a direct services/api dependency (lockfile is C0-0A's, LD-05): load the ajv that @fastify/ajv-compiler ships (same as core/events/publish.ts).
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => { compile(s: object): (v: unknown) => boolean };
const readJson = createRequire(import.meta.url);   // JSON schemas are loaded with require: this file does no file I/O of its own

export type RenderTemplateKey = 'billing.invoice' | 'billing.credit_note' | 'billing.register' | 'analytics.report' | 'partners.access_slip';
const KEYS: ReadonlySet<string> = new Set(['billing.invoice', 'billing.credit_note', 'billing.register', 'analytics.report', 'partners.access_slip']);
export interface RenderPdfResult { contentBase64: string; sha256: string; byteSize: number; pageCount: number }
export interface RenderPort {
  renderPdf(ctx: { actor: { type: string } }, input: { templateKey: RenderTemplateKey; data: Readonly<Record<string, unknown>>; idempotencyKey: string }): Promise<RenderPdfResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;               // IC §4.16
const MAX_PDF_BYTES = 10 * 1024 * 1024;          // IC §4.16 "> 10 MB output"; [CONV] measured on the raw PDF bytes
const MAX_ANALYTICS_ROWS = 5_000;                // IC §4.16

const unavailable = () => new LimsError('reporting.render_unavailable');
const invalidData = () => new LimsError('reporting.template_invalid');

export function createRenderPort(o: { url: string; token: string; timeoutMs?: number; schemas?: Record<string, object>; env?: Record<string, string | undefined> }): RenderPort {
  if (typeof o?.token !== 'string' || o.token.length === 0) throw new Error('RenderPort: renderer token is required');
  const endpoint = `${String(o.url).replace(/\/+$/, '')}/internal/render`;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  const validators = new Map<string, (v: unknown) => boolean>();
  const validatorFor = (key: string) => {
    let v = validators.get(key);
    if (!v) {
      // ponytail: a missing schema file fails closed as render_unavailable (deployment fault, not caller data); no CR code exists for it.
      let schema: object | undefined = o.schemas ? Object.getOwnPropertyDescriptor(o.schemas, key)?.value : undefined;
      try { schema ??= readJson(join(REPO_ROOT, 'contracts', 'render', `${key}.schema.json`)) as object; } catch { throw unavailable(); }
      v = ajv.compile(schema);
      validators.set(key, v);
    }
    return v;
  };

  return {
    async renderPdf(ctx, input) {
      if (ctx?.actor?.type !== 'system') throw new LimsError('auth.forbidden');                     // before anything else: no schema oracle
      if (typeof input?.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) throw new LimsError('common.validation_failed', 'idempotency_key_invalid');
      const key = input.templateKey;
      if (typeof key !== 'string' || !KEYS.has(key)) throw new LimsError('common.validation_failed', 'template_key_unknown');
      const { data } = input;
      if (typeof data !== 'object' || data === null || Array.isArray(data) || !validatorFor(key)(data)) throw invalidData();
      if (key === 'partners.access_slip') {   // 02-TRD §7.4 case 8: portalUrl starts with LIMS_ORIGIN_PORTAL + '/r/' (as the `url` message param); unset origin fails closed
        const origin = (o.env ?? process.env)['LIMS_ORIGIN_PORTAL']?.replace(/\/+$/, '');
        const url = data['portalUrl'];
        if (typeof url !== 'string' || !portalReportUrlOk(url, origin)) throw invalidData();
      }
      if (key === 'analytics.report' && (!Array.isArray(data['rows']) || data['rows'].length > MAX_ANALYTICS_ROWS)) throw invalidData();

      let res: Response; let bytes: Buffer;
      try {
        const signal = AbortSignal.timeout(timeoutMs);   // covers connect, headers and body
        res = await fetch(endpoint, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` },
          body: JSON.stringify({ template_id: key, data, assets: {} }), signal,   // second /internal/render shape (02-TRD §5.1)
        });
        if (res.status === 422) throw invalidData();     // template error / page limit
        if (!res.ok) throw unavailable();                // 408 / 5xx / 401 / 400 …
        const len = Number(res.headers.get('content-length'));
        if (Number.isFinite(len) && len > MAX_PDF_BYTES) { void res.body?.cancel().catch(() => {}); throw new LimsError('common.payload_too_large'); }
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (e instanceof LimsError) throw e;
        throw unavailable();                             // refused / timeout / dropped body; no cause: undici errors can carry the URL or headers
      }
      if (bytes.length > MAX_PDF_BYTES) throw new LimsError('common.payload_too_large');
      const pageCount = Number(res.headers.get('x-page-count'));
      if (!Number.isInteger(pageCount) || pageCount < 1 || bytes.length === 0) throw unavailable();
      return { contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, pageCount };
    },
  };
}
