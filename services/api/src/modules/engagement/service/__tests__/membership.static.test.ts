// C16.T-M1 static checks on the membership backend source (02-TRD §4.12; 08 A24.1 / R25 / A17 P-21; 04 A11 128-bit floor "server-stored lookup").
// Fails now: service/membership.service.ts does not exist.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mod = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // modules/engagement
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return n === '__tests__' ? [] : statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(n) ? [p] : [];
});
const all = () => walk(mod).map((f) => ({ f, t: readFileSync(f, 'utf8') }));
const svc = join(mod, 'service', 'membership.service.ts');

describe('membership backend source', () => {
  it('service/membership.service.ts exists (06-PLAN T-M1 files)', () => { expect(existsSync(svc)).toBe(true); });
  it('no engagement request-path code reads a catalog view or table: no `v_pub_` and no `catalog.` SQL (08 R25 / P-21; CR-C16-013 read withdrawn)', () => {
    for (const { f, t } of all()) {
      expect(t, f).not.toMatch(/catalog\.v_pub_/);
      expect(t, f).not.toMatch(/\b(FROM|JOIN)\s+catalog\./i);
    }
    const m = all().filter(({ t }) => /membership/i.test(t) && /getPriceListStatus/.test(t));
    expect(m.length, 'getPriceListStatus is called by the membership code through the port').toBeGreaterThan(0);
  });
  it('the price list is validated through ctx.ports.CatalogPort only; no import of another module\'s internals', () => {
    const t = readFileSync(svc, 'utf8');
    expect(t).toMatch(/CatalogPort/);
    expect(t).not.toMatch(/from\s+['"][^'"]*modules\/(catalog|frontdesk|identity)\//);
    expect(t).not.toMatch(/from\s+['"]\.\.\/\.\.\/(catalog|frontdesk|identity)\//);
  });
  it('card_token comes from a CSPRNG (node:crypto randomBytes / randomInt / getRandomValues), never Math.random or a timestamp/uuid derivation; Crockford alphabet without I L O U', () => {
    const t = readFileSync(svc, 'utf8');
    expect(t).toMatch(/randomBytes|randomInt|getRandomValues|webcrypto/);
    expect(t).not.toMatch(/Math\.random/);
    expect(t).toMatch(/0123456789ABCDEFGHJKMNPQRSTVWXYZ/);
  });
  it('card_token and card_no are never passed to a logger or console', () => {
    const t = readFileSync(svc, 'utf8');
    expect(t).not.toMatch(/console\./);
    expect(t).not.toMatch(/log\??\.(info|warn|error|debug)\([^)]*(card_token|cardToken|card_no|cardNo)/s);
  });
  it('statements bind values: no template-literal SQL that interpolates card_token / card_no / reason_code', () => {
    const t = readFileSync(svc, 'utf8');
    expect(t).not.toMatch(/`[^`]*\b(SELECT|UPDATE|INSERT)\b[^`]*\$\{\s*(input|body|b|req\.body)?\.?(card_token|cardToken|card_no|cardNo|reason_code|reasonCode)/is);
  });
  it('the lookup writes the access log with the 08 §4.4 code patient_membership.lookup', () => {
    expect(readFileSync(svc, 'utf8')).toMatch(/patient_membership\.lookup/);
  });
});
