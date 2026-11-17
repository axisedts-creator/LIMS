// T0C-SYNC-1 (LD-322, LD-325 b): core.yaml offline sync operations without a handler yet. They answer 501 operation_pending
// after auth (core/openapi.ts mountSpec); production boot refuses them unless LIMS_ALLOW_PENDING_OPS=1. T0B-SYNC-1 removes the ids it implements.
export const CORE_PENDING_OPERATIONS: readonly string[] = Object.freeze([
  'registerSyncDevice',
  'listSyncDevices',
  'revokeSyncDevice',
  'requestDeviceWipe',
  'ackDeviceWipe',
  'getSyncStatus',
  'reserveNumberBlock',
]);
