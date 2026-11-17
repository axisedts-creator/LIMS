// C16.T-Q4 shared types + pure helpers for the W6 console and W7 setup (contracts/openapi/engagement.yaml: Queue, QueueCounter, QueueToken, QueueDisplay).
// No patient fields exist on these shapes: a token carries at most booking_id (AC-21.6).

export interface Queue { id: string; centre_id: string; code: string; display_name: string; token_prefix: string; sort_order: number; is_active: boolean; version: number }
export interface QueueCounter { id: string; centre_id: string; display_name: string; sort_order: number; is_active: boolean; version: number }
export type TokenStatus = 'waiting' | 'called' | 'serving' | 'completed' | 'skipped' | 'cancelled' | 'transferred' | 'expired';
export interface QueueToken {
  id: string; queue_id: string; token_label: string; status: TokenStatus; priority: 'normal' | 'priority'; counter_id?: string;
  issued_at: string; called_at?: string; call_count: number; booking_id?: string; transferred_from_token_id?: string; version: number;
}
export interface QueueDisplayRow { id: string; centre_id: string; display_name: string; queue_ids: string[]; status: 'active' | 'revoked'; paired_at: string; last_seen_at?: string; revoked_at?: string; version: number }

export const MAX_RECALLS = 9; // recall allowed while call_count < 9
export const SUGGEST_SKIP_AFTER = 3; // [CONV] W6: after 3 calls the console suggests Skip

/** Waiting order (AC-21.2): priority first, then oldest issued_at, then label for a stable tie-break. */
export function waitingOrder(a: QueueToken, b: QueueToken): number {
  if (a.priority !== b.priority) return a.priority === 'priority' ? -1 : 1;
  return Date.parse(a.issued_at) - Date.parse(b.issued_at) || a.token_label.localeCompare(b.token_label);
}

/** Elapsed time from the server issued_at as mm:ss (minutes keep counting past 59). */
export function mmss(issuedAt: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(issuedAt)) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}


export const upsertToken = (list: readonly QueueToken[], t: QueueToken): QueueToken[] =>
  list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t];

// ---- W7 field rules (04-UI-UX W7) ----
const CODE_RE = /^[a-z0-9_]{1,32}$/;
const PREFIX_RE = /^[A-Z]{1,2}$/;
const ORDER_RE = /^\d{1,3}$/;

export const checkCode = (v: string) => (v.trim() === '' ? 'Code is required' : CODE_RE.test(v) ? undefined : 'Code must be 1–32 characters: a–z, 0–9 or _');
export const checkName = (v: string, max: number, label = 'Name') => (v.trim() === '' ? `${label} is required` : v.length > max ? `${label} must be ${max} characters or fewer` : undefined);
export const checkPrefix = (v: string) => (v === '' ? 'Token prefix is required' : PREFIX_RE.test(v) ? undefined : 'Token prefix must be 1–2 capital letters (A–Z)');
export const checkOrder = (v: string) => (v.trim() === '' ? 'Order is required' : ORDER_RE.test(v.trim()) ? undefined : 'Order must be a whole number between 0 and 999');

/** Error shape the server actions throw for the client (mapped from the API problem). */
export function problemMessage(e: unknown): string {
  const code = (e as { problem?: { code?: string } } | null)?.problem?.code;
  if (code === 'common.validation_failed') return 'Check the values and try again — the code may already be in use.';
  if (code === 'common.version_conflict') return 'This record was changed by someone else. Reload and try again.';
  if (code === 'auth.forbidden') return 'You do not have permission to do this.';
  if (code === 'engagement.queue_closed') return 'This queue is closed.';
  if (code === 'engagement.queue_token_invalid_transition') return 'That token has already moved on. The list has been refreshed.';
  return 'Something went wrong. Try again.';
}
