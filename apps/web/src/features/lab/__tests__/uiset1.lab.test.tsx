// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 8): /lab/settings (LabSettingsPage, MSW as lab-t29). The tabs (General, Delta rules, Reason codes, QC holds, and Verification policy
// with its permission) sit in the SettingsForm tabs slot; the General tab is the form (one "Save settings" in the sticky bar, no Cards). The other tabs keep their tables, rule forms and dialogs.
// Fails today because: the Tabs are drawn by the page itself (no .lims-settings, no sticky bar, no dirty note, loose Save).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectDirtyState, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';

const PATH = '/lab/settings';
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: [] } }), getRequestPathname: async () => PATH }));

const MANAGE = ['lab.config.manage', 'lab.worklist.read', 'lab.result.read', 'lab.specimen.read'];
const SETTINGS = { version: 3, label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg', host_query_requires_received: true, ingest_auto_receive: false,
  critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: true, history_days: 730 };
const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/settings`, () => HttpResponse.json(SETTINGS)),
  http.get(`${ORIGIN}/v1/lab/delta-check-rules`, () => HttpResponse.json({ data: [] })),
  http.get(`${ORIGIN}/v1/lab/coded-sets/:set`, () => HttpResponse.json({ data: [] })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function mount(permissions: readonly string[] = MANAGE) {
  const { LabSettingsPage } = await import('../components/settings/LabSettingsPage');
  const r = render(<ToastProvider><LabSettingsPage permissions={permissions} /></ToastProvider>);
  await screen.findByLabelText(/label width/i);
  return r;
}

describe('/lab/settings', () => {
  it('General tab: kit SettingsForm with the tabs in its slot, one Save in the sticky bar, every general field kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, {
      path: PATH, tabs: { include: ['General', 'Delta rules', 'Reason codes', 'QC holds'], min: 4 }, unionTabs: false,
      labels: [/label width/i, /label height/i, /copies per specimen/i, /history \(days\)/i, /label renderer/i, /host query requires received specimen/i, /auto-receive instrument results/i,
        /critical notification blocks approval/i, /pre-tick recollection on reject/i, /delta check enabled/i],
    });
    expect(norm(container.querySelector('.lims-settings-bar')!.textContent)).toMatch(/save/i);
  });

  it('dirty state on General: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('read only (no lab.config.manage): the title is the menu label and General has no Save', async () => {
    const { container } = await mount(['lab.worklist.read', 'lab.result.read', 'lab.specimen.read']);
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(container.querySelectorAll('.lims-settings-bar button[type="submit"]').length).toBe(0);
  });
});
