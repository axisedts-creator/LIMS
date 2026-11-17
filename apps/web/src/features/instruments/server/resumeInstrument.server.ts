import 'server-only';
// E30 resumeInstrument (POST …/{instrument_id}/resume, If-Match): suspended → live (driver must still be verified).
import { postTransition } from './shared.server';
import type { Instrument } from './types';

export const resumeInstrument = async (instrumentId: string, version: number): Promise<Instrument> => postTransition(instrumentId, version, 'resume');
