// C3 T-02 — versioning state machine (03-APP-FLOW §2.1 V1–V6; 02-TRD §5.2 error columns). AC-03.2, AC-03.3, AC-03.4, AC-13.4.
import { LimsError } from '../../../core/errors.js';

export const VERSION_STATUSES = ['draft', 'published', 'superseded', 'retired', 'discarded'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export type VersionKind = 'analyte_version' | 'reference_range_set' | 'critical_limit_set' | 'price_list_version';
export type VersionTransitionId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6';

const ABSENT = '∅';
/** `from>to` -> id. V6 (retire) only for range / critical-limit sets. */
const TABLE: ReadonlyMap<string, VersionTransitionId> = new Map([
  [`${ABSENT}>draft`, 'V1'],
  ['draft>draft', 'V2'],
  ['draft>discarded', 'V3'],
  ['draft>published', 'V4'],
  ['published>superseded', 'V5'],
]);
const RETIRABLE: ReadonlySet<string> = new Set<VersionKind>(['reference_range_set', 'critical_limit_set']);

function lookup(from: VersionStatus | null, to: VersionStatus, kind: VersionKind): VersionTransitionId | undefined {
  const id = TABLE.get(`${from ?? ABSENT}>${to}`);
  if (id) return id;
  return from === 'published' && to === 'retired' && RETIRABLE.has(kind) ? 'V6' : undefined;
}

export function isVersionTransitionAllowed(from: VersionStatus | null, to: VersionStatus, kind: VersionKind): boolean {
  return lookup(from, to, kind) !== undefined;
}

/** [CONV] every pair outside §2.1 -> 409 catalog.version_in_use (02-TRD §5.2 uses it for wrong-state publish/retire/discard/edit). */
export function versionTransition(from: VersionStatus | null, to: VersionStatus, kind: VersionKind): VersionTransitionId {
  const id = lookup(from, to, kind);
  if (!id) throw new LimsError('catalog.version_in_use');
  return id;
}

/** Content edits (V2) only on drafts; published rows are immutable (AC-03.2, AC-13.4). Fails closed on unknown status. */
export function assertVersionEditable(status: VersionStatus): void {
  if (status !== 'draft') throw new LimsError('catalog.version_in_use');
}

/** V1 guard: one open draft per parent (AC-03.4). */
export function assertCanCreateDraft(siblingStatuses: readonly VersionStatus[]): void {
  if (siblingStatuses.includes('draft')) throw new LimsError('common.version_conflict');
}

export interface EffectiveWindowInput {
  effectiveFrom: Date;
  now: Date;
  toleranceSeconds?: number;
  path?: string;
  siblings?: readonly { status: VersionStatus; effectiveFrom: Date; effectiveTo?: Date | null }[];
}

const CLOSED_OR_LIVE: ReadonlySet<string> = new Set<VersionStatus>(['published', 'superseded', 'retired']);

/** V4/V6 window rules: no back-dating beyond tolerance (AC-03.3), strictly after live/closed siblings, no overlap with retired windows. */
export function assertEffectiveWindow(o: EffectiveWindowInput): void {
  const { now, toleranceSeconds = 300, path = '/effective_from', siblings = [] } = o;
  const from = o.effectiveFrom.getTime();
  const fail = (): never => {
    throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
  };
  if (Number.isNaN(from) || Number.isNaN(now.getTime())) fail();
  if (from < now.getTime() - toleranceSeconds * 1000) fail();
  for (const s of siblings) {
    if (!CLOSED_OR_LIVE.has(s.status)) continue;
    if (!(from > s.effectiveFrom.getTime())) fail(); // also fails closed on an invalid sibling date
    if (s.status === 'retired' && s.effectiveTo && !(from >= s.effectiveTo.getTime())) fail();
  }
}
