// E16 createSelfRegistration / E17 getSelfRegistration (02-TRD §4.3.4 steps 1-3, §5; PRD US-EN-05.1-5; 05-SCHEMA self_registrations + link_consents; 07-SECURITY REQ-SEC-005, P2 data).
// Order: patient actor + own account -> tenant settings (feature switch BEFORE any field check) -> strict body -> consent version -> age rule -> one `self` per account -> all-or-nothing inserts + enqueue.
// The request writes the registration row and the consent only; C4 and the link are the task's (tasks/create_self_patient.ts). Personal data is never logged, audited, enqueued or echoed.
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export interface SelfRegCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }> };
  readonly now: () => string | Date;
}
type Row = Record<string, any>;

export const CREATE_SELF_PATIENT = 'engagement.create_self_patient';
export const PURGE_DAYS = 30; // TRD §4.3.4 step 4: personal fields NULLed 30 days after the terminal state
const KEYS = new Set(['relationship', 'full_name', 'sex', 'birth_on', 'age_years', 'sms_consent', 'whatsapp_consent', 'consent_text_version']);
const SEX = new Set(['male', 'female', 'other', 'unknown']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENQUEUE_SQL = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)'; // (identifier, payload, job_key, run_at, max_attempts) — TRD §8.1: key selfreg:<id>, max 10

