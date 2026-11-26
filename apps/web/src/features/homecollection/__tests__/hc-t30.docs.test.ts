// HC-T30 — DoD §3.8 (manual pages + in-app help for every screen) and the presence/shape of the TRD §15 "E2E nightly" deliverables (DoD §5.2).
// Spec: 04-UI-UX §6 (help keys homecollection.{dispatch,visit,handovers,devices,settings}; manual: dispatcher guide, phlebotomist guide incl. lost-phone steps,
// centre handover guide, admin settings), 02-TRD §15 (E2E nightly row; Device row: integration_test). Synthetic data only. Static file checks: they run without a stack.
// The scenario itself is apps/web/src/features/homecollection/tests/e2e/HC-T30.nightly.spec.ts (Playwright; needs the compose stack).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const repo = join(web, '..', '..');
const feat = join(web, 'src', 'features', 'homecollection');
const manualDir = join(repo, 'docs', 'manual', 'homecollection');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] =>
  !existsSync(d) ? [] : readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const manuals = walk(manualDir).filter((f) => f.endsWith('.md'));
const find = (re: RegExp) => manuals.filter((f) => re.test(f.slice(manualDir.length) + '\n' + (read(f).match(/^#\s+.*/m)?.[0] ?? '')));

describe('manual pages (04-UI-UX §6: docs/manual/homecollection/)', () => {
  it('the directory exists with at least the four guides', () => {
    expect(existsSync(manualDir), manualDir).toBe(true);
    expect(manuals.length).toBeGreaterThanOrEqual(4);
  });
  const GUIDES: [string, RegExp][] = [['dispatcher guide', /dispatch/i], ['phlebotomist guide', /phlebotomist/i], ['centre handover guide', /handover/i], ['admin settings', /setting/i]];
  it.each(GUIDES)('%s: a page whose file name or title names it', (_n, re) => { expect(find(re).length).toBeGreaterThanOrEqual(1); });

  it.each(manuals.map((f) => [f.slice(manualDir.length + 1), f]))('%s: has an H1, real content, no placeholders, no PHI/secrets', (_n, f) => {
    const t = read(f);
    expect(t).toMatch(/^#\s+\S/m);
    expect(t.replace(/\s+/g, ' ').length).toBeGreaterThan(400);
    expect(t).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b/i);
    expect(t).not.toMatch(/\+?977[- ]?\d{8,10}\b/); // no real-looking phone numbers
    expect(t).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i); // no e-mail addresses
    expect(t).not.toMatch(/(api[_-]?key|secret|password)\s*[:=]\s*\S{6,}/i);
    expect(t).not.toMatch(/#[0-9a-f]{6}\b/i); // LD-140 spirit: no colour codes in docs
  });

  it('phlebotomist guide has the lost-phone steps (04-UI-UX §6; 06-PLAN risk "lost phone with unsynced collections")', () => {
    const t = find(/phlebotomist/i).map(read).join('\n');
    expect(t).toMatch(/lost|stolen/i);
    expect(t).toMatch(/wipe/i); // admin remote wipe (US-13-5)
    expect(t).toMatch(/dispatch|admin|supervisor|lab/i); // who to tell
    expect(t).toMatch(/manual (collect|collection)|collect(ed)? manually|C5|specimen collection screen/i); // fallback for unsynced tubes (runbook)
  });
  it('dispatcher guide covers every action on the board and the visit page', () => {
    const t = find(/dispatch/i).map(read).join('\n');
    for (const w of [/schedule/i, /assign/i, /unassign/i, /cancel/i, /print labels/i, /show phone/i, /on hold/i, /revisit/i, /missed/i]) expect(t).toMatch(w);
  });
  it('centre handover guide: confirm each tube, barcode, discrepancy', () => {
    const t = find(/handover/i).map(read).join('\n');
    for (const w of [/confirm/i, /barcode/i, /discrepanc|missing|not received/i]) expect(t).toMatch(w);
  });
  it('admin settings page: map hand-off ("Navigate"), device wipe', () => {
    const t = find(/setting/i).map(read).join('\n');
    for (const w of [/navigate/i, /wipe/i, /device/i]) expect(t).toMatch(w);
  });
});

describe('in-app help for every web screen (DoD §3.8)', () => {
  const app = join(web, 'src', 'app', '(staff)', 'homecollection');
  const screens = existsSync(app) ? readdirSync(app).filter((n) => statSync(join(app, n)).isDirectory()) : [];
  const helpName = (s: string) => (s === 'visits' ? 'visit' : s);
  it('screens found', () => { expect([...screens].sort()).toEqual(['applications', 'devices', 'dispatch', 'handovers', 'settings', 'visits']); });   // + applications (PHLEBO-UI-FULL-1)
  it.each(['dispatch', 'visit', 'handovers', 'devices', 'settings', 'applications'])('help/%s.md exists, has Purpose, no placeholders', (n) => {
    const p = join(feat, 'help', `${n}.md`);
    expect(existsSync(p), p).toBe(true);
    const t = read(p);
    expect(t).toMatch(/^# \S/m);
    expect(t).toMatch(/^## Purpose/m);
    expect(t).not.toMatch(/\b(TODO|TBD|FIXME)\b/i);
  });
  it('each screen folder maps to a help file', () => { for (const s of screens) expect(existsSync(join(feat, 'help', `${helpName(s)}.md`)), s).toBe(true); });
});

describe('TRD §15 E2E nightly deliverables (DoD §5.2)', () => {
  const e2e = join(feat, 'tests', 'e2e');
  const specs = walk(e2e).filter((f) => /\.spec\.ts$/.test(f));
  const nightly = specs.find((f) => /nightly/i.test(f));
  it('Playwright nightly scenario spec + config exist', () => {
    expect(nightly, 'a *nightly*.spec.ts under features/homecollection/tests/e2e').toBeTruthy();
    expect(walk(e2e).some((f) => /playwright\.config\.ts$/.test(f))).toBe(true);
  });
  it('the scenario runs the TRD §15 steps in order, uses synthetic data and guards against a duplicate order (06-PLAN risk row, R7)', () => {
    const t = read(nightly!);
    const steps = [/booking/i, /assign/i, /order/i, /specimen|label/i, /offline/i, /sync\/mutations|pushSync/i, /collected/i, /in_transit/i, /ledger|payment/i, /handover/i, /confirm/i, /receive/i];
    let at = 0;
    for (const re of steps) { const m = re.exec(t.slice(at)); expect(m, `step ${re} in order`).toBeTruthy(); at += m!.index + m![0].length; }
    expect(t).toMatch(/exactly one order|duplicate order/i);
    expect(t).not.toMatch(/\+977\d{8,10}/);
  });
  it('the Flutter device scenario exists under apps/phlebo_app/integration_test (offline visit, airplane-mode push retry)', () => {
    const dir = join(repo, 'apps', 'phlebo_app', 'integration_test');
    const dart = walk(dir).filter((f) => f.endsWith('_test.dart'));
    expect(dart.length, dir).toBeGreaterThanOrEqual(1);
    const t = dart.map(read).join('\n');
    expect(t).toMatch(/IntegrationTestWidgetsFlutterBinding/);
    expect(t).toMatch(/offline/i);
    expect(t).toMatch(/airplane|retry/i);
    expect(t).toMatch(/SQLite format 3/); // forensic check: cache.db/outbox.db are not plaintext SQLite (TRD §15 Device row)
  });
});
