// Readiness model + fingerprint (02-TRD §4.1, §4.2; AC-02.2, AC-02.3). Pure.
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { sha256Hex } from '../../../../../../packages/shared-ts/src/crypto/index.js';

/** Debounce between a readiness change and assembly (AC-02.2). */
export const ASSEMBLY_DEBOUNCE_MS = 30_000;

const LAB_WORKFLOWS = new Set(['standard', 'attachment', 'microbiology', 'anatomic', 'molecular']);

export interface Requirements { requiresLab: boolean; requiresNarrative: boolean; requiresOutsourced: boolean }

/** §4.1 table: requirement flags from the item's test workflowTypes and its `outsourced` flag. */
export function requirementsFor(input: { workflowTypes: readonly string[]; outsourced: boolean }): Requirements {
  const { workflowTypes, outsourced } = input;
  if (outsourced || workflowTypes.includes('outsourced')) return { requiresLab: false, requiresNarrative: false, requiresOutsourced: true };
  const requiresNarrative = workflowTypes.includes('narrative');
  const requiresLab = workflowTypes.some((w) => LAB_WORKFLOWS.has(w));
  return { requiresLab, requiresNarrative, requiresOutsourced: false };
}

export interface ItemFlags extends Requirements { labReady: boolean; narrativeReady: boolean; outsourcedReady: boolean }

/** Item ready = every required flag is true. */
export function isItemReady(f: ItemFlags): boolean {
  return (!f.requiresLab || f.labReady) && (!f.requiresNarrative || f.narrativeReady) && (!f.requiresOutsourced || f.outsourcedReady);
}

/** outsourced_ready = exactly one `confirmed` input file. */
export function outsourcedReady(confirmedInputFiles: number): boolean {
  return confirmedInputFiles === 1;
}

export type Completeness = 'complete' | 'partial' | 'none';

/** Over the active items' ready flags. */
export function completeness(itemReady: readonly boolean[]): Completeness {
  const n = itemReady.filter(Boolean).length;
  if (n === 0) return 'none';
  return n === itemReady.length ? 'complete' : 'partial';
}

export interface ReadyItem { orderItemId: string; approvedSetHash?: string; narrativeVersionIds: readonly string[]; inputFileId?: string }

/** SHA-256 hex of sorted `<id>|lab:<hash>|nar:<ids sorted>|out:<file>` lines over ready items + `|demog:<counter>` (§4.2).
 *  [CONV] lines joined by "\n", narrative ids by ","; ids are UUIDs/hex hashes so neither separator can appear in a value. */
export function fingerprint(input: { items: readonly ReadyItem[]; regenerationCounter: number }): string {
  const lines = input.items
    .map((i) => `${i.orderItemId}|lab:${i.approvedSetHash ?? ''}|nar:${[...i.narrativeVersionIds].sort().join(',')}|out:${i.inputFileId ?? ''}`)
    .sort();
  return sha256Hex(`${lines.join('\n')}|demog:${input.regenerationCounter}`);
}

/** New version only when fingerprint differs from latest non-discarded version and (complete or partialReleaseAllowed). */
export function shouldAssemble(input: { fingerprint: string; latestFingerprint?: string; complete: boolean; partialReleaseAllowed: boolean }): boolean {
  return input.fingerprint !== input.latestFingerprint && (input.complete || input.partialReleaseAllowed);
}
