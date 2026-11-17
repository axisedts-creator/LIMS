import 'server-only';
// E27 startInstrumentCommissioning (POST …/{instrument_id}/start-commissioning, If-Match): draft → commissioning.
import { postTransition } from './shared.server';
import type { Instrument } from './types';

export const startInstrumentCommissioning = async (instrumentId: string, version: number): Promise<Instrument> => postTransition(instrumentId, version, 'start-commissioning');
