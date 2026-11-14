// @vitest-environment jsdom
// C9.T-24 — TAT alerts poll every 30 s, only while the tab is visible (04-UI-UX §1 "Polling"; 03-APP-FLOW §4 "poll 30 s [CONV]").
// ASSUMED contract (same as T-21 polling): the client polls through a server action -> serverFetch -> global fetch of GET /v1/quality/tat-alerts. Here global `fetch` is stubbed (no MSW) so fake timers are safe.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { PERM_TAT_ACK, TAT, TAT_ROWS, pageText, resetApi, show, tatPage } from './quality-t24.harness';

vi.mock('next/navigation', async () => (await import('./quality-t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t24.harness')).sessionMock);

let hits = 0;
let visible = true;
const setVisible = (v: boolean) => { visible = v; document.dispatchEvent(new Event('visibilitychange')); };
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-14T04:00:00.000Z') });
  resetApi(PERM_TAT_ACK);
  hits = 0;
  visible = true;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string) => {
    if (new URL(String(input)).pathname === TAT) {
      hits += 1;
      return new Response(JSON.stringify(tatPage(TAT_ROWS)), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 503 });
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('TAT alerts polling (30 s, only while visible)', () => {
  it('first poll at 30 s (not before), then every 30 s', async () => {
    await show('tat-alerts/page');
    expect(hits).toBe(1);
    await tick(29_000);
    expect(hits).toBe(1);
    await tick(2_000);
    expect(hits).toBe(2);
    await tick(60_000);
    expect(hits).toBeGreaterThanOrEqual(4);
    expect(hits).toBeLessThanOrEqual(5);
  });
  it('hidden tab: no requests; visible again refreshes within one period', async () => {
    await show('tat-alerts/page');
    setVisible(false);
    await tick(180_000);
    expect(hits).toBe(1);
    setVisible(true);
    await tick(30_500);
    expect(hits).toBeGreaterThanOrEqual(2);
  });
  it('shows "Updated hh:mm:ss" next to the title', async () => {
    await show('tat-alerts/page');
    expect(pageText()).toMatch(/Updated \d{2}:\d{2}:\d{2}/);
  });
  it('unmounting stops polling', async () => {
    await show('tat-alerts/page');
    cleanup();
    await tick(120_000);
    expect(hits).toBe(1);
  });
});
