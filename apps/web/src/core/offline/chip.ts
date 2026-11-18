// T0D-OFFLINE-2 (LD-322; offline design section 4): the state of the status chip in the staff shell. Pure; text from the message catalogue.
// Priority: syncing > needs attention (attention + conflicts) > offline (offline or degraded) > ready for offline > online.
import { t } from '../i18n/messages';
import type { ConnState } from './connectivity';

export type ChipKind = 'online' | 'offline' | 'syncing' | 'attention' | 'ready';
export interface ChipInput { conn: ConnState; pending: number; attention: number; conflicts: number; prefetch: { ready: boolean; fetchedAt: number | null }; now: number }

/** t() with {name} placeholders */
export const tf = (key: string, vars: Record<string, string | number>) => t(key).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

export function ageLabel(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return t('offline.age.now');
  if (min < 60) return tf('offline.age.min', { n: min });
  const h = Math.floor(min / 60);
  return h < 24 ? tf('offline.age.h', { n: h }) : tf('offline.age.d', { n: Math.floor(h / 24) });
}

export function chipState(s: ChipInput): { kind: ChipKind; label: string } {
  const attention = s.attention + s.conflicts;
  if (s.conn === 'syncing') return { kind: 'syncing', label: t('offline.chip.syncing') };
  if (attention > 0) return { kind: 'attention', label: tf('offline.chip.attention', { n: attention }) };
  if (s.conn === 'offline' || s.conn === 'degraded') {
    return { kind: 'offline', label: s.pending > 0 ? tf('offline.chip.offline_pending', { n: s.pending }) : t('offline.chip.offline') };
  }
  if (s.prefetch.ready && s.prefetch.fetchedAt !== null) return { kind: 'ready', label: tf('offline.chip.ready', { age: ageLabel(s.now - s.prefetch.fetchedAt) }) };
  return { kind: 'online', label: t('offline.chip.online') };
}
