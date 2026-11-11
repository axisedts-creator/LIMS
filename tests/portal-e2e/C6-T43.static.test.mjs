// C6-T43 static checks of apps/portal for the dues page (02-TRD §6.6 P2/P7, 03-APP-FLOW §2 row 5a, 04-UI-UX §4 "Dues page"; 08 A21.1; AC-18.9). node:test, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', 'apps', 'portal', 'src');
const files = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; }) : []);
const code = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const PAGE = join(root, 'app', 'r', '[token]', 'dues', 'page.tsx');

test('route /r/[token]/dues exists (page.tsx under apps/portal/src/app/r/[token]/dues)', () => {
  assert.ok(existsSync(PAGE), PAGE);
});

test('dues page: session-gated, reads ONLY P7 /portal/dues (never /portal/report, never the PDF), no report content, no Download', () => {
  assert.ok(existsSync(PAGE)); const s = code(PAGE);
  assert.match(s, /getSession/); assert.match(s, /redirect\(/); assert.match(s, /['"`]\/portal\/dues['"`]/);
  assert.doesNotMatch(s, /\/portal\/report\b|\/download|Download|panel_names|patient_display|status_label|smart_summary/);
});

test('dues page copy (04-UI-UX §4): title, amount card, "report will be sent", counter copy, zero-balance copy', () => {
  assert.ok(existsSync(PAGE)); const s = readFileSync(PAGE, 'utf8');
  for (const t of ['Payment due', 'Amount due: NPR', 'Your report will be sent once payment is complete.', 'Please pay at the lab counter or in the app.', 'Payment received']) assert.ok(s.includes(t), `missing copy: ${t}`);
  assert.match(s, /Pay with/); assert.match(s, /\/pay/);                                  // same PP1 form route as the report-page dues card
});

test('verifyCode routes a dues session to /r/{token}/dues (link_purpose from P2), a report session to /report', () => {
  const s = code(join(root, 'features', 'portal', 'actions.ts'));
  assert.match(s, /link_purpose/); assert.match(s, /\/dues/); assert.match(s, /\/report/);
  assert.doesNotMatch(s, /dues-purpose links \(C15\) go to the report page/);
});

test('the dues page never touches BillingPort / PaymentProviderPort and sends no amount', () => {
  assert.ok(existsSync(PAGE)); const s = code(PAGE); assert.doesNotMatch(s, /BillingPort|PaymentProviderPort/); assert.doesNotMatch(s, /name=["']amount["']/);
  for (const f of files(root).filter((x) => /\.(ts|tsx)$/.test(x))) assert.doesNotMatch(code(f), /BillingPort|PaymentProviderPort/, f);
});
