'use server';
// Global search (10-DESIGN-SYSTEM §3, T0D-UI-R04, LD-140): existing BFF endpoints only — POST /v1/lab/specimens/lookup
// (barcode, lab.specimen.read) and POST /v1/frontdesk/patients/search (frontdesk.patient.read). Text goes in the body,
// never the URL (CV §9.2). Runs server-side so the JWT never reaches the browser; the API enforces permissions, the
// flags below only avoid calls the actor cannot make. Errors are reduced to a generic kind (no problem title/detail).
import { ApiError, serverFetch } from '../api/server-fetch';

export type SearchHit = { id: string; name: string; code: string };
export type SearchResult =
  | { kind: 'order'; orderId: string }
  | { kind: 'patients'; items: SearchHit[] }
  | { kind: 'none' }
  | { kind: 'error' };

const BARCODE = /^[A-Z0-9]{1,20}$/;
const ID = /^[0-9a-f-]{36}$/i;

export async function globalSearch(text: string, can: { patients: boolean; specimens: boolean }): Promise<SearchResult> {
  const query = String(text ?? '').trim().slice(0, 100);
  if (!query) return { kind: 'none' };
  const post = <T,>(path: string, body: unknown) =>
    serverFetch<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // Barcode-shaped text (digits too: a mobile or patient id can look like one) asks both endpoints at once; a specimen
  // match wins and opens its order, otherwise the patient list is shown.
  const specimen = can.specimens && BARCODE.test(query)
    ? post<{ order_id?: string }>('/v1/lab/specimens/lookup', { barcode: query }).then(
        (s) => (s?.order_id && ID.test(s.order_id) ? s.order_id : null),
        (e: unknown) => { if (e instanceof ApiError && e.status === 404) return null; throw e; },
      )
    : Promise.resolve(null);
  const patients = can.patients
    ? post<{ data?: { id: string; full_name: string; patient_code: string }[] }>('/v1/frontdesk/patients/search', { query, mode: 'auto', limit: 20 })
    : Promise.resolve({ data: [] });
  const [s, p] = await Promise.allSettled([specimen, patients]);
  if (s.status === 'fulfilled' && s.value) return { kind: 'order', orderId: s.value };
  if (s.status === 'rejected' || p.status === 'rejected') return { kind: 'error' };
  const items = (p.value?.data ?? []).filter((x) => ID.test(String(x.id))).map((x) => ({ id: x.id, name: String(x.full_name), code: String(x.patient_code) }));
  return items.length ? { kind: 'patients', items } : { kind: 'none' };
}
