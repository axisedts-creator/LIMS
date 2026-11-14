// REQ-SEC-091: every non-GET to the partner BFF must carry Origin = LIMS_ORIGIN_PARTNER (exact match) and, when the
// browser sends it, Sec-Fetch-Site: same-origin. Fails closed when LIMS_ORIGIN_PARTNER is unset. Pure; no server-only needed.
export type CsrfResult = { ok: true } | { ok: false; status: 403; code: 'auth.csrf_failed' };

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const REJECT: CsrfResult = { ok: false, status: 403, code: 'auth.csrf_failed' };

function expectedOrigin(): string | undefined {
  const raw = process.env.LIMS_ORIGIN_PARTNER;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export function checkCsrf({ method, headers }: { method: string; headers: Headers }): CsrfResult {
  if (SAFE.has(method.toUpperCase())) return { ok: true };
  const expected = expectedOrigin();
  if (!expected || headers.get('origin') !== expected) return REJECT;
  const site = headers.get('sec-fetch-site'); // absent on older browsers: the Origin match above is then the control
  if (site !== null && site !== 'same-origin') return REJECT;
  return { ok: true };
}
