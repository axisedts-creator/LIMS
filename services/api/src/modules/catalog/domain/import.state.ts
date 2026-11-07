// C3 T-02 — import state machine (03-APP-FLOW §2.2; 02-TRD §5.2 #102/#103, §10 final-attempt mapping; 05-SCHEMA imports.status).
import { LimsError } from '../../../core/errors.js';

export const IMPORT_STATUSES = [
  'uploaded', 'scanning', 'quarantined', 'validating', 'invalid', 'validated',
  'committing', 'committed', 'commit_failed', 'discarded', 'expired', 'failed',
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

const ABSENT = '∅';
const ALLOWED: ReadonlySet<string> = new Set([
  `${ABSENT}>uploaded`,
  'uploaded>scanning', 'scanning>quarantined', 'scanning>validating',
  'validating>invalid', 'validating>validated',
  'validated>committing', 'committing>committed', 'committing>commit_failed',
  'validated>discarded', 'invalid>discarded', 'validated>expired', 'invalid>expired',
  'uploaded>failed', 'scanning>failed', 'validating>failed',
]);
const TERMINAL: ReadonlySet<string> = new Set<ImportStatus>(['committed', 'commit_failed', 'invalid', 'quarantined', 'discarded', 'expired', 'failed']);

export function isImportTransitionAllowed(from: ImportStatus | null, to: ImportStatus): boolean {
  return ALLOWED.has(`${from ?? ABSENT}>${to}`);
}

/** [CONV] any pair outside §2.2 -> 409 catalog.import_not_committable (only 409 import code in the registry). */
export function importTransition(from: ImportStatus | null, to: ImportStatus): void {
  if (!isImportTransitionAllowed(from, to)) throw new LimsError('catalog.import_not_committable');
}

export function isTerminalImportStatus(s: ImportStatus): boolean {
  return TERMINAL.has(s);
}

/** Worker final-attempt mapping: scan unavailable fails closed to quarantined; commit errors -> commit_failed; else failed. */
export function finalFailureStatus(current: ImportStatus, lastErrorCode?: string): 'quarantined' | 'commit_failed' | 'failed' {
  switch (current) {
    case 'scanning': return lastErrorCode === 'scan_unavailable' ? 'quarantined' : 'failed';
    case 'committing': return 'commit_failed';
    case 'uploaded':
    case 'validating': return 'failed';
    default: throw new LimsError('catalog.import_not_committable');
  }
}

/** commitImport guard (#102): validated and not expired (cron expires on expires_at < now). Invalid dates fail closed. */
export function assertCommittable(o: { status: ImportStatus; expiresAt: Date }, now: Date): void {
  if (o.status !== 'validated' || !(o.expiresAt.getTime() >= now.getTime())) throw new LimsError('catalog.import_not_committable');
}
