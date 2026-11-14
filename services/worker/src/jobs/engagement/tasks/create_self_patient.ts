// Task engagement.create_self_patient (02-TRD §4.3.4 step 4, §8.1 max 10, §9 createSelfRegisteredPatient row; PRD US-EN-05.1, .2, .5). Job key selfreg:<registration id>.
// Load the `queued` registration (anything else = quiet no-op, so redelivery calls C4 once) -> FrontdeskPort.createSelfRegisteredPatient as the system actor with idempotencyKey
// selfreg:<id> -> link {self_registered, visible_from now} to the NEW patient (duplicateSuspected still means a new record, CR-C16-007) -> registration `created`.
// Failure (TRD §9, §4.3.4): frontdesk.consent_required, a lost race on the one-self-link index, or any error on the last attempt -> registration `failed` + failure_code and the task RESOLVES
// (a throw would roll the failed mark back); any other error THROWS (tx rolls back, retry replays the same key). Name, birth date and phone are never logged, audited or stored in failure_code.
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURGE_DAYS = 30; // TRD §4.3.4: personal fields NULLed 30 days after the terminal state (purge_ephemeral keys on expires_at)
const dateOnly = (v: unknown): string => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)); // pg `date` -> YYYY-MM-DD
/** Only a registry error code (e.g. frontdesk.consent_required) is stored; anything else is the generic code. */
const failureCode = (e: unknown): string => { const c = (e as { code?: unknown } | null)?.code; return typeof c === 'string' && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(c) && c.length <= 64 ? c : 'common.internal'; };

export function createCreateSelfPatient(): TaskHandler {
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const id = payload?.['self_registration_id'];
    if (typeof tenantId !== 'string' || (payload?.['tenant_id'] !== undefined && payload['tenant_id'] !== tenantId) || typeof id !== 'string' || !UUID.test(id)) {
      ctx.log?.warn?.({ event: 'create_self_patient_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx; const now = new Date(ctx.now()).toISOString();
    // ponytail: no FOR UPDATE; the queue runs one job per job_key and the port key + unique indexes make a double run harmless. Add the lock if jobs ever run concurrently per key.
    const { rows: [reg] } = await tx.query(
      'SELECT id, account_id, relationship, full_name, sex, birth_on, age_years, sms_consent, whatsapp_consent, consent_id, status FROM engagement.self_registrations WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    if (!reg || reg['status'] !== 'queued') { ctx.log?.info?.({ event: 'create_self_patient_noop' }); return; }
    const { rows: [account] } = await tx.query('SELECT phone_e164, phone_hmac FROM engagement.accounts WHERE tenant_id = $1 AND id = $2', [tenantId, reg['account_id']]);
    const { rows: [consent] } = await tx.query('SELECT consent_text_version FROM engagement.link_consents WHERE tenant_id = $1 AND id = $2', [tenantId, reg['consent_id']]);
    const horizon = new Date(Date.parse(now) + PURGE_DAYS * 86_400_000).toISOString();
    const fail = async (code: string) => {
      await tx.query(`UPDATE engagement.self_registrations SET status = 'failed', failure_code = $3, expires_at = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'queued'`, [tenantId, id, code, horizon]);
      ctx.log?.warn?.({ event: 'create_self_patient_failed', failure_code: code });
    };
    if (!account || !consent) return fail('common.internal'); // dangling references can never succeed

    const lastAttempt = !(typeof ctx.attempt === 'number' && typeof ctx.maxAttempts === 'number' && ctx.attempt < ctx.maxAttempts);
    await tx.query('SAVEPOINT create_self_patient'); // so the failed mark can be written after a failed statement
    try {
      const created = await ctx.ports.FrontdeskPort.createSelfRegisteredPatient(ctx, {
        fullName: reg['full_name'], sex: reg['sex'],
        ...(reg['birth_on'] == null ? {} : { birthOn: dateOnly(reg['birth_on']) }), ...(reg['age_years'] == null ? {} : { ageYears: reg['age_years'] }),
        phoneE164: account['phone_e164'],
        consents: { processing: true, sms: reg['sms_consent'], whatsapp: reg['whatsapp_consent'], email: false, shareWithReferrer: false, consentTextVersion: `app-${consent['consent_text_version']}` },
        idempotencyKey: `selfreg:${id}`,
      });
      const linkId = uuidv7();
      await tx.query(
        `INSERT INTO engagement.account_patient_links (id, tenant_id, account_id, patient_id, relationship, method, consent_id, display_name, sex_snapshot, status, visible_from, record_phone_hmac_at_link, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 'self_registered', $6, $7, $8, 'active', $9::timestamptz, $10, $11, $11)`,
        [linkId, tenantId, reg['account_id'], created.patientId, reg['relationship'], reg['consent_id'], reg['full_name'], reg['sex'], now, account['phone_hmac'], ctx.actor.id]);
      await tx.query(`UPDATE engagement.self_registrations SET status = 'created', patient_id = $3, link_id = $4, expires_at = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, id, created.patientId, linkId, horizon]);
      await tx.query('RELEASE SAVEPOINT create_self_patient');
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      const terminal = code === 'frontdesk.consent_required' || code === '23505'; // 23505: the account got a self link meanwhile — retrying cannot help
      if (!terminal && !lastAttempt) throw e; // transient: rollback + retry with the same idempotency key
      await tx.query('ROLLBACK TO SAVEPOINT create_self_patient');
      await fail(code === '23505' ? 'engagement.link_limit_reached' : failureCode(e));
    }
  };
}
