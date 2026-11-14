// L1 issueLinkCode, L2 revokeLinkCode, L3 listPatientAppLinks, L4 revokeAppLink (02-TRD §4.3 constants, §4.3.1 issue, §5 L1-L4, §5.5 access log, §13 metric;
// 01-PRD US-EN-03.1, 03.6, 03.7, 06.6; 07-SECURITY §3 L1 row, §6.1 cross-tenant, REQ-SEC-080 no echo; 08 A2.4 / A5.5 raw 32-byte bytea HMACs).
// Tenant and actor come from ctx only. The handler asserts IdentityPort.assertRole (floor) before any query.
// [CONV] link_codes has no version column (05-SCHEMA: run state), so L2's If-Match is the constant ETag "1"; any other value is a 409 (TRD §5 L1 note).
// [CONV] L2 / L4 on a code / link that is no longer revocable (redeemed, already revoked) -> 409 common.version_conflict (the contract names no other code).
// [CONV] The plaintext code lives in the 201 body only: never in a log, audit row, metric label, event or stored column (only its HMAC is stored).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { loadEngagementConfig, type EngagementConfig } from '../config.js';
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH, formatLinkCode, normalizeLinkCode } from '../domain/linkCode.js';import { canTransition, type LinkStatus } from '../domain/link.state.js';
import { hasAllowedPrefix, isE164, maskPhone } from '../domain/phone.js';
import { engagementMetrics } from '../metrics.js';
import * as consents from '../repository/consents.repo.js';
import * as repo from '../repository/linkCodes.repo.js';
import type { Row } from '../repository/linkCodes.repo.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createProjectionService } from './projection.service.js';
import { invalid, isUuid, parseIfMatch, type SlotCtx } from './slot.service.js';

export interface LinkCtx extends SlotCtx {
  readonly audit?: { access(entry: Record<string, unknown>): Promise<void> };
  readonly claims?: { readonly membership_id?: unknown };
  readonly commitOnError?: () => void;
  readonly ports?: { FrontdeskPort?: { getPatientDemographics(ctx: unknown, i: { patientId: string; purpose: string }): Promise<{ sex?: unknown; fullName?: unknown; phoneE164?: unknown; status?: unknown }> } } | any;
}
type Out = { status: number; body?: Record<string, unknown> };

const PURPOSE = 'patient_app_link'; // CR-C16-007
const MAX_LIVE_CODES = 3; // TRD §4.3.1 step 3 [CONV]
const RELATIONSHIPS = ['self', 'child', 'parent', 'spouse', 'sibling', 'other'];
const CHECKS = ['photo_id', 'guardian_photo_id', 'known_patient'];
const REVOKE_REASONS = ['patient_request', 'suspected_misuse', 'staff_error', 'other'];
const CODE_ETAG = 1;
const LIVE_FROM: LinkStatus = 'active'; // reconcile suspends only links that are active
const HOUR = 3_600_000;
const SHAPE = new RegExp(`^[0-9A-Z]{${LINK_CODE_LENGTH}}$`); // shape only (400); a symbol outside the alphabet (U) is a normal 422, never a validity oracle

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (v: unknown): string => new Date(v as string).toISOString();
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const strict = (body: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new LimsError('common.validation_failed', undefined, [fe('/', 'common.unknown_field', 'Unknown field')]);
  return body;
};

let cfg: EngagementConfig | undefined;
const config = (): EngagementConfig => (cfg ??= loadEngagementConfig());
const keyCache = new Map<string, Buffer>();
const keyFile = (path: string): Buffer => { let k = keyCache.get(path); if (!k) { k = readFileSync(path); keyCache.set(path, k); } return k; };
/** HMAC-SHA256(link key, tenant_id ‖ ':' ‖ normalised code), raw 32 bytes (TRD §4.3). */
const linkHmac = (tenantId: string, code: string): Buffer => createHmac('sha256', keyFile(config().linkHmacKeyFile)).update(`${tenantId}:${normalizeLinkCode(code)}`).digest();
/** HMAC-SHA256(phone key, tenant_id ‖ ':' ‖ phone_e164), raw 32 bytes (TRD §4.3). */
const phoneHmac = (tenantId: string, phone: string): Buffer => createHmac('sha256', keyFile(config().phoneHmacKeyFile)).update(`${tenantId}:${phone}`).digest();
const phoneEq = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
/** 10 symbols, uniform: the alphabet has 32 symbols, so `byte & 31` has no modulo bias. */
const newCode = (): string => formatLinkCode(Array.from(randomBytes(LINK_CODE_LENGTH), (b) => LINK_CODE_ALPHABET[b & 31]).join(''));

