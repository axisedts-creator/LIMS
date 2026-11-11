import 'server-only';
// E40 getInstrumentSettings (GET /v1/instruments/settings). Needs instruments.instrument.read; errors propagate to error.tsx.
import { serverFetch } from '@/core/api/server-fetch';
import type { InstrumentSettings } from './types';

export const getInstrumentSettings = () => serverFetch<InstrumentSettings>('/v1/instruments/settings');
