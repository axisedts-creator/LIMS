'use client';
// T0D-OFFLINE-2 (LD-322): hands the offline controller to the staff shell and the Offline panel. Without a controller (server render,
// no IndexedDB, a role without sync.use) the context is null and the shell shows no chip, banner or overlay.
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { t } from '../../i18n/messages';
import { tf } from '../chip';
import type { OfflineController, OfflineSnapshot } from '../controller';
import type { OfflineFlows } from '../flows';
import type { CashFlows } from '../cashflows';
import type { LabFlows } from '../labflows';
import { onlineOnlyReason, type OnlineOnlyAction } from '../guards';

type Ctl = Pick<OfflineController, 'getSnapshot' | 'subscribe' | 'syncNow' | 'retry' | 'discard' | 'loadConflict' | 'resolveConflict' | 'unlock' | 'setupPin' | 'changePin'> & { flows?: () => Flows | null };
const Ctx = createContext<Ctl | null>(null);
/** T0D-OFFLINE-3: the parts of the flows the screens use (a test hands a stand-in) */
export type Flows = Pick<OfflineFlows, 'display' | 'statusOf'> & { numbers: Pick<OfflineFlows['numbers'], 'remaining'> } & Partial<OfflineFlows & LabFlows & CashFlows>; // T0D-OFFLINE-4: lab and cash adapters
const FlowsCtx = createContext<Flows | null>(null);

type Props = { controller?: Ctl | null; flows?: Flows | null; live?: { userId: string; permissions: readonly string[] }; children: ReactNode };

export function OfflineProvider({ controller, flows, live, children }: Props) {
  const [own, setOwn] = useState<Ctl | null>(null);
  const userId = live?.userId;
  const perms = live?.permissions.join(' ');
  useEffect(() => {
    if (controller || !userId || !perms?.split(' ').includes('sync.use') || typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) return;
    let stop: (() => void) | null = null; let gone = false;
    import('../controller')
      .then((m) => m.startLiveOffline({ userId, permissions: perms.split(' ') }))
      .then((l) => { if (gone) l.stop(); else { stop = l.stop; setOwn(l.controller); } })
      .catch(() => undefined); // no offline layer on this browser: the shell works as before
    return () => { gone = true; stop?.(); };
  }, [controller, userId, perms]);
  const ctl = controller ?? own;
  return <Ctx.Provider value={ctl}><LiveFlows ctl={ctl} flows={flows}>{children}</LiveFlows></Ctx.Provider>;
}

/** the live controller builds its flows once the store is unlocked and the device is known: re-read them on every snapshot */
function LiveFlows({ ctl, flows, children }: { ctl: Ctl | null; flows: Flows | null | undefined; children: ReactNode }) {
  useOfflineSnapshot();
  return <FlowsCtx.Provider value={flows ?? ctl?.flows?.() ?? null}>{children}</FlowsCtx.Provider>;
}

/** T0D-OFFLINE-3: the offline flows, or null (no provider, no offline layer, locked or not attached yet) */
export const useOfflineFlows = () => useContext(FlowsCtx);

export const useOfflineController = () => useContext(Ctx);

const none = () => () => undefined;
const nothing = () => null;
/** the controller snapshot, or null without a provider. A change renders at once (flushSync): the controller only publishes
 *  from async work, never during a render, and it publishes only when the snapshot really changed. */
export function useOfflineSnapshot(): OfflineSnapshot | null {
  const c = useContext(Ctx);
  const subscribe = useCallback((l: () => void) => (c ? c.subscribe(() => flushSync(l)) : none()), [c]);
  return useSyncExternalStore(subscribe, c ? c.getSnapshot : nothing, c ? c.getSnapshot : nothing);
}

export const isOnline = (s: OfflineSnapshot) => s.conn === 'online' || s.conn === 'syncing';
/** LD-353 rule: a button the user cannot press says why. null = allowed. Permission first, then the connection. */
export function blocked(s: OfflineSnapshot, permission: string, needsOnline = false): string | null {
  if (!s.permissions.includes(permission)) return tf('offline.no_permission', { p: permission });
  if (needsOnline && !isOnline(s)) return t('offline.need_online');
  return null;
}

/** T0D-OFFLINE-3 (done_when 4): an online only action is disabled offline (degraded counts as offline) with a visible reason.
 *  Without a provider (the online screens as before) nothing is disabled. */
export function useOnlineOnly(action: OnlineOnlyAction): { disabled: boolean; reason: string | null } {
  const s = useOfflineSnapshot();
  const reason = s ? onlineOnlyReason(action, isOnline(s)) : null;
  return { disabled: reason !== null, reason };
}
