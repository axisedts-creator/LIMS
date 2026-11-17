// C17 capture-time correction (02-TRD §7.5 steps 1–4, 07-SECURITY AB15). Pure, IO-free: every "now" is injected.
import { LimsError } from '../../../core/errors.js';

export interface ClockAnchor { anchorId: string; serverTime: string; deviceWallTime: string; monotonicMs: number; bootId: string }
export interface CorrectCapturedTimeInput {
  captured: { deviceWallTime: string; anchorId: string; elapsedSinceAnchorMs: number };
  anchors: readonly ClockAnchor[];
  now: { deviceWallTime: string; monotonicMs: number; bootId: string };
  receivedAt: string;
  assignedAt: string;
  toleranceSeconds: number;
}
export interface CorrectedTime { correctedAt: string; clockSource: 'anchor' | 'offset' | 'device'; clockSuspect: boolean; skewSeconds: number }

const invalid = (): LimsError => new LimsError('common.validation_failed', 'invalid timestamp');
const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw invalid();
  return t;
};

export function correctCapturedTime(i: CorrectCapturedTimeInput): CorrectedTime {
  const wall = ms(i.captured.deviceWallTime);
  const el = i.captured.elapsedSinceAnchorMs;
  const named = i.anchors.find((a) => a.anchorId === i.captured.anchorId);
  let raw: number;
  let clockSource: CorrectedTime['clockSource'];
  if (named && named.bootId === i.now.bootId && Number.isFinite(el) && el >= 0) {
    raw = ms(named.serverTime) + el; // step 1: same boot, monotonic elapsed
    clockSource = 'anchor';
  } else if (i.anchors.length > 0) {
    // step 2: offset of the most recent anchor (greatest serverTime)
    const a = i.anchors.reduce((best, x) => (ms(x.serverTime) > ms(best.serverTime) ? x : best));
    raw = wall + (ms(a.serverTime) - ms(a.deviceWallTime));
    clockSource = 'offset';
  } else {
    raw = wall; // step 3: no anchor at all
    clockSource = 'device';
  }
  if (!Number.isFinite(raw)) throw invalid();
  // step 4: plausibility clamp [assigned_at - tolerance, receipt]
  const lo = ms(i.assignedAt) - i.toleranceSeconds * 1000;
  const hi = ms(i.receivedAt);
  const t = Math.min(Math.max(raw, lo), hi);
  return { correctedAt: new Date(t).toISOString(), clockSource, clockSuspect: t !== raw, skewSeconds: (wall - t) / 1000 };
}
