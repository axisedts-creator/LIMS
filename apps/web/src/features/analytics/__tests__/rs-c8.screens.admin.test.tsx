// @vitest-environment jsdom
// RS-C8 — snapshots + axe of the schedule and export screens (companion of rs-c8.screens.test.tsx; same rules, same recording command with `-u rs-c8.screens`;
// records into __snapshots__/rs-c8.screens.admin.test.tsx.snap, kept by the writer per LD-170). Regression baseline, not proof of the look.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { SCHED_ID, api, axeClean, exportDto, json, resetApi, routes, scheduleDto, show } from './an-t20.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const norm = (html: string) =>
  html
    .replace(/react-aria\d*-:?[\w-]+:?/g, 'aria-id')
    .replace(/:r[0-9a-z]+:/g, ':rN:')
    .replace(/(id|for|aria-labelledby|aria-describedby|aria-controls|aria-owns|aria-activedescendant)="[^"]*(?:aria-id|:rN:)[^"]*"/g, '$1="ID"')
    .replace(/></g, '>\n<');
const snap = (el: Element) => expect(norm(el.innerHTML)).toMatchSnapshot();

const S = '/v1/analytics/schedules';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PERMS = ['analytics.schedule.manage', 'analytics.dashboard.read', 'analytics.data.export'];

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetApi(PERMS);
  routes[`GET ${S}`] = json({ data: [scheduleDto(), scheduleDto({ id: '01a1a98a-ac40-7000-8000-000000000041', name: 'Weekly volume', frequency: 'weekly', is_active: false })], page: { limit: 20 } });
  routes[`GET ${S}/${SCHED_ID}`] = json({ ...scheduleDto(), runs: [] });
  routes['GET /v1/analytics/exports'] = json({ data: [exportDto(1, { expires_at: FUTURE }), exportDto(2, { status: 'building', expires_at: FUTURE, ready_at: null }), exportDto(3, { status: 'failed' })], page: { limit: 20 } });
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('RS-C8 schedule and export screens: snapshots + axe', () => {
  it('Schedules list', async () => {
    const v = await show('schedules/page');
    await axeClean();
    snap(v.container);
  });

  it('New schedule form', async () => {
    const v = await show('schedules/new/page');
    await axeClean();
    snap(v.container);
  });

  it('My exports', async () => {
    const v = await show('exports/page');
    await axeClean();
    snap(v.container);
  });
});
