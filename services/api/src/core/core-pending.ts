// T0C-SYNC-1 (LD-322, LD-325 b): core.yaml operations without a handler yet. They answer 501 operation_pending after auth
// (core/openapi.ts mountSpec); production boot refuses them unless LIMS_ALLOW_PENDING_OPS=1. T0B-SYNC-1 implemented and removed all 7
// offline sync ids (registerSyncDevice, listSyncDevices, revokeSyncDevice, requestSyncDeviceWipe, ackDeviceWipe, getSyncStatus,
// reserveNumberBlock; handlers in core/sync); T0B-SYNC-2 implemented and removed the 5 part 2 ids of T0C-SYNC-2 (pushSyncBatch,
// pullChanges, listSyncConflicts, getSyncConflict, resolveSyncConflict; core/sync/index.ts syncPart2Handlers); later core contract tasks add theirs here.
export const CORE_PENDING_OPERATIONS: readonly string[] = Object.freeze([]);
