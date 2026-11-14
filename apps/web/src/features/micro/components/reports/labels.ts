// Words for the report phase and kind (04-UI-UX §3.4: Phase Preliminary/Final, Kind Initial/Update/Amendment). Unknown values from a newer API are shown as received.
export const PHASE_LABEL: Record<string, string> = { preliminary: 'Preliminary report', final: 'Final report' };
export const PHASE_WORD: Record<string, string> = { preliminary: 'Preliminary', final: 'Final' };
export const KIND_LABEL: Record<string, string> = { initial: 'Initial', update: 'Update', amendment: 'Amendment' };
export const labelOf = (m: Record<string, string>, k: string) => m[k] ?? k;
