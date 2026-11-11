import 'server-only';
// E29 suspendInstrument (POST …/{instrument_id}/suspend, If-Match, reason_text 3–300): live → suspended.
import { postTransition, reasonText } from './shared.server';
import type { Instrument } from './types';

export const suspendInstrument = async (instrumentId: string, version: number, reason: string): Promise<Instrument> =>
  postTransition(instrumentId, version, 'suspend', { reason_text: reasonText(reason) });
