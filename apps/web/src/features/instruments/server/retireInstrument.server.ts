import 'server-only';
// E31 retireInstrument (POST …/{instrument_id}/retire, If-Match, reason_text 3–300): any non-retired state → retired.
import { postTransition, reasonText } from './shared.server';
import type { Instrument } from './types';

export const retireInstrument = async (instrumentId: string, version: number, reason: string): Promise<Instrument> =>
  postTransition(instrumentId, version, 'retire', { reason_text: reasonText(reason) });
