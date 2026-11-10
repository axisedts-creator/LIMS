// BL-T22 / 07-SECURITY §6.5 + 05-DoD §1.8: PHI log-scan with planted synthetic PHI through EVERY C4 handler.
// Given a request whose every string field carries a planted synthetic name / phone / PAN / registration number,
// When each handler runs (it will refuse or answer — either way), Then nothing it logs (ctx.log, console, stdout/stderr) and no error it throws
// (message, detail, field errors) contains the planted values. Handlers that refuse with common.service_unavailable pass this vacuously until their task lands;
// the same sweep is re-run by CI for the implemented ones (cross-checked against crossTenant.handlers.test.ts, which fails for the stubs).
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_OPS, captureLogs, ctxFor, requestFor, run, safeJson, spyTx, TENANT_A } from './probe.kit.js';

const PHI = ['Zzyzx Qwerty-Phi', '9800000042', '4242424242', 'REG-PHI-0042', 'phi.probe@example.invalid'];

/** Replaces every string leaf of a sample body with the planted PHI (keeps uuids/enums/dates intact so the handler still parses it). */
function plant(v: any, key = ''): any {
  if (typeof v === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
    if (/phone|mobile|contact/i.test(key)) return PHI[1];
    if (/pan\b/i.test(key)) return PHI[2];
    if (/reg|number|no$/i.test(key)) return PHI[3];
    if (/email/i.test(key)) return PHI[4];
    return PHI[0];
  }
  if (Array.isArray(v)) return v.map((x) => plant(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plant(x, k)]));
  return v;
}

let cap: ReturnType<typeof captureLogs> | undefined;
afterEach(() => { cap?.restore(); cap = undefined; });

describe.each(ALL_OPS.map((o) => [`${o.mod}:${o.id}`, o] as const))('PHI log-scan %s', (_n, o) => {
  it('logs and throws no planted PHI', async () => {
    cap = captureLogs();
    const base = requestFor(o);
    const req = { ...base, body: plant(base.body), query: { q: PHI[0], phone: PHI[1], name: PHI[0] } };
    const { tx } = spyTx();
    const { result, error } = await run(o, await ctxFor(TENANT_A, tx, { log: cap.ctxLog }), req as never);
    const logged = cap.lines.join('\n');
    cap.restore();
    const surfaced = safeJson(error ? { m: error.message, d: error.detail, e: error.errors, s: error.stack?.split('\n')[0] } : { headers: result?.headers });
    for (const p of PHI) {
      expect(logged, `log line contains PHI "${p}"`).not.toContain(p);
      expect(surfaced, `error/headers contain PHI "${p}"`).not.toContain(p);
    }
  });
});

describe('the PHI sweep is not vacuous', () => {
  it('the planter really replaces text fields (self-check)', () => {
    expect(JSON.stringify(plant({ full_name: 'x', phone: 'y', nested: [{ buyer_pan: 'z' }] }))).toContain(PHI[0]);
    expect(JSON.stringify(plant({ phone: 'y' }))).toContain(PHI[1]);
    expect(JSON.stringify(plant({ buyer_pan: 'z' }))).toContain(PHI[2]);
  });
  it('the capture sees console + ctx.log writes', () => {
    const c = captureLogs();
    console.log('canary-one'); c.ctxLog.info('canary-two', { a: 'canary-three' });
    c.restore();
    expect(c.lines.join('|')).toMatch(/canary-one.*canary-two.*canary-three/);
  });
});
