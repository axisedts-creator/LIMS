// @vitest-environment jsdom
// C9.T-21 — polling with visibility (04-UI-UX §1 "Polling"; 03-APP-FLOW §4 + E20; AC-08.3; 04-UI-UX §4 live regions).
//   status board + LJ chart poll every 15 s, only while document.visibilityState === 'visible'; "Updated hh:mm:ss" next to the title; on failure the last data stays with
//   the banner "Connection lost — showing data from hh:mm" and a retry with backoff 5 s, 15 s, 30 s; live region announces only changes of the out-of-control count.
// ASSUMED contract: the client polls through a server action (JWT stays server-side, REQ-SEC-068), i.e. the poll ends in serverFetch -> global fetch of GET /v1/quality/qc-status
//   resp. /v1/quality/lj-chart. Here global `fetch` is stubbed (no MSW, so fake timers are safe) and counted per path. Pages render through the same stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen } from '@testing-library/react';
import {
  PLAN_1, STATUS_ROWS, ljDto, pageText, pt, resetApi, show, statusRow, PERM_READ, LEVEL_1,
} from './quality-t21.harness';

vi.mock('next/navigation', async () => (await import('./quality-t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t21.harness')).sessionMock);

const STATUS = '/v1/quality/qc-status';
const LJ = '/v1/quality/lj-chart';
const feed: Record<string, () => { status: number; body: unknown }> = {};
const hits: Record<string, number> = {};
const hit = (p: string) => hits[p] ?? 0;

