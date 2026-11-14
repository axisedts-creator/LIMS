// CB1 receiveProviderCallback / CB2 verifyProviderCallback (02-TRD §6.7; 01-PRD AC-09.3; 07-SECURITY T12 / A13, REQ-SEC-024 / 095 / 136).
// Every failure is the SAME LimsError('reporting.callback_rejected') (400): unknown token = bad signature = malformed body, nothing is echoed or logged (no token, signature, body).
// CR-C6-001: the adapter checks the signature over req.rawBody. LD-49 (b): the DEFINER only records and returns the tenant id; THIS service enqueues
// reporting.apply_provider_events via ctx.queue.enqueue inside ctx.db.withTenantScope(returned tenant, the reporting system actor). A forged token enqueues nothing.
// [CONV] provider_kind is a DEFINER argument but is only known after the token lookup: outside production the only adapter is `recording` (REQ-SEC-136);
// in production no adapter implements parseCallback yet (T27/T28), so every callback is rejected there.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { callbackAdapter } from '../delivery/callbacks.js';
import type { Transport } from '../delivery/transport.js';
import { hashToken } from '../domain/tokens.js';
import { ingestProviderCallback, type IngestEvent } from '../repository/callbacks.repo.js';

type Tx = Parameters<typeof ingestProviderCallback>[0];
export interface CallbackCtx {
  tx?: Tx;
  db?: { withTenantScope<T>(tx: unknown, tenantId: string, systemActorId: string, fn: () => Promise<T>): Promise<T> };
  queue?: { enqueue(tx: unknown, identifier: string, payload: Record<string, unknown>, jobKey?: string): Promise<unknown> };
  core?: { systemActorOf(module: string): string };
}
export interface CallbackReq { token: unknown; rawBody?: unknown; headers?: Record<string, string | undefined>; query?: Record<string, unknown> }
export interface CallbackDeps { env?: Record<string, string | undefined>; adapter?: Transport | undefined }

const APPLY = 'reporting.apply_provider_events';
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;                    // OpenAPI callback_token pattern
const CHUNK = 100;                                        // the DEFINER's cap per call
const CHALLENGE = /^[A-Za-z0-9._~-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rejected = (): never => { throw new LimsError('reporting.callback_rejected'); };

export function createCallbacksService(deps: CallbackDeps = {}) {
  const adapter = (): Transport | undefined => ('adapter' in deps ? deps.adapter : callbackAdapter(deps.env ?? process.env));

  /** Hash the path token, ask the DEFINER (token check + store); the tenant id it returns is the only tenant source. */
  async function ingest(ctx: CallbackCtx, kind: string, token: unknown, events: IngestEvent[][]): Promise<string> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return rejected();
    if (!ctx?.tx) throw new LimsError('common.internal');   // fail closed
    const hash = hashToken(token);
    let tenant: string | null = null;
    for (const chunk of events) {
      const t = await ingestProviderCallback(ctx.tx, kind, hash, chunk);
      if (t === null || !UUID.test(t)) return rejected();
      tenant = t;
    }
    return tenant ?? rejected();
  }

  return {
    /** CB1 */
    async receive(ctx: CallbackCtx, req: CallbackReq): Promise<{ status: 200; body: Record<string, never> }> {
      const a = adapter();
      const raw = req.rawBody;
      if (!a?.parseCallback || !(raw instanceof Uint8Array) || raw.length === 0) return rejected();
      let parsed;
      try { parsed = a.parseCallback(raw, req.headers ?? {}); } catch { return rejected(); }
      const events: IngestEvent[] = parsed.map((e) => ({
        id: uuidv7() as string, provider_message_id: e.providerMessageId.slice(0, 128), status_raw: e.statusRaw.slice(0, 64), mapped_status: e.mappedStatus,
        ...(e.occurredAt === undefined ? {} : { occurred_at: e.occurredAt }),
      }));
      const chunks: IngestEvent[][] = [];
      for (let i = 0; i < events.length; i += CHUNK) chunks.push(events.slice(i, i + CHUNK));
      const tenantId = await ingest(ctx, a.providerKind, req.token, chunks.length ? chunks : [[]]);
      if (!ctx.db || !ctx.queue || !ctx.core) throw new LimsError('common.internal');
      const { db, queue, core, tx } = { db: ctx.db, queue: ctx.queue, core: ctx.core, tx: ctx.tx };
      await db.withTenantScope(tx, tenantId, core.systemActorOf('reporting'), () => queue.enqueue(tx, APPLY, { tenant_id: tenantId }, `pe:${tenantId}`));
      return { status: 200, body: {} };
    },

    /** CB2: the same token check with no events; answers the provider's challenge as text/plain (never markup). */
    async verify(ctx: CallbackCtx, req: CallbackReq): Promise<{ status: 200; headers: Record<string, string>; body: string }> {
      const a = adapter();
      if (!a) return rejected();
      await ingest(ctx, a.providerKind, req.token, [[]]);
      const c = req.query?.['challenge'];
      return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }, body: typeof c === 'string' && CHALLENGE.test(c) ? c : 'ok' };
    },
  };
}
