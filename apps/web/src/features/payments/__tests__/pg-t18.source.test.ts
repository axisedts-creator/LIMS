// PG-T18 — structure / copy / help of apps/web/src/app/(staff)/payments/{review,intents/[intent_id]} and features/payments (04-UI-UX §2, §2.1–2.2, §7;
// 06-PLAN row PG-T18 "help files"; C0 server-only rule). Static checks only (no rendering).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const routes = { review: join(web, 'src/app/(staff)/payments/review'), detail: join(web, 'src/app/(staff)/payments/intents/[intent_id]') };
const feat = join(web, 'src/features/payments');
const read = (p: string) => readFileSync(p, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (s: string) => [...strip(s).matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__tests__' ? [] : walk(join(d, n))) : [join(d, n)])) : []);
const code = (d: string) => walk(d).filter((f) => /\.(tsx?|mjs)$/.test(f));

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
      expect(e).toMatch(/digest|requestId|request_id/); // "ErrorState with request id"
      expect(read(join(dir, 'page.tsx'))).not.toMatch(/['"]use client['"]/);
    });
    it(`${name}: loading.tsx uses LoadingSkeleton`, () => {
      expect(read(join(dir, 'loading.tsx'))).toMatch(/LoadingSkeleton/);
    });
  }
  it('review page passes helpKey payments.review; detail page helpKey payments.intent (PageHeader lives in page or its feature component)', () => {
    const all = (d: string) => code(d).map(read).join('\n');
    expect(all(routes.review) + all(feat)).toMatch(/helpKey=["'{]*payments\.review/);
    expect(all(routes.detail) + all(feat)).toMatch(/helpKey=["'{]*payments\.intent/);
  });
});

describe('imports and unsafe patterns (REQ-SEC-068, 07-SECURITY: no tokens / raw payloads / URLs in the browser)', () => {
  const files = () => [...code(routes.review), ...code(routes.detail), ...code(feat)];
  it('only react / next / @lims/ui / @/core / @/features/payments / relative imports; no raw fetch libs, no hand-rolled kit', () => {
    for (const f of files()) {
      for (const i of importsOf(read(f))) expect(i, `${f}: ${i}`).toMatch(/^(react|react-dom|next\/[a-z-]+|server-only|@lims\/ui(\/.*)?|@lims\/shared-ts(\/.*)?|@\/core\/.*|@\/features\/payments\/.*|\.{1,2}\/.*)$/);
    }
  });
  it('no raw HTML injection, no browser storage, no document.cookie, no hand-built bearer header', () => {
    for (const f of files()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
      expect(s, f).not.toMatch(/authorization|Bearer /i);
    }
  });
  it("server read/write modules start with 'server-only' or 'use server' and are never imported by a client component", () => {
    for (const f of walk(join(feat, 'server')).filter((p) => /\.tsx?$/.test(p))) {
      expect(strip(read(f)), f).toMatch(/^\s*(['"]use server['"];?\s*)?import ['"]server-only['"]|^\s*['"]use server['"]/);
    }
    for (const f of code(join(feat, 'components')).filter((p) => /^\s*['"]use client['"]/.test(strip(read(p)).trimStart()))) {
      for (const i of importsOf(read(f))) expect(i, f).not.toMatch(/\/server\/(read|write)\.server/);
    }
  });
  it('no hex/rgb colours, no raw-payload / callback-token / return-url / secret field names are rendered or read', () => {
    for (const f of files()) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
      expect(s, f).not.toMatch(/callback_token|return_url|returnUrl|raw_payload|payload_raw|api_key|secret_key|payment_url/i);
    }
  });
  it('does not touch the Fonepay-verified / success-before-settled copy (04-UI-UX §7)', () => {
    for (const f of [...files(), ...walk(join(feat, 'help'))]) {
      const s = read(f);
      expect(s, f).not.toMatch(/Payment successful|Fonepay verified|IRD[ -]approved|approved by IRD/i);
    }
  });
  it('status chips use StatusChip kind="payment_intent" for intents; money/date/id via MoneyText/DateText/IdText (no hand-formatted NPR)', () => {
    const all = files().map((f) => strip(read(f))).join('\n');
    expect(all).toMatch(/StatusChip[^>]*kind=["'{]+payment_intent/);
    expect(all).toMatch(/MoneyText/);
    expect(all).toMatch(/DateText/);
    expect(all).toMatch(/IdText/);
    expect(all).not.toMatch(/toFixed\(2\)|\/\s*100\b/); // no paisa→rupee maths in the UI
  });
});

describe('help files (06-PLAN PG-T18 "help files"; PageHeader helpKey → features/payments/help/<name>.md)', () => {
  const help = join(feat, 'help');
  it.each([
    ['review.md', [/under review|held/i, /re-?check/i, /provider/i]],
    ['intent.md', [/mark as paid/i, /mark as failed/i, /re-?check/i, /exceeds the due|exceeds/i, /refund/i, /cancel/i]],
  ] as const)('%s exists and explains the screen in plain words', (name, needles) => {
    const p = join(help, name);
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t.length).toBeGreaterThan(400);
    expect(t).toMatch(/^# /m);
    for (const n of needles) expect(t).toMatch(n);
  });
  it('help never promises a payment is paid before the provider confirms it and never leaks internals', () => {
    for (const f of walk(help)) {
      const t = read(f);
      expect(t, f).not.toMatch(/callback_token|api[_ ]?key|secret|stack trace|SELECT |INSERT /i);
    }
  });
});
