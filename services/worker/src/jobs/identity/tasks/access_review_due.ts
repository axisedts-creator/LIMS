// identity.access_review_due (02-TRD §10 crontab, per_tenant 06:40 Asia/Kathmandu; 08 A13 P-6, A23.1).
// Last access review > 90 days old at ctx.now() and no unexpired access_review_due notice -> insert ONE admin_notices row
// (kind access_review_due, subject access_review = that review, expires in 30 days per the table retention).
// [CONV] a tenant with no review at all gets no notice: admin_notices__subject__ck needs a subject_id (open point, see C2.T27-impl.md).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { q, tenantOnly } from './shared.js';

export const ACCESS_REVIEW_DUE = 'identity.access_review_due';
const KIND = 'access_review_due';
const DUE_MS = 90 * 86_400_000;
const NOTICE_TTL_MS = 30 * 86_400_000;

export interface AccessReviewNotice { tenantId: string; kind: string; subjectType: string; subjectId: string; expiresAt: string; actorId: string }
export interface AccessReviewRepo {
  lastReview(tx: unknown, tenantId: string): Promise<{ id: string; reviewed_at: string } | undefined>;
  hasLiveNotice(tx: unknown, tenantId: string, nowIso: string): Promise<boolean>;
  insertNotice(tx: unknown, n: AccessReviewNotice): Promise<void>;
}

const isoOf = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export const accessReviewRepo: AccessReviewRepo = {
  async lastReview(tx, tenantId) {
    const r = (await q(tx, `SELECT id, reviewed_at FROM identity.access_reviews WHERE tenant_id = $1 ORDER BY reviewed_at DESC, id DESC LIMIT 1`, [tenantId]))[0];
    return r ? { id: String(r['id']), reviewed_at: isoOf(r['reviewed_at']) } : undefined;
  },
  async hasLiveNotice(tx, tenantId, nowIso) {
    return (await q(tx, `SELECT 1 FROM identity.admin_notices WHERE tenant_id = $1 AND kind = $2 AND expires_at > $3::timestamptz LIMIT 1`, [tenantId, KIND, nowIso])).length > 0;
  },
  async insertNotice(tx, n) {
    await q(tx, `INSERT INTO identity.admin_notices (id, tenant_id, kind, subject_type, subject_id, expires_at, created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $7)`, [uuidv7(), n.tenantId, n.kind, n.subjectType, n.subjectId, n.expiresAt, n.actorId]);
  },
};

export function createAccessReviewDue(deps: { repo: AccessReviewRepo }): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = tenantOnly(ACCESS_REVIEW_DUE, payload, ctx);
    const now = ctx.now(); const nowMs = Date.parse(now);
    const last = await deps.repo.lastReview(ctx.tx, tenantId);
    if (!last || !(nowMs - Date.parse(last.reviewed_at) > DUE_MS)) return;
    if (await deps.repo.hasLiveNotice(ctx.tx, tenantId, now)) return;
    await deps.repo.insertNotice(ctx.tx, { tenantId, kind: KIND, subjectType: 'access_review', subjectId: last.id,
      expiresAt: new Date(nowMs + NOTICE_TTL_MS).toISOString(), actorId: ctx.actor.id });
    ctx.log?.info?.({ event: ACCESS_REVIEW_DUE, notice: 'inserted' });
  };
}

export const accessReviewDue = createAccessReviewDue({ repo: accessReviewRepo });
