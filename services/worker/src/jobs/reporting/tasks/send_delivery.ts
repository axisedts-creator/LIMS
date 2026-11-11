// Task reporting.send_delivery (02-TRD §4.8, §5.4, §9; 01-PRD AC-09.1, AC-09.4, AC-09.5, AC-09.8; 07-SECURITY REQ-SEC-070/101/136).
// Lock + claim the queued delivery -> re-check channel switch / consent / contact as the system actor (suppressed + immediate SMS fallback for WhatsApp, review fix #19)
// -> issue the deferred link (previous unsent link revoked, `superseded_attempt`) -> render the tenant text -> transport -> one delivery_attempts row -> sent | failed | retry.
// Providers: outside production EVERY delivery goes through the `recording` adapter (REQ-SEC-136); in production only a real, allowed provider (NODE_ENV +
// LIMS_REPORTING_ALLOW_REAL_PROVIDERS), never `recording`. A retryable error keeps its attempt row because the task RESOLVES and re-enqueues itself (the worker JobContext has no
// commitOnError and a throw rolls the attempt log back); port / DB failures throw for the queue retry. Max 8 attempts, then `failed` / retries_exhausted.
// [CONV] circuit breaker (10 consecutive retryable failures per channel account, open 60 s) is per worker process. Secret resolution for real providers lands with T27/T28:
// creds = { secretRef }. [CONV] failure codes channel_not_configured, provider_not_permitted, provider_unavailable, template_text_missing, link_unavailable
// are not in 02-TRD §5.4 / 04-UI-UX §2.5 (CR-C6-027, .orchestra/cr/C6-T23.md). Staff / partner recipients are re-resolved as `no_contact` (open point in C6-T23-impl.md).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { recordingTransport } from '../../../../../api/src/modules/reporting/delivery/adapters/recording.js';
import { TransportError, type OutboundMessage, type Transport } from '../../../../../api/src/modules/reporting/delivery/transport.js';
import { issueToken } from '../../../../../api/src/modules/reporting/domain/tokens.js';
import { maskAddress, sha256 } from '../../../../../api/src/modules/reporting/domain/messages.js';
import {
  claimDelivery, findActiveChannelAccount, findDelivery, findQrSnapshot, findReportMeta, findTemplateText, insertAttempt, insertPortalLink, latestAttemptNo, revokeDeliveryLinks, transitionDelivery,
} from '../../../../../api/src/modules/reporting/repository/delivery.repo.js';
import { findSettings } from '../../../../../api/src/modules/reporting/repository/settings.repo.js';
import { publishTransition } from '../../../../../api/src/modules/reporting/service/delivery.service.js';
import { createSmsFallback, isFallbackFailure, port, resolveRecipient, type FlowCtx } from '../../../../../api/src/modules/reporting/service/delivery.flow.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND = 'reporting.send_delivery'; const FALLBACK = 'reporting.check_whatsapp_fallback';
const MAX_ATTEMPTS = 8; const CIRCUIT_FAILS = 10; const CIRCUIT_OPEN_MS = 60_000;
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4::timestamptz, $5)';
type Env = Record<string, string | undefined>;
type Row = Record<string, any>;

export interface SendDeps { env?: Env; transports?: Record<string, Transport> }

// [C6-T39 / 08 A4.3] label_text is stored raw and HTML-escaped when inserted into an e-mail body/subject (`esc` = channel email only; sms/whatsapp are plain text).
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fill = (t: string, p: Record<string, string>, esc = false) => t.replace(/\{([a-z_]+)\}/g, (_m, k: string) => (esc ? escHtml(p[k] ?? '') : p[k] ?? ''));