function scope(ctx: LinkCtx): { tx: any; tenantId: string; userId: string; now: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx || typeof ctx.now !== 'function') throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id, now: iso(ctx.now()) };
}
/** FK / RLS / CHECK refusals mean the target is not visible or not valid for this actor; anything else unexpected fails closed without SQL text. */
function mapDbError(e: unknown): never {
  if (e instanceof LimsError) throw e;
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '23503' || code === '42501') throw new LimsError('common.not_found');
  if (code === '23514') return invalid('/', 'common.field_invalid', 'Field invalid');
  throw new LimsError('common.internal');
}

/** FrontdeskPort errors cross a package boundary (different LimsError class): keep the two refusals that mean something here, everything else fails closed. */
type Demo = { sex?: unknown; fullName?: unknown; phoneE164?: unknown; status?: unknown };
async function viaPort(call: Promise<Demo>): Promise<Demo> {
  try { return await call; } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === 'common.not_found' || code === 'auth.forbidden') throw new LimsError(code);
    throw e;
  }
}

function parseIssue(body: unknown) {
  const b = strict(body, ['patient_id', 'relationship', 'consented_by', 'identity_check_method', 'bind_phone', 'phone_e164']);
  for (const k of ['patient_id', 'relationship', 'consented_by', 'identity_check_method', 'bind_phone']) if (b[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  if (!isUuid(b['patient_id'])) invalid('/patient_id');
  if (typeof b['relationship'] !== 'string' || !RELATIONSHIPS.includes(b['relationship'])) invalid('/relationship');
  if (b['consented_by'] !== 'patient' && b['consented_by'] !== 'guardian') invalid('/consented_by');
  if (typeof b['identity_check_method'] !== 'string' || !CHECKS.includes(b['identity_check_method'])) invalid('/identity_check_method');
  if (b['bind_phone'] !== 'record' && b['bind_phone'] !== 'other') invalid('/bind_phone');
  const phone = b['phone_e164'];
  if (b['bind_phone'] === 'other' && phone === undefined) invalid('/phone_e164', 'common.field_required', 'Field required');
  if (b['bind_phone'] === 'record' && phone !== undefined) invalid('/phone_e164', 'common.field_invalid', 'Only allowed when bind_phone is other');
  if (phone !== undefined && !isE164(phone)) invalid('/phone_e164');
  return { patientId: b['patient_id'] as string, relationship: b['relationship'] as string, consentedBy: b['consented_by'] as string, identityCheck: b['identity_check_method'] as string,
    bindOther: b['bind_phone'] === 'other', phone: phone as string | undefined };
}

/** Row -> AppLink: contract fields only; null columns are omitted (the schema forbids null). profile_id = link id (TRD §5.4 Profile). */
function toLink(l: Row, phone: unknown): Record<string, unknown> {
  const o: Record<string, unknown> = {
    profile_id: l['id'], link_id: l['id'], patient_id: l['patient_id'], display_name: l['display_name'], relationship: l['relationship'], method: l['method'], status: l['status'],
    account_phone_masked: typeof phone === 'string' ? maskPhone(phone) : '',
  };
  if (l['visible_from']) o['history_from'] = iso(l['visible_from']);
  if (l['suspend_reason']) o['suspend_reason'] = l['suspend_reason'];
  if (l['revoked_at']) o['revoked_at'] = iso(l['revoked_at']);
  if (l['revoked_reason_code']) o['revoked_reason_code'] = l['revoked_reason_code'];
  return o;
}

/** E14 body: exactly {code}; the patient id comes only from the code (never from the client). */
function parseRedeem(body: unknown): string {
  const code = strict(body, ['code'])['code'];
  if (typeof code !== 'string' || code.length > 32 || !SHAPE.test(normalizeLinkCode(code))) invalid('/code');
  return code as string;
}

/** Profile wire shape (additionalProperties false): link_id / patient_id / phone stay out. */
function toProfile(l: Row): Record<string, unknown> {
  const o: Record<string, unknown> = { profile_id: l['id'], display_name: String(l['display_name']).slice(0, 120), relationship: l['relationship'], method: l['method'], status: l['status'], version: l['version'] };
  if (l['visible_from']) o['history_from'] = iso(l['visible_from']);
  return o;
}

// ---- T-L3 E15 redeemReportLink (02-TRD §4.3.3, §5; 05-SCHEMA §4 patient column guard + §6.1 app.engagement_apply_report_link; PRD US-EN-04.1-6; 07-SECURITY E15 row, P-L4/P-L6/P-L9; CR-C16-008).
// Order: validate the body -> resolve the caller's account (phone comes from the account, never the client) -> ReportingPort (C6) -> the DEFINER apply -> else limits + insert.
// C16 writes nothing before the C6 call and nothing after its failure; every C6 failure is the one identical 422 (REQ-SEC-094). Token, URL and phone are never logged, audited or queued.
// Reactivation / widening go ONLY through the DEFINER (a direct patient UPDATE of status / visible_from raises immutable_row).
export interface ReportLinkCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }> };
  readonly ports?: { ReportingPort?: { redeemPortalLinkForApp(ctx: unknown, input: { linkToken: string; phoneE164: string }): Promise<{ patientId: string; releasedAt: string | Date }> } };
  readonly audit: { access(e: Record<string, unknown>): Promise<void> };
}

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const PLACEHOLDER_NAME = 'Linked patient'; // real name + sex arrive with engagement.backfill_link (FrontdeskPort, system; review C16 #16)
const LIVE_SQL = `status IN ('active', 'suspended')`;
const LINK_UQ_RETRIES = 2;
export const BACKFILL_TASK = 'engagement.backfill_link';
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)'; // (identifier, payload, job_key, run_at, max_attempts) — TRD §8.1: key backfill:<link_id>, max 10

