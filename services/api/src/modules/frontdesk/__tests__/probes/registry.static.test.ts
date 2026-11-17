// FD-T16 static probes (no database): the contract <-> probe coverage tie, the permission / privilege / idempotency table of 02-TRD §7.1 + contracts/permissions.yaml, and the source scans
// of 07-SECURITY §5 / §6.5 that need no runtime (copy-scan "IRD approved…" / "commission", P-2 no signedUrl, no PHI field in a log call).
// Self-contained on purpose (does not import ./kit.ts, which needs LIMS_TEST_APP_URL).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const OPS = Object.entries<any>(spec.paths).flatMap(([path, item]) => ['get', 'post', 'put', 'patch', 'delete'].filter((m) => item?.[m]?.operationId)
  .map((m) => ({ id: item[m].operationId as string, method: m, path, perm: item[m]['x-permission'] as string, idem: String(item[m]['x-idempotency'] ?? '') })));
const MOD = 'services/api/src/modules/frontdesk';
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' ? [] : walk(rel)) : [rel];
});
const SRC = walk(MOD).filter((f) => f.endsWith('.ts'));

const P = (s: string) => `frontdesk.${s}`;
const EXPECT: Record<string, [string, boolean]> = {   // operationId -> [x-permission, idempotency required]
  searchPatients: [P('patient.read'), false], createPatient: [P('registration.create'), true], listPossibleDuplicatePatients: [P('registration.create'), false],
  getPatient: [P('patient.read'), false], updatePatient: [P('registration.create'), false], recordPatientConsent: [P('registration.create'), true],
  listPatientOrders: [P('order.read'), false], anonymisePatient: [P('patient.anonymise'), true], quoteRegistration: [P('registration.create'), false],
  quoteOrderItemsChange: [P('order.edit'), false], createRegistration: [P('registration.create'), true], listOrders: [P('order.read'), false], getOrder: [P('order.read'), false],
  confirmPreRegisteredOrder: [P('registration.create'), true], changeOrderItems: [P('order.edit'), true], cancelOrder: [P('order.cancel'), true],
  requestDiscountApproval: [P('discount.apply'), true], listDiscountApprovals: [P('discount.approve'), false], getDiscountApproval: [P('discount.apply'), false],
  approveDiscount: [P('discount.approve'), true], rejectDiscount: [P('discount.approve'), true], uploadTrf: [P('trf.upload'), true], getTrfAttachment: [P('order.read'), false],
  getTrfAttachmentContent: [P('order.read'), false], listOrderFlags: [P('order.read'), false], resolveOrderFlag: [P('order.edit'), true],
  getFrontdeskSettings: [P('settings.manage'), false], updateFrontdeskSettings: [P('settings.manage'), false], listFrontdeskCodes: [P('order.read'), false],
  // T0B-REGAPI-2 (LD-310): the 18 operations added by T0C-REGPARITY-2. No new permission code (done_when 6): registration.create for the user's own data, settings.manage for masters.
  createRegistrationDraft: [P('registration.create'), true], listRegistrationDrafts: [P('registration.create'), false], getRegistrationDraft: [P('registration.create'), false],
  deleteRegistrationDraft: [P('registration.create'), false], addFavouriteTest: [P('registration.create'), true], listFavouriteTests: [P('registration.create'), false],
  removeFavouriteTest: [P('registration.create'), false], previewRegistrationNumbers: [P('registration.create'), false], listCustomFieldDefinitions: [P('registration.create'), false],
  createCustomFieldDefinition: [P('settings.manage'), true], updateCustomFieldDefinition: [P('settings.manage'), false], listCoupons: [P('settings.manage'), false],
  createCoupon: [P('settings.manage'), true], updateCoupon: [P('settings.manage'), false], listIcdCodes: [P('registration.create'), false], createIcdCode: [P('settings.manage'), true],
  updateIcdCode: [P('settings.manage'), false], getPatientRewards: [P('patient.read'), false],
};

