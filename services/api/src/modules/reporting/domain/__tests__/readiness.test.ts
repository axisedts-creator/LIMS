// C6-T02 readiness.ts (02-TRD §4.1, §4.2; AC-02.2, AC-02.3). Pure.
// Assumed API: requirementsFor, isItemReady, outsourcedReady, completeness, fingerprint, shouldAssemble, ASSEMBLY_DEBOUNCE_MS.
import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_DEBOUNCE_MS,
  completeness,
  fingerprint,
  isItemReady,
  outsourcedReady,
  requirementsFor,
  shouldAssemble,
} from '../readiness.js';

describe('requirementsFor (§4.1 table)', () => {
  it.each(['standard', 'attachment', 'microbiology', 'anatomic', 'molecular'])('%s, not outsourced -> lab only', (w) => {
    expect(requirementsFor({ workflowTypes: [w], outsourced: false })).toEqual({ requiresLab: true, requiresNarrative: false, requiresOutsourced: false });
  });
  it('all narrative -> narrative only', () => {
    expect(requirementsFor({ workflowTypes: ['narrative', 'narrative'], outsourced: false })).toEqual({ requiresLab: false, requiresNarrative: true, requiresOutsourced: false });
  });
  it('item outsourced flag -> outsourced only', () => {
    expect(requirementsFor({ workflowTypes: ['standard'], outsourced: true })).toEqual({ requiresLab: false, requiresNarrative: false, requiresOutsourced: true });
  });
  it('any test workflowType outsourced -> outsourced only', () => {
    expect(requirementsFor({ workflowTypes: ['outsourced'], outsourced: false })).toEqual({ requiresLab: false, requiresNarrative: false, requiresOutsourced: true });
  });
  it('mixed narrative + standard -> lab and narrative', () => {
    expect(requirementsFor({ workflowTypes: ['standard', 'narrative'], outsourced: false })).toEqual({ requiresLab: true, requiresNarrative: true, requiresOutsourced: false });
  });
});

const flags = (requiresLab: boolean, requiresNarrative: boolean, requiresOutsourced: boolean, labReady: boolean, narrativeReady: boolean, outsourcedReady_: boolean) => ({
  requiresLab, requiresNarrative, requiresOutsourced, labReady, narrativeReady, outsourcedReady: outsourcedReady_,
});

describe('isItemReady / outsourcedReady (§4.2)', () => {
  it('ready = every REQUIRED flag true; unrequired flags are ignored', () => {
    expect(isItemReady(flags(true, false, false, true, false, false))).toBe(true);
    expect(isItemReady(flags(false, true, false, false, true, false))).toBe(true);
    expect(isItemReady(flags(false, false, true, false, false, true))).toBe(true);
    expect(isItemReady(flags(true, true, false, true, true, false))).toBe(true);
  });
  it('one required flag false -> not ready', () => {
    expect(isItemReady(flags(true, false, false, false, true, true))).toBe(false);
    expect(isItemReady(flags(true, true, false, true, false, false))).toBe(false);
    expect(isItemReady(flags(false, false, true, true, true, false))).toBe(false);
  });
  it('outsourced_ready = exactly one confirmed input file', () => {
    expect(outsourcedReady(0)).toBe(false);
    expect(outsourcedReady(1)).toBe(true);
    expect(outsourcedReady(2)).toBe(false);
  });
});

describe('completeness (§4.2)', () => {
  it('all ready -> complete; some -> partial; none -> none', () => {
    expect(completeness([true, true])).toBe('complete');
    expect(completeness([true, false])).toBe('partial');
    expect(completeness([false, false])).toBe('none');
  });
  it('single ready item is complete', () => {
    expect(completeness([true])).toBe('complete');
  });
});

const item = (id: string, over: Partial<{ approvedSetHash: string; narrativeVersionIds: string[]; inputFileId: string }> = {}) => ({
  orderItemId: id, approvedSetHash: 'h1', narrativeVersionIds: [] as string[], ...over,
});

describe('fingerprint (AC-02.2, AC-02.3)', () => {
  const a = item('item-a');
  const b = item('item-b', { narrativeVersionIds: ['n2', 'n1'], inputFileId: 'f1' });
  it('is 64 lowercase hex chars (SHA-256)', () => {
    expect(fingerprint({ items: [a, b], regenerationCounter: 0 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is deterministic: same readiness (three events) -> same fingerprint', () => {
    const f = [1, 2, 3].map(() => fingerprint({ items: [a, b], regenerationCounter: 0 }));
    expect(new Set(f).size).toBe(1);
  });
  it('is independent of item order and of narrative id order', () => {
    const b2 = item('item-b', { narrativeVersionIds: ['n1', 'n2'], inputFileId: 'f1' });
    expect(fingerprint({ items: [b2, a], regenerationCounter: 0 })).toBe(fingerprint({ items: [a, b], regenerationCounter: 0 }));
  });
  it.each([
    ['approved_set_hash', { items: [item('item-a', { approvedSetHash: 'h2' }), b], regenerationCounter: 0 }],
    ['narrative version', { items: [a, item('item-b', { narrativeVersionIds: ['n1', 'n3'], inputFileId: 'f1' })], regenerationCounter: 0 }],
    ['input file', { items: [a, item('item-b', { narrativeVersionIds: ['n2', 'n1'], inputFileId: 'f2' })], regenerationCounter: 0 }],
    ['regeneration counter (demog)', { items: [a, b], regenerationCounter: 1 }],
    ['extra ready item', { items: [a, b, item('item-c')], regenerationCounter: 0 }],
    ['fewer ready items', { items: [a], regenerationCounter: 0 }],
  ])('changes when %s changes', (_n, changed) => {
    expect(fingerprint(changed)).not.toBe(fingerprint({ items: [a, b], regenerationCounter: 0 }));
  });
  it('does not collide when a value shifts between fields', () => {
    const x = fingerprint({ items: [item('i1', { approvedSetHash: 'ab', inputFileId: 'c' })], regenerationCounter: 0 });
    const y = fingerprint({ items: [item('i1', { approvedSetHash: 'a', inputFileId: 'bc' })], regenerationCounter: 0 });
    expect(x).not.toBe(y);
  });
});

describe('shouldAssemble (§4.2, AC-02.3, AC-02.5)', () => {
  const base = { fingerprint: 'f2', latestFingerprint: 'f1', complete: true, partialReleaseAllowed: false };
  it('debounce window is 30 s (AC-02.2)', () => {
    expect(ASSEMBLY_DEBOUNCE_MS).toBe(30_000);
  });
  it('differs + complete -> assemble', () => {
    expect(shouldAssemble(base)).toBe(true);
  });
  it('first version (no latest) + complete -> assemble', () => {
    expect(shouldAssemble({ ...base, latestFingerprint: undefined })).toBe(true);
  });
  it('same fingerprint as latest non-discarded version -> no new version (AC-02.3)', () => {
    expect(shouldAssemble({ ...base, fingerprint: 'f1' })).toBe(false);
    expect(shouldAssemble({ ...base, fingerprint: 'f1', partialReleaseAllowed: true })).toBe(false);
  });
  it('incomplete + partialReleaseAllowed=false -> no version', () => {
    expect(shouldAssemble({ ...base, complete: false })).toBe(false);
  });
  it('incomplete + partialReleaseAllowed=true -> assemble (AC-02.4)', () => {
    expect(shouldAssemble({ ...base, complete: false, partialReleaseAllowed: true })).toBe(true);
  });
});
