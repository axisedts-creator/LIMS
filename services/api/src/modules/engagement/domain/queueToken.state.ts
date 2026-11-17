// Queue token state machine (03-APP-FLOW §4.3 T-2..T-10; 05-SCHEMA queue_tokens__status__ck). called->called = recall. Pure.

export const QUEUE_TOKEN_STATUSES = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'transferred', 'expired'] as const;
export type QueueTokenStatus = (typeof QUEUE_TOKEN_STATUSES)[number];

const NEXT: Readonly<Record<QueueTokenStatus, readonly QueueTokenStatus[]>> = {
  waiting: ['called', 'cancelled', 'transferred', 'expired'],
  called: ['called', 'serving', 'skipped', 'completed', 'cancelled', 'transferred', 'expired'],
  serving: ['completed', 'transferred', 'expired'],
  skipped: ['called', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  transferred: [],
  expired: [],
};

export function canTransition(from: QueueTokenStatus, to: QueueTokenStatus): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}
export const isTerminal = (s: QueueTokenStatus): boolean => Object.hasOwn(NEXT, s) && NEXT[s].length === 0;

export const MAX_CALLS = 9; // recall allowed while call_count < 9 (US-EN-21.2)
export const SKIP_SUGGEST_AFTER = 3; // [CONV] console suggests skip from the 3rd call (US-EN-21.3)

export const canRecall = (callCount: number): boolean => callCount < MAX_CALLS;
export const shouldSuggestSkip = (callCount: number): boolean => callCount >= SKIP_SUGGEST_AFTER;

type Waiting = { priority: 'normal' | 'priority'; issuedAt: Date };

/** Call order: priority first, then oldest issue time (US-EN-21.5). Use with Array.sort. */
export function compareWaiting(a: Waiting, b: Waiting): number {
  if (a.priority !== b.priority) return a.priority === 'priority' ? -1 : 1;
  return a.issuedAt.getTime() - b.issuedAt.getTime();
}

/** `A-001`; 3 digits minimum, 4 after 999 (queue_tokens__label__ck ^[A-Z]{1,2}-[0-9]{3,4}$). */
export const formatTokenLabel = (prefix: string, seq: number): string => `${prefix}-${String(seq).padStart(3, '0')}`;

/** Tenant-local business day `YYYY-MM-DD` (token sequence resets at local midnight). */
export function businessDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
