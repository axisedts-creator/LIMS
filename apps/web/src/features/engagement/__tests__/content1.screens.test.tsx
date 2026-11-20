// @vitest-environment jsdom
// T0D-CONTENT-1 — portal content screens at /engagement/content: tabs News, Banners, Offers, Contact Us, Profile Images (LD-313, LD-310, LD-353 template 1 LIST).
// Component tests with MSW: empty and filled lists, validation, preview = shared renderer output, upload states, permission states. Synthetic data only.
// ASSUMED prop contract (the spec fixes the screens, not the props; dispute through the writer note if wrong). One named export
//   PortalContentScreen({ items, profileImages, permissions, today, searchProfiles })   in features/engagement/components/content/PortalContentScreen.tsx
//   items          = PortalContent[] (contracts/openapi/engagement.yaml, all four kinds, any order; the screen sorts by sort_order inside a kind)
//   profileImages  = (ProfileImage & { profile_name?: string })[]
//   searchProfiles = (kind: 'doctor' | 'centre' | 'staff', q: string) => Promise<{ id: string; name: string }[]>   (other modules own the search, injected like searchPatients)
//   today          = 'YYYY-MM-DD' (tenant local date)
// ASSUMED DOM: role=tablist with tabs "News" "Banners" "Offers" "Contact Us" "Profile Images"; each list tab = table in the kit scroll box, headers Title / Active / Start date / End date / Order,
//   per row: switch (Active), "Move up" / "Move down" buttons, "Edit" button; page header has a "New ..." button; the edit form is a role=dialog with a Title field, "Save" and "Cancel";
//   Markdown editor = textarea labelled "Body" + role=toolbar buttons Bold / Italic / Heading / List / Link + region labelled "Preview"; raw HTML problems show in a role=alert;
//   no access = data-testid="permission-denied" (inventory T-23 precedent). CONTACT US storage (the contract has no contact fields): ONE item of kind contact; body = lines
//   "Address: ..", "Phones: ..", "Email: ..", "Hours: ..", link_url = the map link. Image upload = kit FileUpload (uploadFile) -> POST /v1/identity/settings/branding-assets (multipart file + kind, Idempotency-Key).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectListScreen, headerCells, norm } from '@/features/catalog/__tests__/uilist3.helpers';
// the one renderer the patient app uses (T0B-CONTENT-1, LD-313 d); the web preview must produce the same HTML
import { renderMarkdown } from '../../../../../../services/api/src/modules/engagement/service/safeMarkdown';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/engagement/content',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/engagement/content',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const TODAY = '2026-11-18';
const ASSET = U(900), ASSET_B1 = U(901);
const N1 = U(1), N2 = U(2), N3 = U(3), B1 = U(11), O1 = U(21), C1 = U(31);
const DOC = U(41), CTR = U(42), STAFF = U(43);

const READ = ['engagement.content.read'];
const MANAGE = ['engagement.content.read', 'engagement.content.manage', 'identity.settings.manage'];
const MANAGE_NO_UPLOAD = ['engagement.content.read', 'engagement.content.manage'];

const item = (o: Record<string, unknown>) => ({ sort_order: 0, is_active: true, created_by: U(90), created_at: '2026-11-01T04:00:00.000Z', updated_at: '2026-11-02T04:00:00.000Z', version: 1, ...o });
const NEWS = [
  item({ id: N1, kind: 'news', title: 'Synthetic News Alpha', body: '**Open** on holidays', starts_on: '2026-11-01', ends_on: '2026-12-31', sort_order: 0, version: 3 }),
  item({ id: N2, kind: 'news', title: 'Synthetic News Beta', body: 'Second item', sort_order: 1, is_active: false, version: 1 }),
  item({ id: N3, kind: 'news', title: 'Synthetic News Gamma', body: 'Third item', sort_order: 2, version: 2 }),
];
const BANNER = item({ id: B1, kind: 'banner', title: 'Synthetic Banner One', image_attachment_id: ASSET_B1, link_url: 'https://example.test/promo', sort_order: 0, version: 4 });
const OFFER = item({ id: O1, kind: 'offer', title: 'Synthetic Offer One', body: '**Save** 20% on a panel', sort_order: 0, version: 2 });
const CONTACT_BODY = 'Address: Synthetic Road 1, Synthetic City\nPhones: 9800000000, 9811111111\nEmail: info@example.test\nHours: Sun-Fri 7am-7pm';
const CONTACT = item({ id: C1, kind: 'contact', title: 'Contact Us', body: CONTACT_BODY, link_url: 'https://maps.example.test/place/1', version: 2 });
const ALL = [NEWS[2]!, BANNER, NEWS[0]!, OFFER, CONTACT, NEWS[1]!]; // shuffled on purpose
const PIMGS = [
  { profile_kind: 'doctor', profile_id: DOC, profile_name: 'Synthetic Doctor Rao', image_attachment_id: ASSET_B1, is_active: true, updated_at: '2026-11-10T04:00:00.000Z' },
  { profile_kind: 'centre', profile_id: CTR, profile_name: 'Synthetic Centre A1', image_attachment_id: ASSET_B1, is_active: false, updated_at: '2026-11-09T04:00:00.000Z' },
];

