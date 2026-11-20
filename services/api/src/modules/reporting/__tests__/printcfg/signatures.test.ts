// T0B-PRINTCFG-1 done_when (2) SIGNATURES ON REPORTS (LD-316, founder 2026-11-17 08:39 NPT, T0B-VERLEVEL-1 chain).
// Pure builder test: buildReportDocument (domain/document.ts) with the sign-off chain snapshots of lab.result_signoff.
// PINNED CHOICES (brief + contract silent; a change needs a ruling, see .orchestra/notes/T0B-PRINTCFG-1-tests.md):
//   * BuildDocumentInput gets an optional `signoffs: readonly SignoffSnapshot[]` = the lab.result_signoff rows (camelCase) of the printed result versions, flat:
//       { resultId, resultVersion, seq, action:'verify'|'approve', signerUserId, signerDisplayName, signerTitle?, signerRoleCode, signerIsPathologist,
//         signerRegistrationNo?, signerSignatureAssetId?, signerSignatureSha256?, signedAt }
//     (signerTitle = the signatory profile title, the contract says it is not snapshotted; everything else is the row snapshot).
//   * `signoffs` ABSENT = legacy behaviour (document.test.ts keeps passing); `signoffs` PRESENT (even []) = pathologist-only rule, the approvals/nominated path is not used.
//   * printed signatory = Signatory { membershipId: signerUserId, displayName, displayTitle?, registrationNo?, signatureAssetRef?{source:'signature',id,sha256}, role:'approver' }.
//   * order = signedAt ascending, then seq; one entry per signerUserId (first sign-off); at most config.maxSignatories.
import { describe, expect, it } from 'vitest';
import { buildReportDocument } from '../../domain/document.js';
import { deepFreeze, id, makeInput } from '../../domain/__tests__/document.fixtures.js';

const R1 = id(0x1001), R2 = id(0x1002);
const U = { tech: id(0xa1), senior: id(0xa2), patho1: id(0xa3), patho2: id(0xa4), patho3: id(0xa5) };
const NAME = { tech: 'Tina Technologist (SYNTHETIC)', senior: 'Sena Senior-Tech (SYNTHETIC)', patho1: 'Dr. Paula Patho One (SYNTHETIC)', patho2: 'Dr. Pavan Patho Two (SYNTHETIC)', patho3: 'Dr. Pia Patho Three (SYNTHETIC)' };
const at = (m: number) => `2026-11-05T04:${String(m).padStart(2, '0')}:00.000Z`;
const so = (who: keyof typeof U, seq: number, action: 'verify' | 'approve', over: Record<string, unknown> = {}, resultId = R1) => ({
  resultId, resultVersion: 1, seq, action, signerUserId: U[who], signerDisplayName: NAME[who],
  signerRoleCode: who === 'tech' ? 'lab_technologist' : who === 'senior' ? 'lab_senior_technologist' : 'pathologist',
  signerIsPathologist: who.startsWith('patho'), signedAt: at(10 + seq), ...over,
});
const patho = (who: 'patho1' | 'patho2' | 'patho3', seq: number, action: 'verify' | 'approve' = 'approve', over: Record<string, unknown> = {}) =>
  so(who, seq, action, { signerTitle: 'Consultant Pathologist', signerRegistrationNo: `NMC-${who}`, signerSignatureAssetId: id(0x500 + seq), signerSignatureSha256: 'b'.repeat(64), ...over });
const build = (signoffs: unknown[], cfg: Record<string, unknown> = {}) => buildReportDocument(makeInput({ signoffs, config: { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: [], ...cfg } }));

