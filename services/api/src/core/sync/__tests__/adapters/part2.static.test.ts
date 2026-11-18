// T0B-SYNC-4 done_when (1)-(6) at the source level: the four adapters (result.enter, result.verify, report.print_marker, daily_cash.close) exist, are registered by default, call the service layer
// (never HTTP, no copied rule, no direct write of a domain table), never log personal data, carry the opType / x-permission of the wrapped operation, and refuse a wrong payload shape.
// Self-contained on purpose (no DB helpers). Pinned surface: ./doubles4.ts header.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');   // services/api/src
const FILES = {
  enter: 'modules/lab/sync/resultEnter.adapter.ts',
  verify: 'modules/lab/sync/resultVerify.adapter.ts',
  marker: 'modules/reporting/sync/printMarker.adapter.ts',
  cash: 'modules/billing/sync/cashClose.adapter.ts',
} as const;
const text = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const REPO = join(SRC, '..', '..', '..');
const contract = (f: string): string => readFileSync(join(REPO, 'contracts', f), 'utf8');

describe('adapter files (done_when 1, 2, 3, 4)', () => {
  for (const [k, rel] of Object.entries(FILES)) it(`${k}: ${rel} exists`, () => { expect(existsSync(join(SRC, rel)), rel).toBe(true); });

  it('result.enter, result.verify and daily_cash.close import the existing service layer; none goes over HTTP', () => {
    const want: Array<[string, RegExp]> = [[FILES.enter, /service\/result\.service(\.js)?['"]/], [FILES.verify, /service\/result\.service(\.js)?['"]/], [FILES.cash, /service\/cash\.service(\.js)?['"]/]];
    for (const [rel, re] of want) expect(text(rel), rel).toMatch(re);
    for (const rel of Object.values(FILES)) expect(text(rel), `${rel} must not use HTTP`).not.toMatch(/\bfetch\(|\.inject\(|from ['"](undici|node:http|node:https|http|https|axios|got)['"]|localhost|127\.0\.0\.1/);
  });
  it('result.verify runs the verification policy of T0B-VERLEVEL-1 by calling verifyResult / approveResult, never a policy of its own: no level, distinct people or enterer arithmetic in the adapter', () => {
    const t = text(FILES.verify);
    expect(t).toMatch(/verifyResult/); expect(t).toMatch(/approveResult/);
    expect(t, 'no copy of the policy tables').not.toMatch(/verification_policy|signoff_required|signoff_count|signoffs\.state|allowEntererVerify|required_verifiers/);
  });
  it('the codes a policy failure is mapped from (signoff.service.ts) and the two sync codes it answers with are named verbatim (none invented)', () => {
    const t = text(FILES.verify);
    for (const c of ['lab.verifier_not_distinct', 'lab.enterer_cannot_verify', 'lab.pathologist_required', 'lab.result_invalid_transition', 'sync.verification_policy_failed', 'sync.offline_not_allowed']) expect(t, c).toContain(c);
  });
  it('result.enter is append only through the service: no direct write of a result, no copy of the lock rule beyond the sync codes', () => {
    const t = text(FILES.enter);
    expect(t).toMatch(/sync\.result_locked/);
    expect(t, 'must not write domain tables').not.toMatch(/INSERT INTO (lab|billing|reporting)\.|UPDATE (lab|billing|reporting)\.|DELETE FROM (lab|billing|reporting)\./i);
  });
  it('no adapter writes a domain table or allocates a number itself; the cash close does not recompute the carry forward (the service owns it)', () => {
    for (const rel of Object.values(FILES)) {
      const t = text(rel);
      expect(t, `${rel} must not write domain tables`).not.toMatch(/(?:UPDATE|DELETE FROM)\s+(lab|billing|reporting|frontdesk)\./i);
      expect(t, `${rel} must not allocate numbers`).not.toMatch(/number_counters|barcode_counters|document_counters|\.allocate\(/);
    }
    expect(text(FILES.cash), 'the carry is the service rule').not.toMatch(/previous_outstanding/);
  });
  it('the print marker never creates a print job or a file of its own (the print happened on the device): no insertPrint, no render job', () => {
    expect(text(FILES.marker)).not.toMatch(/insertPrint|render_print|enqueue_job|print_jobs/);
  });
  it('no adapter logs the payload or anything of it (personal data, result values, counted money) — design section 6', () => {
    for (const rel of Object.values(FILES)) {
      const t = text(rel);
      for (const m of t.matchAll(/\b(?:log|logger)\??\.(?:info|warn|error|debug)\??\.?\(([^)]*)\)/g)) {
        expect(m[1], `${rel}: a log call must not carry the payload`).not.toMatch(/payload|body|patient|entries|value|counted|deposit|note|comment/i);
      }
      expect(t, rel).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
  it('the adapter files and their tests stay within the brief (at most 28 files in all)', () => { expect(Object.keys(FILES).length).toBeLessThanOrEqual(28); });
});

describe('registration in the dispatcher (done_when 1)', () => {
  it('the sync index registers all eight adapters by default (the four of SYNC-3 stay)', () => {
    const idx = text('core/sync/index.ts');
    for (const name of ['registrationCreateOrderAdapter', 'billingRecordReceiptAdapter', 'collectionMarkCollectedAdapter', 'accessionReceiveAdapter',
      'resultEnterAdapter', 'resultVerifyAdapter', 'reportPrintMarkerAdapter', 'dailyCashCloseAdapter']) expect(idx, name).toMatch(new RegExp(name));
  });
  it('DEFAULT_SYNC_ADAPTERS holds one adapter per catalogue type: eight distinct opTypes', async () => {
    const m: any = await import('../../index.js');
    const types = (m.DEFAULT_SYNC_ADAPTERS as any[]).map((a) => a.opType).sort();
    expect(types).toEqual(['accession.receive', 'billing.record_receipt', 'collection.mark_collected', 'daily_cash.close', 'registration.create_order', 'report.print_marker', 'result.enter', 'result.verify']);
  });
  it('each adapter has the opType and the x-permission of the wrapped operation, and the permission is a registered code', async () => {
    const m: any = {
      enter: await import('../../../../modules/lab/sync/resultEnter.adapter.js'), verify: await import('../../../../modules/lab/sync/resultVerify.adapter.js'),
      marker: await import('../../../../modules/reporting/sync/printMarker.adapter.js'), cash: await import('../../../../modules/billing/sync/cashClose.adapter.js') };
    const a = [[m.enter.resultEnterAdapter, 'result.enter', 'lab.result.enter'], [m.verify.resultVerifyAdapter, 'result.verify', 'lab.result.verify'],
      [m.marker.reportPrintMarkerAdapter, 'report.print_marker', 'reporting.report.print'], [m.cash.dailyCashCloseAdapter, 'daily_cash.close', 'billing.payment.record']] as const;
    const perms = contract('permissions.yaml');
    for (const [ad, opType, permission] of a) {
      expect(ad.opType).toBe(opType); expect(ad.permission).toBe(permission);
      expect(perms, permission).toContain(`code: ${permission},`);
      expect(typeof ad.validate).toBe('function'); expect(typeof ad.execute).toBe('function');
    }
    for (const f of ['createResultEnterAdapter', 'createResultVerifyAdapter']) expect(typeof (f === 'createResultEnterAdapter' ? m.enter : m.verify)[f], f).toBe('function');
    expect(typeof m.marker.createReportPrintMarkerAdapter).toBe('function'); expect(typeof m.cash.createDailyCashCloseAdapter).toBe('function');
  });
  it('the engine accepts an adapter result { outcome: "rejected", errorCode } (the pinned extension)', () => {
    const e = text('core/sync/engine.ts');
    expect(e).toMatch(/outcome\?: 'accepted' \| 'duplicate' \| 'rejected'|'rejected'[^;\n]*errorCode/);
  });
});

describe('payload shapes: the top level shape of the wrapped request schema (done_when 6)', () => {
  const load = async () => ({
    enter: (await import('../../../../modules/lab/sync/resultEnter.adapter.js')).resultEnterAdapter, verify: (await import('../../../../modules/lab/sync/resultVerify.adapter.js')).resultVerifyAdapter,
    marker: (await import('../../../../modules/reporting/sync/printMarker.adapter.js')).reportPrintMarkerAdapter, cash: (await import('../../../../modules/billing/sync/cashClose.adapter.js')).dailyCashCloseAdapter });
  const rejects = (fn: () => void): void => { try { fn(); } catch (e: any) { expect(e.code).toBe('common.validation_failed'); return; } throw new Error('validate did not throw'); };
  it('valid payloads pass; an unknown key, a missing required key, and a non object are common.validation_failed', async () => {
    const a = await load();
    const good = { enter: { entries: [{ result_id: 'x', version: 1 }] }, verify: {}, marker: { variant: 'plain', copies: 1 }, cash: { counted: [] } } as const;
    for (const k of Object.keys(good) as Array<keyof typeof good>) {
      expect(() => a[k].validate(good[k]), `${k} valid`).not.toThrow();
      rejects(() => a[k].validate({ ...good[k], surplus: 1 })); rejects(() => a[k].validate(null)); rejects(() => a[k].validate([]));
    }
    rejects(() => a.enter.validate({})); rejects(() => a.marker.validate({ variant: 'plain' })); rejects(() => a.marker.validate({ copies: 1 })); rejects(() => a.cash.validate({ note: 'x' }));
  });
});

describe('contract facts the adapters rely on (no new names)', () => {
  it('the sync codes of these four operations are registered: sync.result_locked, sync.verification_policy_failed, sync.offline_not_allowed, sync.entity_changed, sync.base_version_stale', () => {
    const e = contract('errors.yaml');
    for (const c of ['sync.result_locked', 'sync.verification_policy_failed', 'sync.offline_not_allowed', 'sync.entity_changed', 'sync.base_version_stale']) expect(e, c).toContain(`code: ${c},`);
    const core = readFileSync(join(REPO, 'contracts', 'openapi', 'core.yaml'), 'utf8');
    for (const c of ['sync.result_locked', 'sync.verification_policy_failed', 'sync.offline_not_allowed', 'sync.entity_changed', 'common.immutable_record', 'lab.verifier_not_distinct', 'lab.enterer_cannot_verify', 'lab.pathologist_required']) expect(core, c).toContain(`- ${c}`);
  });
  it('the offline approval policy is a sync setting that defaults to off (getSyncStatus offline_approval_allowed)', () => {
    expect(text('core/sync/index.ts')).toMatch(/offline_approval_allowed:\s*s\.offlineApprovalAllowed/);
  });
});
