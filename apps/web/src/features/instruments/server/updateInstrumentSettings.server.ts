import 'server-only';
// E41 updateInstrumentSettings (PUT /v1/instruments/settings, If-Match "<version>"). Raw-archive retention is NOT here (C2 owns it, D-42).
import { serverFetch } from '@/core/api/server-fetch';
import { settingsBody, validateSettings } from '../forms/settings';
import { JSON_HEADERS, badRequest } from './shared.server';
import type { InstrumentSettings, InstrumentSettingsBody } from './types';

export async function updateInstrumentSettings(version: number, body: InstrumentSettingsBody): Promise<InstrumentSettings> {
  if (!Number.isInteger(version) || version < 1 || validateSettings(body).length) throw badRequest(); // before any network call
  return serverFetch<InstrumentSettings>('/v1/instruments/settings', {
    method: 'PUT',
    headers: { ...JSON_HEADERS, 'if-match': `"${version}"` },
    body: JSON.stringify(settingsBody(body as unknown as Record<string, unknown>)),
  });
}