type Call = { method: string; path: string; url: URL; headers: Headers; text: string; json?: any };
const calls: Call[] = [];
const rec = async (r: Request) => {
  const url = new URL(r.url);
  const text = r.method === 'GET' ? '' : await r.clone().text().catch(() => '');
  let json: any; try { json = text ? JSON.parse(text) : undefined; } catch { /* multipart */ }
  calls.push({ method: r.method, path: url.pathname, url, headers: r.headers, text, json });
};
const hit = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));
const problem = (status: number, code: string, detail = 'Synthetic problem') => HttpResponse.json({ type: 'about:blank', title: detail, status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });
const asset = { asset_id: ASSET, kind: 'logo', width: 800, height: 400, sha256: 'a'.repeat(64), scan_state: 'clean' };
const defaults = () => [
  http.post('*/v1/identity/settings/branding-assets', async ({ request }) => { await rec(request); return HttpResponse.json(asset, { status: 201 }); }),
  http.get('*/v1/identity/settings/branding-assets/:id/content', () => new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })),
  http.post('*/v1/engagement/portal-content/reorder', async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { has_more: false } }); }),
  http.post('*/v1/engagement/portal-content/:id/deactivate', async ({ request }) => { await rec(request); return HttpResponse.json({ ...NEWS[0]!, is_active: false, version: 4 }); }),
  http.post('*/v1/engagement/portal-content', async ({ request }) => { await rec(request); return HttpResponse.json({ ...NEWS[0]!, id: U(77), version: 1 }, { status: 201 }); }),
  http.patch('*/v1/engagement/portal-content/:id', async ({ request }) => { await rec(request); return HttpResponse.json({ ...NEWS[0]!, version: 9 }); }),
  http.put('*/v1/engagement/profile-images/:kind/:id', async ({ request }) => { await rec(request); return HttpResponse.json({ ...PIMGS[0]!, image_attachment_id: ASSET }); }),
  http.delete('*/v1/engagement/profile-images/:kind/:id', async ({ request }) => { await rec(request); return HttpResponse.json({ ...PIMGS[0]!, is_active: false }); }),
  http.get('*/v1/engagement/*', async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { has_more: false } }); }),
];
const api = setupServer(...defaults());
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; searchCalls.length = 0; push.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => api.close());

const searchCalls: [string, string][] = [];
const search = async (k: string, q: string) => { searchCalls.push([k, q]); return q ? [{ id: DOC, name: 'Synthetic Doctor Rao' }, { id: CTR, name: 'Synthetic Centre A1' }, { id: STAFF, name: 'Synthetic Staff Sen' }] : []; };
const mount = async (o: { items?: unknown[]; profileImages?: unknown[]; permissions?: string[] } = {}) => {
  const { PortalContentScreen } = await import('@/features/engagement/components/content/PortalContentScreen');
  const ui: ReactNode = (
    <ToastProvider>
      <PortalContentScreen items={(o.items ?? ALL) as never} profileImages={(o.profileImages ?? PIMGS) as never} permissions={o.permissions ?? MANAGE} today={TODAY} searchProfiles={search as never} />
    </ToastProvider>
  );
  return render(ui);
};
const user = () => userEvent.setup();
const tab = async (name: string) => { await userEvent.click(screen.getByRole('tab', { name })); return screen.getByRole('tabpanel'); };
const rowOf = (title: string) => screen.getByText(title).closest('tr, [role="row"]') as HTMLElement;
const titlesInOrder = (panel: HTMLElement, prefix: string) => [...panel.querySelectorAll('tbody tr, [role="row"]')].map((r) => /(Synthetic \w+ \w+)/.exec(r.textContent ?? '')?.[1]).filter((t): t is string => !!t && t.startsWith(prefix));
const dateRe = (iso: string) => { const [y, m, d] = iso.split('-').map(Number) as [number, number, number]; const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]!; return new RegExp(`${iso}|${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}|${d} ${mon},? ${y}|${mon} ${d},? ${y}`); };
const dialog = () => screen.getByRole('dialog');
const field = (name: RegExp) => within(dialog()).getByLabelText(name) as HTMLInputElement | HTMLTextAreaElement;
const save = () => user().click(within(dialog()).getByRole('button', { name: /^save/i }));
const PNG = (name = 'synthetic.png', type = 'image/png', size = 64) => new File([new Uint8Array(size).fill(1)], name, { type });
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const previewHtml = () => (screen.getByRole('region', { name: /preview/i }) as HTMLElement).innerHTML;
const expected = (md: string) => { const d = document.createElement('div'); d.innerHTML = renderMarkdown(md); return d.innerHTML; };
const paste = async (el: HTMLElement, text: string) => { const u = user(); await u.click(el); await u.paste(text); };

