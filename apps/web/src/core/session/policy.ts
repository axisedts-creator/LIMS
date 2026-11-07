// Idle/absolute limits (04 A8; REQ-SEC-073). In staging/production C2 enforces them inside resolveSession and the
// BFF only relays its 401 (08 R10); the dev in-memory provider uses this function to mimic that contract.
export const IDLE_MIN_MINUTES = 15;
export const IDLE_MAX_MINUTES = 30;
export const ABSOLUTE_MAX_HOURS = 12;
/** SessionTimeoutDialog opens this long before idle expiry (04-UI-UX SessionTimeoutDialog). */
export const WARNING_BEFORE_MS = 2 * 60_000;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sessionLimits(idleTimeoutMinutes: number, absoluteHours: number) {
  return {
    idleMs: clamp(idleTimeoutMinutes, IDLE_MIN_MINUTES, IDLE_MAX_MINUTES) * 60_000,
    absoluteMs: clamp(absoluteHours, 0, ABSOLUTE_MAX_HOURS) * 3600_000,
  };
}

/** 'idle' | 'absolute' when the session must end at `now`, else null. */
export function expiryReason(
  s: { createdAt: string; lastSeenAt: string; idleTimeoutMinutes: number; absoluteHours: number },
  now: number,
): 'idle' | 'absolute' | null {
  const { idleMs, absoluteMs } = sessionLimits(s.idleTimeoutMinutes, s.absoluteHours);
  if (now - Date.parse(s.createdAt) >= absoluteMs) return 'absolute';
  if (now - Date.parse(s.lastSeenAt) >= idleMs) return 'idle';
  return null;
}
