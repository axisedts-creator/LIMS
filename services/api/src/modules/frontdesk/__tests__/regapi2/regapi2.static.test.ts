// T0B-REGAPI-2 static facts (no database): the 18 handlers exist and are registered (FIRST PRIORITY, LD-315 a), no new permission code, preview never consumes a counter,
// DELETE / UPDATE statements stay inside LD-315 (b), sensitive values are never logged, billing stores the two payment fields, the delete-policy migration exists.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';

const NEW_OPS = ['createRegistrationDraft', 'listRegistrationDrafts', 'getRegistrationDraft', 'deleteRegistrationDraft', 'addFavouriteTest', 'listFavouriteTests', 'removeFavouriteTest',
  'previewRegistrationNumbers', 'listCustomFieldDefinitions', 'createCustomFieldDefinition', 'updateCustomFieldDefinition', 'listCoupons', 'createCoupon', 'updateCoupon', 'listIcdCodes',
  'createIcdCode', 'updateIcdCode', 'getPatientRewards'] as const;
const FD = 'services/api/src/modules/frontdesk'; const BL = 'services/api/src/modules/billing';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' ? [] : walk(rel)) : [rel];
}).filter((f) => f.endsWith('.ts'));
const FD_SRC = walk(FD); const BL_SRC = walk(BL);
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));

describe('handlers (FIRST PRIORITY: the API must boot on main)', () => {
  it('the contract names the 18 new operations on top of the 29 (count derived from the spec, LD-328 (3))', () => {
    const ids = operationIds(spec);
    expect(ids.length).toBeGreaterThanOrEqual(29 + NEW_OPS.length);
    for (const op of NEW_OPS) expect(ids, op).toContain(op);
  });
  it('handlers/index.ts exports a real function for every operationId, none of the 18 new ones is the common.service_unavailable stub', async () => {
    const { handlers } = await import('../../handlers/index.js');
    expect(Object.keys(handlers).sort()).toEqual(operationIds(spec).sort());
    const ctx: any = { operationId: 'x', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } };
    for (const op of NEW_OPS) {
      expect(handlers[op as keyof typeof handlers], op).toBeTypeOf('function');
      let err: any;
      try { await (handlers as any)[op]({ params: {}, query: {}, headers: {}, body: undefined }, { ...ctx, operationId: op }); } catch (e) { err = e; }
      expect(err?.code, `${op} must fail on its own (missing context), not as the stub`).not.toBe('common.service_unavailable');
    }
  });
  it('probes/pending.json stays the empty stub inventory (no stub left)', () => {
    expect(JSON.parse(text(`${FD}/__tests__/probes/pending.json`))).toEqual([]);
  });
  it('no new permission code: every x-permission of the 18 operations is one of the ten existing frontdesk codes, and permissions.ts still holds exactly those', () => {
    const used = new Set<string>();
    for (const item of Object.values<any>(spec.paths)) for (const m of ['get', 'post', 'put', 'patch', 'delete']) if (NEW_OPS.includes(item?.[m]?.operationId)) used.add(item[m]['x-permission']);
    expect([...used].sort()).toEqual(['frontdesk.patient.read', 'frontdesk.registration.create', 'frontdesk.settings.manage']);
    const codes = new Set([...text(`${FD}/permissions.ts`).matchAll(/frontdesk\.[a-z_]+\.[a-z_]+/g)].map((m) => m[0]));
    expect([...codes].sort()).toEqual(['frontdesk.discount.apply', 'frontdesk.discount.approve', 'frontdesk.order.cancel', 'frontdesk.order.edit', 'frontdesk.order.read', 'frontdesk.patient.anonymise',
      'frontdesk.patient.read', 'frontdesk.registration.create', 'frontdesk.settings.manage', 'frontdesk.trf.upload']);
  });
});

