// TRF scan_state machine (03-APP-FLOW §1.4). Content (F21a) only when clean. Pure.

export const TRF_SCAN_STATES = ['pending', 'clean', 'quarantined', 'failed'] as const;
export type TrfScanState = (typeof TRF_SCAN_STATES)[number];
export type UiScanState = 'pending' | 'clean' | 'infected' | 'unavailable';

const NEXT: Readonly<Record<TrfScanState, readonly TrfScanState[]>> = {
  pending: ['clean', 'quarantined', 'failed'],
  clean: [],
  quarantined: [],
  failed: ['pending'],
};
const UI: Readonly<Record<TrfScanState, UiScanState>> = { pending: 'pending', clean: 'clean', quarantined: 'infected', failed: 'unavailable' };

export function canTransition(from: TrfScanState, to: TrfScanState): boolean {
  return Object.hasOwn(NEXT, from) && NEXT[from].includes(to);
}

export const canServeContent = (s: TrfScanState): boolean => s === 'clean';

/** 03-APP-FLOW §2 F21a: not clean -> 422 common.upload_quarantined. */
export const contentErrorCode = (s: TrfScanState): string | undefined => (canServeContent(s) ? undefined : 'common.upload_quarantined');

export const uiScanState = (s: TrfScanState): UiScanState => UI[s];
