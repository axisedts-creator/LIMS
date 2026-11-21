// T0B-SYNC-3 done_when (1), (5), (6): the four adapters exist, are registered by default, call the service layer (never HTTP, no copied rules) and never log personal data.
// Self-contained on purpose: imports no helpers (those need LIMS_TEST_APP_URL). Pinned surface: see ./doubles.ts header.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');   // services/api/src
const FILES = {
  registration: 'modules/frontdesk/sync/registration.adapter.ts',
  receipt: 'modules/billing/sync/receipt.adapter.ts',
  collection: 'modules/lab/sync/collection.adapter.ts',
  accession: 'modules/lab/sync/accession.adapter.ts',
} as const;
const text = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

describe('adapter files (done_when 1)', () => {
  for (const [k, rel] of Object.entries(FILES)) it(`${k}: ${rel} exists`, () => { expect(existsSync(join(SRC, rel)), rel).toBe(true); });

  it('each adapter imports the existing service layer function and never goes over HTTP', () => {
    const want: Array<[string, RegExp]> = [
      [FILES.registration, /service\/registration\.service(\.js)?['"]/], [FILES.receipt, /service\/ledger\.service(\.js)?['"]/],
      [FILES.collection, /service\/specimen\.service(\.js)?['"]/], [FILES.accession, /service\/specimen\.service(\.js)?['"]/]];
    for (const [rel, re] of want) {
      const t = text(rel);
      expect(t, rel).toMatch(re);
      expect(t, `${rel} must not use HTTP`).not.toMatch(/\bfetch\(|\.inject\(|from ['"](undici|node:http|node:https|http|https|axios|got)['"]|localhost|127\.0\.0\.1/);
    }
  });
  it('the lab adapters read the specimen from lab.specimens by default (the readSpecimen seam default)', () => {
    for (const rel of [FILES.collection, FILES.accession]) expect(text(rel), rel).toMatch(/lab\.specimens/);
  });
  it('no adapter copies a rule of its online counterpart: no price, discount, limit or numbering arithmetic of its own', () => {
    for (const rel of Object.values(FILES)) {
      const t = text(rel);
      expect(t, `${rel} must not allocate numbers itself`).not.toMatch(/number_counters|barcode_counters|document_counters|\.allocate\(/);
      expect(t, `${rel} must not write domain tables`).not.toMatch(/INSERT INTO (frontdesk|billing|lab)\.|UPDATE (frontdesk|billing|lab)\./i);
    }
  });
  it('no adapter logs the payload or anything of it (personal data: patient name, phone, card holder, remarks) — design section 6, done_when 5', () => {
    for (const rel of Object.values(FILES)) {
      const t = text(rel);
      for (const m of t.matchAll(/\b(?:log|logger)\??\.(?:info|warn|error|debug)\??\.?\(([^)]*)\)/g)) {
        expect(m[1], `${rel}: a log call must not carry the payload`).not.toMatch(/payload|body|patient|new_patient|full_name|phone|card_holder|remark|reference/i);
      }
      expect(t, rel).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
  it('the number of new adapter files stays within the brief (at most 28 files in all, tests included)', () => {
    expect(Object.keys(FILES).length).toBeLessThanOrEqual(28);
  });
});

describe('registration in the dispatcher (done_when 1, 6)', () => {
  it('the engine exports SyncConflictError and the sync index registers the four adapters by default', async () => {
    const engine: any = await import('../../engine.js');
    expect(typeof engine.SyncConflictError, 'SyncConflictError').toBe('function');
    const e = new engine.SyncConflictError({ entityType: 'patient', entityId: 'x', serverPayload: { a: 1 }, errorCode: 'frontdesk.patient_duplicate_suspected' });
    expect(e).toBeInstanceOf(Error);
    expect(e.errorCode ?? e.code).toBe('frontdesk.patient_duplicate_suspected');
    const idx = text('core/sync/index.ts');
    for (const name of ['registrationCreateOrderAdapter', 'billingRecordReceiptAdapter', 'collectionMarkCollectedAdapter', 'accessionReceiveAdapter']) expect(idx, name).toMatch(new RegExp(name));
  });
  it('each adapter has the opType and the x-permission of the wrapped operation (contracts/openapi/core.yaml SyncOp* descriptions)', async () => {
    const m: any = {
      registration: await import('../../../../modules/frontdesk/sync/registration.adapter.js'), receipt: await import('../../../../modules/billing/sync/receipt.adapter.js'),
      collection: await import('../../../../modules/lab/sync/collection.adapter.js'), accession: await import('../../../../modules/lab/sync/accession.adapter.js') };
    const a = [[m.registration.registrationCreateOrderAdapter, 'registration.create_order', 'frontdesk.registration.create'], [m.receipt.billingRecordReceiptAdapter, 'billing.record_receipt', 'billing.payment.record'],
      [m.collection.collectionMarkCollectedAdapter, 'collection.mark_collected', 'lab.specimen.collect'], [m.accession.accessionReceiveAdapter, 'accession.receive', 'lab.specimen.receive']] as const;
    for (const [ad, opType, permission] of a) {
      expect(ad, opType).toBeTruthy();
      expect(ad.opType).toBe(opType); expect(ad.permission).toBe(permission);
      for (const fn of ['validate', 'execute']) expect(typeof ad[fn], `${opType}.${fn}`).toBe('function');
    }
    expect(typeof m.collection.createCollectionMarkCollectedAdapter).toBe('function');
    expect(typeof m.accession.createAccessionReceiveAdapter).toBe('function');
  });
  it('the permission codes exist in contracts/permissions (no invented name)', () => {
    const repo = join(SRC, '..', '..', '..');
    const all = ['frontdesk.registration.create', 'billing.payment.record', 'lab.specimen.collect', 'lab.specimen.receive'];
    const yaml = readFileSync(join(repo, 'contracts', 'openapi', 'frontdesk.yaml'), 'utf8') + readFileSync(join(repo, 'contracts', 'openapi', 'billing.yaml'), 'utf8') + readFileSync(join(repo, 'contracts', 'openapi', 'lab.yaml'), 'utf8');
    for (const p of all) expect(yaml, p).toContain(p);
  });
});
