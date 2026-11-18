// T0D-OFFLINE-2 shared fixtures for the jsdom tests (tester-owned; not a test file). Synthetic data only.
//
// CONTRACT chosen by the tester where the brief gives no name (writer: follow it, or dispute in .orchestra/notes/T0D-OFFLINE-2-dispute-*.md).
// Everything the screens show comes from ONE controller, handed down by a React context:
//   @/core/offline/ui/OfflineProvider   exports  OfflineProvider({ controller, children })  and  useOfflineController()
//   Without a provider the staff shell shows no chip, no banner, no overlay (the existing shell tests stay as they are).
//   The screens read it with useSyncExternalStore(controller.subscribe, controller.getSnapshot).
//
//   OfflineController {
//     getSnapshot(): OfflineSnapshot            (same object until something changes)
//     subscribe(listener): () => void
//     syncNow(): Promise<void>
//     retry(opId): Promise<{ ok: boolean }>
//     discard(opId, reason): Promise<{ ok: boolean }>                       (rejects { code: 'offline.reason_required' } on a blank reason)
//     loadConflict(conflictId): Promise<{ local_payload, server_payload } | null>   (null = not available: offline or the call failed)
//     resolveConflict(conflictId, { resolution: 'keep_server' | 'apply_local' | 'merge', reason, merged_payload? }): Promise<{ ok: true } | { ok: false, code?: string }>
//     unlock(pin): Promise<UnlockResult of core/offline/store.ts>
//     setupPin(pin): Promise<{ ok: boolean }>            changePin(oldPin, newPin): Promise<UnlockResult-like>
//   }
//   OfflineSnapshot: see the type below. Permissions that gate the buttons: sync.use (Sync now, Retry, Discard, change PIN) and
//   sync.conflict.resolve (Resolve). A button without its permission is disabled and aria-describedby points at visible text naming the missing permission.
import { createElement, type ReactElement } from 'react';
import { vi } from 'vitest';

export type Conn = 'online' | 'offline' | 'degraded' | 'syncing';
export interface Op { op_id: string; op_type: string; payload: unknown; base_version?: number; entity_id?: string; device_created_at: string; device_id: string; user_id: string }
export interface Snapshot {
  conn: Conn;
  storeState: 'empty' | 'locked' | 'unlocked' | 'wiped' | 'revoked';
  pending: Op[];
  attention: Array<Op & { code: string; at: string }>;
  conflicts: Array<Op & { conflict_id: string; code?: string; at: string }>;
  prefetch: { ready: boolean; fetchedAt: number | null; bytes: number; capBytes: number };
  skewFlag: boolean;
  now: number;
  permissions: string[];
  signedInUsers: number;
}

export const NOW = Date.parse('2026-11-18T06:00:00.000Z');
export const PERMS = ['sync.use', 'sync.conflict.resolve'];
export const PATIENT_NAME = 'Asha Verma'; // synthetic
export const PATIENT_PHONE = '9800000000'; // synthetic

export const op = (n: number, over: Partial<Op> = {}): Op => ({
  op_id: `0192f0d6-0000-7000-8000-00000000a${String(n).padStart(3, '0')}`,
  op_type: 'registration.create_order',
  payload: { patient: { full_name: PATIENT_NAME, phone: PATIENT_PHONE, patient_id: `p-${n}` } },
  device_created_at: new Date(NOW - n * 60_000).toISOString(),
  device_id: '0192f0d6-0000-7000-8000-0000000000d1',
  user_id: '0192f0d6-0000-7000-8000-000000000001',
  ...over,
});
export const attentionItem = (n: number, code = 'sync.result_locked', over: Partial<Op> = {}) => ({ ...op(n, over), code, at: new Date(NOW).toISOString() });
export const conflictItem = (n: number, conflict_id = `0192f0d6-0000-7000-8000-00000000c${String(n).padStart(3, '0')}`, over: Partial<Op> = {}) =>
  ({ ...op(n, over), conflict_id, code: 'sync.base_version_stale', at: new Date(NOW).toISOString() });

export const baseSnapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  conn: 'online', storeState: 'unlocked', pending: [], attention: [], conflicts: [],
  prefetch: { ready: false, fetchedAt: null, bytes: 0, capBytes: 150 * 1024 * 1024 },
  skewFlag: false, now: NOW, permissions: PERMS, signedInUsers: 2, ...over,
});

export const LOCAL_VERSION = { full_name: PATIENT_NAME, phone: PATIENT_PHONE, city: 'Pune' };
export const SERVER_VERSION = { full_name: PATIENT_NAME, phone: '9811111111', city: 'Mumbai' };

/** A controller double with the real shape. `set(patch)` replaces the snapshot and notifies subscribers. */
export function fakeController(initial: Partial<Snapshot> = {}) {
  let snap = baseSnapshot(initial);
  const subs = new Set<() => void>();
  const set = (patch: Partial<Snapshot>) => { snap = { ...snap, ...patch }; subs.forEach((l) => l()); };
  return {
    getSnapshot: () => snap,
    subscribe: (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; },
    set,
    syncNow: vi.fn(async () => undefined),
    retry: vi.fn(async (_id: string) => ({ ok: true })),
    discard: vi.fn(async (_id: string, _reason: string) => ({ ok: true })),
    loadConflict: vi.fn(async (_id: string): Promise<{ local_payload: unknown; server_payload: unknown } | null> => ({ local_payload: LOCAL_VERSION, server_payload: SERVER_VERSION })),
    resolveConflict: vi.fn(async (_id: string, _body: { resolution: string; reason: string; merged_payload?: unknown }): Promise<{ ok: boolean; code?: string }> => ({ ok: true })),
    unlock: vi.fn(async (_pin: string): Promise<{ ok: true } | { ok: false; reason: string; attemptsLeft?: number }> => { set({ storeState: 'unlocked' }); return { ok: true as const }; }),
    setupPin: vi.fn(async (_pin: string) => { set({ storeState: 'unlocked' }); return { ok: true }; }),
    changePin: vi.fn(async (_old: string, _next: string): Promise<{ ok: true } | { ok: false; reason: string; attemptsLeft?: number }> => ({ ok: true })),
  };
}
export type FakeController = ReturnType<typeof fakeController>;

/** wraps an element in the provider the tests expect (dynamic import: the module does not exist before the writer's work). */
export async function withProvider(controller: FakeController, el: ReactElement) {
  const { OfflineProvider } = await import('@/core/offline/ui/OfflineProvider');
  return createElement(OfflineProvider as never, { controller } as never, el);
}
