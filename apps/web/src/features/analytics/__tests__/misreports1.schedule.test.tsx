// @vitest-environment jsdom
// T0D-MISREPORTS-1 done_when 2 "a scheduled export option": the existing schedule editor (/analytics/schedules/new, route staff.analytics.schedules) offers every new
// report the session may read, by its catalogue label, as a checkbox. Nothing is hidden by the editor itself: the list = REPORT_CODES filtered by schedulable and
// the session permission (schedules-page.tsx). The two money reports need analytics.referral_report.read (A39: flag off = omitted for everyone is enforced by the API).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { API, DEFS, MONEY, PERM, api, def, openPage } from './misreports1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => API.reset());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const re = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
const open = (perms: string[]) => openPage('analytics/schedules/new', { perms: [PERM.schedule, ...perms] });
const box = (title: string) => screen.queryByRole('checkbox', { name: re(title) });

describe('T0D-MISREPORTS-1 the schedule editor lists the new reports', () => {
  it('a session with every analytics read permission sees all 11 new reports as checkboxes', async () => {
    await open([PERM.dashboard, PERM.collections, PERM.referral]);
    await screen.findByRole('checkbox', { name: /^income$/i });
    for (const d of DEFS) expect(box(d.title), `${d.code} (${d.title})`).toBeTruthy();
  });
  it('analytics.dashboard.read alone: the dashboard reports are there, the collections reports and the two money reports are not', async () => {
    await open([PERM.dashboard]);
    await screen.findByRole('checkbox', { name: /^income$/i });
    for (const d of DEFS) {
      if (d.permission === PERM.dashboard) expect(box(d.title), d.code).toBeTruthy();
      else expect(box(d.title), d.code).toBeNull();
    }
  });
  it('the money reports appear only with analytics.referral_report.read', async () => {
    await open([PERM.dashboard, PERM.collections]);
    await screen.findByRole('checkbox', { name: /^income$/i });
    for (const c of MONEY) expect(box(def(c).title), c).toBeNull();
    cleanup();
    await open([PERM.dashboard, PERM.collections, PERM.referral]);
    await screen.findByRole('checkbox', { name: /^income$/i });
    for (const c of MONEY) expect(box(def(c).title), c).toBeTruthy();
  });
  it('without analytics.schedule.manage the editor is a 404 before any API call', async () => {
    await expect(openPage('analytics/schedules/new', { perms: [PERM.dashboard, PERM.collections, PERM.referral] })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(API.calls).toEqual([]);
  });
});