// ------------------------------------------------------------------------------------------------- page and tabs
describe('page shell (LD-353 template 1, done_when 1 and 6)', () => {
  it('h1 = the menu label; five tabs in the spec order; News is open first', async () => {
    const { container } = await mount();
    const tabs = screen.getAllByRole('tab').map((t) => norm(t.textContent));
    expect(tabs).toEqual(['News', 'Banners', 'Offers', 'Contact Us', 'Profile Images']);
    expect(screen.getByRole('tab', { name: 'News' }).getAttribute('aria-selected')).toBe('true');
    expectListScreen(container, { path: '/engagement/content', filterBar: 'optional', headers: ['Title', 'Active', 'Start date', 'End date', 'Order'] });
  });
  it('no access without engagement.content.read: permission-denied state, no API call, no tabs of data', async () => {
    await mount({ permissions: [] });
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(calls).toEqual([]);
  });
  it('axe: the filled News tab has no violations', async () => { await mount(); await noAxeViolations(); });
});

// ------------------------------------------------------------------------------------------------- lists
describe.each([['News', 'news', 'Synthetic News'], ['Banners', 'banner', 'Synthetic Banner'], ['Offers', 'offer', 'Synthetic Offer']] as const)('%s list', (tabName, kind, prefix) => {
  it('empty: the header row is still drawn, one EmptyState with a hint, and a New button', async () => {
    await mount({ items: [] });
    const panel = await tab(tabName);
    expect(headerCells(panel)).toEqual(expect.arrayContaining(['Title', 'Active', 'Start date', 'End date', 'Order']));
    expect(panel.querySelector('.lims-state'), 'EmptyState in the body').toBeTruthy();
    expect(panel.querySelectorAll('.lims-state .lims-btn, .lims-state a, .lims-state button').length, 'EmptyState has at most one button').toBeLessThanOrEqual(1);
    expect(within(panel).getAllByRole('button', { name: /^new/i }).length).toBeGreaterThan(0);
  });
  it('filled: only this kind is listed, ordered by sort order, with the start and end dates and a switch per row', async () => {
    await mount();
    const panel = await tab(tabName);
    const titles = titlesInOrder(panel, prefix);
    expect(titles.length).toBeGreaterThan(0);
    for (const other of ['Synthetic News', 'Synthetic Banner', 'Synthetic Offer'].filter((p) => p !== prefix)) expect(panel.textContent).not.toContain(other);
    if (kind === 'news') {
      expect(titles).toEqual(['Synthetic News Alpha', 'Synthetic News Beta', 'Synthetic News Gamma']);
      expect(rowOf('Synthetic News Alpha').textContent).toMatch(dateRe('2026-11-01'));
      expect(rowOf('Synthetic News Alpha').textContent).toMatch(dateRe('2026-12-31'));
      const sw = (t: string) => within(rowOf(t)).getByRole('switch') as HTMLInputElement;
      expect(sw('Synthetic News Alpha').checked).toBe(true);
      expect(sw('Synthetic News Beta').checked).toBe(false);
    }
    expect(within(panel).getAllByRole('switch').length).toBe(titles.length);
  });
  it('cut-off cells carry a title attribute (rule 5)', async () => {
    const long = `${prefix} with a very long headline that will not fit the title column of a compact table`;
    await mount({ items: [item({ id: U(60), kind, title: long, body: 'x' })] });
    const panel = await tab(tabName);
    const cell = [...panel.querySelectorAll<HTMLElement>('td, [role="gridcell"]')].find((c) => norm(c.textContent).includes(long))!;
    expect([cell, ...cell.querySelectorAll<HTMLElement>('[title]')].some((e) => (e.getAttribute('title') ?? '').includes(long))).toBe(true);
  });
});

