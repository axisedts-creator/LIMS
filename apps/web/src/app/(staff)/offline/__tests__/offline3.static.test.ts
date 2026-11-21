// T0D-OFFLINE-3 (LD-322; brief "additive offline paths", at most 28 files, nothing under pinned paths): the existing screens are WIRED to the adapters.
// Source scans, because the screens call server actions and need a live API; the behaviour of every part is proven in offline3.{numbers,flows,outage,ui}.
// Fails now: none of the wiring exists yet.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/
const src = (p: string) => join(web, 'src', p);
const read = (p: string) => (existsSync(src(p)) ? readFileSync(src(p), 'utf8') : '');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
// boolean checks: a failure names the file and the wording, it never dumps the whole source
const has = (s: string, re: RegExp, what: string) => expect(re.test(s), `${what} must match ${re}`).toBe(true);
const lacks = (s: string, re: RegExp, what: string) => expect(re.test(s), `${what} must not match ${re}`).toBe(false);

describe('the adapter modules exist, are exported, and cite their decisions', () => {
  const files = ['core/offline/numbers.ts', 'core/offline/flows.ts', 'core/offline/guards.ts', 'core/offline/ui/OfflineParts.tsx'];
  it('numbers.ts, flows.ts, guards.ts and ui/OfflineParts.tsx are there; the barrel re-exports the three modules', () => {
    for (const f of files) expect(existsSync(src(f)), f).toBe(true);
    const barrel = read('core/offline/index.ts');
    for (const m of ['numbers', 'flows', 'guards']) has(barrel, new RegExp(`from\\s+['"]\\./${m}['"]`), `index.ts re-export of ${m}`);
  });
  it('numbers.ts and flows.ts cite LD-322 in a comment (binding decisions are cited in code)', () => {
    has(read('core/offline/numbers.ts'), /LD-322/, 'numbers.ts');
    has(read('core/offline/flows.ts'), /LD-322/, 'flows.ts');
  });
  it('no browser storage, no cookies, no console output, no test-only library in the adapters (personal data stays in the encrypted store)', () => {
    for (const f of files) {
      expect(existsSync(src(f)), f).toBe(true);
      const s = read(f);
      lacks(s, /localStorage|sessionStorage|document\.cookie|\bconsole\./, f);
      lacks(s, /fake-indexeddb/, f);
    }
  });
  it('the texts the parts show come from the message catalogue, not literals', () => {
    const parts = read('core/offline/ui/OfflineParts.tsx');
    has(read('core/i18n/messages.ts'), /pending sync/i, 'messages.ts');
    has(read('core/i18n/messages.ts'), /issued offline/i, 'messages.ts');
    has(parts, /\bt\(|\btf\(/, 'OfflineParts.tsx uses t()');
    lacks(parts, /['">]Pending sync['"<]/, 'OfflineParts.tsx literal');
  });
});

describe('the op envelope carries reserved_numbers to the server', () => {
  it('outbox.ts OperationInput and engine.ts WIRE_KEYS include reserved_numbers (assertReservedInDeviceBlocks reads it)', () => {
    has(read('core/offline/outbox.ts'), /reserved_numbers/, 'outbox.ts');
    has(read('core/offline/engine.ts'), /WIRE_KEYS[^\n]*reserved_numbers/, 'engine.ts WIRE_KEYS');
  });
});

describe('the screens use the adapters', () => {
  it('registration: RegistrationForm reads the offline flows, saves through registerOrder and warns with BlockWarning', () => {
    const s = read('features/frontdesk/components/RegistrationForm.tsx');
    for (const w of ['useOfflineFlows', 'registerOrder', 'BlockWarning']) has(s, new RegExp(w), `RegistrationForm.tsx ${w}`);
  });
  it('billing: the success panel and the receipt and invoice print views show DocNumber; both print views carry the watermark', () => {
    has(read('features/frontdesk/components/SuccessPanel.tsx'), /DocNumber/, 'SuccessPanel.tsx');
    for (const f of ['features/billing/components/print/ReceiptPrintView.tsx', 'features/billing/components/print/InvoicePrintView.tsx']) {
      has(read(f), /DocNumber/, f); has(read(f), /IssuedOfflineWatermark/, f);
    }
  });
  it('collection and accession: CollectDispatch queues markCollected, ReceiveScreen queues receiveSpecimen, both show the Pending sync badge', () => {
    const c = read('features/lab/components/CollectDispatch.tsx'); const r = read('features/lab/components/ReceiveScreen.tsx');
    has(c, /markCollected/, 'CollectDispatch markCollected'); has(c, /PendingSyncBadge/, 'CollectDispatch badge');
    has(r, /receiveSpecimen/, 'ReceiveScreen receiveSpecimen'); has(r, /PendingSyncBadge/, 'ReceiveScreen badge');
  });
  it('online only actions: order cancel and refund are gated with useOnlineOnly', () => {
    has(read('features/frontdesk/components/OrderView.tsx'), /useOnlineOnly\(\s*['"]order\.cancel['"]/, 'OrderView cancel');
    const billing = walk(src('features/billing/components')).filter((f) => /\.tsx$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    has(billing, /useOnlineOnly\(\s*['"]order\.refund['"]/, 'billing refund');
  });
  it('the lab code label says PENDING for a provisional code', () => {
    const labels = walk(src('features/lab/components/labels')).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    has(labels, /PENDING/, 'label sources');
  });
});

describe('task bounds: at most 28 files in all, nothing under the pinned paths', () => {
  const changed = () => {
    const wt = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: web, encoding: 'utf8' });
    if (wt.status !== 0) return null; // not a git checkout
    return (wt.stdout ?? '').split('\n').map((l) => l.slice(3).trim().replace(/\\/g, '/')).filter(Boolean);
  };
  it('nothing changed under features/admin, features/platform, app/(auth), app/(platform) (rs-c2.static pins them)', () => {
    const files = changed(); if (!files) return;
    expect(files.filter((f) => /apps\/web\/src\/(features\/(admin|platform)\/|app\/\((auth|platform)\)\/)/.test(f))).toEqual([]);
  });
  it('the working tree changes at most 28 files outside tests and notes', () => {
    const files = changed(); if (!files) return;
    const mine = files.filter((f) => !/__tests__\/|\.test\.|(^|\/)\.orchestra\//.test(f));
    expect(mine.length, mine.join('\n')).toBeLessThanOrEqual(28);
  });
});
