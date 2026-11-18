// T0B-SYNC-1 (LD-322, LD-325 b): handlers of the 7 core offline sync operations of T0C-SYNC-1 (contracts/openapi/core.yaml).
// bootstrap.ts merges syncHandlers over the health handlers; CORE_PENDING_OPERATIONS is empty since this task.
// Limits come from SyncSettings (design section 7: at most 50 operations and 1 MB per batch, backoff with full jitter capped at 5 minutes;
// offline approval default off, LD-322 decision 3). [CONV] defaults below until a tenant settings source exists (open point, T0B-SYNC-2+).
import type { Handler, HandlerContext } from '../module.js';
import { reserveBlock } from './blocks.service.js';
import { ackWipe, deviceStatus, listDevices, registerDevice, requestWipe, revokeDevice, type SyncCtx } from './devices.service.js';

export interface SyncSettings {
  maxBatchOperations: number; maxBatchBytes: number; maxBlockSize: number; minAppVersion?: string | undefined;
  offlineApprovalAllowed: boolean; retryBaseDelayMs: number; retryMaxDelayMs: number;
}
export const DEFAULT_SYNC_SETTINGS: Readonly<SyncSettings> = Object.freeze({
  maxBatchOperations: 50, maxBatchBytes: 1_048_576, maxBlockSize: 1000, offlineApprovalAllowed: false, retryBaseDelayMs: 1000, retryMaxDelayMs: 300_000,
});

const c = (ctx: HandlerContext): SyncCtx => ctx as unknown as SyncCtx;

export function createSyncHandlers(deps: { settings?: Partial<SyncSettings> } = {}): Record<string, Handler> {
  const s: SyncSettings = { ...DEFAULT_SYNC_SETTINGS, ...deps.settings };
  return {
    registerSyncDevice: async (req, ctx) => ({ status: 200, body: await registerDevice(c(ctx), req.body) }),
    listSyncDevices: async (req, ctx) => ({ status: 200, body: await listDevices(c(ctx), req.query) }),
    revokeSyncDevice: async (req, ctx) => ({ status: 200, body: await revokeDevice(c(ctx), req.params) }),
    requestSyncDeviceWipe: async (req, ctx) => ({ status: 200, body: await requestWipe(c(ctx), req.params) }),
    ackDeviceWipe: async (req, ctx) => ({ status: 200, body: await ackWipe(c(ctx), req.params) }),
    getSyncStatus: async (req, ctx) => {
      const { now, row } = await deviceStatus(c(ctx), req.query, req.headers);
      return {
        status: 200,
        body: {
          server_time: now, device_status: row.status,
          ...(s.minAppVersion !== undefined ? { min_app_version: s.minAppVersion } : {}),
          limits: { max_batch_operations: s.maxBatchOperations, max_batch_bytes: s.maxBatchBytes },
          retry: { base_delay_ms: s.retryBaseDelayMs, max_delay_ms: s.retryMaxDelayMs, jitter: 'full' },
          offline_approval_allowed: s.offlineApprovalAllowed,
        },
      };
    },
    reserveNumberBlock: async (req, ctx) => ({ status: 201, body: await reserveBlock(c(ctx), req.body, s.maxBlockSize) }),
  };
}

export const syncHandlers = createSyncHandlers();
