// T0B-PRINTCFG-1 done_when (3) profile choice + (6) validation (LD-316, LD-319(1)). Pure tests of the NEW module reporting/domain/printProfile.ts.
// PINNED API (spec silent; a change needs a ruling):
//   validatePrintProfileInput(body: unknown): PrintProfileInput   -> snake_case contract keys with the contract defaults filled (reserve_*_mm 0, show_logo false, show_seller_pan true,
//                                                                    grayscale false, font_size_pt 10, is_active true, header_text '' footer_text ''); throws LimsError common.validation_failed
//   validateSignatoryProfileInput(body: unknown): SignatoryProfileInput  (same rules as the contract SignatoryProfileInput; is_active default true)
//   resolvePrintProfile(rows, { documentKind, branchId?, recipientType? }): row | undefined
//        rows are PrintProfile rows (snake_case: document_kind, branch_id?, recipient_type?, is_active, ...). Active rows of that document kind only. Order of preference:
//        (branch, recipient) > (branch, every recipient) > (lab default, recipient) > (lab default, every recipient)   [done_when 3: the branch row wins over the lab default].
//   assertImageAsset(meta, tenantId): meta = { tenantId, mimeType } | undefined; passes for image/png and image/jpeg of the SAME tenant, otherwise throws common.validation_failed.
import { describe, expect, it } from 'vitest';
import { assertImageAsset, resolvePrintProfile, validatePrintProfileInput, validateSignatoryProfileInput } from '../../domain/printProfile.js';

const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e) { return (e as { code?: string }).code; } return undefined; };
const bad = (fn: () => unknown) => expect(code(fn)).toBe('common.validation_failed');
const B1 = '01900000-0000-7000-8000-0000000000b1', B2 = '01900000-0000-7000-8000-0000000000b2', T1 = '01900000-0000-7000-8000-0000000000c1', T2 = '01900000-0000-7000-8000-0000000000c2';
const line = (n: number) => 'x'.repeat(n);
const ok = (over: Record<string, unknown> = {}) => ({ document_kind: 'report', paper_mode: 'typed_header_footer', ...over });

describe('validatePrintProfileInput', () => {
  it('accepts the minimal body and fills the contract defaults', () => {
    expect(validatePrintProfileInput(ok())).toMatchObject({ document_kind: 'report', paper_mode: 'typed_header_footer', header_text: '', footer_text: '', reserve_top_mm: 0, reserve_bottom_mm: 0,
      show_logo: false, show_seller_pan: true, grayscale: false, font_size_pt: 10, is_active: true });
  });
  it('accepts 8 lines of 120 characters, plain text with & and quotes and non ASCII (escaped at render, never refused)', () => {
    const eight = Array.from({ length: 8 }, () => line(120)).join('\n');
    expect(validatePrintProfileInput(ok({ header_text: eight, footer_text: eight })).header_text).toBe(eight);
    expect(validatePrintProfileInput(ok({ header_text: 'Lab & "Co" नेपाल\nTel: 01-5550000' })).header_text).toContain('&');
  });
  it.each([
    ['9 lines', { header_text: Array.from({ length: 9 }, () => 'a').join('\n') }],
    ['a line of 121 characters', { footer_text: line(121) }],
    ['markup <b>', { header_text: '<b>Lab</b>' }],
    ['a lone <', { footer_text: 'a < b' }],
    ['a lone >', { footer_text: 'a > b' }],
    ['a script tag', { header_text: '<script>alert(1)</script>' }],
    ['a control character', { header_text: 'a\u0007b' }],
    ['a carriage return', { header_text: 'a\r\nb' }],
    ['a NUL byte', { footer_text: 'a\u0000b' }],
    ['reserve_top_mm 81', { reserve_top_mm: 81 }],
    ['reserve_bottom_mm 61', { reserve_bottom_mm: 61 }],
    ['negative reserve', { reserve_top_mm: -1 }],
    ['fractional reserve', { reserve_top_mm: 10.5 }],
    ['font 7', { font_size_pt: 7 }],
    ['font 13', { font_size_pt: 13 }],
    ['an unknown paper mode', { paper_mode: 'fancy' }],
    ['an unknown document kind', { document_kind: 'receipt' }],
    ['an unknown recipient type', { recipient_type: 'cat' }],
    ['a branch id that is not a uuid', { branch_id: 'main' }],
    ['an unknown key (additionalProperties false)', { tenant_id: T1 }],
    ['a string where a boolean belongs', { grayscale: 'yes' }],
    ['header_text as a number', { header_text: 5 }],
  ])('rejects %s', (_n, over) => bad(() => validatePrintProfileInput(ok(over))));
  it.each([[null], [undefined], ['x'], [[]], [{}], [{ paper_mode: 'plain' }], [{ document_kind: 'report' }]])('rejects the body %j', (b) => bad(() => validatePrintProfileInput(b)));
  it('accepts every document kind, recipient type and paper mode of the contract', () => {
    for (const document_kind of ['report', 'invoice', 'credit_note']) for (const paper_mode of ['letterhead_image', 'typed_header_footer', 'preprinted_paper', 'plain'])
      for (const recipient_type of [undefined, 'patient', 'doctor', 'franchise', 'laboratory', 'other'])
        expect(() => validatePrintProfileInput({ document_kind, paper_mode, ...(recipient_type ? { recipient_type } : {}) })).not.toThrow();
  });
  it('does not mutate or return the same object as the input', () => {
    const body = Object.freeze(ok({ header_text: 'a' }));
    expect(() => validatePrintProfileInput(body)).not.toThrow();
  });
});