export function createSendDelivery(deps: SendDeps = {}): TaskHandler {
  const breaker = new Map<string, { fails: number; openUntil: number }>();
  return async (payload, jobCtx) => {
    const ctx = jobCtx as unknown as FlowCtx & { now(): string; log?: any };
    const env = deps.env ?? process.env;
    const tenantId = ctx.tenantId; const id = payload?.['delivery_id']; const actor = ctx.actor.id;
    if (typeof tenantId !== 'string' || typeof id !== 'string' || !UUID.test(id)) return;
    const tx = ctx.tx as any;
    const now = ctx.now(); const nowMs = Date.parse(now);
    const metrics = (ctx as any).metrics as { inc?(n: string, l?: Record<string, unknown>): void; set?(n: string, v: number, l?: Record<string, unknown>): void } | undefined;

    const d: Row | undefined = await findDelivery(tx, tenantId, id, true);
    if (!d || d['status'] !== 'queued') return;                      // already handled / unknown: silent no-op
    const attemptNo = (await latestAttemptNo(tx, tenantId, id)) + 1;
    if (!(await claimDelivery(tx, tenantId, id, d['version'], attemptNo, now, actor))) return;   // another run won

    const record = (outcome: string, errorCode: string | null) =>
      insertAttempt(tx, { id: uuidv7() as string, tenantId, deliveryId: id, attemptNo, startedAt: now, finishedAt: now, outcome, errorCode, actorId: actor });
    const enqueue = (identifier: string, key: string, runAt: string | null) =>
      tx.query(ENQUEUE, [identifier, JSON.stringify({ delivery_id: id }), key, runAt, MAX_ATTEMPTS]);
    const finish = async (to: 'sent' | 'failed' | 'suppressed', failureCode: string | null, extra: Row = {}) => {
      const v = await transitionDelivery(tx, tenantId, id, { status: to, failureCode, at: now, actorId: actor, ...extra });
      if (v === undefined) return false;
      metrics?.inc?.('lims_reporting_deliveries_total', { channel: d['channel'], purpose: d['purpose'], status: to });   // T33; bounded labels, no destination / id
      await publishTransition(ctx, d, to, { seq: v, at: now, attemptNo, failureCode });
      return true;
    };
    const fallbackIfWhatsapp = () => createSmsFallback(ctx, d);

    // 1. consent / channel / contact re-check (AC-09.4, REQ-ARCH-085)
    const report = d['report_id'] ? await findReportMeta(tx, tenantId, d['report_id']) : undefined;
    const r = await resolveRecipient(ctx, { channel: d['channel'], purpose: d['purpose'], kind: d['recipient_kind'], recipientId: d['recipient_id'], patientId: report?.patient_id ?? null, e164: d['destination_e164'], centreId: d['centre_id'] ?? report?.centre_id ?? null });
    if (!r.ok) {
      await record('suppressed', r.failure);
      await finish('suppressed', r.failure);
      if (isFallbackFailure(r.failure)) await fallbackIfWhatsapp();
      return;
    }
    const address = r.address;
    if (!address) { await record('suppressed', 'no_contact'); await finish('suppressed', 'no_contact'); return; }

    const permanent = async (code: string) => {
      await record('permanent_error', code);
      await finish('failed', code);
      await fallbackIfWhatsapp();
    };

    // 2. provider choice (REQ-SEC-136)
    const prod = env['NODE_ENV'] === 'production';
    const account = await findActiveChannelAccount(tx, tenantId, d['channel']);
    let kind = 'recording';
    if (prod) {
      if (!account) return permanent('channel_not_configured');
      kind = account.provider_kind;
      if (kind === 'recording' || env['LIMS_REPORTING_ALLOW_REAL_PROVIDERS'] !== 'true') return permanent('provider_not_permitted');
    }
    const transport = kind === 'recording' ? (deps.transports?.['recording'] ?? recordingTransport) : deps.transports?.[kind];
    if (!transport) return permanent('provider_unavailable');

    // 3. circuit breaker per channel account
    const bk = account?.id ?? d['channel']; const b = breaker.get(bk) ?? { fails: 0, openUntil: 0 };
    if (b.openUntil > nowMs) {
      metrics?.set?.('lims_reporting_transport_circuit_open', 1);   // T33 alert gauge; per worker process like the breaker
      await record('circuit_open', 'circuit_open');
      await enqueue(SEND, `${id}:retry:${attemptNo}`, new Date(b.openUntil).toISOString());
      return;
    }
    if (b.openUntil !== 0) { b.fails = 0; b.openUntil = 0; metrics?.set?.('lims_reporting_transport_circuit_open', 0); }

    // 4. message: tenant text + deferred link (the plaintext URL exists only in memory)
    const text = await findTemplateText(tx, tenantId, d['template_code'], d['channel'], d['language']);
    if (!text) return permanent('template_text_missing');
    if (d['channel'] === 'whatsapp' && text['approval_status'] !== 'approved') return permanent('template_not_approved');
    const params: Record<string, string> = { ...(d['params'] ?? {}) };
    let linkId: string | null = null;
    const dl = d['deferred_link'];
    if (dl && typeof dl === 'object') {
      const meta = report ?? (d['report_id'] ? await findReportMeta(tx, tenantId, d['report_id']) : undefined);
      const centreId = d['centre_id'] ?? meta?.centre_id;
      if (!centreId || !d['report_id']) return permanent('link_unavailable');
      await revokeDeliveryLinks(tx, tenantId, id, 'superseded_attempt', now, actor);
      const ttl = (await port(ctx, 'IdentityPort', 'identity').getTenantSettings(ctx, { keys: ['reportLinkTtlDays'] }))?.reportLinkTtlDays;
      const days = Number.isInteger(ttl) && ttl >= 1 && ttl <= 90 ? ttl : 30;
      const { token, tokenSha256 } = issueToken('link');
      linkId = uuidv7() as string;
      await insertPortalLink(tx, {
        id: linkId, tenantId, centreId, reportId: d['report_id'], boundVersionNo: dl['version_no'] ?? d['report_version_no'], channel: d['channel'], recipientKind: d['recipient_kind'],
        destinationMasked: maskAddress(address), destinationSha256: sha256(address), patientDisplay: (await findQrSnapshot(tx, tenantId, d['report_id']))?.patient_display_snapshot ?? 'Patient',
        tokenSha256, expiresAt: new Date(nowMs + days * 86_400_000).toISOString(), deliveryId: id, purpose: dl['purpose'] === 'dues' ? 'dues' : 'report', actorId: actor,
      });
      params['url'] = `${env['LIMS_ORIGIN_PORTAL'] ?? ''}/r/${token}`;
    }
    const isMail = d['channel'] === 'email';
    const body = fill(text['body_text'], params, isMail);
    const msg: OutboundMessage = {
      deliveryId: id, channel: d['channel'], to: address, body, unicode: /[^\x00-\x7f]/.test(body),
      ...(account?.sender_id ? { senderId: account.sender_id } : {}),
      ...(d['channel'] === 'email' && text['subject_text'] ? { subject: fill(text['subject_text'], params, true) } : {}),
      ...(d['channel'] === 'whatsapp' ? { providerTemplate: { name: text['provider_template_name'], language: text['provider_template_language'], variables: ((text['provider_variable_order'] ?? []) as string[]).map((k) => params[k] ?? '') } } : {}),
    };

    // 5. transport
    // only the provider call is guarded: a DB / port failure afterwards must throw (rollback + queue retry), never be logged as a provider error
    let out;
    try {
      out = await transport.send(msg, { secretRef: account?.secret_ref });
    } catch (e) {
      metrics?.inc?.('lims_reporting_transport_errors_total', { provider_kind: kind, retryable: String(e instanceof TransportError ? e.retryable : true) });
      if (e instanceof TransportError && !e.retryable) { b.fails = 0; breaker.set(bk, b); return permanent(e.failureCode.slice(0, 64)); }
      const code = (e instanceof TransportError ? e.failureCode : 'unexpected_error').slice(0, 64);
      b.fails += 1; if (b.fails >= CIRCUIT_FAILS) b.openUntil = nowMs + CIRCUIT_OPEN_MS; breaker.set(bk, b);
      await record('retryable_error', code);
      if (attemptNo >= MAX_ATTEMPTS || ctx.attempt >= ctx.maxAttempts) {
        await finish('failed', 'retries_exhausted');
        await fallbackIfWhatsapp();
      } else {
        const delayS = Math.min(30 * 2 ** (attemptNo - 1), 3600);
        await enqueue(SEND, `${id}:retry:${attemptNo}`, new Date(nowMs + delayS * 1000).toISOString());
      }
      return;
    }
    b.fails = 0; breaker.set(bk, b);
    await record('accepted', null);
    let fallbackAt: string | null = null;
    if (d['channel'] === 'whatsapp') {
      const minutes = (await findSettings(tx, tenantId))?.whatsapp_fallback_minutes ?? 30;
      fallbackAt = new Date(nowMs + minutes * 60_000).toISOString();
    }
    await finish('sent', null, {
      channelAccountId: account?.id ?? null, providerKind: kind, providerMessageId: out.providerMessageId ?? null, linkId, fallbackCheckAt: fallbackAt,
      destinationMasked: maskAddress(address), destinationSha256: sha256(address),
    });
    if (fallbackAt) await enqueue(FALLBACK, `fallback:${id}`, fallbackAt);
  };
}
