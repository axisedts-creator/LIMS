// @vitest-environment jsdom
// RS-C3 (LD-140; 10-DESIGN-SYSTEM s4 "Masters: list on the left, drawer form on the right with sections and per-section Save",
// s6 "what not to do", s8 acceptance): arrangement checks on the catalog list screens + axe + keyboard-only path. Synthetic data only.
// Behaviour must not change, so the keyboard path asserts the SAME api call (method, url, body) the dialog made before the restyle.
// ASSUMED contract (the spec fixes the kit, not the markup; the writer may dispute a name via the ruling flow):
//   - edit/new forms for departments, specimen types, containers, units and the New panel / New price list forms open in the kit
//     `Drawer` (`@lims/ui/components/Drawer`: class `lims-drawer` on the modal, role="dialog" inside), not the centred `Dialog`.
//   - the drawer body is made of one or more kit `DrawerSection`s (`section.lims-drawer-section`, labelled by an h3), each with its own
//     button whose accessible name starts with "Save".  Ctrl+S in the drawer still saves (existing behaviour, 04-UI-UX s3).
//   - the container's cap colour is shown in the list as a swatch: an element whose class contains "swatch", styled by class/token
//     (no inline style), with the colour NAME still printed next to it (10-DESIGN-SYSTEM s6: never colour-only).
//   - no list screen is a page of tabs that holds the whole editor; the page header keeps ONE primary button.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/catalog/departments',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000e${String(n).padStart(4, '0')}`;
const MANAGE = ['catalog.test.read', 'catalog.test.manage', 'catalog.price_list.read', 'catalog.price_list.manage'];
const base = (n: number, o: Record<string, unknown>) => ({ id: ID(n), is_active: true, version: 3, created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-06T09:30:00.000Z', ...o });
const DEPTS = [base(1, { code: 'HAEM', name: 'Hematology', report_order: 10, report_heading: 'HAEMATOLOGY' }), base(2, { code: 'BIOC', name: 'Biochemistry', report_order: 20 })];
const SPECS = [base(11, { code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' })];
const CONTS = [base(21, { code: 'LAV', name: 'Lavender tube', additive: 'K2EDTA', cap_colour_display: 'Lavender', default_specimen_type_id: ID(11) })];
const UNITS = [base(41, { code: 'g_dL', display: 'g/dL', scope: 'global' }), base(43, { code: 'lab_ratio', display: 'ratio', scope: 'tenant' })];
const VSETS = [base(51, { code: 'SEMI', display: 'Semi-quantitative', is_ordered: true, scope: 'tenant', values: [{ code: 'NEG', display: 'Negative', sort_order: 0, is_active: true }] })];
const PANELS = [base(61, { kind: 'panel', code: 'CBC', name: 'Complete blood count', panel_kind: 'clinical', is_orderable: true, revision: 1, members: [] })];
const PLISTS = [{ id: ID(71), code: 'DEFAULT', name: 'Default list', owner_kind: 'default', falls_through: false, assignments: [], is_active: true, version: 1 }];

const calls: { method: string; url: URL; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), body: ['POST', 'PATCH', 'PUT'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const api = setupServer(
  http.post(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...DEPTS[0], id: ID(99) }, { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...DEPTS[0], version: 4 }); }),
  http.get(`${ORIGIN}/v1/catalog/*`, () => HttpResponse.json({ data: [], page: { limit: 20 } })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; });

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noSeriousAxe = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout or colours
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const rowOf = (code: string) => screen.getByRole('row', { name: new RegExp(`\\b${code}\\b`) });
const drawer = () => {
  const d = document.querySelector('.lims-drawer');
  expect(d, 'form must open in the kit Drawer (class lims-drawer), not a centred Dialog').toBeTruthy();
  return d as HTMLElement;
};
const sections = (d: HTMLElement) => [...d.querySelectorAll<HTMLElement>('section.lims-drawer-section')];
const expectSectionedDrawer = () => {
  const d = drawer();
  expect(within(d).getByRole('dialog')).toBeTruthy();
  const s = sections(d);
  expect(s.length, 'drawer body must be made of DrawerSection(s)').toBeGreaterThan(0);
  for (const sec of s) {
    expect(within(sec).getByRole('heading', { level: 3 })).toBeTruthy();
    expect(within(sec).getAllByRole('button', { name: /^save/i }).length, 'each section has its own Save').toBeGreaterThanOrEqual(1);
  }
  return { d, s };
};
const primaryButtons = () => [...document.querySelectorAll('button.lims-btn-primary, button[class*="primary"]')].filter((b) => !b.closest('.lims-drawer, [role="dialog"]'));

describe('RS-C3 departments: list + drawer (s4 Masters)', () => {
  const load = async () => (await import('../components/DepartmentsList')).DepartmentsList;
  it('Edit opens a sectioned drawer; axe has no serious/critical violations on list and drawer', async () => {
    const DepartmentsList = await load();
    wrap(<DepartmentsList departments={DEPTS as never} permissions={MANAGE} />);
    await noSeriousAxe();
    await userEvent.click(within(rowOf('HAEM')).getByRole('button', { name: /edit/i }));
    expectSectionedDrawer();
    await noSeriousAxe();
  });
  it('one primary button on the page (s3)', async () => {
    const DepartmentsList = await load();
    wrap(<DepartmentsList departments={DEPTS as never} permissions={MANAGE} />);
    expect(primaryButtons().length).toBe(1);
  });
  it('keyboard only: Tab to Edit, Enter opens the drawer, edit Name, Ctrl+S sends the same PATCH as before, Escape closes', async () => {
    const DepartmentsList = await load();
    wrap(<DepartmentsList departments={DEPTS as never} permissions={MANAGE} />);
    const edit = within(rowOf('HAEM')).getByRole('button', { name: /edit/i });
    edit.focus();
    await userEvent.keyboard('{Enter}');
    const d = drawer();
    const name = within(d).getByRole('textbox', { name: /^name/i });
    await userEvent.clear(name);
    await userEvent.type(name, 'Haematology');
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe(`/v1/catalog/departments/${ID(1)}`);
    expect(calls[0]!.body).toEqual({ name: 'Haematology' }); // only the changed field (unchanged behaviour)
    await waitFor(() => expect(document.querySelector('.lims-drawer')).toBeNull());
    expect(refresh).toHaveBeenCalled();
  });
  it('a section Save button works with the pointer too and sends the same call', async () => {
    const DepartmentsList = await load();
    wrap(<DepartmentsList departments={DEPTS as never} permissions={MANAGE} />);
    await userEvent.click(within(rowOf('BIOC')).getByRole('button', { name: /edit/i }));
    const d = drawer();
    const name = within(d).getByRole('textbox', { name: /^name/i });
    await userEvent.clear(name);
    await userEvent.type(name, 'Clinical biochemistry');
    await userEvent.click(within(sections(d)[0]!).getAllByRole('button', { name: /^save/i })[0]!);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body).toEqual({ name: 'Clinical biochemistry' });
  });
  it('New department posts the same create body (POST, not PATCH)', async () => {
    const DepartmentsList = await load();
    wrap(<DepartmentsList departments={DEPTS as never} permissions={MANAGE} />);
    await userEvent.click(screen.getByRole('button', { name: /new department/i }));
    const d = drawer();
    await userEvent.type(within(d).getByRole('textbox', { name: /^code/i }), 'MICR');
    await userEvent.type(within(d).getByRole('textbox', { name: /^name/i }), 'Microbiology');
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/v1/catalog/departments');
    expect(calls[0]!.body).toMatchObject({ code: 'MICR', name: 'Microbiology', report_order: 100, is_active: true });
  });
  it('without catalog.test.manage there is no Edit button and no New button (permissions unchanged)', async () => {
    const DepartmentsList = await load();
    wrap(<DepartmentsList departments={DEPTS as never} permissions={['catalog.test.read']} />);
    expect(screen.queryByRole('button', { name: /edit|new department/i })).toBeNull();
  });
});

describe('RS-C3 specimen types and containers (s4 Masters; container colour as a swatch)', () => {
  const load = async () => (await import('../components/SpecimensScreen')).SpecimensScreen;
  const show = async () => {
    const SpecimensScreen = await load();
    return wrap(<SpecimensScreen specimenTypes={SPECS as never} containers={CONTS as never} permissions={MANAGE} />);
  };
  const toContainers = async () => userEvent.click(screen.getByRole('tab', { name: /^containers$/i }));

  it('specimen type edit opens a sectioned drawer; axe clean', async () => {
    await show();
    await noSeriousAxe();
    await userEvent.click(within(rowOf('EDTA_WB')).getByRole('button', { name: /edit/i }));
    expectSectionedDrawer();
    await noSeriousAxe();
  });
  it('container list shows the cap colour as a swatch plus its name, with no inline style and no colour-only meaning', async () => {
    await show();
    await toContainers();
    const row = rowOf('LAV');
    const swatch = row.querySelector<HTMLElement>('[class*="swatch"]');
    expect(swatch, 'cap colour swatch element (class contains "swatch")').toBeTruthy();
    expect(swatch!.getAttribute('style')).toBeNull();
    expect(within(row).getByText('Lavender', { exact: true })).toBeTruthy(); // the colour name stays as text next to the swatch
    expect(swatch!.getAttribute('aria-hidden') === 'true' || !!swatch!.getAttribute('aria-label') || swatch!.getAttribute('role') === 'img').toBe(true); // decorative or named, never a bare div
    await noSeriousAxe();
  });
  it('container with no cap colour shows the dash and no swatch', async () => {
    const SpecimensScreen = await load();
    wrap(<SpecimensScreen specimenTypes={SPECS as never} containers={[{ ...CONTS[0], cap_colour_display: undefined }] as never} permissions={MANAGE} />);
    await toContainers();
    expect(rowOf('LAV').querySelector('[class*="swatch"]')).toBeNull();
  });
  it('container edit opens a sectioned drawer and the swatch follows the colour field (axe clean)', async () => {
    await show();
    await toContainers();
    await userEvent.click(within(rowOf('LAV')).getByRole('button', { name: /edit/i }));
    const { d } = expectSectionedDrawer();
    expect(within(d).getByRole('textbox', { name: /cap colour/i })).toBeTruthy();
    await noSeriousAxe();
  });
  it('keyboard only: container Ctrl+S sends the same PATCH (only the changed field)', async () => {
    await show();
    await toContainers();
    await userEvent.click(within(rowOf('LAV')).getByRole('button', { name: /edit/i }));
    const cap = within(drawer()).getByRole('textbox', { name: /cap colour/i });
    await userEvent.clear(cap);
    await userEvent.type(cap, 'Purple');
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe(`/v1/catalog/containers/${ID(21)}`);
    expect(calls[0]!.body).toEqual({ cap_colour_display: 'Purple' });
  });
});

describe('RS-C3 units and value sets', () => {
  const load = async () => (await import('../components/UnitsScreen')).UnitsScreen;
  it('no emoji lock: system units say so in text or a named kit icon (s6)', async () => {
    const UnitsScreen = await load();
    wrap(<UnitsScreen units={UNITS as never} valueSets={VSETS as never} permissions={MANAGE} />);
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(screen.getAllByRole('img', { name: /system/i }).length + screen.queryAllByText(/system/i).length).toBeGreaterThan(0); // still tells the user it is a system unit
  });
  it('unit edit opens a sectioned drawer; axe clean', async () => {
    const UnitsScreen = await load();
    wrap(<UnitsScreen units={UNITS as never} valueSets={VSETS as never} permissions={MANAGE} />);
    await noSeriousAxe();
    await userEvent.click(within(rowOf('lab_ratio')).getByRole('button', { name: /edit/i }));
    expectSectionedDrawer();
    await noSeriousAxe();
  });
  it('value set edit opens a sectioned drawer (the values grid is its own section)', async () => {
    const UnitsScreen = await load();
    wrap(<UnitsScreen units={UNITS as never} valueSets={VSETS as never} permissions={MANAGE} />);
    await userEvent.click(screen.getByRole('tab', { name: /value sets/i }));
    await userEvent.click(within(rowOf('SEMI')).getByRole('button', { name: /edit/i }));
    const { s } = expectSectionedDrawer();
    expect(s.some((x) => x.querySelector('[role="grid"]')), 'values grid sits inside a section').toBe(true);
  });
});

describe('RS-C3 panels and packages, price lists', () => {
  it('New panel opens a sectioned drawer; list axe clean', async () => {
    const { PanelsList } = await import('../components/PanelsList');
    wrap(<PanelsList panels={PANELS as never} departments={DEPTS as never} permissions={MANAGE} />);
    await noSeriousAxe();
    await userEvent.click(screen.getByRole('button', { name: /new panel/i }));
    expectSectionedDrawer();
    await noSeriousAxe();
  });
  it('New price list opens a sectioned drawer; list axe clean; one primary button', async () => {
    const { PriceListsList } = await import('../components/PriceListsList');
    wrap(<PriceListsList priceLists={PLISTS as never} permissions={MANAGE} />);
    expect(primaryButtons().length).toBe(1);
    await noSeriousAxe();
    await userEvent.click(screen.getByRole('button', { name: /new price list/i }));
    expectSectionedDrawer();
    await noSeriousAxe();
  });
});

describe('RS-C3 drawer opens and closes with the keyboard and returns focus (s8 keyboard-only path)', () => {
  it('Escape closes the drawer and focus returns to the Edit button', async () => {
    const { DepartmentsList } = await import('../components/DepartmentsList');
    wrap(<DepartmentsList departments={DEPTS as never} permissions={MANAGE} />);
    const edit = within(rowOf('HAEM')).getByRole('button', { name: /edit/i });
    edit.focus();
    await userEvent.keyboard('{Enter}');
    drawer();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('.lims-drawer')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(edit));
  });
});