describe('contract <-> probes', () => {
  // LD-328 (3) style: the count is derived from the loaded contract spec, never hardcoded (later T0C tasks add operations; each must then be added to EXPECT with its permission).
  it('every contract operation (the 29 of 02-TRD §7.1 + the 18 of T0C-REGPARITY-2 and any later one) has an EXPECT row, and EXPECT names no operation the contract lacks', () => {
    expect(OPS.map((o) => o.id).sort()).toEqual(Object.keys(EXPECT).sort());
    expect(OPS).toHaveLength(Object.keys(EXPECT).length);
    expect(OPS.length).toBeGreaterThanOrEqual(47);
  });
  it('LD-325 (b): the frontdesk module manifest lists none of the 18 REGAPI-2 operations as pending (they have real handlers)', () => {
    const idx = text(`${MOD}/index.ts`);
    const pending = /pendingOperations:\s*\[([^\]]*)\]/.exec(idx)?.[1] ?? '';
    for (const op of ['listRegistrationDrafts', 'createRegistrationDraft', 'getRegistrationDraft', 'deleteRegistrationDraft', 'listFavouriteTests', 'addFavouriteTest', 'removeFavouriteTest',
      'previewRegistrationNumbers', 'listCustomFieldDefinitions', 'createCustomFieldDefinition', 'updateCustomFieldDefinition', 'listCoupons', 'createCoupon', 'updateCoupon', 'listIcdCodes',
      'createIcdCode', 'updateIcdCode', 'getPatientRewards']) expect(pending, op).not.toContain(op);
  });
  it('every operation has a probe request in kit.ts (requestFor) and is exercised by the cross-tenant suite', () => {
    const kit = text(`${MOD}/__tests__/probes/kit.ts`);
    for (const o of OPS) expect(kit, o.id).toContain(`case '${o.id}'`);
  });
  it('every table of schema frontdesk is named in the table probes', () => {
    const mig = text('db/migrations/20261105001600_frontdesk__create_frontdesk_schema.sql');
    const tables = [...mig.matchAll(/CREATE TABLE frontdesk\.([a-z_]+)/g)].map((m) => m[1]!);
    const probes = text(`${MOD}/__tests__/probes/kit.ts`) + text(`${MOD}/__tests__/probes/tables.live.test.ts`);
    for (const t of [...tables, 'event_inbox']) expect(probes, t).toContain(`'${t}'`);
    expect(tables).toHaveLength(13);
  });
  it('the six tables of migration 20261117110000 are named in the table probes (LD-315)', () => {
    const probes = text(`${MOD}/__tests__/probes/kit.ts`) + text(`${MOD}/__tests__/probes/tables.live.test.ts`);
    const mig = text('db/migrations/20261117110000_frontdesk__add_registration_parity_fields.sql');
    const tables = [...mig.matchAll(/CREATE TABLE IF NOT EXISTS frontdesk\.([a-z_]+)/g)].map((m) => m[1]!).sort();
    expect(tables).toEqual(['coupons', 'custom_field_definitions', 'favourite_tests', 'icd_codes', 'registration_drafts', 'reward_points_ledger']);
    for (const t of tables) expect(probes, t).toContain(`'${t}'`);
  });
});

describe('permission + idempotency table (02-TRD §7.1, contracts/permissions.yaml)', () => {
  it.each(OPS.map((o) => [o.id, o] as const))('%s', (_id, o) => {
    const [perm, required] = EXPECT[o.id]!;
    expect(o.perm).toBe(perm);
    expect(/required/i.test(o.idem), `x-idempotency=${o.idem}`).toBe(required);
  });
  it('the privileged (aal2) frontdesk permissions are exactly approve / settings / anonymise (+ the unused merge)', () => {
    const yaml = text('contracts/permissions.yaml');
    const priv = [...yaml.matchAll(/code: (frontdesk\.[a-z_.]+),\s+privileged: (true|false)/g)].map((m) => [m[1], m[2]] as const);
    expect(priv.filter(([, p]) => p === 'true').map(([c]) => c).sort()).toEqual([P('discount.approve'), P('patient.anonymise'), P('patient.merge'), P('settings.manage')]);
  });
  it('no operation accepts a patient / portal / partner actor (every operation names a staff permission)', () => {
    for (const o of OPS) expect(o.perm, o.id).toMatch(/^frontdesk\./);
  });
});

describe('source scans of the frontdesk module (non-test code)', () => {
  it('copy-scan: no "IRD approved…" claim and no "commission" wording anywhere in C4 code or the contract (07 §6.5)', () => {
    const hits = [...SRC, 'contracts/openapi/frontdesk.yaml'].filter((f) => /ird[ -]approved|commission/i.test(text(f)));
    expect(hits).toEqual([]);
  });
  it('P-2: no handler / service / repository requests a signed Storage URL', () => {
    expect(SRC.filter((f) => /signedUrl\s*\(/.test(text(f)))).toEqual([]);
  });
  it('07 §5.1: no log call names a PHI field (name, phone, email, address, birth, filename, reason text, note)', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => {
      if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && /(full_name|phone|email|address|birth|filename|original_filename|reason_text|\bnote\b|\bquery\b|req\.body|\.body\b)/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
    expect(bad).toEqual([]);
  });
  it('07 §5.1: error responses never interpolate request values (no template literal with a PHI field inside a LimsError)', () => {
    const bad: string[] = [];
    for (const f of SRC) text(f).split('\n').forEach((l, i) => {
      if (/new LimsError\(/.test(l) && /\$\{[^}]*(full_name|phone|email|address|birth|filename|reason_text|note)/.test(l)) bad.push(`${f}:${i + 1}`);
    });
    expect(bad).toEqual([]);
  });
});
