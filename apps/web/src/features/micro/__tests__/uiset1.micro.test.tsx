// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 8): /micro/settings (harness of C10 T-24). The five tabs sit in the SettingsForm tabs slot; the General tab is the form
// (one Save in the sticky bar, switches, no Cards). The four master-list tabs keep their own tables and drawers (not forms).
// Fails today because: the Tabs are drawn by the screen itself (no .lims-settings, no .lims-settings-tabs, no sticky Save bar on General, no dirty note).
// t24.settings pins "one primary button per page" and a Save named /^save/i: both stay true.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectDirtyState, expectSettingsForm, menuLabel, norm } from '@/__tests__/uiset1.helpers';
import { PERM_CFG, PERM_READ_ONLY, api, resetHits, settingsDto } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

const PATH = '/micro/settings';
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetHits());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (permissions = PERM_CFG) => {
  const { MicroSettingsScreen } = await import('../components/settings/MicroSettingsScreen');
  return render(<ToastProvider><MicroSettingsScreen settings={settingsDto() as never} permissions={permissions} /></ToastProvider>);
};
const TABS = ['Dictionaries', 'Plating protocols', 'AST panels', 'Instrument mappings', 'General'];

describe('/micro/settings', () => {
  it('General tab: kit SettingsForm with the five tabs in its slot, one Save in the sticky bar, all general fields kept', async () => {
    const { container } = await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'General' }));
    await expectSettingsForm(container, { path: PATH, tabs: TABS, unionTabs: false, labels: [/default no-growth final after/i, /recently submitted/i, /suggest for zone diameters/i, /suggest for mic/i, /require a reason for early no-growth finals/i] });
  });

  it('dirty state on General: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await userEvent.click(screen.getByRole('tab', { name: 'General' }));
    await expectDirtyState(container, PATH);
  });

  it('the title is the menu label also on the list tabs, and a list tab draws no second Save', async () => {
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel(PATH)]);
    expect(tabsOf(container)).toEqual(TABS);
    expect(container.querySelectorAll('.lims-settings-bar button[type="submit"]').length).toBeLessThanOrEqual(1);
  });

  it('read only (no micro.config.manage): General has no Save', async () => {
    const { container } = await mount(PERM_READ_ONLY);
    await userEvent.click(screen.getByRole('tab', { name: 'General' }));
    expect(container.querySelectorAll('button[type="submit"]').length).toBe(0);
  });
});

const tabsOf = (c: HTMLElement) => [...c.querySelectorAll('.lims-settings-tabs [role="tab"]')].map((t) => norm(t.textContent));