describe('validateSignatoryProfileInput', () => {
  const sig = (over: Record<string, unknown> = {}) => ({ display_name: 'Dr. Synthetic Patho', ...over });
  it('accepts a minimal and a full body', () => {
    expect(validateSignatoryProfileInput(sig())).toMatchObject({ display_name: 'Dr. Synthetic Patho', is_active: true });
    expect(() => validateSignatoryProfileInput(sig({ title: 'Consultant Pathologist', registration_no: 'NMC 12345', signature_asset_id: T1, is_active: false }))).not.toThrow();
  });
  it.each([
    ['empty display name', { display_name: '' }],
    ['display name of 121 characters', { display_name: line(121) }],
    ['markup in the display name', { display_name: '<i>Dr</i>' }],
    ['markup in the title', { title: 'a<b' }],
    ['title of 121 characters', { title: line(121) }],
    ['registration number of 61 characters', { registration_no: line(61) }],
    ['markup in the registration number', { registration_no: '<x>' }],
    ['a control character in the name', { display_name: 'Dr\u0001' }],
    ['a signature asset id that is not a uuid', { signature_asset_id: 'file.png' }],
    ['an unknown key', { user_id: T1 }],
  ])('rejects %s', (_n, over) => bad(() => validateSignatoryProfileInput(sig(over))));
  it.each([[null], [{}], ['x']])('rejects the body %j', (b) => bad(() => validateSignatoryProfileInput(b)));
});

describe('assertImageAsset: the asset must be an image of the same tenant', () => {
  it.each(['image/png', 'image/jpeg'])('accepts %s of the same tenant', (mimeType) => expect(() => assertImageAsset({ tenantId: T1, mimeType }, T1)).not.toThrow());
  it('rejects an unknown asset, an asset of another tenant, and non raster or non image types', () => {
    bad(() => assertImageAsset(undefined, T1));
    bad(() => assertImageAsset({ tenantId: T2, mimeType: 'image/png' }, T1));
    for (const mimeType of ['application/pdf', 'image/svg+xml', 'text/html', 'image/gif', '']) bad(() => assertImageAsset({ tenantId: T1, mimeType }, T1));
  });
});

describe('resolvePrintProfile: branch row wins over the lab default; recipient type is the second key', () => {
  const row = (over: Record<string, unknown>) => ({ id: `${over['paper_mode']}-${over['branch_id'] ?? 'lab'}-${over['recipient_type'] ?? 'all'}`, document_kind: 'report', is_active: true, paper_mode: 'plain', ...over });
  const lab = row({ paper_mode: 'letterhead_image' });
  const branch1 = row({ branch_id: B1, paper_mode: 'typed_header_footer' });
  const labPatient = row({ recipient_type: 'patient', paper_mode: 'preprinted_paper' });
  const branch1Doctor = row({ branch_id: B1, recipient_type: 'doctor', paper_mode: 'plain' });
  const pick = (rows: unknown[], q: Record<string, unknown>) => (resolvePrintProfile(rows as never, { documentKind: 'report', ...q } as never) as any)?.paper_mode;
  it('the branch row beats the lab default; another branch falls back to the lab default', () => {
    expect(pick([lab, branch1], { branchId: B1 })).toBe('typed_header_footer');
    expect(pick([lab, branch1], { branchId: B2 })).toBe('letterhead_image');
    expect(pick([lab, branch1], {})).toBe('letterhead_image');
  });
  it('a recipient specific row beats the every recipient row of the same branch level; other recipients fall back', () => {
    expect(pick([lab, labPatient], { recipientType: 'patient' })).toBe('preprinted_paper');
    expect(pick([lab, labPatient], { recipientType: 'doctor' })).toBe('letterhead_image');
    expect(pick([lab, labPatient], {})).toBe('letterhead_image');
  });
  it('preference order (branch, recipient) > (branch, all) > (lab, recipient) > (lab, all)', () => {
    const all = [lab, labPatient, branch1, branch1Doctor];
    expect(pick(all, { branchId: B1, recipientType: 'doctor' })).toBe('plain');
    expect(pick(all, { branchId: B1, recipientType: 'patient' })).toBe('typed_header_footer');
    expect(pick(all, { branchId: B2, recipientType: 'patient' })).toBe('preprinted_paper');
    expect(pick(all, { branchId: B2, recipientType: 'doctor' })).toBe('letterhead_image');
  });
  it('inactive rows and rows of another document kind are ignored; nothing configured -> undefined', () => {
    expect(pick([{ ...branch1, is_active: false }, lab], { branchId: B1 })).toBe('letterhead_image');
    expect(pick([row({ document_kind: 'invoice', paper_mode: 'plain' })], {})).toBeUndefined();
    expect(pick([], { branchId: B1 })).toBeUndefined();
  });
  it('the result does not depend on the order of the rows', () => {
    const all = [lab, labPatient, branch1, branch1Doctor];
    for (const rows of [all, [...all].reverse(), [all[2], all[0], all[3], all[1]]]) expect(pick(rows, { branchId: B1, recipientType: 'doctor' })).toBe('plain');
  });
});
