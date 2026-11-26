// PHLEBO-UI-FULL-1: openMobileSession with phone_e164 (phone + password sign-in for the phlebotomist app).
// The phone is turned into the account's email by app.identity_staff_email_for_phone (its SQL is proven on a real
// database in the migration scenario); here the lookup is a fake and the rest of the login runs as in session-kinds.login.test.ts.
import { describe, expect, it } from 'vitest';
import { createOpenMobileSession } from '../openMobileSession.js';
import { EMAIL, PASSWORD, SUB } from '../../service/__tests__/auth.helpers.js';
import { APP_INSTANCE, loginRunner, makeWorld, rejection, staffRow } from './kinds.helpers.js';

const PHONE = '+9779800000001';
const BODY = { phone_e164: PHONE, password: PASSWORD, app_instance_id: APP_INSTANCE, app_platform: 'android' };

function run(body: unknown, known: Record<string, string> = { [PHONE]: EMAIL }) {
  const w = makeWorld({ rows: { [SUB]: staffRow() } });
  const deps = { ...w.deps, now: () => new Date(w.clock.ms), repo: { ...w.deps.repo, async membershipHasPermission() { return true; } } };
  const r = loginRunner(w, undefined);
  const lookups: unknown[] = [];
  const inner = r.hctx.db.identityAuthTx;
  r.hctx.db.identityAuthTx = (input: any, fn: any) => inner(input, (tx: any, o: any) => {
    tx.query = async (sql: string, values: unknown[]) => {
      if (!sql.includes('identity_staff_email_for_phone')) throw new Error(`unexpected SQL: ${sql}`);
      lookups.push(values[0]);
      return { rows: [{ email: known[values[0] as string] ?? null }] };
    };
    return fn(tx, o);
  });
  return { w, lookups, call: () => createOpenMobileSession(deps as any)(r.req(body) as any, r.hctx) };
}

describe('openMobileSession with a phone number', () => {
  it('a known phone and the right password open a staff_mobile session; GoTrue is asked with the resolved email, never the phone', async () => {
    const t = run(BODY);
    const out: any = await t.call();
    expect(out.status).toBe(200);
    expect(out.body.session).toMatchObject({ kind: 'staff_mobile', state: 'active' });
    expect(t.lookups).toEqual([PHONE]);
    expect(t.w.deps.gotrue.signInWithPassword).toHaveBeenCalledWith(EMAIL, PASSWORD);
    expect(JSON.stringify(out.body)).not.toContain(EMAIL);
  });

  it('an unknown phone fails exactly like a wrong password (auth.login_failed), and so does a known phone with a wrong password', async () => {
    const unknown = run(BODY, {});
    expect((await rejection(unknown.call())).code).toBe('auth.login_failed');
    expect(unknown.w.deps.gotrue.signInWithPassword).toHaveBeenCalledWith(PHONE, PASSWORD);   // the phone is not a GoTrue login: refused there
    const wrong = run({ ...BODY, password: 'not-the-password' });
    expect((await rejection(wrong.call())).code).toBe('auth.login_failed');
  });

  it('input hygiene: both or neither of email and phone, a malformed phone or an injection string are refused before any lookup', async () => {
    for (const body of [
      { ...BODY, email: EMAIL }, { password: PASSWORD, app_instance_id: APP_INSTANCE, app_platform: 'android' },
      { ...BODY, phone_e164: '9800000001' }, { ...BODY, phone_e164: "+977' OR 1=1 --" }, { ...BODY, phone_e164: 9800000001 }, { ...BODY, phone_e164: '+0000000000' },
    ]) {
      const t = run(body);
      expect((await rejection(t.call())).code, JSON.stringify(body)).toBe('common.validation_failed');
      expect(t.lookups).toEqual([]);
      expect(t.w.deps.gotrue.signInWithPassword).not.toHaveBeenCalled();
    }
  });

  it('email sign-in is unchanged and makes no phone lookup', async () => {
    const t = run({ email: EMAIL, password: PASSWORD, app_instance_id: APP_INSTANCE, app_platform: 'android' });
    expect(((await t.call()) as any).status).toBe(200);
    expect(t.lookups).toEqual([]);
  });
});