const bad = (path: string, code: string, message: string): never => { throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]); };
const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** Origin is read at call time; an unset origin fails closed (nothing can match). Only `<origin>/r/<token>` passes; the submitted value is never echoed. */
function parseReportToken(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('/', 'common.field_invalid', 'Field invalid');
  for (const k of Object.keys(body)) if (k !== 'link_url') bad(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field'); // phone / patient never come from the client
  const u = (body as Row)['link_url'];
  if (u === undefined) bad('/link_url', 'common.field_required', 'Field required');
  const origin = process.env['LIMS_ORIGIN_PORTAL']?.replace(/\/+$/, '');
  if (!origin) throw new LimsError('common.service_unavailable');
  const prefix = `${origin}/r/`;
  if (typeof u !== 'string' || u.length > 2000 || !u.startsWith(prefix)) return bad('/link_url', 'common.field_invalid', 'Field invalid');
  const token = u.slice(prefix.length);
  return TOKEN.test(token) ? token : bad('/link_url', 'common.field_invalid', 'Field invalid');
}

const reportProfile = (l: Row) => ({
  profile_id: l['id'], display_name: String(l['display_name']).slice(0, 120), relationship: l['relationship'], method: l['method'], status: 'active', version: l['version'],
  ...(l['visible_from'] == null ? {} : { history_from: iso(l['visible_from']) }),
});

async function reportAccountOf(ctx: ReportLinkCtx): Promise<Row> {
  if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden');
  const { rows } = await ctx.tx.query(
    `SELECT id, phone_e164, phone_hmac FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status <> 'deleted'`, [ctx.tenantId, ctx.actor.id]);
  if (!rows[0]) throw new LimsError('auth.forbidden');
  return rows[0];
}

const applyReportLink = (ctx: ReportLinkCtx, patientId: string, releasedAt: string) =>
  ctx.tx.query('SELECT * FROM app.engagement_apply_report_link($1, $2::timestamptz)', [patientId, releasedAt]).then((r) => r.rows[0]);

async function reportDone(ctx: ReportLinkCtx, status: 200 | 201, link: Row) {
  await ctx.tx.query(ENQUEUE_SQL, [BACKFILL_TASK, JSON.stringify({ tenant_id: ctx.tenantId, link_id: link['id'] }), `backfill:${link['id']}`, null, 10]);
  await ctx.audit.access({ action: 'app_link.redeem', entityType: 'app_link', entityId: link['id'], outcome: 'success' });
  return { status, body: reportProfile(link) };
}

/** TRD §4.3.2 step 4: account active links < max_profiles_per_account. (Per-patient limit: mechanism under patient RLS not specified — see notes.) */
// CR pending: .orchestra/cr/T-L3.md (per-patient max_accounts_per_patient needs a DEFINER count; not invented here)
async function reportCheckLimit(ctx: ReportLinkCtx, accountId: string): Promise<void> {
  const [{ rows: s }, { rows: c }] = await Promise.all([
    ctx.tx.query('SELECT max_profiles_per_account FROM engagement.settings WHERE tenant_id = $1', [ctx.tenantId]),
    ctx.tx.query(`SELECT count(*) FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'`, [ctx.tenantId, accountId]),
  ]);
  const max = Number(s[0]?.['max_profiles_per_account']);
  if (!Number.isFinite(max)) throw new LimsError('common.service_unavailable');
  if (Number(c[0]?.['count']) >= max) throw new LimsError('engagement.link_limit_reached');
}

async function redeemReportLink(ctx: ReportLinkCtx, input: { body: unknown }) {
  if (typeof ctx.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  const token = parseReportToken(input.body);
  const account = await reportAccountOf(ctx);
  const port = ctx.ports?.ReportingPort;
  if (!port) throw new LimsError('common.service_unavailable');

  let proof;
  try { proof = await port.redeemPortalLinkForApp(ctx, { linkToken: token, phoneE164: account['phone_e164'] }); } catch (e) {
    if (e instanceof LimsError && e.code === 'reporting.link_invalid') throw new LimsError('engagement.link_code_invalid'); // identical for every cause; C6 counts its own failures
    throw e;
  }
  const releasedAt = iso(proof.releasedAt);
  const linkById = async (id: string): Promise<Row> => {
    const { rows } = await ctx.tx.query('SELECT * FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND id = $3', [ctx.tenantId, account['id'], id]);
    return rows[0] ?? bad('/', 'common.field_invalid', 'Field invalid');
  };

  for (let attempt = 1; ; attempt++) {
    const hit = await applyReportLink(ctx, proof.patientId, releasedAt); // existing active -> widen; suspended -> reactivate (DEFINER only)
    if (hit) return reportDone(ctx, 200, await linkById(hit['link_id']));

    await reportCheckLimit(ctx, account['id']);
    const { rows: selfs } = await ctx.tx.query(`SELECT id FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND relationship = 'self' AND ${LIVE_SQL}`, [ctx.tenantId, account['id']]);
    const id = uuidv7();
    await ctx.tx.query('SAVEPOINT redeem_link'); // a lost race must not poison the request transaction
    try {
      const { rows } = await ctx.tx.query(
        `INSERT INTO engagement.account_patient_links (id, tenant_id, account_id, patient_id, relationship, method, display_name, status, visible_from, record_phone_hmac_at_link, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 'report_link', $6, 'active', $7::timestamptz, $8, $9, $9) RETURNING *`,
        [id, ctx.tenantId, account['id'], proof.patientId, selfs.length ? 'other' : 'self', PLACEHOLDER_NAME, releasedAt, account['phone_hmac'], ctx.actor.id]);
      await ctx.tx.query('RELEASE SAVEPOINT redeem_link');
      return reportDone(ctx, 201, rows[0]!);
    } catch (e) {
      if (pgCode(e) !== '23505') throw e;
      await ctx.tx.query('ROLLBACK TO SAVEPOINT redeem_link');
      if (attempt >= LINK_UQ_RETRIES) throw new LimsError('engagement.link_limit_reached'); // never a 5xx on a lost race
    }
  }
}

export function createLinkService() {
  const phonesOf = async (tx: any, tenantId: string, links: Row[]) =>
    new Map((await repo.accountPhones(tx, { tenantId, accountIds: [...new Set(links.map((l) => l['account_id'] as string))] })).map((a) => [a['id'], a['phone_e164']]));

  return {
    redeemReportLink, // T-L3 E15

    /** L1 (TRD §4.3.1): body (400) -> app_enabled (403) -> patient via FrontdeskPort (404 / 400) -> bound phone (400) -> limits (409) -> supersede -> consent -> code -> access log + metric. */
    async issue(ctx: LinkCtx, input: { body: unknown }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const v = parseIssue(input.body);
      try {
        const s = await repo.settings(tx, tenantId);
        if (!s || !s['app_enabled']) throw new LimsError('common.feature_disabled');
        if (v.bindOther && !hasAllowedPrefix(v.phone!, s['allowed_phone_prefixes'] ?? [])) invalid('/phone_e164', 'common.field_invalid', 'Phone prefix not allowed');
        const frontdesk = ctx.ports?.FrontdeskPort;
        if (!frontdesk) throw new LimsError('common.service_unavailable'); // never issue without the patient lookup
        const p = await viaPort(frontdesk.getPatientDemographics(ctx, { patientId: v.patientId, purpose: PURPOSE }));
        if (p?.status !== 'active') invalid('/patient_id', 'common.field_invalid', 'Patient record is merged or anonymised');
        const recordPhone = typeof p.phoneE164 === 'string' && p.phoneE164 ? p.phoneE164 : undefined;
        if (!v.bindOther && !recordPhone) invalid('/bind_phone', 'common.field_invalid', 'Patient record has no phone');
        const bound = v.bindOther ? v.phone! : recordPhone!;

        if ((await repo.activeLinkCount(tx, { tenantId, patientId: v.patientId })) >= s['max_accounts_per_patient']) throw new LimsError('engagement.link_limit_reached');
        const live = await repo.liveCodes(tx, { tenantId, patientId: v.patientId, now });
        for (const old of live.slice(0, Math.max(0, live.length - (MAX_LIVE_CODES - 1)))) await repo.supersede(tx, { tenantId, userId, id: old['id'], now });

        const consentId = await consents.insertDeskConsent(tx, { tenantId, userId, patientId: v.patientId, relationship: v.relationship, consentedBy: v.consentedBy, identityCheck: v.identityCheck,
          consentTextVersion: s['app_consent_text_version'], now });
        const code = newCode();
        const expiresAt = new Date(Date.parse(now) + Number(s['link_code_ttl_hours']) * HOUR).toISOString();
        const id = await repo.insertCode(tx, { tenantId, userId, patientId: v.patientId, codeHmac: linkHmac(tenantId, code), boundPhoneHmac: phoneHmac(tenantId, bound), boundPhoneLast2: bound.slice(-2),
          recordPhoneHmac: recordPhone ? phoneHmac(tenantId, recordPhone) : null, relationship: v.relationship, consentId, displayName: String(p.fullName ?? ''), sex: typeof p.sex === 'string' ? p.sex : null, expiresAt, now });
        await ctx.audit?.access({ action: 'link_code.issue', entityType: 'patient', entityId: v.patientId, outcome: 'allowed' }); // no code, no phone
        engagementMetrics.linkEvent(ctx, 'link_code', 'issued');
        return { status: 201, body: { link_code_id: id, code, expires_at: expiresAt, bound_phone_masked: maskPhone(bound) } };
      } catch (e) { return mapDbError(e); }
    },

    /**
     * E14 (TRD §4.3.2): body (400) -> account -> failure counter (429) -> DEFINER redeem (the redemption AND the widening / reactivation of an existing link happen only inside it)
     * -> no row: counter + ctx.commitOnError() + 422 -> existing link: 200 -> limits (409, NO commitOnError: the redemption rolls back) -> insert link (201). Backfill enqueue + access log.
     */
    async redeem(ctx: LinkCtx, input: { body: unknown }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const code = parseRedeem(input.body);
      const commitOnError = ctx.commitOnError;
      const membershipId = ctx.claims?.membership_id;
      if (typeof commitOnError !== 'function' || typeof membershipId !== 'string') throw new LimsError('auth.unauthenticated'); // never redeem without the means to persist a failure
      try {
        const acct = await repo.myAccount(tx, { tenantId, membershipId });
        if (!acct) throw new LimsError('auth.unauthenticated');
        const nowMs = Date.parse(now);
        const key = `linkfail:${acct['id']}:${now.slice(0, 13).replace(/\D/g, '')}`; // yyyymmddhh (UTC)
        if ((await repo.failureCount(tx, { tenantId, key })) >= config().linkRedeemFailuresPerHour) {
          throw Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: Math.max(1, Math.ceil((HOUR - (nowMs % HOUR)) / 1000)) });
        }

        // SECURITY DEFINER (05-SCHEMA §6.1; named here, in the service, on purpose: this is the one statement that redeems): raw 32-byte bytea (08 A2.4, A5.5). No row = unknown / expired / used / other phone.
        const r = (await tx.query('SELECT * FROM app.engagement_redeem_link_code($1::bytea)', [linkHmac(tenantId, code)])).rows[0] as Row | undefined;
        if (!r) { // unknown, expired, used, other phone: one identical answer; the counter is the only write and survives the 422 (08 A19 P-42)
          await repo.countFailure(tx, { tenantId, key, expiresAt: new Date(nowMs + 24 * HOUR).toISOString(), createdBy: userId });
          commitOnError();
          engagementMetrics.linkEvent(ctx, 'link_code', 'invalid');
          throw new LimsError('engagement.link_code_invalid');
        }

        let link: Row | undefined; let status = 200;
        if (r['existing_link_id']) link = await repo.getLink(tx, { tenantId, id: r['existing_link_id'] as string });
        if (!link) { // new link: limits first (a throw rolls the DEFINER's redemption back)
          // CR-pending (.orchestra/cr/T-L2.md #1): activeLinkCount runs under PAT_ACC RLS, so as a patient actor it sees only own links; max_accounts_per_patient needs a DEFINER count.
          const s = await repo.redeemLimits(tx, tenantId);
          if (!s || (await repo.activeLinksOfAccount(tx, { tenantId, accountId: acct['id'] })) >= s['max_profiles_per_account']
            || (await repo.activeLinkCount(tx, { tenantId, patientId: r['patient_id'] })) >= s['max_accounts_per_patient']) {
            engagementMetrics.linkEvent(ctx, 'link_code', 'limit');
            throw new LimsError('engagement.link_limit_reached');
          }
          const relationship = r['relationship'] === 'self' && (await repo.liveSelfLinks(tx, { tenantId, accountId: acct['id'] })) > 0 ? 'other' : r['relationship']; // review C16 #12
          link = await repo.insertRedeemedLink(tx, { tenantId, userId, accountId: acct['id'], patientId: r['patient_id'], relationship, codeId: r['link_code_id'], consentId: r['consent_id'],
            recordPhoneHmac: r['record_phone_hmac'] ?? null, displayName: r['display_name_snapshot'], sex: r['sex_snapshot'] ?? null });
          status = 201;
        }
        await repo.enqueueBackfill(tx, { tenantId, linkId: link['id'] });
        await ctx.audit?.access({ action: 'app_link.redeem', entityType: 'app_link', entityId: link['id'], outcome: 'allowed' }); // no code, no phone
        engagementMetrics.linkEvent(ctx, 'link_code', 'redeemed');
        return { status, body: toProfile(link) };
      } catch (e) { return mapDbError(e); }
    },

    /**
     * T-L5 reconcile (TRD §4.3.5, §4.4; system actor, caller's one transaction): every active / suspended link -> FrontdeskPort demographics (once per patient) ->
     * suspend (patient_merged | patient_anonymised > phone_mismatch > dormant; active links only, never reactivated here) + display_name / sex_snapshot refresh (live links, one write)
     * -> profile_paused notification + metric per newly suspended link -> projection rows of patients without a live link are deleted.
     * A patient C4 no longer knows (common.not_found) is skipped; any other port error propagates so the queue retries and the transaction rolls back.
     */
    async reconcile(ctx: LinkCtx): Promise<void> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const frontdesk = ctx.ports?.FrontdeskPort;
      if (!frontdesk) throw new LimsError('common.service_unavailable');
      const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await tx.query(sql, params)).rows as Row[];
      const links = await rows(
        `SELECT id, account_id, patient_id, method, status, display_name, sex_snapshot, record_phone_hmac_at_link FROM engagement.account_patient_links WHERE tenant_id = $1 AND status IN ('active', 'suspended')`, [tenantId]);
      const live = new Set(links.map((l) => l['patient_id'] as string));
      if (links.length > 0) {
        const [s] = await rows('SELECT dormant_after_days FROM engagement.settings WHERE tenant_id = $1', [tenantId]);
        const cutoff = Date.parse(now) - Number(s?.['dormant_after_days'] ?? 180) * 86_400_000; // [CONV] TRD §4.3.5 strict `<`; 180 = column default
        const logins = new Map((await rows('SELECT id, last_login_at FROM engagement.accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, [...new Set(links.map((l) => l['account_id'] as string))]]))
          .map((a) => [a['id'], a['last_login_at']]));
        const demo = new Map<string, Demo | null>();
        for (const patientId of live) {
          try { demo.set(patientId, await frontdesk.getPatientDemographics(ctx, { patientId, purpose: PURPOSE })); } catch (e) {
            if ((e as { code?: unknown } | null)?.code !== 'common.not_found') throw e;
            demo.set(patientId, null);
          }
        }
        for (const l of links) {
          const d = demo.get(l['patient_id']);
          let reason: string | undefined;
          if (d && l['status'] === 'active') {
            const stored = l['record_phone_hmac_at_link'] == null ? undefined : Buffer.from(l['record_phone_hmac_at_link']);
            if (d.status === 'merged') reason = 'patient_merged';
            else if (d.status === 'anonymised') reason = 'patient_anonymised';
            else if (stored && !(typeof d.phoneE164 === 'string' && d.phoneE164 !== '' && phoneEq(stored, phoneHmac(tenantId, d.phoneE164)))) reason = 'phone_mismatch'; // phone removed from the record counts as a change
          }
          if (!reason && l['status'] === 'active') { const last = logins.get(l['account_id']); if (last != null && Date.parse(last as string) < cutoff) reason = 'dormant'; }
          const name = typeof d?.fullName === 'string' ? d.fullName.trim().slice(0, 200) : '';
          const sets: string[] = []; const p: unknown[] = [tenantId, l['id'], userId, now];
          if (reason) { p.push(reason); sets.push(`status = 'suspended'`, `suspend_reason = $${p.length}`, 'suspended_at = $4'); }
          if (d && d.status !== 'merged' && d.status !== 'anonymised') {
            if (name && name !== l['display_name']) { p.push(name); sets.push(`display_name = $${p.length}`); }
            if (typeof d.sex === 'string' && d.sex !== l['sex_snapshot']) { p.push(d.sex); sets.push(`sex_snapshot = $${p.length}`); }
          }
          if (sets.length === 0) continue;
          if (reason) p.push(LIVE_FROM); // conditional suspend; the status is a bound value on purpose: only the DEFINER writes a literal `active` (link.redeem source guard)
          const res = await tx.query(`UPDATE engagement.account_patient_links SET ${sets.join(', ')}, version = version + 1, updated_at = $4, updated_by = $3
            WHERE tenant_id = $1 AND id = $2 AND status IN ('active', 'suspended')${reason ? ` AND status = $${p.length}` : ''} RETURNING id`, p);
          if (!reason || res.rows.length === 0) continue;
          await tx.query( // dedupe key (tenant, account, kind, entity_id, entity_seq): a rerun adds nothing
            `INSERT INTO engagement.notifications (id, tenant_id, account_id, patient_id, kind, entity_type, entity_id, entity_seq, route_id, created_by, expires_at)
             VALUES ($1, $2, $3, $4, 'profile_paused', 'profile', $5, 0, NULL, $6, $7) ON CONFLICT DO NOTHING`,
            [uuidv7(), tenantId, l['account_id'], l['patient_id'], l['id'], userId, new Date(Date.parse(now) + 180 * 86_400_000).toISOString()]);
          engagementMetrics.linkEvent(ctx, String(l['method']), 'suspended');
        }
      }
      // projections: only patients with an active / suspended link keep a read model (a link suspended by this run is still live)
      // ponytail: reads every patient id of the tenant's orders / reports; keyset-page it if a tenant grows past ~1e5 projected patients.
      const held = new Set<string>();
      for (const table of ['patient_orders', 'patient_reports']) for (const r of await rows(`SELECT patient_id FROM engagement.${table} WHERE tenant_id = $1`, [tenantId])) held.add(r['patient_id']);
      const dead = [...held].filter((id) => !live.has(id));
      if (dead.length > 0) await createProjectionService().deleteForPatients({ tx, tenantId }, dead);
    },

    /** L2: If-Match (428 / 400) -> id (400) -> row (404) -> ETag (409) -> conditional revoke (409 when it is no longer `issued`). */
    async revokeCode(ctx: LinkCtx, input: { id: unknown; headers: unknown }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/link_code_id');
      try {
        const cur = await repo.getCode(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        if (expected !== CODE_ETAG) throw new LimsError('common.version_conflict');
        if (!(await repo.revokeCode(tx, { tenantId, userId, id: input.id, now }))) throw new LimsError('common.version_conflict');
        return { status: 204 };
      } catch (e) { return mapDbError(e); }
    },

    /** L3: the patient must be visible to the tenant (FrontdeskPort, 404 otherwise); read-only. */
    async list(ctx: LinkCtx, input: { patientId: unknown }): Promise<Out> {
      const { tx, tenantId } = scope(ctx);
      if (!isUuid(input.patientId)) return invalid('/patient_id');
      try {
        const frontdesk = ctx.ports?.FrontdeskPort;
        if (!frontdesk) throw new LimsError('common.service_unavailable');
        await viaPort(frontdesk.getPatientDemographics(ctx, { patientId: input.patientId, purpose: PURPOSE })); // 404 for an unknown / other-tenant patient
        const [links, codes] = await Promise.all([repo.linksOf(tx, { tenantId, patientId: input.patientId }), repo.codesOf(tx, { tenantId, patientId: input.patientId })]);
        const phones = await phonesOf(tx, tenantId, links);
        return { status: 200, body: { data: links.map((l) => toLink(l, phones.get(l['account_id']))), codes: codes.map((c) => ({ link_code_id: c['id'], status: c['status'], expires_at: iso(c['expires_at']), issued_at: iso(c['created_at']) })) } };
      } catch (e) { return mapDbError(e); }
    },

    /** L4: If-Match -> id -> body (400) -> row (404) -> state (409) -> version (409) -> conditional revoke -> access log + metric. */
    async revokeLink(ctx: LinkCtx, input: { id: unknown; headers: unknown; body: unknown }): Promise<Out> {
      const { tx, tenantId, userId, now } = scope(ctx);
      const expected = parseIfMatch(input.headers);
      if (!isUuid(input.id)) return invalid('/link_id');
      const reason = strict(input.body, ['reason_code'])['reason_code'];
      if (typeof reason !== 'string' || !REVOKE_REASONS.includes(reason)) invalid('/reason_code');
      try {
        const cur = await repo.getLink(tx, { tenantId, id: input.id });
        if (!cur) throw new LimsError('common.not_found');
        if (!canTransition(cur['status'] as LinkStatus, 'revoked') || cur['version'] !== expected) throw new LimsError('common.version_conflict');
        const l = await repo.revokeLink(tx, { tenantId, userId, id: input.id, expectedVersion: expected, reason: reason as string, now });
        if (!l) throw new LimsError('common.version_conflict'); // lost a race between the read and the write
        await ctx.audit?.access({ action: 'app_link.revoke', entityType: 'app_link', entityId: l['id'], outcome: 'allowed' });
        engagementMetrics.linkEvent(ctx, String(l['method'] ?? 'link_code'), 'revoked');
        const phones = await phonesOf(tx, tenantId, [l]);
        return { status: 200, body: toLink(l, phones.get(l['account_id'])) };
      } catch (e) { return mapDbError(e); }
    },
  };
}
export type LinkService = ReturnType<typeof createLinkService>;
