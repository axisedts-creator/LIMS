// C13.T14 — partner slip page PR-2 (/reports/{report_id}/slip; 04-UI-UX PR-2; 03-APP-FLOW §5.5; 08 A5.3, A19 D-105). ACs: US-09.4 (poll every 1 s, give up after 30 s), US-09.5 (no-phone warning), US-09.6.
// LD-140 (UI): screens only from packages/ui components and tokens: no hex colours, no inline style objects, no pixel radii in feature code.
// No jsdom in this package, so the page is proven through (1) the polling function with fake timers, (2) a scan of the slip feature sources for the specified texts and the LD-140 / no-secret rules.
// SEAMS (spec does not fix them; the writer follows them or disputes):
//  - polling lives in apps/partner/src/core/slip-poll.ts: `SLIP_POLL_INTERVAL_MS = 1000`, `SLIP_POLL_TIMEOUT_MS = 30000` and
//    `pollAccessSlip(fetchSlip: () => Promise<{ state: string; [k: string]: unknown }>): Promise<{ slip: <last slip>; timedOut: boolean }>` using the global timers (setTimeout/setInterval, so fake timers drive it):
//    first fetch at once, then one fetch per second while state is `requested`; resolves as soon as the state is issued | failed | expired (timedOut false); gives up 30 s after the start (timedOut true, last slip returned) and fetches no more.
//  - the page is the file .../reports/[report_id]/slip/page.tsx under apps/partner/src/app (route group free); every file under a directory named `slip` (and slip-poll.ts) is a "slip feature source".
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const norm = (p: string) => p.split(sep).join('/');
const featureFiles = () => walk(SRC).filter((p) => /\.(tsx?|css)$/.test(p)).filter((p) => /\/slip\//.test(norm(p)) || /\/slip-poll\.ts$/.test(norm(p)));
const pageFile = () => walk(SRC).find((p) => /\/reports\/\[report_id\]\/slip\/page\.tsx$/.test(norm(p)));
const source = () => featureFiles().map((p) => readFileSync(p, 'utf8')).join('\n');

afterEach(() => { vi.useRealTimers(); });

describe('slip polling: every 1 s, give up after 30 s (accepted, 08 A5.3)', () => {
  const load = async () => import('../../src/core/slip-poll');
  const slip = (state: string) => ({ id: 'S', report_id: 'R', version_no: 1, state });

  it('constants: 1000 ms interval, 30000 ms limit', async () => {
    const m = await load();
    expect(m.SLIP_POLL_INTERVAL_MS).toBe(1000);
    expect(m.SLIP_POLL_TIMEOUT_MS).toBe(30000);
  });

  it('polls once per second while requested; resolves at once with the slip when it is issued', async () => {
    vi.useFakeTimers(); const { pollAccessSlip } = await load();
    const stamps: number[] = []; let n = 0;
    const fetchSlip = vi.fn(async () => { stamps.push(Date.now()); return slip(++n < 4 ? 'requested' : 'issued'); });
    const p = pollAccessSlip(fetchSlip);
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.slip.state).toBe('issued');
    expect(fetchSlip).toHaveBeenCalledTimes(4);
    expect(stamps.slice(1).map((t, i) => t - stamps[i]!)).toEqual([1000, 1000, 1000]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchSlip).toHaveBeenCalledTimes(4); // stops after the terminal state
  });

  it('failed and expired are terminal too', async () => {
    vi.useFakeTimers(); const { pollAccessSlip } = await load();
    for (const state of ['failed', 'expired']) {
      const f = vi.fn(async () => slip(state)); const p = pollAccessSlip(f);
      await vi.advanceTimersByTimeAsync(5000);
      expect((await p).slip.state).toBe(state); expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('gives up after 30 s of `requested`: still pending at 29 s, timedOut at 30 s with the last slip, no fetch afterwards', async () => {
    vi.useFakeTimers(); const { pollAccessSlip } = await load();
    const f = vi.fn(async () => slip('requested')); let done: { slip: { state: string }; timedOut: boolean } | undefined;
    void pollAccessSlip(f).then((x) => { done = x; });
    await vi.advanceTimersByTimeAsync(29_000); expect(done).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500); expect(done).toMatchObject({ timedOut: true, slip: { state: 'requested' } });
    const calls = f.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(30); expect(calls).toBeLessThanOrEqual(32);
    await vi.advanceTimersByTimeAsync(20_000); expect(f).toHaveBeenCalledTimes(calls);
  });
});

describe('slip page PR-2: texts, no-phone warning, LD-140, no secret in the browser', () => {
  it('the slip page exists at /reports/[report_id]/slip', () => {
    expect(pageFile(), 'apps/partner/src/app/**/reports/[report_id]/slip/page.tsx').toBeTruthy();
    expect(existsSync(join(SRC, 'core', 'slip-poll.ts'))).toBe(true);
  });

  it('shows every specified text (04-UI-UX PR-2) incl. the D-105 warning with its key partners.slip.no_phone_warning', () => {
    const s = source();
    for (const t of ['Preparing the slip…', 'The slip is taking longer than usual. Check again in a minute.', 'Check again', 'Download slip (PDF)', 'Link valid until',
      'The slip opens only if the lab has a mobile number for this patient.', 'partners.slip.no_phone_warning', 'A slip cannot be made for this report.',
      'This report has a newer version. Make the slip from the latest version.', 'This slip has expired.', 'reporting.report_superseded']) expect(s, t).toContain(t);
  });

  it('LD-140: no hex colour, no inline style object, no pixel radius; components come from @lims/ui', () => {
    const s = source();
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(s).not.toMatch(/style=\{\{/);
    expect(s).not.toMatch(/border-?[rR]adius\s*:|rounded-\[\d+px\]/);
    expect(s).toMatch(/@lims\/ui/);
  });

  it('the browser never handles a link: no portal url / token field, no QR library, the PDF comes from the R6 route', () => {
    const s = source();
    expect(s).not.toMatch(/portalUrl|portal_url|link_token|\.url\b|signedUrl/);
    expect(s).not.toMatch(/from ['"](qrcode|qrcode\.react|react-qr-code|qr-code-styling|qrious)/);
    expect(s).toMatch(/access-slips/);
  });
});

describe('no QR / PDF library in C13 (08 A5.1: C6 draws the QR in the slip PDF)', () => {
  it('apps/partner, services/api and services/worker package.json add none', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    for (const p of ['apps/partner', 'services/api', 'services/worker']) {
      const pkg = JSON.parse(readFileSync(join(root, p, 'package.json'), 'utf8'));
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
      expect(deps.filter((d) => /qr|pdfkit|pdf-lib|jspdf|puppeteer|playwright-core|bwip/i.test(d)), p).toEqual([]);
    }
  });
});
