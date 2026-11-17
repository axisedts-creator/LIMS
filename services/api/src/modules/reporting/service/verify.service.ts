// Q1 public QR verification + R14 / R15 / R16 (02-TRD §6.3; 01-PRD AC-10.1..10.5; 07-SECURITY REQ-SEC-018, REQ-SEC-095, tests 1, 7, 9, 14). SQL lives in repository/verify.repo.ts.
// Q1: every failure (rate-limit aside) is the same LimsError('reporting.verify_not_found'); the limiter runs first so format probing is not free; only the SHA-256 reaches the DB.
// [CONV] re-revoking an already revoked token / link answers 200 with the ORIGINAL revoked_at (OpenAPI lists no conflict code; the DB guard makes revoked_* write-once).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { hashToken } from '../domain/tokens.js';
import * as repo from '../repository/verify.repo.js';
import { listCodes } from '../repository/settings.repo.js';

type Row = Record<string, any>;
type Tx = { query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QR_TOKEN = /^[A-Za-z0-9_-]{22}$/;                  // 16 random bytes, base64url without padding (domain/tokens)
const LINKS_MAX = 200;                                   // OpenAPI maxItems
const REASON_TEXT_MAX = 500;
const iso = (v: unknown): string => new Date(v as string).toISOString();
const invalid = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};

export interface PublicCtx { clientIp?: string; tx?: Tx; rateLimit?: { consume(tier: string, key: string): Promise<unknown> } }
export interface StaffCtx {
  tenantId: string; actor: { type: string; id: string }; tx: Tx; now(): string;
  audit?: { access(entry: Row): Promise<unknown> };
}

/** Q1. `token` is whatever the body carried; anything but a 22-char base64url string is the same 404 as an unknown token. */
async function verifyQr(ctx: PublicCtx, token: unknown) {
  if (!ctx?.tx || !ctx.rateLimit || typeof ctx.clientIp !== 'string' || ctx.clientIp === '') throw new LimsError('common.internal');   // fail closed, never a shared bucket
  await ctx.rateLimit.consume('qr_verify', `i:${ctx.clientIp}`);                // 100 per day per client IP, hits and misses alike
  if (typeof token !== 'string' || !QR_TOKEN.test(token)) throw new LimsError('reporting.verify_not_found');
  const row = await repo.verifyQr(ctx.tx, hashToken(token));
  if (!row) throw new LimsError('reporting.verify_not_found');
  return {
    lab_name: row.lab_name, patient_display: row.patient_display, panel_names: row.panel_names,
    issued_at: iso(row.issued_at), version_no: row.version_no, status: row.status,
  };
}

function scope(ctx: StaffCtx) {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  if (ctx.actor.type !== 'user') throw new LimsError('auth.forbidden');         // portal / system actors never revoke or list
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}

/** { reason_code, reason_text? } against the token_revoke_reasons coded set; `other` needs a non-blank text. */
async function reason(tx: Tx, tenantId: string, raw: unknown): Promise<{ code: string; text: string | null }> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('/');
  const b = raw as Row;
  for (const k of Object.keys(b)) if (k !== 'reason_code' && k !== 'reason_text') invalid('/');   // additionalProperties: false
  const code = b['reason_code']; const text = b['reason_text'];
  if (typeof code !== 'string' || code.length < 1 || code.length > 64) invalid('/reason_code');
  if (text !== undefined && (typeof text !== 'string' || text.length > REASON_TEXT_MAX)) invalid('/reason_text');
  if (!(await listCodes(tx, tenantId, 'token_revoke_reasons', 200)).some((c) => c.code === code)) invalid('/reason_code');
  if (code === 'other' && (typeof text !== 'string' || text.trim() === '')) invalid('/reason_text');
  return { code: code as string, text: typeof text === 'string' ? text : null };
}

export function createVerifyService() {
  /** Shared R14 / R16 shape: find (tenant-scoped, else 404), revoke if still live, and on a lost race / replay return the original revoked_at. */
  async function revoke(ctx: StaffCtx, o: {
    find: () => Promise<{ id: string; revoked_at: unknown } | undefined>;
    write: (id: string, r: { code: string; text: string | null }) => Promise<{ revoked_at: unknown } | undefined>;
    entityType: string; body: unknown;
  }) {
    const { tx, tenantId } = scope(ctx);
    if (!ctx.audit) throw new LimsError('common.internal');                       // fail closed: no revoke without an access-log writer
    const r = await reason(tx, tenantId, o.body);
    let row = await o.find();
    if (!row) throw new LimsError('common.not_found');
    if (row.revoked_at == null) {
      const won = await o.write(row.id, r);
      if (won) {
        await ctx.audit.access({ action: 'report.token_revoke', entityType: o.entityType, entityId: row.id, outcome: 'allowed', detail: { reason_code: r.code } });
        return { status: 200, body: { revoked_at: iso(won.revoked_at) } };
      }
      row = await o.find();                                                       // lost the race: report the winner's time
      if (!row || row.revoked_at == null) throw new LimsError('common.internal');
    }
    return { status: 200, body: { revoked_at: iso(row.revoked_at) } };
  }

  return {
    verifyQr,

    /** R14 */
    async revokeQrToken(ctx: StaffCtx, input: { versionId: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = typeof input?.versionId === 'string' && UUID.test(input.versionId) ? input.versionId : undefined;
      return revoke(ctx, {
        entityType: 'qr_token', body: input?.body,
        find: async () => (id ? repo.findQrByVersion(tx, tenantId, id) : undefined),
        write: (qrId, r) => repo.revokeQr(tx, tenantId, qrId, ctx.now(), actorId, r.code, r.text),
      });
    },

    /** R16 */
    async revokeLink(ctx: StaffCtx, input: { linkId: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const id = typeof input?.linkId === 'string' && UUID.test(input.linkId) ? input.linkId : undefined;
      return revoke(ctx, {
        entityType: 'portal_link', body: input?.body,
        find: async () => (id ? repo.findLink(tx, tenantId, id) : undefined),
        write: (linkId, r) => repo.revokeLink(tx, tenantId, linkId, ctx.now(), actorId, r.code),
      });
    },

    /** R15: no token, URL or hash; unset optionals are omitted. */
    async listLinks(ctx: StaffCtx, input: { reportId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (typeof input?.reportId !== 'string' || !UUID.test(input.reportId) || !(await repo.reportExists(tx, tenantId, input.reportId))) throw new LimsError('common.not_found');
      const rows = await repo.linksOfReport(tx, tenantId, input.reportId, LINKS_MAX);
      return {
        status: 200,
        body: {
          data: rows.slice(0, LINKS_MAX).map((l) => ({
            id: l['id'], channel: l['channel'], recipient_kind: l['recipient_kind'],
            ...(l['destination_masked'] != null ? { destination_masked: l['destination_masked'] } : {}),
            expires_at: iso(l['expires_at']),
            ...(l['revoked_at'] != null ? { revoked_at: iso(l['revoked_at']) } : {}),
            ...(l['last_used_at'] != null ? { last_used_at: iso(l['last_used_at']) } : {}),
            use_count: Number(l['use_count']),
          })),
        },
      };
    },
  };
}
