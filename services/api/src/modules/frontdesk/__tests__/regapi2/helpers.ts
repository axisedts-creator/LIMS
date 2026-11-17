// T0B-REGAPI-2 (LD-310, LD-315) shared helpers. Handlers run through the FD-T16 kit (../probes/kit.ts: one request = one committed tx under RLS as the real `lims_api`
// login, claims carry the caller's membership_id, fake IdentityPort, real core audit/events). Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/frontdesk/T0B-REGAPI-2.pg.sh).
// Synthetic data only. PINNED PICKS used by the suites in this folder are listed in .orchestra/notes/T0B-REGAPI-2-tests.md.
import { expect } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { FULL_A, FULL_B, as, codeOf, fire, mid, ownerRows, req, superTx, tag, uid, type Outcome, type Who } from '../probes/kit.js';

export { FULL_A, FULL_B, as, codeOf, fire, mid, ownerRows, req, superTx, tag, uid };
export type { Outcome, Who };
export { CENTRE, CENTRE_A2, T, TENANT_A, TENANT_B, seed } from '../probes/kit.js';
export { schemaErrors } from '../patients/helpers.js';

/** Two distinct users of tenant A (every frontdesk permission, aal2, all centres) and one of tenant B. Row ownership = membershipId. */
export const U1: Who = as(FULL_A, { membershipId: mid('a', 701) });
export const U2: Who = as(FULL_A, { membershipId: mid('a', 702) });
export const UB: Who = as(FULL_B, { membershipId: mid('b', 701) });
/** A brand-new user of `base`'s tenant (random membership id): lists and counts of that user start empty on every run. */
export const fresh = (base: Who = FULL_A): Who => as(base, { membershipId: `01a1a98a-ac40-7000-8000-${Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}` });
export const without =(w: Who, ...perms: string[]): Who => as(w, { grants: w.grants.filter((g) => !perms.includes(g)) });
export const idem = () => ({ 'idempotency-key': uid() });
export const ifm = (v: number) => ({ 'if-match': `"${v}"` });

/** 2xx expected: returns the body, with the error text in the failure message. */
export function ok(o: Outcome, status = 200): any {
  expect(o.error, `unexpected error: ${(o.error as any)?.code} ${(o.error as any)?.message} ${JSON.stringify((o.error as any)?.errors ?? [])}`).toBeUndefined();
  expect(o.reply?.status).toBe(status);
  return o.reply!.body;
}
/** A rejection with `code` (default 400 common.validation_failed); `path` must appear in errors[]; the request value is never echoed. */
export function rejected(o: Outcome, code = 'common.validation_failed', path?: string, secret?: string): any {
  expect(o.reply, `expected ${code} but the handler answered ${o.reply?.status} ${JSON.stringify(o.reply?.body)?.slice(0, 200)}`).toBeUndefined();
  expect(o.error, 'expected a LimsError').toBeInstanceOf(LimsError);
  expect(codeOf(o), `${(o.error as any)?.message}`).toBe(code);
  if (path) expect(JSON.stringify((o.error as any).errors ?? []), `errors[] must name ${path}`).toContain(path);
  if (secret) expect(`${(o.error as any).message} ${(o.error as any).detail ?? ''} ${JSON.stringify((o.error as any).errors ?? [])}`).not.toContain(secret);
  return o.error;
}
export const notFound = (o: Outcome) => rejected(o, 'common.not_found');
export const forbidden = (o: Outcome) => rejected(o, 'auth.forbidden');
/** Writes the handler issued (INSERT / UPDATE / DELETE / TRUNCATE statements seen on ctx.tx). */
export const writesOf = (o: Outcome): string[] => o.probe.writes;

export const draftRows = (user: string, centre?: string) => ownerRows('frontdesk.registration_drafts', centre ? 'user_id = $1 AND centre_id = $2 ORDER BY created_at, id' : 'user_id = $1 ORDER BY created_at, id', centre ? [user, centre] : [user]);
export const draftBody = (centre: string, extra: Record<string, unknown> = {}, size = 0) =>
  ({ centre_id: centre, payload: JSON.stringify({ centre_id: centre, visit_type: 'opd', items: [], ...extra, ...(size ? { pad: 'x'.repeat(size) } : {}) }) });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const upper = () => tag().toUpperCase();
let n = 0;
/** unique ICD-shaped code: ^[0-9A-Z][0-9A-Z.]{0,15}$ */
export const icd = () => `T${String(Date.now() % 1e7)}${++n}`;
/** DB truth: age of a timestamptz column relative to the database clock, in seconds. */
export const dbNow = async (): Promise<Date> => superTx(async (tx) => (await tx.query('SELECT now() AS n')).rows[0].n as Date);
