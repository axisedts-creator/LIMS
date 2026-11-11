// Portal service: ReportingPort.issuePortalLink (AC-15.2, 02-TRD §7.1) + the portal API P1-P6 (02-TRD §6.6; 01-PRD AC-11.1..11.12; 07-SECURITY T3-T5, A3-A5, A26).
// Portal paths touch only reporting.* tables and the two app.* functions (08 R8): no BillingPort / PaymentProviderPort / SmartReportPort. The stage comes from the
// resolver's claims (ctx.claims.portal_stage); the link purpose is read from the DB (core allowlists no purpose claim). Tokens and codes only through domain/tokens + domain/otp.
// Wrong-code attempts are written and the 4xx still commits (ctx.commitOnError, 08 A19 P-42), so the attempts counter survives.
// [CONV] otp_request has no per-link key in the core limiter grammar (only `p:`): the 3-per-hour-per-link budget of P1 is counted from reporting.otp_challenges under the link row lock.
import { readFileSync } from 'node:fs';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadReportingConfig, type ReportingConfig } from '../config.js';
import { OTP_MAX_ATTEMPTS, verifyOtp } from '../domain/otp.js';
import { issueToken } from '../domain/tokens.js';
import { findLinkRecipient, findOpenRequestOfLink, findPortalPaymentGateways, findReportForPayment, findRequestOfLink, insertQueuedRequest } from '../repository/portal-payment.repo.js';

type Row = Record<string, any>;
type Tx = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };
type Env = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[0-9]{6}$/;
const CHANNELS = ['whatsapp', 'sms', 'email', 'print_qr', 'patient_app'];
const RECIPIENT_KINDS = ['patient', 'referrer', 'centre', 'partner'];
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const CHALLENGES_PER_HOUR = 3;                                           // AC-11.4 / 04 A9
const DEFAULT_REISSUES_PER_DAY = 3;                                      // settings.link_reissue_max_per_day default
const SEND_TASK = 'reporting.send_portal_otp';
const REISSUE_TASK = 'reporting.reissue_portal_link';
const TASK_MAX_ATTEMPTS = 8;                                             // 02-TRD §9
const REPORT_BUCKET = 'reports';
const PAY_CREATE_TASK = 'reporting.create_portal_payment_intent';       // PP1 (08 A11.1)
const PAY_REFRESH_TASK = 'reporting.refresh_portal_payment_request';    // PP2
const PAY_TASK_MAX_ATTEMPTS = 3;                                         // 02-TRD §9
const PAY_GATEWAYS = ['esewa', 'khalti'];                               // Fonepay is BLOCKED B8
const PAY_REQUEST_TTL_DAYS = 90;                                         // row retention [CONV]
const PAY_REFRESH_AFTER_MS = 3_000;                                      // PP2 enqueues a refresh when last_checked_at is at least this old
const NO_STORE = { 'cache-control': 'no-store' };
const KATHMANDU = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' });   // P-15: yyyy-mm-dd
const STATUS_LABEL: Readonly<Record<string, string>> = { final: 'Final report', partial: 'Partial report', preliminary: 'Preliminary report', amended: 'Amended report', addendum: 'Addendum' };   // [CONV]

const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';
const INSERT_LINK = `INSERT INTO reporting.portal_links (id, tenant_id, centre_id, report_id, bound_version_no, channel, recipient_kind, patient_display_snapshot,
  token_sha256, expires_at, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`;