const bad = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => { throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]); };
const iso = (v: unknown): string => new Date(v as string).toISOString();
/** Calendar date in Nepal (Asia/Kathmandu) of an instant: the age rule counts whole years on the lab's local date. */
const localDate = (instant: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(new Date(instant));
function wholeYears(birthOn: string, today: string): number {
  const [by, bm, bd] = birthOn.split('-').map(Number) as [number, number, number], [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
const isDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

interface Form { relationship: 'self' | 'child'; fullName: string; sex: string; birthOn?: string; ageYears?: number; sms: boolean; whatsapp: boolean; version: string }

/** Strict body (additionalProperties false, contracts E16); values are never echoed. */
function parse(body: unknown): Form {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('/', 'common.field_invalid');
  const b = body as Row;
  for (const k of Object.keys(b)) if (b[k] !== undefined && !KEYS.has(k)) bad(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
  const need = (k: string) => (b[k] === undefined ? bad(`/${k}`, 'common.field_required', 'Field required') : b[k]);
  const relationship = need('relationship'); if (relationship !== 'self' && relationship !== 'child') bad('/relationship');
  const fullName = need('full_name'); if (typeof fullName !== 'string' || fullName.length < 1 || fullName.length > 200) bad('/full_name');
  const sex = need('sex'); if (typeof sex !== 'string' || !SEX.has(sex)) bad('/sex');
  const sms = need('sms_consent'); if (typeof sms !== 'boolean') bad('/sms_consent');
  const whatsapp = need('whatsapp_consent'); if (typeof whatsapp !== 'boolean') bad('/whatsapp_consent');
  const version = need('consent_text_version'); if (typeof version !== 'string' || version.length < 1 || version.length > 32) bad('/consent_text_version');
  const birthOn = b['birth_on'], ageYears = b['age_years'];
  if (birthOn !== undefined && !isDate(birthOn)) bad('/birth_on');
  if (ageYears !== undefined && !(Number.isInteger(ageYears) && (ageYears as number) >= 0 && (ageYears as number) <= 150)) bad('/age_years');
  if (birthOn !== undefined && ageYears !== undefined) bad('/age_years', 'common.field_invalid', 'Give birth_on or age_years, not both');
  if (birthOn === undefined && ageYears === undefined) bad('/birth_on', 'common.field_required', 'Give birth_on or age_years');
  return { relationship: relationship as 'self' | 'child', fullName: fullName as string, sex: sex as string, sms: sms as boolean, whatsapp: whatsapp as boolean, version: version as string,
    ...(birthOn === undefined ? {} : { birthOn: birthOn as string }), ...(ageYears === undefined ? {} : { ageYears: ageYears as number }) };
}

export function createSelfRegService() {
  async function accountOf(ctx: SelfRegCtx): Promise<Row> {
    if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden');
    const { rows } = await ctx.tx.query(`SELECT id FROM engagement.accounts WHERE tenant_id = $1 AND membership_id = $2 AND status <> 'deleted'`, [ctx.tenantId, ctx.actor.id]);
    if (!rows[0]) throw new LimsError('auth.forbidden');
    return rows[0];
  }

  return {
    async createSelfRegistration(ctx: SelfRegCtx, input: { body: unknown }) {
      const account = await accountOf(ctx);
      const { rows: s } = await ctx.tx.query('SELECT app_enabled, app_consent_text, app_consent_text_version, minor_age_years FROM engagement.settings WHERE tenant_id = $1', [ctx.tenantId]);
      const set = s[0]; // no settings row = nothing is switched on
      if (!set || set['app_enabled'] !== true || !set['app_consent_text'] || !set['app_consent_text_version']) throw new LimsError('common.feature_disabled');
      const f = parse(input.body);
      if (f.version !== set['app_consent_text_version']) bad('/consent_text_version', 'common.field_invalid', 'Consent text version is not current');

      const now = iso(ctx.now());
      const today = localDate(now);
      if (f.birthOn !== undefined && f.birthOn > today) bad('/birth_on'); // no future birth date, self or child
      if (f.relationship === 'child') {
        const minor = Number(set['minor_age_years']);
        if (!Number.isFinite(minor)) throw new LimsError('common.service_unavailable');
        const age = f.birthOn !== undefined ? wholeYears(f.birthOn, today) : (f.ageYears as number);
        if (age >= minor) bad(f.birthOn !== undefined ? '/birth_on' : '/age_years', 'common.field_invalid', 'Not a minor');
      } else {
        const { rows } = await ctx.tx.query(`SELECT id FROM engagement.account_patient_links WHERE tenant_id = $1 AND account_id = $2 AND relationship = 'self' AND status IN ('active', 'suspended')`, [ctx.tenantId, account['id']]);
        if (rows.length) throw new LimsError('engagement.link_limit_reached'); // self once per account (the partial unique index is the race guard)
      }

      const consentId = uuidv7(), id = uuidv7();
      await ctx.tx.query(
        `INSERT INTO engagement.link_consents (id, tenant_id, account_id, source, relationship, consented_by, consent_text_version, created_by) VALUES ($1, $2, $3, 'app', $4, $5, $6, $7)`,
        [consentId, ctx.tenantId, account['id'], f.relationship, f.relationship === 'self' ? 'patient' : 'guardian', set['app_consent_text_version'], ctx.actor.id]);
      await ctx.tx.query(
        `INSERT INTO engagement.self_registrations (id, tenant_id, account_id, relationship, full_name, sex, birth_on, age_years, sms_consent, whatsapp_consent, consent_id, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, ctx.tenantId, account['id'], f.relationship, f.fullName, f.sex, f.birthOn ?? null, f.ageYears ?? null, f.sms, f.whatsapp, consentId, ctx.actor.id,
          new Date(Date.parse(now) + PURGE_DAYS * 86_400_000).toISOString()]);
      await ctx.tx.query(ENQUEUE_SQL, [CREATE_SELF_PATIENT, JSON.stringify({ tenant_id: ctx.tenantId, self_registration_id: id }), `selfreg:${id}`, null, 10]); // ids only: no personal data in the queue
      return { status: 202 as const, body: { id, relationship: f.relationship, status: 'queued' } };
    },

    /** E17: the caller's own registration; any other id (unknown, another account, another tenant) is the same 404. */
    async getSelfRegistration(ctx: SelfRegCtx, input: { id: unknown }) {
      const account = await accountOf(ctx);
      if (typeof input.id !== 'string' || !UUID.test(input.id)) throw new LimsError('common.not_found');
      const { rows } = await ctx.tx.query(
        'SELECT id, relationship, status, failure_code, link_id FROM engagement.self_registrations WHERE tenant_id = $1 AND account_id = $2 AND id = $3', [ctx.tenantId, account['id'], input.id]);
      const r = rows[0];
      if (!r) throw new LimsError('common.not_found');
      return { status: 200 as const, body: {
        id: r['id'], relationship: r['relationship'], status: r['status'],
        ...(r['status'] === 'created' && r['link_id'] ? { profile_id: r['link_id'] } : {}), // the link id, never the patient id
        ...(r['status'] === 'failed' && r['failure_code'] ? { failure_code: r['failure_code'] } : {}),
      } };
    },
  };
}
