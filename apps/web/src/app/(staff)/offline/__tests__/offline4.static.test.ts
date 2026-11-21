// T0D-OFFLINE-4 (LD-322; brief "additive offline paths", at most 28 files, nothing under pinned paths): the existing screens are WIRED to the adapters.
// Source scans, because the screens call server actions and need a live API; the behaviour is proven in offline4.{policy,flows,print,outage,ui}.
// Fails now: none of the modules or the wiring exists.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/
const src = (p: string) => join(web, 'src', p);
const read = (p: string) => (existsSync(src(p)) ? readFileSync(src(p), 'utf8') : '');
const has = (s: string, re: RegExp, what: string) => expect(re.test(s), `${what} must match ${re}`).toBe(true);
const lacks = (s: string, re: RegExp, what: string) => expect(re.test(s), `${what} must not match ${re}`).toBe(false);

describe('the adapter modules exist, are exported, and cite their decisions', () => {
  const files = ['core/offline/labflows.ts', 'core/offline/cashflows.ts'];
  it('labflows.ts and cashflows.ts exist and the barrel re-exports them', () => {
    for (const f of files) expect(existsSync(src(f)), f).toBe(true);
    const barrel = read('core/offline/index.ts');
    for (const m of ['labflows', 'cashflows']) has(barrel, new RegExp(`from\\s+['"]\\./${m}['"]`), `index.ts re-export of ${m}`);
  });
  it('both cite LD-322 in a comment', () => { for (const f of files) has(read(f), /LD-322/, f); });
  it('no browser storage, no cookies, no console output, no test-only library (personal data stays in the encrypted store)', () => {
    for (const f of [...files, 'core/offline/ui/OfflineParts.tsx']) {
      const s = read(f); expect(s.length, f).toBeGreaterThan(0);
      lacks(s, /localStorage|sessionStorage|document\.cookie|\bconsole\./, f); lacks(s, /fake-indexeddb/, f);
    }
  });
  it('the policy is not re-implemented from literals of the online messages in two places: the refusal texts live in the message catalogue', () => {
    const m = read('core/i18n/messages.ts');
    has(m, /A different person must sign it next/, 'messages.ts'); has(m, /Someone else must sign it off/, 'messages.ts'); has(m, /must come from a pathologist/, 'messages.ts');
    has(m, /recall/i, 'messages.ts (recall banner)');
    has(read('core/offline/labflows.ts'), /\bt\(/, 'labflows.ts uses t()');
  });
});

describe('the screens use the adapters', () => {
  it('result entry (ResultGrid): reads the offline flows, queues enterResults when offline, shows the Pending sync badge', () => {
    const s = read('features/lab/components/grid/ResultGrid.tsx');
    for (const w of ['useOfflineFlows', 'enterResults', 'PendingSyncBadge']) has(s, new RegExp(w), `ResultGrid.tsx ${w}`);
  });
  it('verification (QueueScreen): checks the sign off locally, queues verifyResult, shows the reason and the badge', () => {
    const s = read('features/lab/components/QueueScreen.tsx');
    for (const w of ['useOfflineFlows', 'checkVerify', 'verifyResult', 'PendingSyncBadge']) has(s, new RegExp(w), `QueueScreen.tsx ${w}`);
  });
  it('report print (ReportDetailView): printReport offline, the marker and recall banner', () => {
    const s = read('features/reporting/components/ReportDetailView.tsx');
    for (const w of ['useOfflineFlows', 'printReport', 'ReportOfflineMarker']) has(s, new RegExp(w), `ReportDetailView.tsx ${w}`);
  });
  it('daily cash (DailyCashView): closeDay offline, Pending sync and the conflict shown', () => {
    const s = read('features/billing/components/DailyCashView.tsx');
    for (const w of ['useOfflineFlows', 'closeDay', 'PendingSyncBadge']) has(s, new RegExp(w), `DailyCashView.tsx ${w}`);
  });
  it('ReportOfflineMarker is exported by ui/OfflineParts.tsx and uses flows.reportStatus', () => {
    const s = read('core/offline/ui/OfflineParts.tsx');
    has(s, /export function ReportOfflineMarker/, 'OfflineParts.tsx'); has(s, /reportStatus/, 'OfflineParts.tsx');
  });
  it('the Offline panel words a recall (result.verify rejected with sync.verification_policy_failed)', () => {
    has(read('core/offline/ui/OfflinePanel.tsx'), /verification_policy_failed|offline\.recall/, 'OfflinePanel.tsx');
  });
});

describe('task bounds: at most 28 files in all, nothing under the pinned paths, core/offline stays within its 28 file cap', () => {
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
