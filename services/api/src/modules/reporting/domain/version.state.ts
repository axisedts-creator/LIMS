// report_versions.status machine (03-IC §10.3 + `discarded` CR-C6-005; 05-SCHEMA tg_report_versions_guard) + release check (02-TRD §4.6 rule 1).
export const VERSION_STATUSES = ['rendering', 'render_failed', 'rendered', 'released', 'superseded', 'discarded'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

const ALLOWED: Record<VersionStatus, readonly VersionStatus[]> = {
  rendering: ['rendered', 'render_failed', 'discarded'],
  render_failed: ['rendering', 'discarded'],
  rendered: ['released', 'discarded'],
  released: ['superseded'],
  superseded: [],
  discarded: [],
};

export function canTransition(from: VersionStatus, to: VersionStatus): boolean {
  return Object.hasOwn(ALLOWED, from) && ALLOWED[from].includes(to);
}

export type ReleaseCheck = { ok: true } | { ok: false; code: 'reporting.release_not_ready' | 'reporting.version_not_latest' };

/** Status first (a discarded version is not_ready even though a newer one exists, CR-C6-005), then latest (CR-C6-004). */
export function checkRelease(v: { status: VersionStatus; versionNo: number; latestVersionNo: number }): ReleaseCheck {
  if (v.status !== 'rendered') return { ok: false, code: 'reporting.release_not_ready' };
  if (v.versionNo !== v.latestVersionNo) return { ok: false, code: 'reporting.version_not_latest' };
  return { ok: true };
}

/** supersedes_version_no is the previously released version's number, decided at release (AC-02.6). */
export function supersedesVersionNo(previouslyReleasedVersionNo: number | undefined): number | undefined {
  return previouslyReleasedVersionNo;
}
