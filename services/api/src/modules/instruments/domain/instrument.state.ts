// Instrument commissioning machine (03-APP-FLOW §2.2 I1–I6). Pure; driver/checklist guards live in the service (API-T05).
import { LimsError } from '../../../core/errors.js';

export const INSTRUMENT_STATES = ['draft', 'commissioning', 'live', 'suspended', 'retired'] as const;
export type InstrumentState = (typeof INSTRUMENT_STATES)[number];
export type InstrumentAction = 'create' | 'startCommissioning' | 'goLive' | 'suspend' | 'resume' | 'retire';

const ABSENT = '∅';
const TABLE: Readonly<Record<InstrumentAction, Readonly<Partial<Record<InstrumentState | typeof ABSENT, InstrumentState>>>>> = {
  create: { [ABSENT]: 'draft' }, // I1
  startCommissioning: { draft: 'commissioning' }, // I2
  goLive: { commissioning: 'live' }, // I3
  suspend: { live: 'suspended' }, // I4
  resume: { suspended: 'live' }, // I5
  retire: { draft: 'retired', commissioning: 'retired', live: 'retired', suspended: 'retired' }, // I6
};

export function instrumentNext(from: InstrumentState | null, action: InstrumentAction): InstrumentState {
  const to = TABLE[action]?.[from ?? ABSENT];
  if (!to) throw new LimsError('instruments.invalid_transition');
  return to;
}
