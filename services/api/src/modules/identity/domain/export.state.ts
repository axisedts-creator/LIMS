// Audit export state table (03-APP-FLOW §2.7; identity.audit_exports.status). Pure.
export const STATES = ['queued', 'building', 'ready', 'failed', 'expired'] as const;
export type AuditExportStatus = (typeof STATES)[number];

const EDGES: Readonly<Record<AuditExportStatus, readonly AuditExportStatus[]>> = {
  queued: ['building', 'failed'], // failed = validation at build time
  building: ['ready', 'failed'],
  ready: ['expired'], // downloads_remaining 0 or TTL
  failed: [],
  expired: [],
};

export function canTransition(from: AuditExportStatus, to: AuditExportStatus): boolean {
  return Object.hasOwn(EDGES, from) && EDGES[from].includes(to);
}
