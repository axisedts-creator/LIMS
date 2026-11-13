// C12 consumption-fact state table — 03-APP-FLOW §3.6 C2–C4. no_rule, dismissed, reversed are terminal; only manual facts reverse (AC-15.4).
import { LimsError } from '../../../core/errors.js';

export const FACT_STATUSES = ['posted', 'no_rule', 'unresolved', 'dismissed', 'reversed'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];
export type FactSource = 'event' | 'manual' | 'cron';

// Map (not an object) so '__proto__' / 'constructor' can never match.
const NEXT = new Map<string, ReadonlySet<string>>([
  ['unresolved', new Set(['posted', 'dismissed'])], // C2, C3
  ['posted', new Set(['reversed'])], // C4 (manual only, see below)
]);

export function canTransition(from: FactStatus, to: FactStatus, source: FactSource): boolean {
  if (!(NEXT.get(from)?.has(to) ?? false)) return false;
  return from === 'posted' ? source === 'manual' : true;
}

export function assertTransition(from: FactStatus, to: FactStatus, source: FactSource): void {
  if (canTransition(from, to, source)) return;
  const reversible = NEXT.get(from)?.has(to) && from === 'posted' && (source === 'event' || source === 'cron');
  throw new LimsError(reversible ? 'inventory.fact_not_reversible' : 'inventory.document_invalid_transition');
}