describe('pathologist only signatures, levels 1, 2, 3 (done_when 2)', () => {
  it('level 1: one pathologist sign-off prints one signature with name, title, registration number and signature image', () => {
    const d = build([patho('patho1', 1)]);
    expect(d.signatories).toHaveLength(1);
    expect(d.signatories[0]).toMatchObject({ displayName: NAME.patho1, displayTitle: 'Consultant Pathologist', registrationNo: 'NMC-patho1',
      signatureAssetRef: { source: 'signature', id: id(0x501), sha256: 'b'.repeat(64) } });
  });
  it('level 2: technologist verifies, pathologist approves -> only the pathologist prints; the technologist name is nowhere in the document', () => {
    const d = build([so('tech', 1, 'verify'), patho('patho1', 2)]);
    expect(d.signatories.map((s) => s.displayName)).toEqual([NAME.patho1]);
    expect(JSON.stringify(d)).not.toContain(NAME.tech);
  });
  it('level 3: technologist, senior technologist, pathologist -> only the pathologist prints; neither technologist name is in the document', () => {
    const d = build([so('tech', 1, 'verify'), so('senior', 2, 'verify'), patho('patho1', 3)]);
    expect(d.signatories.map((s) => s.displayName)).toEqual([NAME.patho1]);
    const json = JSON.stringify(d);
    expect(json).not.toContain(NAME.tech); expect(json).not.toContain(NAME.senior);
  });
  it('level 3 with two pathologists + a technologist: both pathologists print, in sign-off order, not the technologist', () => {
    const d = build([so('tech', 1, 'verify'), patho('patho1', 2, 'verify'), patho('patho2', 3)]);
    expect(d.signatories.map((s) => s.displayName)).toEqual([NAME.patho1, NAME.patho2]);
  });
  it('NO pathologist sign-off -> no signatories at all (no placeholder entry), whatever the chain length', () => {
    for (const chain of [[], [so('tech', 1, 'verify')], [so('tech', 1, 'verify'), so('senior', 2, 'verify')]]) {
      const d = build(chain);
      expect(d.signatories).toEqual([]);
      expect(JSON.stringify(d.signatories)).toBe('[]');
    }
  });
  it('a technologist sign-off flagged signer_is_pathologist=false is never printed even when the role code looks senior', () => {
    expect(build([so('senior', 1, 'approve')]).signatories).toEqual([]);
  });
});

describe('order, limit, dedupe', () => {
  it('sign-off order: input order is irrelevant, signedAt then seq decides', () => {
    const d = build([patho('patho2', 3), patho('patho1', 2, 'verify')], { maxSignatories: 4 });
    expect(d.signatories.map((s) => s.displayName)).toEqual([NAME.patho1, NAME.patho2]);
  });
  it('at most the template signatories.max (maxSignatories), the earliest sign-offs win', () => {
    const chain = [patho('patho1', 1, 'verify'), patho('patho2', 2, 'verify'), patho('patho3', 3)];
    expect(build(chain, { maxSignatories: 1 }).signatories.map((s) => s.displayName)).toEqual([NAME.patho1]);
    expect(build(chain, { maxSignatories: 2 }).signatories.map((s) => s.displayName)).toEqual([NAME.patho1, NAME.patho2]);
    expect(build(chain, { maxSignatories: 3 }).signatories).toHaveLength(3);
  });
  it('one pathologist who signed several printed results prints once', () => {
    const d = build([patho('patho1', 1), { ...patho('patho1', 1), resultId: R2 }], { maxSignatories: 4 });
    expect(d.signatories).toHaveLength(1);
  });
  it('a technologist who signed one result and a pathologist who signed another: only the pathologist prints', () => {
    const d = build([so('tech', 1, 'verify', {}, R1), patho('patho1', 1), { ...so('tech', 1, 'verify'), resultId: R2 }]);
    expect(d.signatories.map((s) => s.displayName)).toEqual([NAME.patho1]);
  });
});

describe('snapshots, optional fields, purity', () => {
  it('data comes from the sign-off snapshot: a later edit of the signatory profile (IdentityPort signatories list) never changes the printed name / registration', () => {
    const editedProfiles = [{ membershipId: U.patho1, displayName: 'RENAMED LATER', displayTitle: 'Other', registrationNo: 'NMC-CHANGED', isActive: true }];
    const d = buildReportDocument(makeInput({ signoffs: [patho('patho1', 1)], signatories: editedProfiles, config: { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: [] } }));
    expect(d.signatories[0]).toMatchObject({ displayName: NAME.patho1, registrationNo: 'NMC-patho1' });
    expect(JSON.stringify(d)).not.toContain('RENAMED LATER');
  });
  it('no signature image reference without a snapshot asset; no title / registration keys when absent', () => {
    const d = build([so('patho1', 1, 'approve')]);
    expect(d.signatories).toHaveLength(1);
    expect('signatureAssetRef' in d.signatories[0]!).toBe(false);
    expect('displayTitle' in d.signatories[0]!).toBe(false);
    expect('registrationNo' in d.signatories[0]!).toBe(false);
  });
  it('the builder does not mutate its (frozen) input', () => {
    const input = deepFreeze(makeInput({ signoffs: [so('tech', 1, 'verify'), patho('patho1', 2)], config: { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: [] } }));
    expect(() => buildReportDocument(input)).not.toThrow();
  });
  it('signoffs absent keeps the legacy approver path (nothing else in this task may change existing reports)', () => {
    const d = buildReportDocument(makeInput());
    expect(d.signatories.length).toBeGreaterThan(0);
  });
});
