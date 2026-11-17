// BL-T14 cbms/ folder: CbmsClient.ts (interface, TRD §9) + RecordingStubCbmsClient.ts (default; "returns stub_recorded; persists nothing itself").
// PRD US-BL-13.1; 02-TRD §9, §11.1 (LIMS_BILLING_CBMS_MODE=stub|live, live refused at boot), 07-SECURITY REQ-SEC-136 (non-prod: CBMS stub), §"CBMS credentials" (never in DB/logs).
// Fails now: ../RecordingStubCbmsClient.js does not exist. ASSUMED: `export class RecordingStubCbmsClient` (no-arg constructor) in cbms/RecordingStubCbmsClient.ts; CbmsClient.ts is types only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RecordingStubCbmsClient } from '../RecordingStubCbmsClient.js';

const DIR = join(import.meta.dirname, '..');
const KINDS = ['invoice', 'credit_note', 'invoice_cancellation'] as const;
const document = (kind: (typeof KINDS)[number]) => ({
  kind, documentId: '01a1a98a-ac40-7000-8000-000000e00001', documentNo: '083/84-000001', fiscalYearBs: '2083/84', issuedAtUtc: '2026-11-08T05:00:00.000Z', dateBs: '2083-07-22',
  sellerPan: '999999999', buyerName: 'Synthetic Buyer One', buyerPan: '123456789', totals: { gross: 100000, discount: 0, exempt: 0, taxable: 100000, vat: 13000, otherTax: 0, net: 113000 },
});
const T = '0190a000-0000-7000-8000-00000000aaaa';

describe('RecordingStubCbmsClient', () => {
  it("mode 'stub'", () => expect(new RecordingStubCbmsClient().mode).toBe('stub'));
  for (const kind of KINDS) {
    it(`${kind}: submit -> { outcome: 'stub_recorded' } and never 'accepted' (the stub cannot make a document look synced)`, async () => {
      const r = await new RecordingStubCbmsClient().submit({ tenantId: T, document: document(kind) as never, idempotencyKey: `${kind}:x` });
      expect(r.outcome).toBe('stub_recorded');
      expect(r.externalRef ?? null).toBeNull(); // an external reference would suggest the tax authority saw it
    });
  }
  it('same answer on every call, input untouched, no state kept between calls', async () => {
    const c = new RecordingStubCbmsClient(); const input = { tenantId: T, document: document('invoice') as never, idempotencyKey: 'invoice:x' }; const copy = structuredClone(input);
    const a = await c.submit(input), b = await c.submit(input);
    expect(a).toEqual(b); expect(input).toEqual(copy);
  });
  it('rawStatusRedacted, if any, carries no buyer name / PAN / document number', async () => {
    const r = await new RecordingStubCbmsClient().submit({ tenantId: T, document: document('invoice') as never, idempotencyKey: 'invoice:x' });
    expect(JSON.stringify(r)).not.toMatch(/Synthetic Buyer|123456789|999999999|083\/84/);
  });
});

describe('cbms/ source rules (TRD §9: "persists nothing itself", "No CBMS endpoint, field name or auth scheme appears anywhere else")', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
  const code = (f: string) => readFileSync(join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('the folder has CbmsClient.ts and RecordingStubCbmsClient.ts and NO LiveCbmsClient (blocked B6)', () => {
    expect(files).toEqual(expect.arrayContaining(['CbmsClient.ts', 'RecordingStubCbmsClient.ts']));
    expect(files.some((f) => /live/i.test(f))).toBe(false);
  });
  it('no network, no db, no fs, no env, no console in the stub or the interface file', () => {
    for (const f of ['CbmsClient.ts', 'RecordingStubCbmsClient.ts']) {
      const c = code(f);
      expect(c, f).not.toMatch(/\bfetch\s*\(|node:(http|https|net|tls|fs|child_process)|from ['"](http|https|net|pg|undici|axios)['"]|process\.env|console\.|\.query\s*\(/);
    }
  });
  it('CbmsClient.ts declares the TRD §9 contract: the three document kinds, the four outcomes, mode stub|live, submit()', () => {
    const c = code('CbmsClient.ts');
    for (const w of ['invoice', 'credit_note', 'invoice_cancellation', 'accepted', 'rejected_permanent', 'retryable_error', 'stub_recorded', "'stub'", "'live'", 'submit', 'idempotencyKey']) expect(c, w).toContain(w);
  });
});
