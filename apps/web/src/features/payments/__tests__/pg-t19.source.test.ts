// PG-T19 — structure / copy / help of apps/web/src/app/(staff)/payments/{refunds,reconciliation,static-qr,settings} and features/payments (04-UI-UX §2, §2.3–2.6, §6, §7;
// 06-PLAN row PG-T19 "component tests; axe"; C0 server-only rule; REQ-SEC-058 write-only secret). Static checks only (no rendering).
// NOTE for the writer: pg-t18.source.test.ts scans ALL of features/payments (code + help): code may not contain secret_key|api_key|return_url|payment_url|callback_token|raw_payload,
// and help/*.md may not contain the words "secret" or "api key" — say "key" in the settings help.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const base = join(web, 'src/app/(staff)/payments');
const routes = { refunds: join(base, 'refunds'), reconciliation: join(base, 'reconciliation'), 'static-qr': join(base, 'static-qr'), settings: join(base, 'settings') };
const HELP_KEY: Record<string, string> = { refunds: 'payments.refunds', reconciliation: 'payments.reconciliation', 'static-qr': 'payments.static_qr', settings: 'payments.settings' };
const feat = join(web, 'src/features/payments');
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (s: string) => [...strip(s).matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__tests__' ? [] : walk(join(d, n))) : [join(d, n)])) : []);
const code = (d: string) => walk(d).filter((f) => /\.(tsx?|mjs)$/.test(f));
const T19_COMPONENTS = ['RefundsList', 'RefundRequestDialog', 'ReconciliationView', 'StaticQrView', 'SettingsView'].map((n) => join(feat, 'components', `${n}.tsx`));

describe('component files exist (names are the contract the tests import)', () => {
  it.each(T19_COMPONENTS)('%s', (f) => { expect(existsSync(f), f).toBe(true); });
});

describe('route files (04-UI-UX §2: every page has PageHeader helpKey, loading.tsx, error.tsx)', () => {
  for (const [name, dir] of Object.entries(routes)) {
    it.each(['page.tsx', 'loading.tsx', 'error.tsx'])(`${name}/%s exists`, (f) => {
      expect(existsSync(join(dir, f))).toBe(true);
    });
    it(`${name}: error.tsx is a client component using ErrorState with onRetry and request id; page/loading are not client`, () => {
      const e = read(join(dir, 'error.tsx'));
      expect(strip(e).trimStart().startsWith("'use client'")).toBe(true);
      expect(e).toMatch(/ErrorState/);
      expect(e).toMatch(/onRetry=\{reset\}/);
      expect(e).toMatch(/digest|requestId|request_id/);
      expect(read(join(dir, 'page.tsx'))).not.toMatch(/['"]use client['"]/);
    });
    it(`${name}: loading.tsx uses LoadingSkeleton`, () => {
      expect(read(join(dir, 'loading.tsx'))).toMatch(/LoadingSkeleton/);
    });
    it(`${name}: the page (or its feature component) passes helpKey ${HELP_KEY[name]}`, () => {
      const all = [...code(dir), ...code(join(feat, 'components'))].map(read).join('\n');
      expect(all).toMatch(new RegExp(`helpKey=["'{]*${HELP_KEY[name]!.replace('.', '\\.')}`));
    });
    it(`${name}: page checks the permission before any API call (notFound / PermissionDenied) and never reads a token itself`, () => {
      const p = strip(read(join(dir, 'page.tsx')));
      expect(p).toMatch(/notFound\(\)|PermissionDenied/);
      expect(p).toMatch(/getShellSession/);
      expect(p).not.toMatch(/getAccessToken|authorization|Bearer /i);
    });
  }
});

describe('imports and unsafe patterns (REQ-SEC-068, REQ-SEC-058, 07-SECURITY: no tokens / raw payloads / secrets in the browser)', () => {
  const files = () => [...Object.values(routes).flatMap(code), ...T19_COMPONENTS.filter(existsSync)];
  it('only react / next / @lims/ui / @/core / @/features/payments / relative imports; no raw fetch libs', () => {
    for (const f of files()) for (const i of importsOf(read(f))) expect(i, `${f}: ${i}`).toMatch(/^(react|react-dom|next\/[a-z-]+|server-only|@lims\/ui(\/.*)?|@lims\/shared-ts(\/.*)?|@\/core\/.*|@\/features\/payments\/.*|\.{1,2}\/.*)$/);
  });
  it('no raw HTML injection, browser storage, document.cookie, console logging, hand-built bearer header or hand-rolled table / select / dialog / textarea', () => {
    for (const f of files()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
      expect(s, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(s, f).not.toMatch(/authorization|Bearer /i);
      expect(s, f).not.toMatch(/<(table|select|dialog|textarea)[\s>]/);
    }
  });
  it('no hex/rgb colours; no callback-token / return-url / raw-payload / payment-url field is read or rendered', () => {
    for (const f of files()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
      expect(s, f).not.toMatch(/callback_token|return_url|returnUrl|raw_payload|payload_raw|payment_url/i);
    }
  });
  it('the secret is write-only: nothing reads a secret value / ciphertext / nonce from a DTO, and no code stores it', () => {
    for (const f of [...files(), ...code(join(feat, 'server'))]) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/secret\??\.value|secret_plain|secret_ciphertext|secret_nonce|secret_auth_tag|secret_key|api_key/);
    }
  });
  it('settings: the secret input is a password-type control (type="password" or the SecretField kit component) with autocomplete off/new-password', () => {
    const s = strip(read(join(feat, 'components', 'SettingsView.tsx')));
    expect(s).toMatch(/type=["']password["']|SecretField/);
    expect(s).toMatch(/autoComplete=["'](off|new-password)["']|SecretField/);
  });
  it('copy: no "Payment successful" / "Fonepay verified" / IRD claim in code or help', () => {
    for (const f of [...files(), ...walk(join(feat, 'help'))]) expect(read(f), f).not.toMatch(/Payment successful|Fonepay verified|IRD[ -]approved|approved by IRD/i);
  });
  it('uses the kit for the things the spec names: StatusChip(generic) for refunds/findings, MoneyText/DateText/IdText, ConfirmDialog, Tabs, StatTile, Switch, Banner, DatePicker, MoneyField, DataTable, FilterBar, Card', () => {
    const all = files().map((f) => strip(read(f))).join('\n');
    for (const k of ['StatusChip', 'MoneyText', 'DateText', 'IdText', 'ConfirmDialog', 'Tabs', 'StatTile', 'Switch', 'Banner', 'DatePicker', 'MoneyField', 'DataTable', 'FilterBar', 'Card']) expect(all, k).toMatch(new RegExp(`\\b${k}\\b`));
    expect(all).toMatch(/StatusChip[^>]*kind=["'{]+generic/);
  });
});

describe('help files (06-PLAN: PageHeader helpKey → features/payments/help/<suffix>.md, same naming as billing/lab: refunds.md, reconciliation.md, static_qr.md, settings.md)', () => {
  const help = join(feat, 'help');
  it.each([
    ['refunds.md', [/approve/i, /second person|two people|two-person/i, /re-?check/i, /confirm/i, /provider|gateway/i, /reject/i, /failed/i]],
    ['reconciliation.md', [/run now/i, /finding/i, /critical/i, /resolve/i, /business date|nightly/i]],
    ['static_qr.md', [/worksheet/i, /bank statement/i, /not available yet|not live/i, /difference/i, /note/i]],
    ['settings.md', [/\bkey\b/i, /test connection/i, /UAT|production/i, /Fonepay/i, /refund/i, /enabled|enable/i]],
  ] as const)('%s exists and explains the screen in plain words', (name, needles) => {
    const p = join(help, name);
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(400);
    expect(t).toMatch(/^# /m);
    for (const n of needles) expect(t).toMatch(n);
  });
  it('help never leaks internals, never promises success before the provider confirms, never implies Fonepay is live', () => {
    for (const f of walk(help)) {
      const t = read(f);
      expect(t, f).not.toMatch(/callback_token|api[_ ]?key|secret|stack trace|SELECT |INSERT /i);
    }
    expect(read(join(help, 'static_qr.md'))).not.toMatch(/Fonepay[^.]{0,30}(is live|verified)/i);
  });
});
