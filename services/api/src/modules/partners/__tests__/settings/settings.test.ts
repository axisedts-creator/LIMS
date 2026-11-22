// T0D-BUILD-2 (LD-447, CR DEPLOY-AXIS-012 item 8): getPartnerSettings (GET /v1/partners/admin/settings, partners.partner.read) and updatePartnerSettings (PUT, partners.partner.manage,
// If-Match). Real PG17 over a tx with RLS on (kit of T0B-PARTYSET-1). Synthetic data only. Needs LIMS_TEST_APP_URL + LIMS_TEST_SUPER_URL (tests/partners/T0D-BUILD-2.pg.sh).
// PINS (see .orchestra/notes/T0D-BUILD-2-tests.md):
//  - no partners.settings row = the table defaults (05-SCHEMA §3.8), answered 200, ETag "1", NOTHING written (never 404/500);
//  - ETag = `"<partners.settings.version>"`; PUT is a full replace of the 10 contract fields; If-Match is required (absent -> common.precondition_required,
//    malformed -> common.validation_failed, stale -> common.version_conflict); a save always moves the version up, so an ETag read before is stale after;
//  - a limit breach is common.validation_failed OR partners.setting_out_of_range (the contract lists both) with the JSON pointer of the field in errors[] and NO write;
//  - the handler asserts its x-permission FIRST (before any SQL); audit is the row trigger of partners.settings (audit.audit_log, actor = caller, changed columns).
import { beforeEach, describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { ADMIN_A, ADMIN_B, NOBODY_A, P, SYS_ACTOR, T, TENANT_A, TENANT_B, codeOf, dbRows, fire, ifm, ok, only, req, superTx, type Outcome } from '../partyset/helpers.js';

const URL_PATH = '/v1/partners/admin/settings';
const KEYS = ['access_slip_enabled', 'consent_statement', 'consent_text_version', 'default_conversion_mode', 'draft_ttl_days', 'include_default_price_list', 'max_lines_per_manifest',
  'pickup_max_days_ahead', 'report_download_daily_cap_per_user', 'require_mapped_referrer'];
/** 05-SCHEMA §3.8 / table defaults: what a tenant without a row answers */
const DEFAULTS = { default_conversion_mode: 'on_receipt', include_default_price_list: true, require_mapped_referrer: false, access_slip_enabled: false, max_lines_per_manifest: 200, draft_ttl_days: 30,
  pickup_max_days_ahead: 7, report_download_daily_cap_per_user: 500, consent_text_version: 'partner-v1',
  consent_statement: 'The patient has agreed that the lab may process their sample and contact them about the result.' };
const VALID = { default_conversion_mode: 'on_submit', include_default_price_list: false, require_mapped_referrer: true, access_slip_enabled: true, max_lines_per_manifest: 120, draft_ttl_days: 45,
  pickup_max_days_ahead: 10, report_download_daily_cap_per_user: 800, consent_text_version: 'v2', consent_statement: 'Synthetic consent statement, version two.' };

const get = (who = ADMIN_A) => fire('getPartnerSettings', req(), who);
const put = (body: unknown, headers: object = ifm(1), who = ADMIN_A) => fire('updatePartnerSettings', req({ headers, body }), who);
const rowOf = async (tenant: string) => (await superTx(async (tx) => (await tx.query('SELECT * FROM partners.settings WHERE tenant_id = $1', [tenant])).rows, tenant))[0];
const seed = (tenant: string, o: Record<string, unknown> = {}) => superTx(async (tx) => {
  const r: Record<string, unknown> = { tenant_id: tenant, created_by: SYS_ACTOR, updated_by: SYS_ACTOR, ...o };
  const cols = Object.keys(r);
  return (await tx.query(`INSERT INTO partners.settings (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((c) => r[c]))).rows[0];
}, tenant);
const wipeSettings = async () => { for (const t of [TENANT_A, TENANT_B]) await superTx(async (tx) => { await tx.query('DELETE FROM partners.settings WHERE tenant_id = $1', [t]); }, t); };
const auditOf = (tenant: string) => dbRows('audit.audit_log', "tenant_id = $1 AND schema_name = 'partners' AND table_name = 'settings' ORDER BY occurred_at, id", [tenant]);
const etagOf = (o: Outcome): string | undefined => { const h = o.reply?.headers ?? {}; const k = Object.keys(h).find((x) => x.toLowerCase() === 'etag'); return k ? h[k] : undefined; };
/** the answer must be a refusal with one of `codes` (a handler throw), carrying a field path when `path` is given; nothing written */
function refused(o: Outcome, codes: readonly string[], path?: string): LimsError {
  expect(o.reply, `expected one of ${codes.join('|')} but got ${o.reply?.status} ${JSON.stringify(o.reply?.body)?.slice(0, 200)}`).toBeUndefined();
  expect(o.error, 'expected a LimsError').toBeInstanceOf(LimsError);
  expect(codes, `${(o.error as any)?.message}`).toContain(codeOf(o));
  const paths = ((o.error as any).errors ?? []).map((e: { path?: string }) => e.path);
  // '*' = any field path (kit convention, partners/__tests__/sales/helpers.ts); errors[].path is a JSON Pointer (02-CONVENTIONS.md:415, :427)
  if (path === '*') expect(paths.some((p: unknown) => typeof p === 'string' && p.startsWith('/')), 'errors[] must carry a JSON Pointer path').toBe(true);
  else if (path) expect(paths, `errors[] must name ${path}`).toContain(path);
  expect(o.probe.writes, 'a refused request writes nothing').toEqual([]);
  return o.error as LimsError;
}
const RANGE = ['common.validation_failed', 'partners.setting_out_of_range'] as const;

beforeEach(wipeSettings, T);

describe('getPartnerSettings', () => {
  it('a tenant with no stored settings answers 200 with the table defaults, ETag "1", exactly the 10 contract fields, and writes nothing', async () => {
    const o = await get();
    const b = ok(o);
    expect(b).toEqual(DEFAULTS);
    expect(Object.keys(b).sort()).toEqual(KEYS);
    expect(etagOf(o)).toBe('"1"');
    expect(o.probe.writes).toEqual([]);
    expect(await rowOf(TENANT_A)).toBeUndefined();
  }, T);
  it('a stored row is answered field by field; ETag is its version; no tenant_id / version / audit column leaks', async () => {
    await seed(TENANT_A, { ...VALID, version: 3 });
    const o = await get();
    const b = ok(o);
    expect(b).toEqual(VALID);
    expect(Object.keys(b).sort()).toEqual(KEYS);
    expect(etagOf(o)).toBe('"3"');
  }, T);
  it('tenant isolation: tenant B never sees the settings of tenant A (it gets the defaults, ETag "1"), and each tenant sees its own row', async () => {
    await seed(TENANT_A, { ...VALID, version: 3 });
    const b = await get(ADMIN_B);
    expect(ok(b)).toEqual(DEFAULTS);
    expect(etagOf(b)).toBe('"1"');
    await seed(TENANT_B, { max_lines_per_manifest: 7, version: 5 });
    expect(ok(await get(ADMIN_B))).toMatchObject({ max_lines_per_manifest: 7 });
    expect(ok(await get())).toMatchObject({ max_lines_per_manifest: 120 });
  }, T);
  it('needs partners.partner.read, asserted BEFORE any SQL; manage alone or no grant is auth.forbidden', async () => {
    await seed(TENANT_A, { ...VALID });
    for (const who of [only(1, P.partnerManage), only(2, P.settingRead), NOBODY_A]) {
      const o = await get(who);
      expect(o.reply, 'no 2xx without partners.partner.read').toBeUndefined();
      expect(codeOf(o)).toBe('auth.forbidden');
      expect(o.probe.sql, 'the permission check comes before any query').toEqual([]);
      expect(JSON.stringify(o.error)).not.toContain(VALID.consent_statement);
    }
    const allowed = await get(only(3, P.partnerRead));
    expect(ok(allowed)).toEqual(VALID);
    expect(allowed.probe.identity[0]).toBe('partners.partner.read');
  }, T);
  it('a read leaves the row and the audit trail untouched', async () => {
    await seed(TENANT_A, { ...VALID, version: 2 });
    const before = (await auditOf(TENANT_A)).length;
    const o = await get();
    ok(o);
    expect(o.probe.writes).toEqual([]);
    expect((await auditOf(TENANT_A)).length).toBe(before);
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 2, ...VALID });
  }, T);
});

describe('updatePartnerSettings: save, version, If-Match', () => {
  it('first save on a tenant with no row (If-Match "1", the ETag the GET gave): 200 echoes the 10 fields, ETag moves past "1", one row is stored with the caller as updated_by', async () => {
    const o = await put(VALID, ifm(1));
    const b = ok(o);
    expect(b).toEqual(VALID);
    expect(Object.keys(b).sort()).toEqual(KEYS);
    const r = await rowOf(TENANT_A);
    expect(r).toMatchObject({ ...VALID, tenant_id: TENANT_A, updated_by: ADMIN_A.userId });
    expect(r.version).toBeGreaterThan(1);
    expect(etagOf(o)).toBe(`"${r.version}"`);
    expect(ok(await get())).toEqual(VALID);
  }, T);
  it('a save of a stored row with the current If-Match answers 200, bumps the version by one, and the next GET carries the new ETag', async () => {
    await seed(TENANT_A, { version: 3 });
    const o = await put(VALID, ifm(3));
    expect(ok(o)).toEqual(VALID);
    expect(etagOf(o)).toBe('"4"');
    expect(await rowOf(TENANT_A)).toMatchObject({ ...VALID, version: 4, updated_by: ADMIN_A.userId });
    const g = await get();
    expect(etagOf(g)).toBe('"4"');
  }, T);
  it('a stale If-Match is common.version_conflict and changes nothing; the stale ETag stays stale after a good save', async () => {
    await seed(TENANT_A, { max_lines_per_manifest: 11, version: 3 });
    refused(await put(VALID, ifm(2)), ['common.version_conflict']);
    refused(await put(VALID, ifm(4)), ['common.version_conflict']);
    expect(await rowOf(TENANT_A)).toMatchObject({ max_lines_per_manifest: 11, version: 3 });
    ok(await put(VALID, ifm(3)));
    refused(await put({ ...VALID, draft_ttl_days: 2 }, ifm(3)), ['common.version_conflict']);
    expect(await rowOf(TENANT_A)).toMatchObject({ draft_ttl_days: 45, version: 4 });
  }, T);
  it('If-Match is required: absent is common.precondition_required, malformed is common.validation_failed; nothing is written', async () => {
    await seed(TENANT_A, { version: 1 });
    refused(await put(VALID, {}), ['common.precondition_required']);
    for (const bad of ['abc', '"x"', '*', '""', '"-1"', '"1.5"', '"99999999999"']) refused(await put(VALID, { 'if-match': bad }), ['common.validation_failed', 'common.precondition_required']);
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 1, ...DEFAULTS });
  }, T);
  it('two concurrent saves with the same If-Match: exactly one wins (200), the other is common.version_conflict, the version moved by one', async () => {
    await seed(TENANT_A, { version: 1 });
    const outs = await Promise.all([1, 2, 3, 4].map((n) => put({ ...VALID, max_lines_per_manifest: 10 * n }, ifm(1))));
    expect(outs.filter((x) => x.reply?.status === 200)).toHaveLength(1);
    for (const x of outs.filter((y) => y.reply?.status !== 200)) refused(x, ['common.version_conflict']);
    expect((await rowOf(TENANT_A)).version).toBe(2);
  }, T);
  it('the limits themselves are valid: every minimum, every maximum, both modes, both ends of the text lengths', async () => {
    const lo = { ...VALID, default_conversion_mode: 'on_receipt', max_lines_per_manifest: 1, draft_ttl_days: 1, pickup_max_days_ahead: 1, report_download_daily_cap_per_user: 50, consent_text_version: 'v', consent_statement: 'x' };
    const hi = { ...VALID, default_conversion_mode: 'on_submit', max_lines_per_manifest: 200, draft_ttl_days: 90, pickup_max_days_ahead: 30, report_download_daily_cap_per_user: 5000, consent_text_version: 'v'.repeat(32), consent_statement: 'y'.repeat(2000) };
    const a = await put(lo, ifm(1));
    expect(ok(a)).toEqual(lo);
    const v = (await rowOf(TENANT_A)).version;
    expect(ok(await put(hi, ifm(v)))).toEqual(hi);
  }, T);
  it('text with quotes, SQL and non-ASCII is stored verbatim (no injection, no mangling)', async () => {
    const txt = `Patient's consent'); DROP TABLE partners.settings; -- नमस्ते "quoted" \\ back`;
    expect(ok(await put({ ...VALID, consent_statement: txt }, ifm(1)))).toMatchObject({ consent_statement: txt });
    expect((await rowOf(TENANT_A)).consent_statement).toBe(txt);
  }, T);
});

describe('updatePartnerSettings: permission, tenant, audit', () => {
  it('needs partners.partner.manage, asserted BEFORE any SQL; read alone or no grant is auth.forbidden and nothing is written', async () => {
    await seed(TENANT_A, { version: 1 });
    for (const who of [only(1, P.partnerRead), only(2, P.settingManage), NOBODY_A]) {
      const o = await put(VALID, ifm(1), who);
      expect(codeOf(o)).toBe('auth.forbidden');
      expect(o.probe.sql, 'the permission check comes before any query').toEqual([]);
    }
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 1, ...DEFAULTS });
    const good = await put(VALID, ifm(1), only(3, P.partnerManage));
    ok(good);
    expect(good.probe.identity[0]).toBe('partners.partner.manage');
  }, T);
  it('the permission is checked before the body: a caller without manage gets auth.forbidden even for an invalid body or a missing If-Match', async () => {
    expect(codeOf(await put({ nonsense: 1 }, {}, only(1, P.partnerRead)))).toBe('auth.forbidden');
  }, T);
  it('tenant isolation: a save by tenant B writes only tenant B, a stale ETag of A cannot be replayed against B, and A is unchanged', async () => {
    await seed(TENANT_A, { max_lines_per_manifest: 11, version: 3 });
    ok(await put({ ...VALID, max_lines_per_manifest: 77 }, ifm(1), ADMIN_B));
    expect(await rowOf(TENANT_A)).toMatchObject({ max_lines_per_manifest: 11, version: 3 });
    expect(await rowOf(TENANT_B)).toMatchObject({ max_lines_per_manifest: 77 });
    refused(await put(VALID, ifm(3), ADMIN_B), ['common.version_conflict']);
    expect(await rowOf(TENANT_A)).toMatchObject({ max_lines_per_manifest: 11, version: 3 });
  }, T);
  it('a body that names tenant_id / version / created_by cannot move another tenant or the version (mass assignment is refused, nothing written)', async () => {
    await seed(TENANT_A, { version: 1 });
    for (const extra of [{ tenant_id: TENANT_B }, { version: 99 }, { created_by: ADMIN_B.userId }, { updated_by: ADMIN_B.userId }, { id: ADMIN_B.userId }]) refused(await put({ ...VALID, ...extra }, ifm(1)), RANGE, '*');
    expect(await rowOf(TENANT_B)).toBeUndefined();
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 1, ...DEFAULTS });
  }, T);
  it('audit: a save writes one UPDATE row in audit.audit_log for the tenant (actor = caller, the changed columns named, not the other tenant); a refused save writes none', async () => {
    await seed(TENANT_A, { version: 1 });
    const before = (await auditOf(TENANT_A)).length;
    const beforeB = (await auditOf(TENANT_B)).length;
    refused(await put({ ...VALID, draft_ttl_days: 0 }, ifm(1)), RANGE, '/draft_ttl_days');
    expect((await auditOf(TENANT_A)).length).toBe(before);
    ok(await put({ ...DEFAULTS, draft_ttl_days: 31 }, ifm(1)));
    const rows = await auditOf(TENANT_A);
    expect(rows.length).toBe(before + 1);
    const last = rows[rows.length - 1];
    // actor_id = kit appTx claims (sub = SYS_ACTOR, frontdesk helpers.ts:55); caller attribution is pinned by updated_by at :108/:118;
    // trigger sub->actor_id is a C0 schema test (05-SCHEMA.md:387, §10 test 20). Claims are built by the core only (02-TRD.md:601, REQ-SEC-013).
    expect(last).toMatchObject({ action: 'UPDATE', actor_id: SYS_ACTOR, tenant_id: TENANT_A });
    expect(last.changed_columns).toContain('draft_ttl_days');
    expect((await auditOf(TENANT_B)).length).toBe(beforeB);
  }, T);
  it('the logs of a save carry no consent text (free text of the tenant is not logged)', async () => {
    const o = await put({ ...VALID, consent_statement: 'PLANTED-CONSENT-7f3a' }, ifm(1));
    ok(o);
    expect(o.probe.logs.join('\n')).not.toContain('PLANTED-CONSENT-7f3a');
  }, T);
});

describe('updatePartnerSettings: validation (full replace, every field to the schema limits, JSON pointer of the field, no write)', () => {
  const bad: Array<[string, unknown]> = [
    ['default_conversion_mode', 'on_close'], ['default_conversion_mode', 'ON_RECEIPT'], ['default_conversion_mode', ''], ['default_conversion_mode', null], ['default_conversion_mode', 1],
    ['include_default_price_list', 'true'], ['include_default_price_list', 1], ['include_default_price_list', null],
    ['require_mapped_referrer', 'yes'], ['require_mapped_referrer', 0], ['access_slip_enabled', 'on'], ['access_slip_enabled', null],
    ['max_lines_per_manifest', 0], ['max_lines_per_manifest', 201], ['max_lines_per_manifest', 1.5], ['max_lines_per_manifest', '10'], ['max_lines_per_manifest', null], ['max_lines_per_manifest', Number.NaN], ['max_lines_per_manifest', -1],
    ['draft_ttl_days', 0], ['draft_ttl_days', 91], ['draft_ttl_days', 2.5], ['draft_ttl_days', '30'], ['draft_ttl_days', null],
    ['pickup_max_days_ahead', 0], ['pickup_max_days_ahead', 31], ['pickup_max_days_ahead', 0.5], ['pickup_max_days_ahead', true],
    ['report_download_daily_cap_per_user', 49], ['report_download_daily_cap_per_user', 5001], ['report_download_daily_cap_per_user', 100.1], ['report_download_daily_cap_per_user', '500'], ['report_download_daily_cap_per_user', 0],
    ['consent_text_version', ''], ['consent_text_version', 'v'.repeat(33)], ['consent_text_version', 5], ['consent_text_version', null],
    ['consent_statement', ''], ['consent_statement', 'y'.repeat(2001)], ['consent_statement', 5], ['consent_statement', null],
  ];
  it.each(bad)('%s = %j is refused with /%s and nothing is written', async (field, value) => {
    await seed(TENANT_A, { version: 1 });
    refused(await put({ ...VALID, [field]: value }, ifm(1)), RANGE, `/${field}`);
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 1, ...DEFAULTS });
  }, T);
  it('a missing required field is refused with its path (PUT replaces the whole object, no partial save)', async () => {
    await seed(TENANT_A, { version: 1 });
    for (const k of KEYS) { const { [k]: _gone, ...rest } = VALID as Record<string, unknown>; refused(await put(rest, ifm(1)), RANGE, `/${k}`); }
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 1, ...DEFAULTS });
  }, T);
  it('an unknown field, a non-object body, an empty body and an array body are refused with a field path', async () => {
    await seed(TENANT_A, { version: 1 });
    refused(await put({ ...VALID, foo: 1 }, ifm(1)), RANGE, '*');
    for (const b of [null, undefined, [], 'text', 5, {}]) refused(await put(b, ifm(1)), RANGE);
    expect(await rowOf(TENANT_A)).toMatchObject({ version: 1, ...DEFAULTS });
  }, T);
  it('every bad field is reported in one answer', async () => {
    await seed(TENANT_A, { version: 1 });
    const e: any = refused(await put({ ...VALID, draft_ttl_days: 0, max_lines_per_manifest: 500, default_conversion_mode: 'x' }, ifm(1)), RANGE);
    expect((e.errors ?? []).map((x: { path?: string }) => x.path).sort()).toEqual(['/default_conversion_mode', '/draft_ttl_days', '/max_lines_per_manifest']);
  }, T);
  it('the error answer never echoes the consent text or the planted value (no PHI / free text reflection)', async () => {
    await seed(TENANT_A, { version: 1 });
    const o = await put({ ...VALID, consent_statement: 'PLANTED-CONSENT-9c2d'.repeat(200), draft_ttl_days: 0 }, ifm(1));
    refused(o, RANGE);
    expect(`${(o.error as any).message} ${(o.error as any).detail ?? ''} ${JSON.stringify((o.error as any).errors ?? [])}`).not.toContain('PLANTED-CONSENT-9c2d');
  }, T);
});

describe('contract wiring', () => {
  it('both operations are bound to a real handler (not the 501 pending handler, not the common.internal stub) and the path is the contract path', async () => {
    const { manifest } = await import('../../index.js');
    const h = manifest.handlers as Record<string, unknown>;
    expect(typeof h['getPartnerSettings']).toBe('function');
    expect(typeof h['updatePartnerSettings']).toBe('function');
    expect(manifest.pendingOperations ?? []).not.toContain('getPartnerSettings');
    expect(manifest.pendingOperations ?? []).not.toContain('updatePartnerSettings');
    expect(URL_PATH).toBe('/v1/partners/admin/settings');
    // a handler that is still the T01 stub or the FIX-2 pending answer cannot return the defaults of a new tenant
    expect(ok(await get())).toEqual(DEFAULTS);
  }, T);
});
