// Export job state machine (03-APP-FLOW §1.8; 05-SCHEMA export_jobs__status__ck). Pure.

export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

const NEXT: Readonly<Record<ExportStatus, readonly ExportStatus[]>> = {
  queued: ['running'], running: ['ready', 'failed'], ready: ['expired'], failed: [], expired: [],
};

export function canTransition(from: ExportStatus, to: ExportStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: ExportStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;
