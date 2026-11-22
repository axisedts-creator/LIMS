// Access review list + record (T0D-BUILD-3, LD-447; LD-189 AUTH SENSITIVE; 02-TRD §5.9; 05-SCHEMA §4.16; contracts identity.yaml AccessReview*).
// Built on the EXISTING identity.access_reviews table (no migration). Tenant, reviewer membership and creator come from ctx only, never the body;
// reviewed_at is the database clock (now()). Every statement names tenant_id (defence in depth over RLS). The table is append-only: INSERT + SELECT.
// Audit: the row-audit trigger access_reviews__audit (app.tg_row_audit) writes the audit entry; recordAccessReview is not on the 02-TRD §9 access-log
// list and no seeded access action fits, so no ctx.audit.access here (see .orchestra/notes/T0D-BUILD-3-dispute.md). Notes never reach a log or error.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export interface AccessReviewCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
}
interface Row { id: string; reviewed_by_membership_id: string; memberships_reviewed: number; notes: string | null; reviewed_at: Date | string }
type Q = { query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> };

const LIST_MAX = 200;          // AccessReviewList.data maxItems
const COUNT_MAX = 100_000;     // AccessReviewCreateRequest.memberships_reviewed maximum
const NOTES_MAX = 2000;        // maxLength; also access_reviews__notes__ck
const COLS = 'id, reviewed_by_membership_id, memberships_reviewed, notes, reviewed_at';
const LIST_SQL = `SELECT ${COLS} FROM identity.access_reviews WHERE tenant_id = $1 ORDER BY reviewed_at DESC, id DESC LIMIT ${LIST_MAX}`;
const INSERT_SQL = `INSERT INTO identity.access_reviews (id, tenant_id, reviewed_by_membership_id, memberships_reviewed, notes, reviewed_at, created_by)
  VALUES ($1, $2, $3, $4, $5, now(), $6) RETURNING ${COLS}`;

const invalid = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
};

function who(ctx: AccessReviewCtx) {
  const a = ctx?.actor;
  if (typeof ctx?.tenantId !== 'string' || !a || a.type !== 'user' || typeof a.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as Q, tenantId: ctx.tenantId, userId: a.id, membershipId: a.membershipId };
}

const toBody = (r: Row) => ({
  access_review_id: r.id, reviewed_by_membership_id: r.reviewed_by_membership_id, memberships_reviewed: Number(r.memberships_reviewed),
  ...(r.notes == null ? {} : { notes: r.notes }), reviewed_at: new Date(r.reviewed_at).toISOString(),
});

function parseCreate(body: unknown): { count: number; notes: string | null } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) invalid('');
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'memberships_reviewed' && k !== 'notes') invalid(`/${k}`);   // additionalProperties: false
  const n = b['memberships_reviewed'];
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > COUNT_MAX) invalid('/memberships_reviewed');
  const notes = b['notes'];
  if (notes !== undefined && (typeof notes !== 'string' || [...notes].length > NOTES_MAX)) invalid('/notes');   // code points, as char_length
  return { count: n as number, notes: (notes as string | undefined) ?? null };
}

export async function listAccessReviews(ctx: AccessReviewCtx) {
  const { tx, tenantId } = who(ctx);
  const rows = (await tx.query(LIST_SQL, [tenantId])).rows as Row[];
  return { status: 200, body: { data: rows.slice(0, LIST_MAX).map(toBody) } };
}

export async function recordAccessReview(ctx: AccessReviewCtx, body: unknown) {
  const { tx, tenantId, userId, membershipId } = who(ctx);
  if (typeof membershipId !== 'string' || !membershipId) throw new LimsError('auth.forbidden');   // the reviewer is the caller's own membership
  const { count, notes } = parseCreate(body);
  const rows = (await tx.query(INSERT_SQL, [uuidv7(), tenantId, membershipId, count, notes, userId])).rows as Row[];
  if (!rows[0]) throw new LimsError('common.internal');
  return { status: 201, body: toBody(rows[0]) };
}
