// C6-T42 static checks of apps/portal for the dues payment pages (02-TRD §3.5/§6.6 PP1-PP2, 03-APP-FLOW §2.7-2.8; 07-SECURITY REQ-SEC-046/059). node:test, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', 'apps', 'portal', 'src');
const files = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : [p]; }) : []);
const code = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const R = (...p) => join(root, 'app', 'r', ...p);

test('route skeleton: POST /r/[token]/pay, status page, done page (route portal.payment_done)', () => {
  assert.ok(existsSync(R('[token]', 'pay', 'route.ts')), 'apps/portal/src/app/r/[token]/pay/route.ts');
  assert.ok(existsSync(R('[token]', 'payments', '[id]', 'page.tsx')), 'r/[token]/payments/[id]/page.tsx');
  assert.ok(existsSync(R('payments', '[id]', 'done', 'page.tsx')), 'r/payments/[id]/done/page.tsx');
});

test('pay route: POST only, forwards {gateway} only to PP1 with an Idempotency-Key from the hidden form nonce, redirects 303; no amount field is read', () => {
  const f = R('[token]', 'pay', 'route.ts'); assert.ok(existsSync(f)); const s = code(f);
  assert.match(s, /export\s+(async\s+)?function\s+POST|export\s+const\s+POST/); assert.doesNotMatch(s, /export\s+(async\s+)?function\s+(GET|PUT|PATCH|DELETE)\b/);
  assert.match(s, /\/portal\/payment-requests/); assert.match(s, /[Ii]dempotency-Key/); assert.match(s, /303/);
  assert.doesNotMatch(s, /amount/i, 'the amount is never read from the form or sent (REQ-SEC-046)');
});

test('done page never reads or renders the gateway `outcome` (REQ-SEC-059)', () => {
  const f = R('payments', '[id]', 'done', 'page.tsx'); assert.ok(existsSync(f)); const s = code(f);
  assert.doesNotMatch(s, /outcome/); assert.match(s, /payment-requests/);
});

test('portal code never touches BillingPort / PaymentProviderPort and never logs the gateway URL / action_url', () => {
  for (const f of files(root).filter((x) => /\.(ts|tsx)$/.test(x))) {
    const s = code(f); assert.doesNotMatch(s, /BillingPort|PaymentProviderPort/, f);
    assert.doesNotMatch(s, /console\.\w+\([^)]*(action_url|actionUrl)/, f);
  }
});

test('the gateway link is a plain anchor with rel noreferrer (Referrer-Policy: no-referrer on the status page, 03-APP-FLOW §2.7)', () => {
  const f = R('[token]', 'payments', '[id]', 'page.tsx'); assert.ok(existsSync(f)); const s = code(f);
  assert.match(s, /Continue to/); assert.match(s, /noreferrer|no-referrer/); assert.match(s, /action_url/);
});
