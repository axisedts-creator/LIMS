// T0D-BUILD-2 (LD-447, CR DEPLOY-AXIS-012 item 8): getPartnerSettings / updatePartnerSettings (GET/PUT /v1/partners/admin/settings, contract PartnerSettings).
// Order: staff actor -> IdentityPort.assertRole (its x-permission, before any SQL) -> If-Match (PUT) -> body rules (no SQL) -> row lock -> version -> ONE write.
// No row = the table defaults of partners.settings (migration 20261115130000), ETag "1", nothing written. ETag = `"<version>"`; a save always moves the version up.
// Audit = the row trigger partners.settings settings__audit (app.tg_row_audit). Nothing of the body is logged; error messages are fixed text (no value echoed).
import type { FieldError } from '../../../core/errors.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import { Checker, ifMatch, type Obj } from '../domain/partyset.rules.js';

type Req = { headers?: unknown; body?: unknown };
type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Obj[] }> };

const MODES = ['on_receipt', 'on_submit'] as const;
const FIELDS = ['default_conversion_mode', 'include_default_price_list', 'require_mapped_referrer', 'access_slip_enabled', 'max_lines_per_manifest', 'draft_ttl_days',
  'pickup_max_days_ahead', 'report_download_daily_cap_per_user', 'consent_text_version', 'consent_statement'] as const;
const BOOLS = new Set<string>(['include_default_price_list', 'require_mapped_referrer', 'access_slip_enabled']);
const INTS: Readonly<Record<string, readonly [number, number]>> = {
  max_lines_per_manifest: [1, 200], draft_ttl_days: [1, 90], pickup_max_days_ahead: [1, 30], report_download_daily_cap_per_user: [50, 5000],
};
const TEXTS: Readonly<Record<string, number>> = { consent_text_version: 32, consent_statement: 2000 };
/** [CONV] the column defaults of partners.settings (05-SCHEMA §3.8): what a tenant without a row reads */
const DEFAULTS: Readonly<Obj> = Object.freeze({
  default_conversion_mode: 'on_receipt', include_default_price_list: true, require_mapped_referrer: false, access_slip_enabled: false, max_lines_per_manifest: 200,
  draft_ttl_days: 30, pickup_max_days_ahead: 7, report_download_daily_cap_per_user: 500, consent_text_version: 'partner-v1',
  consent_statement: 'The patient has agreed that the lab may process their sample and contact them about the result.',
});
const COLS = FIELDS.join(', ');

async function authorize(ctx: HandlerContext, permission: string): Promise<{ tenantId: string; actorId: string }> {
  if (ctx.actor?.type !== 'user' || !ctx.tenantId) throw new LimsError('auth.forbidden'); // staff operation only: nothing else reaches SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission });
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id };
}

const dto = (r: Obj | undefined): Obj => Object.fromEntries(FIELDS.map((k) => {
  const v = (r ?? DEFAULTS)[k];
  return [k, k in INTS ? Number(v) : v];
}));
const answer = (r: Obj | undefined): HandlerResult => ({ status: 200, headers: { ETag: `"${r ? Number(r['version']) : 1}"` }, body: dto(r) });

/** PUT is a full replace: every field required, unknown fields refused, every bad field in one answer */
function parseBody(raw: unknown): unknown[] {
  const c = new Checker(raw, FIELDS);
  const out: unknown[] = [];
  for (const k of FIELDS) {
    if (c.src[k] === undefined) { c.errors.push({ path: `/${k}`, code: 'common.field_required', message: 'Field required' } as FieldError); out.push(undefined); continue; }
    if (k === 'default_conversion_mode') out.push(c.oneOf(k, MODES, true));
    else if (BOOLS.has(k)) out.push(c.bool(k));
    else if (k in INTS) out.push(c.int(k, INTS[k]![0], INTS[k]![1], true));
    else out.push(c.text(k, TEXTS[k]!, true));
  }
  c.done();
  return out;
}

export async function getSettings(_req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, 'partners.partner.read');
  const r = (await (ctx.tx as Q).query(`SELECT ${COLS}, version FROM partners.settings WHERE tenant_id = $1`, [tenantId])).rows[0];
  return answer(r);
}

export async function updateSettings(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, 'partners.partner.manage');
  const expected = ifMatch(req.headers)!;
  const values = parseBody(req.body);
  const tx = ctx.tx as Q;
  // the row lock serialises writers of one tenant: a second writer with the same If-Match waits, then sees the bumped version (409, no write)
  const cur = (await tx.query('SELECT version FROM partners.settings WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows[0];
  const conflict = (): never => { throw new LimsError('common.version_conflict'); };
  let row: Obj | undefined;
  if (!cur) {
    if (expected !== 1) conflict(); // a tenant without a row answered ETag "1"
    // version 2: a save always moves past the "1" the defaults answered; a concurrent first save wins the PK and this one is stale
    row = (await tx.query(`INSERT INTO partners.settings (tenant_id, ${COLS}, version, created_by, updated_by)
      VALUES ($1, ${FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, 2, $${FIELDS.length + 2}, $${FIELDS.length + 2})
      ON CONFLICT (tenant_id) DO NOTHING RETURNING ${COLS}, version`, [tenantId, ...values, actorId])).rows[0];
  } else {
    if (Number(cur['version']) !== expected) conflict();
    row = (await tx.query(`UPDATE partners.settings SET ${FIELDS.map((k, i) => `${k} = $${i + 3}`).join(', ')},
      version = version + 1, updated_at = now(), updated_by = $${FIELDS.length + 3}
      WHERE tenant_id = $1 AND version = $2 RETURNING ${COLS}, version`, [tenantId, expected, ...values, actorId])).rows[0];
  }
  return row ? answer(row) : conflict();
}