let visible = true;
const setVisible = (v: boolean) => {
  visible = v;
  document.dispatchEvent(new Event('visibilitychange'));
};
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-14T04:00:00.000Z') });
  resetApi(PERM_READ);
  for (const k of Object.keys(hits)) delete hits[k];
  for (const k of Object.keys(feed)) delete feed[k];
  feed[STATUS] = () => ({ status: 200, body: { data: STATUS_ROWS, page: { limit: 50 } } });
  feed[LJ] = () => ({ status: 200, body: ljDto() });
  visible = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    const p = new URL(String(input)).pathname;
    hits[p] = (hits[p] ?? 0) + 1;
    const f = feed[p];
    const r = f ? f() : { status: 503, body: { type: 'urn:lims:error:common.dependency_unavailable', title: 'x', status: 503, code: 'common.dependency_unavailable' } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('status board polling (15 s, only while visible)', () => {
  it('first poll at 15 s (not before), then every 15 s', async () => {
    await show('page');
    expect(hit(STATUS)).toBe(1); // the server render
    await tick(14_500);
    expect(hit(STATUS)).toBe(1);
    await tick(1_000); // 15.5 s
    expect(hit(STATUS)).toBe(2);
    await tick(45_000); // 60.5 s
    expect(hit(STATUS)).toBeGreaterThanOrEqual(5);
    expect(hit(STATUS)).toBeLessThanOrEqual(6);
  });

  it('hidden tab: NO requests while hidden; becoming visible again refreshes within one period', async () => {
    await show('page');
    setVisible(false);
    await tick(120_000);
    expect(hit(STATUS)).toBe(1);
    setVisible(true);
    await tick(15_500);
    expect(hit(STATUS)).toBeGreaterThanOrEqual(2);
  });

  it('unmounting (leaving the page) stops polling', async () => {
    const v = await show('page');
    await tick(15_500);
    const n = hit(STATUS);
    v.unmount();
    await tick(120_000);
    expect(hit(STATUS)).toBe(n);
  });

  it('a slow response is awaited: no overlapping polls', async () => {
    await show('page');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = feed[STATUS]!;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { hits[STATUS] = (hits[STATUS] ?? 0) + 1; await gate; const r = real(); return new Response(JSON.stringify(r.body), { status: 200 }); });
    await tick(15_500);
    const n = hit(STATUS);
    await tick(60_000);
    expect(hit(STATUS)).toBe(n); // first poll still in flight, none piled up
    release();
    await tick(15_500);
    expect(hit(STATUS)).toBeGreaterThan(n);
  });

  it('"Updated hh:mm:ss" moves forward after a poll', async () => {
    await show('page');
    const before = pageText().match(/Updated (\d{2}:\d{2}:\d{2})/)?.[1];
    expect(before).toBeTruthy();
    await tick(15_500);
    const after = pageText().match(/Updated (\d{2}:\d{2}:\d{2})/)?.[1];
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it('new data replaces the rows (a pair that turns out-of-control appears without reload)', async () => {
    await show('page');
    expect(pageText()).not.toContain('Out of control · 2-2s');
    feed[STATUS] = () => ({ status: 200, body: { data: [statusRow({ status: 'out_of_control', violated_rules: ['2-2s'], analyte_code: 'GLU' })], page: { limit: 50 } } });
    await tick(15_500);
    expect(pageText()).toContain('Out of control · 2-2s');
  });

  it('E20: a failed poll keeps the last rows and shows "Connection lost — showing data from hh:mm"; recovery removes it', async () => {
    await show('page');
    feed[STATUS] = () => ({ status: 503, body: { type: 'urn:lims:error:common.dependency_unavailable', title: 'x', status: 503, code: 'common.dependency_unavailable' } });
    await tick(15_500);
    expect(pageText()).toMatch(/Connection lost — showing data from \d{2}:\d{2}/);
    expect(pageText()).toContain('TSH'); // last data kept
    expect(pageText()).not.toMatch(/dependency_unavailable|postgres/); // LD-178: danger Banner carries a hidden "Error: " prefix (Banner.tsx:23), so it is not asserted
    feed[STATUS] = () => ({ status: 200, body: { data: STATUS_ROWS, page: { limit: 50 } } });
    await tick(31_000);
    expect(pageText()).not.toMatch(/Connection lost/);
  });

  it('E20 backoff after a failure: retry after 5 s, then 15 s, then 30 s (not hammering at the 15 s cadence)', async () => {
    await show('page');
    feed[STATUS] = () => ({ status: 503, body: { type: 'urn:lims:error:common.dependency_unavailable', title: 'x', status: 503, code: 'common.dependency_unavailable' } });
    await tick(15_500); // failure #1 at ~15 s
    const f1 = hit(STATUS);
    await tick(5_200); // retry #1 due within 5 s
    expect(hit(STATUS)).toBe(f1 + 1);
    await tick(14_000); // next retry waits ~15 s, so not yet
    expect(hit(STATUS)).toBe(f1 + 1);
    await tick(1_500);
    expect(hit(STATUS)).toBe(f1 + 2);
    await tick(28_500); // then ~30 s (LD-178: failure at 15.0 s -> retries at 20.0, 35.0, 65.0 s)
    expect(hit(STATUS)).toBe(f1 + 2);
    await tick(2_000);
    expect(hit(STATUS)).toBe(f1 + 3);
  });

  it('live region: announces a change of the out-of-control count, never a plain refresh (04-UI-UX §4)', async () => {
    await show('page');
    const region = () => document.querySelector('[aria-live="polite"]')!;
    const first = region().textContent;
    await tick(15_500); // same data
    expect(region().textContent).toBe(first);
    feed[STATUS] = () => ({ status: 200, body: { data: [...STATUS_ROWS, statusRow({ plan_id: '01a1a98a-ac40-7000-8000-0000000c1099',analyte_code: 'ALT', status: 'out_of_control', violated_rules: ['R-4s'] })], page: { limit: 50 } } });
    await tick(15_500);
    expect(region().textContent).toMatch(/2/);
    expect(region().textContent).not.toBe(first);
  });
});

describe('LJ chart polling — AC-08.3: a new evaluated observation appears within 15 s', () => {
  const sp = { searchParams: { plan_id: PLAN_1, level_id: LEVEL_1 } };
  const n = () => screen.getAllByRole('row').length;

  it('polls #35 every 15 s while visible; the new point shows up in the table without a reload', async () => {
    await show('lj/page', sp);
    const before = n();
    const next = ljDto();
    next.series[0]!.points.push(pt(6, 'accepted', { value: '101.1' }));
    feed[LJ] = () => ({ status: 200, body: next });
    await tick(14_500);
    expect(hit(LJ)).toBe(1);
    await tick(1_000);
    expect(hit(LJ)).toBe(2);
    expect(n()).toBe(before + 1);
    expect(pageText()).toContain('101.1');
  });

  it('hidden tab: no polling; unmount: no polling', async () => {
    const v = await show('lj/page', sp);
    setVisible(false);
    await tick(90_000);
    expect(hit(LJ)).toBe(1);
    setVisible(true);
    await tick(15_500);
    const c = hit(LJ);
    expect(c).toBeGreaterThanOrEqual(2);
    v.unmount();
    await tick(90_000);
    expect(hit(LJ)).toBe(c);
  });

  it('a failed poll keeps the chart data and shows the connection-lost banner', async () => {
    await show('lj/page', sp);
    feed[LJ] = () => ({ status: 503, body: { type: 'urn:lims:error:common.dependency_unavailable', title: 'x', status: 503, code: 'common.dependency_unavailable' } });
    await tick(15_500);
    expect(pageText()).toMatch(/Connection lost — showing data from \d{2}:\d{2}/);
    expect(pageText()).toContain('106.4');
  });
});
