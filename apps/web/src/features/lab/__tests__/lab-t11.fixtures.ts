// C5.T-11 shared synthetic fixtures + MSW plumbing (no real patient data). Imported by the lab-t11.* tests only.
import { HttpResponse } from 'msw';

export const ORIGIN = 'http://api.test';
export const LAB = `${ORIGIN}/v1/lab`;
export const uuid = (kind: number, n: number) => `01a1a98a-ac40-7000-8000-${String(kind).padStart(4, '0')}${String(n).padStart(8, '0')}`;
export const SP = (n: number) => uuid(5, n); // specimen ids
export const BC = (n: number) => `SYN${String(n).padStart(7, '0')}`; // synthetic barcodes, match ^[A-Z0-9]{1,20}$
export const ORDER = uuid(4, 1);
export const REG = 'REG2611050001'; // 13 chars: matches the barcode pattern too, so NOT used for registration-no lookups
export const LONG_REG = 'REGISTRATIONNO2611050001'; // 24 chars: > barcode max 20, valid registration_no (^[A-Z0-9]{1,40}$)
export const CENTRE_A = uuid(2, 1);
export const CENTRE_B = uuid(2, 2);
export const CENTRES = [
  { id: CENTRE_A, name: 'Synthetic Central Lab' },
  { id: CENTRE_B, name: 'Synthetic Satellite Lab' },
];
export const REASONS = [
  { code: 'haemolysed', display: 'Haemolysed' },
  { code: 'insufficient_volume', display: 'Insufficient volume' },
];

export const specimen = (n: number, o: Record<string, unknown> = {}) => ({
  id: SP(n), version: 1, barcode: BC(n), order_id: ORDER, registration_no: REG, specimen_type_code: 'serum', container_code: 'sst',
  status: 'ordered', priority: 'routine', centre_id: CENTRE_A, is_active: true, collection_barcode_unverified: false, label_print_count: 1,
  tests: [{ test_id: uuid(3, n), test_code: `TST${n}` }], ...o,
});

export const problem = (status: number, code: string, title: string) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code }, { status });

export interface Call { method: string; url: URL; headers: Headers; body?: any }
export const calls: Call[] = [];
export const rec = async (r: Request) => {
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) });
};
export const sent = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname));
export const lookups = () => sent('POST', /\/specimens\/lookup$/);
export const receives = () => sent('POST', /\/specimens\/[^/]+\/receive$/);
export const rejects = () => sent('POST', /\/specimens\/[^/]+\/reject$/);
export const bulkCollects = () => sent('POST', /\/specimens\/bulk-collect$/);
export const bulkDispatches = () => sent('POST', /\/specimens\/bulk-dispatch$/);
