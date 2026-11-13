// E15 redeemReportLink (02-TRD §4.3.3, §5; 05-SCHEMA §4 patient column guard + §6.1 app.engagement_apply_report_link; PRD US-EN-04.1-6; 07-SECURITY E15 row, P-L4/P-L6/P-L9; CR-C16-008).
// Order: validate the body -> resolve the caller's account (phone comes from the account, never the client) -> ReportingPort (C6) -> the DEFINER apply -> else limits + insert.
// C16 writes nothing before the C6 call and nothing after its failure; every C6 failure is the one identical 422 (REQ-SEC-094). Token, URL and phone are never logged, audited or queued.
// Reactivation / widening go ONLY through the DEFINER (a direct patient UPDATE of status / visible_from raises immutable_row).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export interface LinkCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }> };
  readonly ports?: { ReportingPort?: { redeemPortalLinkForApp(ctx: unknown, input: { linkToken: string; phoneE164: string }): Promise<{ patientId: string; releasedAt: string | Date }> } };
  readonly audit: { access(e: Record<string, unknown>): Promise<void> };
}
type Row = Record<string, any>;

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const PLACEHOLDER_NAME = 'Linked patient'; // real name + sex arrive with engagement.backfill_link (FrontdeskPort, system; review C16 #16)
const LIVE = `status IN ('active', 'suspended')`;
const LINK_UQ_RETRIES = 2;
export const BACKFILL_TASK = 'engagement.backfill_link';
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)'; // (identifier, payload, job_key, run_at, max_attempts) — TRD §8.1: key backfill:<link_id>, max 10

const bad = (path: string, code: string, message: string): never => { throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]); };
const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
const iso = (v: unknown): string => new Date(v as string).toISOString();

/** Origin is read at call time; an unset origin fails closed (nothing can match). Only `<origin>/r/<token>` passes; the submitted value is never echoed. */
function parseToken(body: unknown): string {
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

const profile = (l: Row) => ({
  profile_id: l['id'], display_name: String(l['display_name']).slice(0, 120), relationship: l['relationship'], method: l['method'], status: 'active',
  ...(l['visible_from'] == null ? {} : { history_from: iso(l['visible_from']) }),
});

export function createLinkService() {
  async function accountOf(ctx: LinkCtx): Promise<Row> {
    if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden');
    const { rows } = await ctx.tx.query(
      `SELECT id, phone_e164, phone_hmac FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status <> 'deleted'`, [ctx.tenantId, ctx.actor.id]);
    if (!rows[0]) throw new LimsError('auth.forbidden');
    return rows[0];
  }

  const apply = (ctx: LinkCtx, patientId: string, releasedAt: string) =>
    ctx.tx.query('SELECT * FROM app.engagement_apply_report_link($1, $2::timestamptz)', [patientId, releasedAt]).then((r) => r.rows[0]);

  async function done(ctx: LinkCtx, status: 200 | 201, link: Row) {
    await ctx.tx.query(ENQUEUE_SQL, [BACKFILL_TASK, JSON.stringify({ tenant_id: ctx.tenantId, link_id: link['id'] }), `backfill:${link['id']}`, null, 10]);
    await ctx.audit.access({ action: 'app_link.redeem', entityType: 'app_link', entityId: link['id'], outcome: 'success' });
    return { status, body: profile(link) };
  }

  /** TRD §4.3.2 step 4: account active links < max_profiles_per_account. (Per-patient limit: mechanism under patient RLS not specified — see notes.) */
  async function checkLimit(ctx: LinkCtx, accountId: string): Promise<void> {
    const [{ rows: s }, { rows: c }] = await Promise.all([
      ctx.tx.query('SELECT max_profiles_per_account FROM engagement.settings WHERE tenant_id = $1', [ctx.tenantId]),
      ctx.tx.query(`SELECT count(*) FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND status = 'active'`, [ctx.tenantId, accountId]),
    ]);
    const max = Number(s[0]?.['max_profiles_per_account']);
    if (!Number.isFinite(max)) throw new LimsError('common.service_unavailable');
    if (Number(c[0]?.['count']) >= max) throw new LimsError('engagement.link_limit_reached');
  }

  return {
    async redeemReportLink(ctx: LinkCtx, input: { body: unknown }) {
      if (typeof ctx.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
      const token = parseToken(input.body);
      const account = await accountOf(ctx);
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
        const hit = await apply(ctx, proof.patientId, releasedAt); // existing active -> widen; suspended -> reactivate (DEFINER only)
        if (hit) return done(ctx, 200, await linkById(hit['link_id']));

        await checkLimit(ctx, account['id']);
        const { rows: selfs } = await ctx.tx.query(`SELECT id FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND relationship = 'self' AND ${LIVE}`, [ctx.tenantId, account['id']]);
        const id = uuidv7();
        await ctx.tx.query('SAVEPOINT redeem_link'); // a lost race must not poison the request transaction
        try {
          const { rows } = await ctx.tx.query(
            `INSERT INTO engagement.account_patient_links (id, tenant_id, account_id, patient_id, relationship, method, display_name, status, visible_from, record_phone_hmac_at_link, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, 'report_link', $6, 'active', $7::timestamptz, $8, $9, $9) RETURNING *`,
            [id, ctx.tenantId, account['id'], proof.patientId, selfs.length ? 'other' : 'self', PLACEHOLDER_NAME, releasedAt, account['phone_hmac'], ctx.actor.id]);
          await ctx.tx.query('RELEASE SAVEPOINT redeem_link');
          return done(ctx, 201, rows[0]!);
        } catch (e) {
          if (pgCode(e) !== '23505') throw e;
          await ctx.tx.query('ROLLBACK TO SAVEPOINT redeem_link');
          if (attempt >= LINK_UQ_RETRIES) throw new LimsError('engagement.link_limit_reached'); // never a 5xx on a lost race
        }
      }
    },
  };
}