describe('number preview consumes nothing (done_when 5)', () => {
  const previewFiles = [...FD_SRC, ...BL_SRC].filter((f) => /preview/i.test(f));
  it('a preview handler exists and no preview file takes a sequence value or writes', () => {
    expect(previewFiles.some((f) => f.endsWith('handlers/previewRegistrationNumbers.ts')), 'handlers/previewRegistrationNumbers.ts').toBe(true);
    for (const f of previewFiles) {
      const s = text(f);
      expect(s, f).not.toMatch(/nextval\s*\(/i);
      expect(s, f).not.toMatch(/nextCounterValue/);
      expect(s, f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+[a-z_.]+\s+SET|DELETE\s+FROM)\b/i);
    }
  });
  it('no module code anywhere calls nextval (counters are rows, upsert under a row lock; sequences are forbidden in the schema)', () => {
    expect([...FD_SRC, ...BL_SRC].filter((f) => /\bnextval\s*\(/i.test(text(f)))).toEqual([]);
  });
});

describe('statements on the new tables stay inside LD-315 (b)', () => {
  it('DELETE FROM frontdesk.* appears only for registration_drafts and favourite_tests; never TRUNCATE; the points ledger is never updated or deleted', () => {
    const tables = new Set<string>();
    for (const f of FD_SRC) {
      const s = text(f);
      for (const m of s.matchAll(/DELETE\s+FROM\s+frontdesk\.([a-z_]+)/gi)) tables.add(m[1]!.toLowerCase());
      expect(s, `${f}: TRUNCATE`).not.toMatch(/\bTRUNCATE\b/i);
      expect(s, `${f}: reward_points_ledger is append only`).not.toMatch(/(UPDATE|DELETE\s+FROM)\s+frontdesk\.reward_points_ledger/i);
      expect(s, `${f}: coupons / icd / custom fields are deactivated, never deleted`).not.toMatch(/DELETE\s+FROM\s+frontdesk\.(coupons|icd_codes|custom_field_definitions)\b/i);
    }
    for (const t of tables) expect(['registration_drafts', 'favourite_tests'], t).toContain(t);
  });
  it('a migration after 20261117110000 binds the DELETE policies of registration_drafts and favourite_tests to the owning membership and grants no DELETE / TRUNCATE on any other new table', () => {
    const dir = join(REPO_ROOT, 'db/migrations');
    const later = readdirSync(dir).filter((f) => f > '20261117110000' && f.endsWith('.sql')).sort();
    const sql = later.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    expect(later.length, 'a new migration (e.g. 20261117140000_frontdesk__narrow_parity_table_grants.sql) is needed').toBeGreaterThan(0);
    for (const t of ['registration_drafts', 'favourite_tests']) {
      expect(sql, t).toMatch(new RegExp(`CREATE POLICY\\s+${t}__delete__[a-z_]+\\s+ON\\s+frontdesk\\.${t}\\s+FOR DELETE[\\s\\S]{0,300}?current_membership_id`, 'i'));
    }
    for (const m of sql.matchAll(/GRANT\s+([A-Z, ]+)\s+ON\s+(?:TABLE\s+)?frontdesk\.([a-z_]+)/gi)) {
      if (/DELETE|TRUNCATE|ALL/i.test(m[1]!)) expect(['registration_drafts', 'favourite_tests'], `${m[0]}`).toContain(m[2]);
    }
    expect(sql).not.toMatch(/GRANT[^;]*TRUNCATE/i);
  });
  it('the merged migration 20261117110000 is NOT edited: its DELETE grants are exactly the two allowed tables (the narrowing, if any, is a new file)', () => {
    const mig = text('db/migrations/20261117110000_frontdesk__add_registration_parity_fields.sql');
    const deletes = [...mig.matchAll(/GRANT\s+([A-Z, ]+)\s+ON\s+frontdesk\.([a-z_]+)\s+TO/g)].filter((m) => /DELETE/.test(m[1]!)).map((m) => m[2]).sort();
    expect(deletes).toEqual(['favourite_tests', 'registration_drafts']);
  });
});

describe('sensitive values (07-SECURITY D-27a)', () => {
  const SENSITIVE = /(clinical_history|patient_history|card_holder_name|clinicalHistory|patientHistory|cardHolderName)/;
  it('no log call in frontdesk or billing code names clinical_history, patient_history or card_holder_name; no LimsError message interpolates them', () => {
    const bad: string[] = [];
    for (const f of [...FD_SRC, ...BL_SRC]) text(f).split('\n').forEach((l, i) => {
      if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && SENSITIVE.test(l)) bad.push(`${f}:${i + 1}`);
      if (/new LimsError\(/.test(l) && /\$\{[^}]*(clinical|history|card_holder|cardHolder)/.test(l)) bad.push(`${f}:${i + 1}`);
    });
    expect(bad).toEqual([]);
  });
  it('the draft payload is never logged', () => {
    const bad: string[] = [];
    for (const f of FD_SRC.filter((x) => /draft/i.test(x))) text(f).split('\n').forEach((l, i) => { if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && /payload/.test(l)) bad.push(`${f}:${i + 1}`); });
    expect(bad).toEqual([]);
  });
});

describe('billing stores and returns the two payment fields (T0C-REGPARITY-2: billing.ledger_entries.card_holder_name, payment_remark)', () => {
  it('the ledger repository writes both columns and the ledger DTO returns both', () => {
    const repo = text(`${BL}/repository/ledger.repo.ts`); const dto = text(`${BL}/service/ledgerDto.ts`);
    for (const c of ['card_holder_name', 'payment_remark']) { expect(repo, `ledger.repo.ts ${c}`).toContain(c); expect(dto, `ledgerDto.ts ${c}`).toContain(c); }
  });
  it('frontdesk forwards both fields of each PaymentInput to the billing port', () => {
    const src = FD_SRC.filter((f) => /registration|payment/i.test(f)).map(text).join('\n');
    expect(src).toMatch(/card_holder_name|cardHolderName/);
    expect(src).toMatch(/payment_remark|paymentRemark/);
  });
});
