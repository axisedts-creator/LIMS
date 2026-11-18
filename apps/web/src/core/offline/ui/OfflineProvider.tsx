'use client';
// T0D-OFFLINE-2 (LD-322): hands the offline controller to the staff shell and the Offline panel. Without a controller (server render,
// no IndexedDB, a role without sync.use) the context is null and the shell shows no chip, banner or overlay.
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { t } from '../../i18n/messages';
import { tf } from '../chip';
import type { OfflineController, OfflineSnapshot } from '../controller';

type Ctl = Pick<OfflineController, 'getSnapshot' | 'subscribe' | 'syncNow' | 'retry' | 'discard' | 'loadConflict' | 'resolveConflict' | 'unlock' | 'setupPin' | 'changePin'>;
const Ctx = createContext<Ctl | null>(null);

type Props = { controller?: Ctl | null; live?: { userId: string; permissions: readonly string[] }; children: ReactNode };

export function OfflineProvider({ controller, live, children }: Props) {
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
  return <Ctx.Provider value={controller ?? own}>{children}</Ctx.Provider>;
}

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