const INSERT_CHALLENGE = `INSERT INTO reporting.otp_challenges (id, tenant_id, link_id, channel, status, expires_at, created_by) VALUES ($1, $2, $3, $4, 'pending_send', $5, $6)`;
const INSERT_SESSION = `INSERT INTO reporting.portal_sessions (id, tenant_id, link_id, report_id, token_sha256, last_seen_at, idle_expires_at, absolute_expires_at,
  link_purpose, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

export interface PortalCtx {
  tenantId: string; actor: { type: string; id: string }; tx: Tx; now(): string; claims?: Row;
  rateLimit?: { consume(tier: string, key: string): Promise<unknown> };
  audit?: { access(entry: Row): Promise<unknown> };
  storage?: { read(bucket: string, path: string): Promise<Uint8Array> };
  ports?: Row; commitOnError?: () => void;
  metrics?: { inc(name: string, labels?: Record<string, string>): void };
}

const invalidField = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
const iso = (v: unknown): string => new Date(v as string).toISOString();
const ms = (v: unknown): number => Date.parse(iso(v));

/** PortalPaymentRequest (02-TRD §6.6): never an amount input; `action_url` only while ready and not under review (the DB CHECK scrubs action_json otherwise). */
function paymentView(r: Row): Row {
  const out: Row = { id: r['id'], status: r['status'], gateway: r['gateway'], review: !!r['review'] };
  if (r['amount_paisa'] !== null && r['amount_paisa'] !== undefined) out['amount_paisa'] = Number(r['amount_paisa']);
  if (r['status'] === 'ready' && !r['review'] && typeof r['action_json']?.url === 'string') out['action_url'] = r['action_json'].url;
  if (r['failure_code']) out['failure_code'] = r['failure_code'];
  if (r['intent_expires_at']) out['intent_expires_at'] = iso(r['intent_expires_at']);
  return out;
}

function scope(ctx: PortalCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const audit = (ctx: PortalCtx) => { if (!ctx.audit) throw new LimsError('common.internal'); return ctx.audit; };   // fail closed

export function createPortalService(deps: { env: Env; newId?: () => string }) {
  const newId = deps.newId ?? uuidv7;
  let cfg: ReportingConfig | undefined; let key: Uint8Array | undefined;
  const config = () => (cfg ??= loadReportingConfig(deps.env));
  const hmacKey = () => (key ??= new Uint8Array(readFileSync(config().otpHmacKeyFile)));

  /** Stage `session`: a live, unended session row (re-read from the DB); slides the idle window to now + idle, capped at the absolute expiry (AC-11.8). */
  async function liveSession(ctx: PortalCtx, slide: boolean) {
    const { tx, tenantId } = scope(ctx);
    const stage = ctx.claims?.['portal_stage'];
    if (stage === 'link') throw new LimsError('reporting.otp_required');             // AC-11.12
    if (stage !== 'session' || typeof ctx.claims?.['portal_session_id'] !== 'string') throw new LimsError('reporting.link_invalid');
    const now = ctx.now();
    const s = (await tx.query(`SELECT id, link_id, report_id, link_purpose, idle_expires_at, absolute_expires_at FROM reporting.portal_sessions
      WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`, [tenantId, ctx.claims['portal_session_id']])).rows[0];
    if (!s || ms(s['idle_expires_at']) <= Date.parse(now) || ms(s['absolute_expires_at']) <= Date.parse(now)) throw new LimsError('reporting.link_invalid');
    if (slide) {
      const idle = new Date(Math.min(Date.parse(now) + config().portalSessionIdleMinutes * MIN, ms(s['absolute_expires_at']))).toISOString();
      await tx.query(`UPDATE reporting.portal_sessions SET last_seen_at = $3, idle_expires_at = $4 WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`, [tenantId, s['id'], now, idle]);
    }
    return { tx, tenantId, sessionId: s['id'] as string, linkId: s['link_id'] as string, reportId: s['report_id'] as string, purpose: s['link_purpose'] as string, now };
  }

  return {
    /** ReportingPort.issuePortalLink (03-IC §4.5). Staff (`user`) or `system` actors only (08 A2.1). The URL is returned once and never stored or logged. */
    async issuePortalLink(ctx: PortalCtx, input: { reportId: unknown; versionNo?: unknown; channel: unknown; recipientKind: unknown }) {
      if (ctx?.actor?.type !== 'user' && ctx?.actor?.type !== 'system') throw new LimsError('auth.forbidden');
      const { tx, tenantId, actorId } = scope(ctx);
      if (typeof input?.reportId !== 'string' || !UUID.test(input.reportId)) invalidField('/reportId');
      if (typeof input.channel !== 'string' || !CHANNELS.includes(input.channel)) invalidField('/channel');
      if (typeof input.recipientKind !== 'string' || !RECIPIENT_KINDS.includes(input.recipientKind)) invalidField('/recipientKind');
      if (input.versionNo !== undefined && (!Number.isInteger(input.versionNo) || (input.versionNo as number) < 1)) invalidField('/versionNo');
      const origin = deps.env['LIMS_ORIGIN_PORTAL']?.replace(/\/+$/, '');
      if (!origin) throw new LimsError('common.internal');

      const r = (await tx.query(`SELECT id, centre_id, released_version_no, patient_display_name FROM reporting.reports WHERE tenant_id = $1 AND id = $2`, [tenantId, input.reportId])).rows[0];
      if (!r) throw new LimsError('common.not_found');
      const released = r['released_version_no'] as number | null;
      if (released === null || released === undefined) throw new LimsError('reporting.report_not_released');
      const versionNo = (input.versionNo as number | undefined) ?? released;
      if (versionNo < released) throw new LimsError('reporting.report_superseded');
      const v = versionNo === released
        ? (await tx.query(`SELECT status FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3`, [tenantId, input.reportId, versionNo])).rows[0] : undefined;
      if (v?.['status'] !== 'released') throw new LimsError('reporting.report_not_released');

      const settings = await (ctx.ports?.['IdentityPort'] as Row | undefined)?.['getTenantSettings']?.(ctx, { keys: ['reportLinkTtlDays'] });
      const ttlDays = settings?.reportLinkTtlDays;
      if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 90) throw new LimsError('common.internal');   // 04 A10: ≤ 90 days
      const expiresAt = new Date(Date.parse(ctx.now()) + ttlDays * DAY).toISOString();

      const { token, tokenSha256 } = issueToken('link');
      const id = newId();
      await tx.query(INSERT_LINK, [id, tenantId, r['centre_id'], input.reportId, versionNo, input.channel, input.recipientKind,
        String(r['patient_display_name'] || 'Patient').slice(0, 60), Buffer.from(tokenSha256), expiresAt, actorId]);
      return { linkId: id, url: `${origin}/r/${token}`, expiresAt };
    },

    /** P1 — stage link. Locks the link row, enforces 3 challenges per hour per link, supersedes earlier ones, enqueues the send task (the worker resolves the destination, D-31). */
    async createChallenge(ctx: PortalCtx) {
      const { tx, tenantId, actorId } = scope(ctx);
      if (ctx.claims?.['portal_stage'] !== 'link') throw new LimsError('reporting.link_invalid');   // also expired_link and session
      const link = (await tx.query(`SELECT id, otp_channel FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE`, [tenantId, actorId])).rows[0];
      if (!link) throw new LimsError('reporting.link_invalid');
      const now = Date.parse(ctx.now());
      const recent = (await tx.query(`SELECT created_at FROM reporting.otp_challenges WHERE tenant_id = $1 AND link_id = $2 AND created_at > $3 ORDER BY created_at DESC LIMIT $4`,
        [tenantId, actorId, new Date(now - HOUR).toISOString(), CHALLENGES_PER_HOUR])).rows;
      if (recent.length >= CHALLENGES_PER_HOUR) {
        const e = new LimsError('common.rate_limited');
        e.retryAfterSeconds = Math.max(1, Math.ceil((ms(recent[CHALLENGES_PER_HOUR - 1]!['created_at']) + HOUR - now) / 1000));
        throw e;
      }
      await tx.query(`UPDATE reporting.otp_challenges SET status = 'superseded' WHERE tenant_id = $1 AND link_id = $2 AND status IN ('pending_send', 'pending')`, [tenantId, actorId]);
      const id = newId(); const channel = (link['otp_channel'] as string | null) ?? 'sms';
      await tx.query(INSERT_CHALLENGE, [id, tenantId, actorId, channel, new Date(now + config().otpTtlSeconds * 1000).toISOString(), actorId]);
      await tx.query(ENQUEUE, [SEND_TASK, JSON.stringify({ tenant_id: tenantId, challenge_id: id }), `portal_otp:${id}`, null, TASK_MAX_ATTEMPTS]);
      return { status: 202, body: { challenge_id: id, channel } };
    },

    /** P2 — stage link. Every non-verifiable challenge (unknown, other link, not pending, expired) answers like a wrong code (no oracle). */
    async verifyChallenge(ctx: PortalCtx, input: { challengeId: unknown; code: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      if (ctx.claims?.['portal_stage'] !== 'link') throw new LimsError('reporting.link_invalid');
      if (typeof input?.challengeId !== 'string' || !UUID.test(input.challengeId)) invalidField('/challenge_id');
      if (typeof input.code !== 'string' || !CODE.test(input.code)) invalidField('/code');
      const challengeId = input.challengeId as string; const code = input.code as string;
      if (!ctx.rateLimit) throw new LimsError('common.internal');
      await ctx.rateLimit.consume('otp_verify', `o:${challengeId}`);                  // 5 per OTP lifetime, key = challenge id

      const now = ctx.now();
      const c = (await tx.query(`SELECT id, status, attempts, code_hmac, expires_at FROM reporting.otp_challenges WHERE tenant_id = $1 AND id = $2 AND link_id = $3 FOR UPDATE`,
        [tenantId, challengeId, actorId])).rows[0];
      if (!c) throw new LimsError('auth.otp_invalid');
      if (c['status'] === 'exhausted' || (c['status'] === 'pending' && c['attempts'] >= OTP_MAX_ATTEMPTS)) throw new LimsError('auth.otp_attempts_exhausted');
      if (c['status'] !== 'pending' || !c['code_hmac'] || ms(c['expires_at']) <= Date.parse(now)) throw new LimsError('auth.otp_invalid');

      if (!verifyOtp(hmacKey(), challengeId, code, new Uint8Array(c['code_hmac']))) {
        const upd = (await tx.query(`UPDATE reporting.otp_challenges SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND attempts < $3 RETURNING attempts`,
          [tenantId, challengeId, OTP_MAX_ATTEMPTS])).rows[0];
        const exhausted = !!upd && upd['attempts'] >= OTP_MAX_ATTEMPTS;
        if (exhausted) await tx.query(`UPDATE reporting.otp_challenges SET status = 'exhausted' WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`, [tenantId, challengeId]);
        await audit(ctx).access({ action: 'auth.otp_failure', entityType: 'otp_challenge', entityId: challengeId, outcome: 'denied', detail: { attempts: Number(upd?.['attempts'] ?? OTP_MAX_ATTEMPTS) } });
        ctx.commitOnError?.();                                                     // the counter must survive this 4xx (P-42)
        ctx.metrics?.inc('lims_reporting_otp_verify_failures_total', { tenant_id: tenantId });   // T33: brute-force alert (REQ-SEC-133); tenant_id only, never challenge/link id
        throw new LimsError(exhausted ? 'auth.otp_attempts_exhausted' : 'auth.otp_invalid');
      }

      const done = (await tx.query(`UPDATE reporting.otp_challenges SET status = 'verified', verified_at = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id`,
        [tenantId, challengeId, now])).rows[0];
      if (!done) throw new LimsError('auth.otp_invalid');                              // single use: lost a race
      const link = (await tx.query(`SELECT id, report_id, purpose FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL`, [tenantId, actorId])).rows[0];
      if (!link) throw new LimsError('reporting.link_invalid');

      const { token, tokenSha256 } = issueToken('session');
      const t = Date.parse(now); const sessionId = newId();
      const idle = new Date(t + config().portalSessionIdleMinutes * MIN).toISOString();
      const absolute = new Date(t + config().portalSessionAbsoluteMinutes * MIN).toISOString();
      await tx.query(INSERT_SESSION, [sessionId, tenantId, actorId, link['report_id'], Buffer.from(tokenSha256), now, idle, absolute, link['purpose'], actorId]);
      await tx.query(`UPDATE reporting.portal_links SET last_used_at = $3, use_count = use_count + 1 WHERE tenant_id = $1 AND id = $2`, [tenantId, actorId, now]);
      await audit(ctx).access({ action: 'portal.session_start', entityType: 'portal_session', entityId: sessionId, outcome: 'allowed', detail: { link_id: actorId } });
      return { status: 200, body: { session_token: token, idle_expires_at: idle, absolute_expires_at: absolute, link_purpose: link['purpose'] as string } };
    },

    /** P3 — stage session, purpose report. Latest released version from the frozen snapshots; never calls another module (smart_summary = the version's own JSON). */
    async getReport(ctx: PortalCtx) {
      const s = await liveSession(ctx, true);
      if (s.purpose !== 'report') throw new LimsError('common.not_found');             // A26
      const { tx, tenantId } = s;
      const r = (await tx.query(`SELECT id, family, released_version_no, billing_balance_due_paisa FROM reporting.reports WHERE tenant_id = $1 AND id = $2`, [tenantId, s.reportId])).rows[0];
      if (!r || r['released_version_no'] === null || r['released_version_no'] === undefined) throw new LimsError('common.not_found');
      const v = (await tx.query(`SELECT id, version_no, report_kind, released_at, smart_summary_json FROM reporting.report_versions
        WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3 AND status = 'released'`, [tenantId, s.reportId, r['released_version_no']])).rows[0];
      const qr = v && (await tx.query(`SELECT lab_name_snapshot, panel_names_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_version_id = $2 AND revoked_at IS NULL`, [tenantId, v['id']])).rows[0];
      const link = (await tx.query(`SELECT recipient_kind, patient_display_snapshot FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2`, [tenantId, s.linkId])).rows[0];
      if (!v || !qr || !link) throw new LimsError('common.not_found');

      const report: Row = { family: r['family'], report_kind: v['report_kind'], status_label: STATUS_LABEL[v['report_kind']] ?? 'Report', issued_at: iso(v['released_at']),
        version_no: v['version_no'], panel_names: Array.isArray(qr['panel_names_snapshot']) ? qr['panel_names_snapshot'] : [] };
      if (v['version_no'] > 1) report['updated_notice'] = { previous_version_no: v['version_no'] - 1, updated_at: iso(v['released_at']) };
      const body: Row = { lab_name: qr['lab_name_snapshot'], patient_display: link['patient_display_snapshot'], report, download: { report_version_id: v['id'] } };
      const summary = typeof v['smart_summary_json'] === 'string' ? JSON.parse(v['smart_summary_json']) : v['smart_summary_json'];
      if (summary !== null && summary !== undefined) body['smart_summary'] = summary;
      if (link['recipient_kind'] === 'patient' && Number(r['billing_balance_due_paisa']) > 0) {
        const st = (await tx.query(`SELECT portal_payment_gateways FROM reporting.settings WHERE tenant_id = $1`, [tenantId])).rows[0];
        const dues: Row = { balance_due_paisa: Number(r['billing_balance_due_paisa']), online_gateways: Array.isArray(st?.['portal_payment_gateways']) ? st['portal_payment_gateways'] : [] };
        const open = await findOpenRequestOfLink(tx, tenantId, s.linkId);               // this link's request only (AC-18.4)
        if (open) dues['open_request'] = { id: open['id'], status: open['status'] };
        body['dues'] = dues;
      }
      await audit(ctx).access({ action: 'report.portal_view', entityType: 'report_version', entityId: v['id'], outcome: 'allowed', detail: { link_id: s.linkId } });
      return { status: 200, body };
    },

    /** P7 — stage session, purpose `dues` or `report` (08 A21.1). The dues block is the one of P3 (balance hint on the report row, this link's open request); never any report content.
     *  [CONV] lab_name = latest qr_tokens snapshot of the report; a dues session cannot read qr_tokens under RLS (policy needs portal_link_purpose = 'report'),
     *  so it gets the neutral 'Laboratory' until a CR gives it a source (.orchestra/notes/C6-T43-impl.md). */
    async getDues(ctx: PortalCtx) {
      const s = await liveSession(ctx, true);
      const { tx, tenantId } = s;
      const r = (await tx.query(`SELECT billing_balance_due_paisa FROM reporting.reports WHERE tenant_id = $1 AND id = $2`, [tenantId, s.reportId])).rows[0];
      const link = (await tx.query(`SELECT recipient_kind FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2`, [tenantId, s.linkId])).rows[0];
      if (!r || !link) throw new LimsError('common.not_found');
      const qr = (await tx.query(`SELECT lab_name_snapshot FROM reporting.qr_tokens WHERE tenant_id = $1 AND report_id = $2 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1`, [tenantId, s.reportId])).rows[0];
      const body: Row = { lab_name: typeof qr?.['lab_name_snapshot'] === 'string' && qr['lab_name_snapshot'] ? qr['lab_name_snapshot'] : 'Laboratory', report_follows: s.purpose === 'dues' };
      const due = Number(r['billing_balance_due_paisa']);
      if (link['recipient_kind'] === 'patient' && due > 0) {
        const st = (await tx.query(`SELECT portal_payment_gateways FROM reporting.settings WHERE tenant_id = $1`, [tenantId])).rows[0];
        const dues: Row = { balance_due_paisa: due, online_gateways: Array.isArray(st?.['portal_payment_gateways']) ? st['portal_payment_gateways'] : [] };
        const open = await findOpenRequestOfLink(tx, tenantId, s.linkId);
        if (open) dues['open_request'] = { id: open['id'], status: open['status'] };
        body['dues'] = dues;
      }
      return { status: 200, body };
    },

    /** P4 — stage session, purpose report. Only the report's current released version; 20 per hour per link; access log report.portal_download. */
    async download(ctx: PortalCtx, input: { reportVersionId: unknown }) {
      const s = await liveSession(ctx, true);
      if (s.purpose !== 'report') throw new LimsError('common.not_found');             // A26
      if (typeof input?.reportVersionId !== 'string' || !UUID.test(input.reportVersionId)) throw new LimsError('common.not_found');
      if (!ctx.rateLimit || !ctx.storage) throw new LimsError('common.internal');
      await ctx.rateLimit.consume('report_download', `l:${s.linkId}`);
      const v = (await s.tx.query(`SELECT id, version_no, pdf_object_path FROM reporting.report_versions WHERE tenant_id = $1 AND report_id = $2 AND id = $3 AND status = 'released'`,
        [s.tenantId, s.reportId, input.reportVersionId])).rows[0];
      if (!v || typeof v['pdf_object_path'] !== 'string' || !v['pdf_object_path']) throw new LimsError('common.not_found');   // A5: other report / tenant / superseded
      const bytes = await ctx.storage.read(REPORT_BUCKET, v['pdf_object_path']);
      await audit(ctx).access({ action: 'report.portal_download', entityType: 'report_version', entityId: v['id'], outcome: 'allowed', detail: { link_id: s.linkId } });
      return { bytes, filename: `report-v${v['version_no']}.pdf` };
    },

    /** P5 — stage link or expired_link. Always 202 {}; only an expired, unrevoked link under its daily budget enqueues the reissue task. */
    async requestReissue(ctx: PortalCtx) {
      const { tx, tenantId, actorId } = scope(ctx);
      const stage = ctx.claims?.['portal_stage'];
      if (stage !== 'link' && stage !== 'expired_link') throw new LimsError('reporting.link_invalid');
      const done = { status: 202, body: {} };
      if (stage === 'link') return done;
      const link = (await tx.query(`SELECT id, reissue_count_day, reissue_day::text AS reissue_day FROM reporting.portal_links WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL FOR UPDATE`,
        [tenantId, actorId])).rows[0];
      if (!link) throw new LimsError('reporting.link_invalid');
      const day = KATHMANDU.format(new Date(ctx.now()));
      const used = String(link['reissue_day'] ?? '').slice(0, 10) === day ? Number(link['reissue_count_day']) : 0;
      const st = (await tx.query(`SELECT link_reissue_max_per_day FROM reporting.settings WHERE tenant_id = $1`, [tenantId])).rows[0];
      if (used >= Number(st?.['link_reissue_max_per_day'] ?? DEFAULT_REISSUES_PER_DAY)) return done;
      const n = used + 1;
      await tx.query(`UPDATE reporting.portal_links SET reissue_count_day = $3, reissue_day = $4::date WHERE tenant_id = $1 AND id = $2`, [tenantId, actorId, n, day]);
      await tx.query(ENQUEUE, [REISSUE_TASK, JSON.stringify({ tenant_id: tenantId, link_id: actorId, reissue_day: day, n }), `reissue:${actorId}:${day}:${n}`, null, TASK_MAX_ATTEMPTS]);
      return done;
    },

    /** PP1 — stage session, `report` or `dues` link (08 A21.1). Request path only: no money port, no amount (REQ-SEC-046); the worker task creates the intent.
     *  The request is the gateway name and nothing else. This link's open request -> 200 with it; another link's open request surfaces as the unique-index violation -> 409. */
    async createPaymentRequest(ctx: PortalCtx, input: { body: unknown }) {
      const s = await liveSession(ctx, true);
      const body = typeof input?.body === 'object' && input.body !== null ? (input.body as Row) : {};
      for (const k of Object.keys(body)) if (k !== 'gateway') invalidField(`/${k}`);   // amount / amount_paisa / anything else is rejected, never read
      const gateway = body['gateway'];
      if (typeof gateway !== 'string' || !PAY_GATEWAYS.includes(gateway)) invalidField('/gateway');
      const { tx, tenantId } = s;

      const link = await findLinkRecipient(tx, tenantId, s.linkId);
      if (!link || link.recipient_kind !== 'patient') throw new LimsError('common.not_found');   // [CONV] no dues for referrer / centre / partner links
      const report = await findReportForPayment(tx, tenantId, s.reportId);
      if (!report) throw new LimsError('common.not_found');
      if (report.state !== 'open') throw new LimsError('reporting.report_cancelled');
      if (!(await findPortalPaymentGateways(tx, tenantId)).includes(gateway as string)) invalidField('/gateway');   // [] until C15 is live (AC-18.2)

      const open = await findOpenRequestOfLink(tx, tenantId, s.linkId);
      if (open) return { status: 200, body: paymentView(open), headers: NO_STORE };

      const id = newId(); const now = ctx.now();
      try {
        await insertQueuedRequest(tx, { id, tenantId, linkId: s.linkId, reportId: s.reportId, orderId: report.order_id, gateway: gateway as string, now,
          expiresAt: new Date(Date.parse(now) + PAY_REQUEST_TTL_DAYS * DAY).toISOString() });
      } catch (e) {
        if ((e as Row)?.['code'] === '23505') throw new LimsError('common.version_conflict', 'payment_in_progress');   // open request through another link: nothing of it is exposed
        throw e;
      }
      await tx.query(ENQUEUE, [PAY_CREATE_TASK, JSON.stringify({ tenant_id: tenantId, portal_payment_request_id: id }), `ppay:${id}`, null, PAY_TASK_MAX_ATTEMPTS]);
      return { status: 202, body: { id, status: 'queued', gateway, review: false }, headers: NO_STORE };
    },

    /** PP2 — stage session. Reads this link's row only (any other id is `not_found`); never writes (the session is not slid). A `ready` row not checked for 3 s gets a keyed refresh task. */
    async getPaymentRequest(ctx: PortalCtx, input: { id: unknown }) {
      const s = await liveSession(ctx, false);
      if (typeof input?.id !== 'string' || !UUID.test(input.id)) throw new LimsError('common.not_found');
      const r = await findRequestOfLink(s.tx, s.tenantId, s.linkId, input.id);
      if (!r) throw new LimsError('common.not_found');
      if (r['status'] === 'ready' && (!r['last_checked_at'] || Date.parse(s.now) - ms(r['last_checked_at']) >= PAY_REFRESH_AFTER_MS)) {
        await s.tx.query(ENQUEUE, [PAY_REFRESH_TASK, JSON.stringify({ tenant_id: s.tenantId, portal_payment_request_id: r['id'] }), `ppref:${r['id']}`, null, PAY_TASK_MAX_ATTEMPTS]);
      }
      return { status: 200, body: paymentView(r), headers: NO_STORE };
    },

    /** P6 — stage session. Ends this session only; the link and its OTP budget are untouched. */
    async endSession(ctx: PortalCtx) {
      const s = await liveSession(ctx, false);
      await s.tx.query(`UPDATE reporting.portal_sessions SET ended_at = $3 WHERE tenant_id = $1 AND id = $2 AND ended_at IS NULL`, [s.tenantId, s.sessionId, s.now]);
      return { status: 204 };
    },
  };
}
