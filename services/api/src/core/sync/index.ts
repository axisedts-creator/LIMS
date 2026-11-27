// T0B-SYNC-1 (LD-322, LD-325 b): handlers of the 7 core offline sync operations of T0C-SYNC-1 (contracts/openapi/core.yaml).
// bootstrap.ts merges syncHandlers over the health handlers; CORE_PENDING_OPERATIONS is empty since this task.
// Limits come from SyncSettings (design section 7: at most 50 operations and 1 MB per batch, backoff with full jitter capped at 5 minutes;
// offline approval default off, LD-322 decision 3). [CONV] defaults below until a tenant settings source exists (open point, T0B-SYNC-2+).
import type { Handler, HandlerContext } from '../module.js';
import { reserveBlock } from './blocks.service.js';
import { ackWipe, deviceStatus, listDevices, registerDevice, requestWipe, revokeDevice, type SyncCtx } from './devices.service.js';
import { getConflict, listConflicts, resolveConflict } from './conflicts.service.js';
import { createPushEngine, type PushSettings, type SyncAdapter } from './engine.js';
import { pullChanges } from './pull.service.js';
import { registrationCreateOrderAdapter } from '../../modules/frontdesk/sync/registration.adapter.js';
import { billingRecordReceiptAdapter } from '../../modules/billing/sync/receipt.adapter.js';
import { collectionMarkCollectedAdapter } from '../../modules/lab/sync/collection.adapter.js';
import { accessionReceiveAdapter } from '../../modules/lab/sync/accession.adapter.js';
import { readResultState, resultEnterAdapter } from '../../modules/lab/sync/resultEnter.adapter.js';
import { resultVerifyAdapter } from '../../modules/lab/sync/resultVerify.adapter.js';
import { createReportPrintMarkerAdapter } from '../../modules/reporting/sync/printMarker.adapter.js';
import { dailyCashCloseAdapter } from '../../modules/billing/sync/cashClose.adapter.js';

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

// ---------- T0B-SYNC-2 (LD-322, LD-325 b): part 2 = pushSyncBatch, pullChanges, listSyncConflicts, getSyncConflict, resolveSyncConflict ----------
export type { SyncAdapter } from './engine.js';
export type Part2Settings = Omit<PushSettings, 'maxBatchOperations' | 'maxBatchBytes'>;
export const DEFAULT_PART2_SETTINGS: Readonly<Part2Settings> = Object.freeze({
  skewFlagMs: 300_000, skewRejectMs: 86_400_000, deviceBatchesPerMinute: 30, tenantBatchesPerMinute: 1200,
});

// Composition root: the print marker reads result states through the lab reader, wired here so reporting does not import lab (02-CONVENTIONS §1.3).
const reportPrintMarkerAdapter = createReportPrintMarkerAdapter({ readResult: readResultState });

/** T0B-SYNC-3 + T0B-SYNC-4: the default registry = one adapter per catalogue type (eight). */
export const DEFAULT_SYNC_ADAPTERS: readonly SyncAdapter[] = [registrationCreateOrderAdapter, billingRecordReceiptAdapter, collectionMarkCollectedAdapter, accessionReceiveAdapter,
  resultEnterAdapter, resultVerifyAdapter, reportPrintMarkerAdapter, dailyCashCloseAdapter];

/** `adapters` install the dispatcher registry over the defaults (one per opType, a later entry replaces an earlier one). */
export function createSyncPart2Handlers(deps: { settings?: Partial<SyncSettings & Part2Settings>; adapters?: readonly SyncAdapter[] } = {}): Record<string, Handler> {
  const s = { ...DEFAULT_SYNC_SETTINGS, ...DEFAULT_PART2_SETTINGS, ...deps.settings };
  const registry = new Map([...DEFAULT_SYNC_ADAPTERS, ...(deps.adapters ?? [])].map((a) => [a.opType, a] as const));
  const push = createPushEngine(s, registry);
  return {
    pushSyncBatch: async (req, ctx) => ({ status: 200, body: await push(ctx as HandlerContext & SyncCtx, req.body, req.headers) }),
    pullChanges: async (req, ctx) => ({ status: 200, body: await pullChanges(c(ctx) as any, req.body) }),
    listSyncConflicts: async (req, ctx) => ({ status: 200, body: await listConflicts(c(ctx), req.query) }),
    getSyncConflict: async (req, ctx) => ({ status: 200, body: await getConflict(c(ctx), req.params) }),
    resolveSyncConflict: async (req, ctx) => ({ status: 200, body: await resolveConflict(c(ctx), req.params, req.body, registry) }),
  };
}

export const syncPart2Handlers = createSyncPart2Handlers();
