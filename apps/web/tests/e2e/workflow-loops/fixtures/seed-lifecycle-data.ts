// Synthetic Lifecycle Data & Constants for Multi-Agent Web Verification
import { randomUUID } from 'node:crypto';

export const IDS = {
  tenantA: '01900000-0000-7000-8000-00000000000a',
  tenantB: '01900000-0000-7000-8000-00000000000b',
  centre1: '01900000-0000-7000-8000-000000000101',
  centre2: '01900000-0000-7000-8000-000000000102',
  hbOrderableId: '01900000-0000-7000-8000-000000000042',
  cbcOrderableId: '01900000-0000-7000-8000-000000000043',
};

export function makeSyntheticPatient() {
  const nonce = Date.now().toString(36);
  return {
    fullName: `E2E Verified Patient ${nonce}`,
    phone: `+977980000${Math.floor(1000 + Math.random() * 9000)}`,
    email: `patient-${nonce}@metrolims.invalid`,
    age: 32,
    sex: 'female' as const,
  };
}

export type ApiResponse<T = any> = {
  status: number;
  body: T;
  headers: Headers;
};

/** Direct API caller for agent assertions and out-of-band state checks */
export async function directApi<T = any>(
  baseUrl: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'idempotency-key': randomUUID(),
    ...extraHeaders,
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  const init: RequestInit = {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const response = await fetch(url, init);

  let parsed: any = null;
  const text = await response.text();
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  return {
    status: response.status,
    body: parsed,
    headers: response.headers,
  };
}