describe('News: active toggle, order, edit (done_when 1)', () => {
  it('switching an active item off deactivates it (PATCH is_active false or POST deactivate) with If-Match = its version; nothing is deleted', async () => {
    await mount();
    await tab('News');
    await userEvent.click(within(rowOf('Synthetic News Alpha')).getByRole('switch'));
    await waitFor(() => expect(hit('PATCH', /portal-content\/[^/]+$/).length + hit('POST', /deactivate$/).length).toBe(1));
    const c = hit('PATCH', /portal-content\/[^/]+$/)[0] ?? hit('POST', /deactivate$/)[0]!;
    expect(c.path).toContain(N1);
    expect(c.headers.get('if-match')).toBe('"3"');
    if (c.method === 'PATCH') expect(c.json).toEqual({ is_active: false });
    expect(calls.filter((x) => x.method === 'DELETE')).toEqual([]);
  });
  it('switching an inactive item on is a PATCH { is_active: true } with its own version', async () => {
    await mount();
    await tab('News');
    await userEvent.click(within(rowOf('Synthetic News Beta')).getByRole('switch'));
    await waitFor(() => expect(hit('PATCH', /portal-content\/[^/]+$/)).toHaveLength(1));
    const c = hit('PATCH', /portal-content\/[^/]+$/)[0]!;
    expect(c.path).toContain(N2);
    expect(c.json).toEqual({ is_active: true });
    expect(c.headers.get('if-match')).toBe('"1"');
  });
  it('move up is off on the first row and move down is off on the last row', async () => {
    await mount();
    await tab('News');
    expect((within(rowOf('Synthetic News Alpha')).getByRole('button', { name: /move up/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowOf('Synthetic News Gamma')).getByRole('button', { name: /move down/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowOf('Synthetic News Alpha')).getByRole('button', { name: /move down/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('move down sends ONE reorder with every item of the kind (inactive too) in the new order', async () => {
    await mount();
    await tab('News');
    await userEvent.click(within(rowOf('Synthetic News Alpha')).getByRole('button', { name: /move down/i }));
    await waitFor(() => expect(hit('POST', /portal-content\/reorder$/)).toHaveLength(1));
    expect(hit('POST', /portal-content\/reorder$/)[0]!.json).toEqual({ kind: 'news', ids: [N2, N1, N3] });
  });
  it('edit opens the form with the stored values and saves a PATCH with If-Match = version', async () => {
    await mount();
    await tab('News');
    await userEvent.click(within(rowOf('Synthetic News Alpha')).getByRole('button', { name: /edit/i }));
    expect(field(/^title/i).value).toBe('Synthetic News Alpha');
    expect(field(/^body/i).value).toBe('**Open** on holidays');
    expect(within(dialog()).getByRole('switch', { name: /active/i })).toBeTruthy();
    expect(dialog().textContent).toMatch(dateRe('2026-11-01'));
    await userEvent.clear(field(/^title/i));
    await userEvent.type(field(/^title/i), 'Synthetic News Alpha v2');
    await save();
    await waitFor(() => expect(hit('PATCH', /portal-content\/[^/]+$/)).toHaveLength(1));
    const c = hit('PATCH', /portal-content\/[^/]+$/)[0]!;
    expect(c.path).toContain(N1);
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.json.title).toBe('Synthetic News Alpha v2');
    expect(c.json.kind ?? 'news').toBe('news');
  });
  it('a 409 version conflict keeps the form open and tells the user to reload (no silent overwrite)', async () => {
    api.use(http.patch('*/v1/engagement/portal-content/:id', async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict', 'The item was changed by someone else'); }));
    await mount();
    await tab('News');
    await userEvent.click(within(rowOf('Synthetic News Alpha')).getByRole('button', { name: /edit/i }));
    await userEvent.type(field(/^title/i), ' x');
    await save();
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(dialog().textContent).toMatch(/changed|reload|conflict|someone else/i);
  });
});

// ------------------------------------------------------------------------------------------------- create + validation
describe('create and validation (done_when 2, 7)', () => {
  const openNew = async (tabName: string) => { const panel = await tab(tabName); await userEvent.click(within(panel).getAllByRole('button', { name: /^new/i })[0]!); };

  it('creating a news item POSTs kind, title and the Markdown body, then refreshes the list', async () => {
    await mount({ items: [] });
    await openNew('News');
    await userEvent.type(field(/^title/i), 'Synthetic holiday hours');
    await paste(field(/^body/i), 'We are **open** on Saturday.');
    await save();
    await waitFor(() => expect(hit('POST', /portal-content$/)).toHaveLength(1));
    const c = hit('POST', /portal-content$/)[0]!;
    expect(c.json).toMatchObject({ kind: 'news', title: 'Synthetic holiday hours', body: 'We are **open** on Saturday.' });
    await waitFor(() => expect(refresh.mock.calls.length > 0 || screen.queryByText('Synthetic holiday hours') !== null).toBe(true));
  });
  it('an empty title, or a title with "<" or ">", is refused in the form: field marked invalid, no request', async () => {
    await mount({ items: [] });
    await openNew('News');
    await save();
    expect(field(/^title/i).getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(field(/^title/i), 'Bad <b>title</b>');
    await save();
    expect(field(/^title/i).getAttribute('aria-invalid')).toBe('true');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it.each([
    ['raw HTML', 'Hello <b>x</b>', /html/i],
    ['a script tag', 'Hi <script>alert(1)</script>', /html/i],
    ['an image', 'Look ![x](https://example.test/a.png)', /image/i],
    ['an http link', 'Go [here](http://example.test)', /https/i],
    ['a javascript link', 'Go [here](javascript:alert(1))', /https|link/i],
    ['a reference definition', '[x]: https://example.test', /reference|link|not allowed/i],
    ['a numeric character reference', 'a &#60;b', /character|not allowed|reference/i],
  ])('the body with %s shows a visible alert, the preview stays safe, and Save sends nothing', async (_n, body, msg) => {
    await mount({ items: [] });
    await openNew('News');
    await userEvent.type(field(/^title/i), 'Synthetic title');
    await paste(field(/^body/i), body);
    const alerts = within(dialog()).getAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(msg);
    const prev = screen.getByRole('region', { name: /preview/i });
    expect(prev.querySelector('script, b, img, iframe, [onerror], a[href^="http:"], a[href^="javascript"]')).toBeNull();
    await save();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it('a body over 20000 characters is refused with a visible message, no request', async () => {
    await mount({ items: [] });
    await openNew('Offers');
    await userEvent.type(field(/^title/i), 'Synthetic offer');
    await paste(field(/^body/i), 'a'.repeat(20001));
    expect(within(dialog()).getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/20[ ,.]?000|too long|limit/i);
    await save();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it('a server 400 on /body keeps the form open and shows the problem text', async () => {
    api.use(http.post('*/v1/engagement/portal-content', async ({ request }) => { await rec(request); return problem(400, 'common.validation_failed', 'body: not allowed'); }));
    await mount({ items: [] });
    await openNew('News');
    await userEvent.type(field(/^title/i), 'Synthetic title');
    await paste(field(/^body/i), 'fine text');
    await save();
    await waitFor(() => expect(hit('POST', /portal-content$/)).toHaveLength(1));
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('a read-only user has no New button, no Edit, no move buttons and disabled switches, with a visible reason', async () => {
    await mount({ permissions: READ });
    const panel = await tab('News');
    expect(within(panel).queryAllByRole('button', { name: /^new/i }).filter((b) => !(b as HTMLButtonElement).disabled)).toEqual([]);
    expect(within(panel).queryAllByRole('button', { name: /edit/i }).filter((b) => !(b as HTMLButtonElement).disabled)).toEqual([]);
    for (const s of within(panel).getAllByRole('switch')) expect((s as HTMLInputElement).disabled).toBe(true);
    for (const b of within(panel).queryAllByRole('button', { name: /move (up|down)/i })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(norm(document.body.textContent)).toMatch(/read[- ]only|permission|not allowed to (change|manage|edit)/i);
  });
});

// ------------------------------------------------------------------------------------------------- markdown editor + preview
describe('Markdown editor and live preview (done_when 2)', () => {
  const openNews = async () => { await mount({ items: [] }); const panel = await tab('News'); await userEvent.click(within(panel).getAllByRole('button', { name: /^new/i })[0]!); };

  it('the toolbar has Bold, Italic, Heading, List and Link; Offers has it too; Banners does not (no Markdown body there)', async () => {
    await openNews();
    const bar = within(dialog()).getByRole('toolbar');
    for (const n of [/bold/i, /italic/i, /heading/i, /list/i, /link/i]) expect(within(bar).getByRole('button', { name: n })).toBeTruthy();
    cleanup(); await mount({ items: [] });
    await userEvent.click(within(await tab('Offers')).getAllByRole('button', { name: /^new/i })[0]!);
    expect(within(dialog()).getByRole('toolbar')).toBeTruthy();
    cleanup(); await mount({ items: [] });
    await userEvent.click(within(await tab('Banners')).getAllByRole('button', { name: /^new/i })[0]!);
    expect(within(dialog()).queryByRole('button', { name: /bold/i })).toBeNull();
  });
  it('Bold wraps the selection in **, Italic in *, Heading prefixes "# ", List prefixes "- ", Link adds an https link skeleton', async () => {
    await openNews();
    const ta = field(/^body/i) as HTMLTextAreaElement;
    const bar = within(dialog()).getByRole('toolbar');
    const select = (a: number, b: number) => { ta.focus(); ta.setSelectionRange(a, b); };
    await paste(ta, 'hello');
    select(0, 5); await userEvent.click(within(bar).getByRole('button', { name: /bold/i }));
    expect(ta.value).toContain('**hello**');
    await userEvent.clear(ta); await paste(ta, 'hello');
    select(0, 5); await userEvent.click(within(bar).getByRole('button', { name: /italic/i }));
    expect(ta.value).toMatch(/(^|[^*])\*hello\*([^*]|$)|_hello_/);
    await userEvent.clear(ta); await paste(ta, 'hello');
    select(0, 5); await userEvent.click(within(bar).getByRole('button', { name: /heading/i }));
    expect(ta.value).toMatch(/^#{1,6} hello/);
    await userEvent.clear(ta); await paste(ta, 'hello');
    select(0, 5); await userEvent.click(within(bar).getByRole('button', { name: /list/i }));
    expect(ta.value).toMatch(/^([-*+]|1\.) hello/);
    await userEvent.clear(ta); await paste(ta, 'hello');
    select(0, 5); await userEvent.click(within(bar).getByRole('button', { name: /link/i }));
    expect(ta.value).toMatch(/\[hello\]\(https:\/\//);
  });
  it.each([
    ['bold, italic and underscore italic', '**bold** and *italic* and _it_'],
    ['heading, bullets and numbers', '# Heading\n\n- a\n- b\n\n1. x\n2. y'],
    ['an https link', 'See [the site](https://example.test/a?b=1&c=2) now'],
    ['paragraphs and line breaks', 'one\ntwo\n\nthree'],
    ['unclosed marks and specials', 'Hello ** not closed & "quoted" colon: x=1'],
  ])('the live preview of %s is exactly the renderer output (same safe renderer as the patient app)', async (_n, md) => {
    await openNews();
    await paste(field(/^body/i), md);
    expect(previewHtml()).toContain(expected(md));
  });
  it('the preview follows the text as it changes and is empty-safe', async () => {
    await openNews();
    expect(screen.getByRole('region', { name: /preview/i })).toBeTruthy();
    await paste(field(/^body/i), '# One');
    expect(previewHtml()).toContain(expected('# One'));
    await userEvent.clear(field(/^body/i));
    await paste(field(/^body/i), '# Two');
    expect(previewHtml()).toContain(expected('# Two'));
    expect(previewHtml()).not.toContain('One');
  });
  it('axe: the open editor has no violations', async () => { await openNews(); await noAxeViolations(); });
});

// ------------------------------------------------------------------------------------------------- upload
describe('Banners: image upload with the kit FileUpload (done_when 3)', () => {
  const openBanner = async (permissions = MANAGE) => { await mount({ items: [], permissions }); const panel = await tab('Banners'); await userEvent.click(within(panel).getAllByRole('button', { name: /^new/i })[0]!); };
  const input = () => within(dialog()).getByLabelText(/image/i, { selector: 'input[type="file"]' }) as HTMLInputElement;
  const uploads = () => hit('POST', /\/v1\/identity\/settings\/branding-assets$/);

  it('the kit FileUpload accepts only PNG and JPEG and states the limits (2 MB, PNG or JPEG) in its description', async () => {
    await openBanner();
    expect(dialog().querySelector('.lims-file-upload')).toBeTruthy();
    expect(input().getAttribute('accept')).toBe('image/png,image/jpeg');
    const desc = (input().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(desc).toMatch(/2 ?MB/i);
    expect(desc).toMatch(/PNG/i);
    expect(desc).toMatch(/JPEG|JPG/i);
  });
  it('a PNG goes up as ONE multipart POST with an Idempotency-Key, shows progress, then "Uploaded" and the thumbnail', async () => {
    api.use(http.post('*/v1/identity/settings/branding-assets', async ({ request }) => { await rec(request); await delay(250); return HttpResponse.json(asset, { status: 201 }); }));
    await openBanner();
    await userEvent.upload(input(), PNG('banner.png'));
    expect(await within(dialog()).findByRole('progressbar')).toBeTruthy();
    expect(await within(dialog()).findByText('Uploaded', {}, { timeout: 5000 })).toBeTruthy();
    expect(uploads()).toHaveLength(1);
    const u = uploads()[0]!;
    expect(u.headers.get('idempotency-key')).toMatch(/^[0-9a-zA-Z-]{16,}$/);
    expect(u.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(u.text).toMatch(/name="file"/);
    expect(u.text).toMatch(/name="kind"[\s\S]*?\r\n\r\n(logo|letterhead_header|letterhead_footer)\r\n/);
    const img = within(dialog()).getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('alt') ?? '', 'thumbnail has alt text').not.toBe('');
    expect(img.getAttribute('src') ?? '').toContain(ASSET);
  });
  it('saving the banner sends the uploaded asset id as image_attachment_id and an https link', async () => {
    await openBanner();
    await userEvent.upload(input(), PNG());
    await within(dialog()).findByText('Uploaded', {}, { timeout: 5000 });
    await userEvent.type(field(/^title/i), 'Synthetic banner');
    await userEvent.type(field(/link/i), 'https://example.test/promo');
    await save();
    await waitFor(() => expect(hit('POST', /portal-content$/)).toHaveLength(1));
    expect(hit('POST', /portal-content$/)[0]!.json).toMatchObject({ kind: 'banner', title: 'Synthetic banner', image_attachment_id: ASSET, link_url: 'https://example.test/promo' });
  });
  it('a non-https link is refused in the form (no request)', async () => {
    await openBanner();
    await userEvent.type(field(/^title/i), 'Synthetic banner');
    await userEvent.type(field(/link/i), 'http://example.test/promo');
    await save();
    expect(field(/link/i).getAttribute('aria-invalid')).toBe('true');
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });
  it('a file over 2 MB, a PDF and an empty file are refused in the browser with a visible message: no request', async () => {
    await openBanner();
    const u = userEvent.setup({ applyAccept: false });
    await u.upload(input(), PNG('big.png', 'image/png', 2 * 1024 * 1024 + 1));
    expect(within(dialog()).getByText(/larger than 2 MB/i)).toBeTruthy();
    await u.upload(input(), PNG('x.pdf', 'application/pdf'));
    expect(within(dialog()).getByText(/not allowed/i)).toBeTruthy();
    await u.upload(input(), new File([], 'empty.png', { type: 'image/png' }));
    expect(within(dialog()).getByText(/empty/i)).toBeTruthy();
    expect(uploads()).toEqual([]);
  });
  it('a failing upload retries by itself, then shows "Upload failed" and a Try again that works once the server recovers', async () => {
    let ok = false;
    api.use(http.post('*/v1/identity/settings/branding-assets', async ({ request }) => { await rec(request); return ok ? HttpResponse.json(asset, { status: 201 }) : problem(500, 'common.internal'); }));
    await openBanner();
    await userEvent.upload(input(), PNG());
    expect(await within(dialog()).findByText('Upload failed', {}, { timeout: 9000 })).toBeTruthy();
    expect(uploads().length, 'first try + retries').toBeGreaterThan(1);
    ok = true;
    await userEvent.click(within(dialog()).getByRole('button', { name: /try again/i }));
    expect(await within(dialog()).findByText('Uploaded', {}, { timeout: 5000 })).toBeTruthy();
  });
  it('an infected or quarantined file (422/400 problem) is shown as a visible failure, never as a thumbnail', async () => {
    api.use(http.post('*/v1/identity/settings/branding-assets', async ({ request }) => { await rec(request); return problem(422, 'common.upload_quarantined', 'The file was blocked'); }));
    await openBanner();
    await userEvent.upload(input(), PNG());
    expect(await within(dialog()).findByText('Upload failed', {}, { timeout: 9000 })).toBeTruthy();
    expect(within(dialog()).queryByRole('img')).toBeNull();
  });
  it('editing a banner shows its current thumbnail', async () => {
    await mount();
    const panel = await tab('Banners');
    await userEvent.click(within(within(panel).getByText('Synthetic Banner One').closest('tr, [role="row"]') as HTMLElement).getByRole('button', { name: /edit/i }));
    const img = within(dialog()).getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src') ?? '').toContain(ASSET_B1);
  });
  it('a manager without identity.settings.manage cannot upload (the branding route needs it): the input is disabled and the reason is read out', async () => {
    await openBanner(MANAGE_NO_UPLOAD);
    expect(input().disabled).toBe(true);
    const desc = (input().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(desc).toMatch(/permission|administrator|branding|not allowed/i);
  });
});

// ------------------------------------------------------------------------------------------------- contact us
describe('Contact Us: one form (done_when 4)', () => {
  it('is a form, not a list: no table, no New button; fields Address, Phones, Email, Opening hours, Map link are filled from the stored item', async () => {
    await mount();
    const panel = await tab('Contact Us');
    expect(within(panel).queryAllByRole('columnheader')).toEqual([]);
    expect(within(panel).queryAllByRole('button', { name: /^new/i })).toEqual([]);
    expect((within(panel).getByLabelText(/^address/i) as HTMLInputElement).value).toBe('Synthetic Road 1, Synthetic City');
    expect((within(panel).getByLabelText(/^phones?/i) as HTMLInputElement).value).toBe('9800000000, 9811111111');
    expect((within(panel).getByLabelText(/^e-?mail/i) as HTMLInputElement).value).toBe('info@example.test');
    expect((within(panel).getByLabelText(/hours/i) as HTMLInputElement).value).toBe('Sun-Fri 7am-7pm');
    expect((within(panel).getByLabelText(/map link/i) as HTMLInputElement).value).toBe('https://maps.example.test/place/1');
  });
  it('saving an existing entry PATCHes it with If-Match = version, the lines in body and the map link in link_url', async () => {
    await mount();
    const panel = await tab('Contact Us');
    const a = within(panel).getByLabelText(/^address/i);
    await userEvent.clear(a);
    await userEvent.type(a, 'Synthetic Marg 7');
    await userEvent.click(within(panel).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('PATCH', /portal-content\/[^/]+$/)).toHaveLength(1));
    const c = hit('PATCH', /portal-content\/[^/]+$/)[0]!;
    expect(c.path).toContain(C1);
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.json.body).toContain('Address: Synthetic Marg 7');
    expect(c.json.body).toContain('Phones: 9800000000, 9811111111');
    expect(c.json.body).toContain('Email: info@example.test');
    expect(c.json.body).toContain('Hours: Sun-Fri 7am-7pm');
    expect(c.json.link_url).toBe('https://maps.example.test/place/1');
  });
  it('with no entry yet, saving creates ONE item of kind contact', async () => {
    await mount({ items: NEWS });
    const panel = await tab('Contact Us');
    await userEvent.type(within(panel).getByLabelText(/^address/i), 'Synthetic Road 2');
    await userEvent.type(within(panel).getByLabelText(/^phones?/i), '9800000001');
    await userEvent.type(within(panel).getByLabelText(/^e-?mail/i), 'a@example.test');
    await userEvent.type(within(panel).getByLabelText(/hours/i), 'Daily 8am-5pm');
    await userEvent.type(within(panel).getByLabelText(/map link/i), 'https://maps.example.test/p/2');
    await userEvent.click(within(panel).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(hit('POST', /portal-content$/)).toHaveLength(1));
    expect(hit('POST', /portal-content$/)[0]!.json).toMatchObject({ kind: 'contact', link_url: 'https://maps.example.test/p/2' });
    expect(hit('POST', /portal-content$/)[0]!.json.body).toContain('Address: Synthetic Road 2');
  });
  it.each([
    ['http map link', /map link/i, 'http://maps.example.test/p'],
    ['javascript map link', /map link/i, 'javascript:alert(1)'],
    ['scheme-less map link', /map link/i, 'maps.example.test/p'],
    ['email without @', /^e-?mail/i, 'not-an-email'],
    ['address with raw HTML', /^address/i, 'Road <script>alert(1)</script>'],
  ])('%s is refused in the form (field invalid, visible message, no request)', async (_n, label, value) => {
    await mount();
    const panel = await tab('Contact Us');
    const el = within(panel).getByLabelText(label) as HTMLInputElement;
    await userEvent.clear(el);
    await paste(el, value);
    await userEvent.click(within(panel).getByRole('button', { name: /^save/i }));
    expect(el.getAttribute('aria-invalid')).toBe('true');
    expect(calls.filter((c) => c.method === 'POST' || c.method === 'PATCH')).toEqual([]);
  });
  it('a read-only user sees the values with every field read only and no Save', async () => {
    await mount({ permissions: READ });
    const panel = await tab('Contact Us');
    const a = within(panel).getByLabelText(/^address/i) as HTMLInputElement;
    expect(a.value).toBe('Synthetic Road 1, Synthetic City');
    expect(a.readOnly || a.disabled).toBe(true);
    expect(within(panel).queryByRole('button', { name: /^save/i })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------- profile images
describe('Profile Images (done_when 5)', () => {
  const panelOf = async () => tab('Profile Images');

  it('lists the images with headers always drawn (also when empty) and an EmptyState when there are none', async () => {
    await mount({ profileImages: [] });
    const panel = await panelOf();
    expect(headerCells(panel)).toEqual(expect.arrayContaining(['Profile type', 'Profile', 'Image']));
    expect(panel.querySelector('.lims-state')).toBeTruthy();
    cleanup(); await mount();
    const filled = await panelOf();
    expect(filled.textContent).toContain('Synthetic Doctor Rao');
    expect(filled.textContent).toContain('Synthetic Centre A1');
  });
  it('search by profile type (Doctor, Centre, Staff) and name calls the injected search with that kind', async () => {
    await mount();
    const panel = await panelOf();
    for (const k of ['Doctor', 'Centre', 'Staff']) expect(within(panel).getByRole('radio', { name: k })).toBeTruthy();
    await userEvent.click(within(panel).getByRole('radio', { name: 'Centre' }));
    await userEvent.type(within(panel).getByRole('searchbox', { name: /search/i }), 'Syn');
    await waitFor(() => expect(searchCalls).toContainEqual(['centre', 'Syn']));
    expect(await within(panel).findByRole('button', { name: 'Synthetic Staff Sen' })).toBeTruthy();
  });
  it('picking a profile with an active image shows its thumbnail; uploading sets it with PUT { image_attachment_id } on the right kind and id', async () => {
    await mount();
    const panel = await panelOf();
    await userEvent.type(within(panel).getByRole('searchbox', { name: /search/i }), 'Syn');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Synthetic Doctor Rao' }));
    const img = within(panel).getAllByRole('img').find((i) => (i.getAttribute('src') ?? '').includes(ASSET_B1));
    expect(img, 'current thumbnail').toBeTruthy();
    const input = within(panel).getByLabelText(/image/i, { selector: 'input[type="file"]' }) as HTMLInputElement;
    expect(input.getAttribute('accept')).toBe('image/png,image/jpeg');
    await userEvent.upload(input, PNG('doctor.png'));
    await within(panel).findByText('Uploaded', {}, { timeout: 5000 });
    await waitFor(() => expect(hit('PUT', /profile-images\/doctor\/[^/]+$/)).toHaveLength(1));
    const c = hit('PUT', /profile-images\/doctor\/[^/]+$/)[0]!;
    expect(c.path.endsWith(`/profile-images/doctor/${DOC}`)).toBe(true);
    expect(c.json).toEqual({ image_attachment_id: ASSET });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('Clear image DELETEs the profile image (after the confirmation, if one is asked); it is offered only when an image is active', async () => {
    await mount();
    const panel = await panelOf();
    await userEvent.type(within(panel).getByRole('searchbox', { name: /search/i }), 'Syn');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Synthetic Centre A1' })); // its image is already cleared
    expect(within(panel).queryByRole('button', { name: /clear image/i })).toBeNull();
    await userEvent.click(await within(panel).findByRole('button', { name: 'Synthetic Doctor Rao' }));
    await userEvent.click(within(panel).getByRole('button', { name: /clear image/i }));
    const ask = screen.queryByRole('alertdialog');
    if (ask) await userEvent.click(within(ask).getByRole('button', { name: /clear|confirm|yes/i }));
    await waitFor(() => expect(hit('DELETE', /profile-images\/doctor\/[^/]+$/)).toHaveLength(1));
    expect(hit('DELETE', /profile-images\/doctor\//)[0]!.path.endsWith(DOC)).toBe(true);
  });
  it('a server failure on set shows a visible error and leaves the screen usable', async () => {
    api.use(http.put('*/v1/engagement/profile-images/:kind/:id', async ({ request }) => { await rec(request); return problem(400, 'common.validation_failed', 'image_attachment_id is not an image of this lab'); }));
    await mount();
    const panel = await panelOf();
    await userEvent.type(within(panel).getByRole('searchbox', { name: /search/i }), 'Syn');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Synthetic Doctor Rao' }));
    await userEvent.upload(within(panel).getByLabelText(/image/i, { selector: 'input[type="file"]' }) as HTMLInputElement, PNG());
    expect(await screen.findByText(/not an image of this lab|could not|failed/i, {}, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Profile Images' })).toBeTruthy();
  });
  it('a read-only user can search and see images but has no upload and no Clear image', async () => {
    await mount({ permissions: READ });
    const panel = await panelOf();
    await userEvent.type(within(panel).getByRole('searchbox', { name: /search/i }), 'Syn');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Synthetic Doctor Rao' }));
    const input = within(panel).queryByLabelText(/image/i, { selector: 'input[type="file"]' }) as HTMLInputElement | null;
    expect(input === null || input.disabled).toBe(true);
    expect(within(panel).queryByRole('button', { name: /clear image/i })).toBeNull();
  });
  it('axe: the Profile Images tab has no violations', async () => { await mount(); await panelOf(); await noAxeViolations(); });
});
