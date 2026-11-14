'use server';
import 'server-only';
// Scan flow for the T-19 worklist (04-UI-UX §2 "Scan behaviour", AC-02.2): C5 lookup → C10 cultures of that specimen → open / choose / none.
// REQ-SEC-098: the barcode travels only in the POST body (never a URL), is never logged, and never echoed back to the client.
// S-02 (no existence oracle): unknown barcode, no culture, only cancelled cultures and a refused lookup (403) all return the same `none`.
// Only the async `scanSpecimenAction` is exported (server-action file); the result is plain data, never a problem body or message.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { CulturePage, ScanResult } from './types';

const BARCODE_RE = /^[A-Z0-9]{1,20}$/; // C5 barcode charset (IC §9.3)

async function lookupSpecimenByBarcode(barcode: string): Promise<string> {
  const s = await serverFetch<{ id?: unknown }>('/v1/lab/specimens/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ barcode }) });
  return uuid(s.id); // ids are validated as UUIDs before they reach a path
}

export async function scanSpecimenAction(barcode: string): Promise<ScanResult> {
  if (typeof barcode !== 'string' || !BARCODE_RE.test(barcode)) return { kind: 'none' };
  try {
    const specimenId = await lookupSpecimenByBarcode(barcode);
    const list = await serverFetch<CulturePage>(`/v1/micro/cultures?specimen_id=${specimenId}&limit=50`);
    const live = list.data.filter((c) => c.status !== 'cancelled');
    if (live.length === 0) return { kind: 'none' };
    if (live.length === 1) return { kind: 'open', cultureId: uuid(live[0]!.id) };
    return { kind: 'choose', cultures: live.map((c) => ({ id: uuid(c.id), test_code: c.test_code, test_name: c.test_name, status: c.status })) };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return { kind: 'none' };
    return { kind: 'error' };
  }
}
