// @vitest-environment jsdom
// RS-C2 (LD-140; 10-DESIGN-SYSTEM s3, s4, s6, s8): the C2 identity + admin screens as built, restyled to Metro Green. Appearance and
// arrangement only: every behavioural assertion here also holds for the pre-restyle code (writer: they must stay green).
// What the restyle adds, and what fails until it is done:
//   * "Required" is visible text in the field (not only `*` / aria-required), in the field's own container (label or description);
//     optional fields do not say it. NOTE the chunk tests t12 query labels as exact "Password" / /^email/i, so put "Required" in a
//     description / sibling element of the label, not inside the label text.
//   * the branch / centre master: row opens a RIGHT drawer (kit Drawer, side end) whose body is >= 2 sections (kit DrawerSection),
//     each with its own "Save <section title>" button; Save from any section sends the same updateUnit / createUnit call as before.
//   * the role editor shows an MFA chip (kit Badge / StatusChip: `.lims-chip` with the word "MFA") for a role holding privileged
//     permissions or with mfa_required, and none for a role without.
//   * one primary button per page (and per drawer).
//   * visual snapshots of the key screens are recorded (`__snapshots__/rs-c2.screens.test.tsx.snap`); run with CI=true so an
//     unrecorded snapshot fails. Record once, after everything else is green:
//     pnpm --dir apps/web exec vitest run --config src/features/admin/__tests__/vitest.rs-c2.config.ts -u rs-c2.screens
// Kept as guards (pass before and after): axe zero serious/critical, keyboard-only path through sign-in and the drawer, behaviour.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const m = vi.hoisted(() => ({
  push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(),
  searchUsers: vi.fn(), createRole: vi.fn(), updateRole: vi.fn(), deactivateRole: vi.fn(),
  createUnit: vi.fn(), updateUnit: vi.fn(), setUnitActive: vi.fn(),
  setFeatureFlag: vi.fn(), updateSettings: vi.fn(), uploadBrandingAsset: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: m.push, replace: m.replace, refresh: m.refresh, back: m.back }),
  usePathname: () => '/admin',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('server-only', () => ({}));
vi.mock('../actions', () => m);

import { LoginForm } from '../auth/LoginForm';
import { ForgotPasswordForm } from '../auth/ForgotPasswordForm';
import { SetPasswordForm } from '../auth/SetPasswordForm';
import { MfaChallengeForm } from '../auth/MfaChallengeForm';
import { UsersTable } from '../components/UsersTable';
import { RoleEditor } from '../components/RoleEditor';
import { OrgUnits } from '../components/OrgUnits';
import { SettingsScreen } from '../components/SettingsScreen';
import type { Branch, Centre, Permission, Role, UserSummary } from '../lib';

const here = dirname(fileURLToPath(import.meta.url));
const u = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------- synthetic fixtures
const catalog: Permission[] = [
  { code: 'identity.user.read', privileged: false, module: 'identity', phase: '1', assignable: true },
  { code: 'frontdesk.order.read', privileged: false, module: 'frontdesk', phase: '1', assignable: true },
  { code: 'lab.result.approve', privileged: true, module: 'lab', phase: '1', assignable: true },
  { code: 'platform.tenant.manage', privileged: true, module: 'platform', phase: '1', assignable: false },
];
const roleFd: Role = { role_id: u(11), code: 'front_desk', name: 'Front desk', is_default: true, mfa_required: false, permission_codes: ['frontdesk.order.read'], member_count: 3, is_active: true, version: 2 };
const roleLab: Role = { role_id: u(12), code: 'lab_admin', name: 'Lab admin', is_default: false, mfa_required: true, permission_codes: ['lab.result.approve'], member_count: 0, is_active: true, version: 3 };
const branch = { branch_id: u(20), code: 'KTM', name: 'Kathmandu lab', is_processing_lab: true, is_active: true, version: 1 } satisfies Branch;
const centre = { centre_id: u(30), code: 'C01', name: 'Central Collection', branch_id: u(20), kind: 'own', address_text: 'Synthetic Road 1', phone: '+97711111111', is_active: true, version: 4 } satisfies Centre;
const user: UserSummary = { membership_id: u(2), display_name: 'Synthetic Sita Rai', email_masked: 'te***@example.test', status: 'active', is_locked: false, roles: [{ role_id: u(11), code: 'front_desk', name: 'Front desk' }], all_centres: false, centre_count: 2, mfa_enrolled: true, last_login_at: '2026-11-10T09:00:00.000Z', version: 4 };
const settings = { version: 7, display_name: 'Synthetic Lab', contact_email: 'lab@example.test' };

const ok = () => vi.fn(async (_fd?: unknown) => ({ ok: true as const }));
const withToast = (el: ReactElement) => <ToastProvider>{el}</ToastProvider>;

beforeEach(() => {
  m.updateUnit.mockResolvedValue({ ok: true, data: { ...centre, name: 'Renamed centre', version: 5 } });
  m.createUnit.mockResolvedValue({ ok: true, data: { ...centre, centre_id: u(31), code: 'C99', name: 'Brand new centre', version: 1 } });
  m.updateRole.mockResolvedValue({ ok: true, data: { ...roleLab, version: 4 } });
  m.createRole.mockResolvedValue({ ok: true, data: { ...roleLab, role_id: u(13) } });
  m.updateSettings.mockResolvedValue({ ok: true, data: { ...settings, version: 8 } });
  m.searchUsers.mockResolvedValue({ ok: true, data: { data: [] } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

type Screen = { name: string; ui: () => ReactElement };
const SCREENS: Screen[] = [
  { name: 'sign-in', ui: () => <LoginForm action={ok()} /> },
  { name: 'forgot-password', ui: () => <ForgotPasswordForm action={ok()} /> },
  { name: 'set-password', ui: () => <SetPasswordForm action={ok()} variant="invite" /> },
  { name: 'mfa-challenge', ui: () => <MfaChallengeForm action={ok()} logoutAction={ok()} /> },
  { name: 'users', ui: () => <UsersTable rows={[user]} /> },
  { name: 'roles-new', ui: () => withToast(<RoleEditor catalog={catalog} canEdit />) },
  { name: 'roles-edit-privileged', ui: () => withToast(<RoleEditor role={roleLab} catalog={catalog} canEdit />) },
  { name: 'centres', ui: () => withToast(<OrgUnits kind="centres" units={[centre]} branches={[branch]} canEdit />) },
  { name: 'branches', ui: () => withToast(<OrgUnits kind="branches" units={[branch]} branches={[branch]} canEdit />) },
  { name: 'settings', ui: () => withToast(<SettingsScreen settings={settings} flags={[]} annexes={[]} />) },
];

// ---------------------------------------------------------------- helpers
const serious = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.impact}): ${v.nodes[0]?.html.slice(0, 120)}`);
};
const primaries = (root: ParentNode) => [...root.querySelectorAll('button.lims-btn-primary, a.lims-btn-primary')];
/** The field's own container: the nearest `.lims-field`, else the parent element of the control. */
const fieldBox = (input: HTMLElement) => input.closest('.lims-field') ?? input.parentElement!;
const norm = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
const says = (input: HTMLElement) => /\bRequired\b/.test(norm(fieldBox(input).textContent));
const sectionOf = (el: HTMLElement) => {
  const s = el.closest('section.lims-drawer-section');
  if (!s) throw new Error(`"${el.getAttribute('name') || el.id}" is not inside a kit DrawerSection (section.lims-drawer-section)`);
  return s as HTMLElement;
};
const byLabel = (root: HTMLElement | Document, label: string) => within(root as HTMLElement).getByLabelText(new RegExp(`^${label}\\b`));
/** Stable HTML for a snapshot: React / RAC generated ids replaced, one tag per line. */
const snapHtml = () =>
  document.body.innerHTML
    .replace(/(?:react-aria[\w:«»-]*|:r[\w]+:|_r_[\w]+_|«r[\w]+»)/g, '#id')
    .replace(/></g, '>\n<');

// ---------------------------------------------------------------- axe, one primary (guards)
describe.each(SCREENS)('screen: $name', ({ name, ui }) => {
  it('axe: zero serious or critical violations (colour contrast is gated by the token build, not jsdom)', async () => {
    render(ui());
    expect(await serious()).toEqual([]);
  });

  it('s3 one primary button per page', () => {
    render(ui());
    expect(primaries(document.body).length, `${name}: primary buttons`).toBeLessThanOrEqual(1);
  });

  it('s6 no emoji, no greeting', () => {
    render(ui());
    const t = norm(document.body.textContent);
    expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
    // T0D-MSERIES-5 (LD-276, board M1-entry.png): the sign-in heading IS "Welcome back"; every other screen keeps the no-greeting rule.
    if (name !== 'sign-in') expect(t).not.toMatch(/welcome back/i);
  });
});

// ---------------------------------------------------------------- s3 "Required" (fails until restyled)
describe('s3 required fields say "Required"; optional ones do not', () => {
  it('sign-in: Work email and Password', () => {
    render(<LoginForm action={ok()} />);
    expect(says(byLabel(document, 'Work email'))).toBe(true);
    expect(says(byLabel(document, 'Password'))).toBe(true);
  });

  it('forgot password: Email', () => {
    render(<ForgotPasswordForm action={ok()} />);
    expect(says(byLabel(document, 'Email'))).toBe(true);
  });

  it('role editor (new): Name and Code say it, Description does not', () => {
    render(withToast(<RoleEditor catalog={catalog} canEdit />));
    expect(says(byLabel(document, 'Name'))).toBe(true);
    expect(says(byLabel(document, 'Code'))).toBe(true);
    expect(says(byLabel(document, 'Description'))).toBe(false);
  });

  it('role editor (existing): the immutable Code is not marked Required', () => {
    render(withToast(<RoleEditor role={roleLab} catalog={catalog} canEdit />));
    expect(says(byLabel(document, 'Code'))).toBe(false);
    expect(says(byLabel(document, 'Name'))).toBe(true);
  });

  it('centre drawer (new): Code and Name say it, Address and Phone do not', async () => {
    const user = userEvent.setup();
    render(withToast(<OrgUnits kind="centres" units={[centre]} branches={[branch]} canEdit />));
    await user.click(screen.getByRole('button', { name: 'New centre' }));
    const dialog = await screen.findByRole('dialog');
    expect(says(byLabel(dialog, 'Code'))).toBe(true);
    expect(says(byLabel(dialog, 'Name'))).toBe(true);
    expect(says(byLabel(dialog, 'Address'))).toBe(false);
    expect(says(byLabel(dialog, 'Phone'))).toBe(false);
  });

  it('settings (General): Display name says it, Contact email does not', () => {
    render(withToast(<SettingsScreen settings={settings} flags={[]} annexes={[]} />));
    expect(says(byLabel(document, 'Display name'))).toBe(true);
    expect(says(byLabel(document, 'Contact email'))).toBe(false);
  });
});

// ---------------------------------------------------------------- s4 masters: list + right drawer, per-section Save
describe.each([
  ['centres', 'centre'],
  ['branches', 'branch'],
] as const)('s4 master %s: list + right drawer with per-section Save', (kind, noun) => {
  const unit = kind === 'centres' ? centre : branch;
  const ui = () => withToast(<OrgUnits kind={kind} units={[unit as never]} branches={[branch]} canEdit />);

  it('row opens the editor in a drawer on the right (side end), and Escape closes it', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('button', { name: unit.name }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.closest('.lims-drawer-end'), 'right-hand drawer').not.toBeNull();
    expect(within(dialog).getByRole('heading', { name: `Edit ${noun}` })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the drawer body is at least two sections, each with a heading and its own Save', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('button', { name: unit.name }));
    const dialog = await screen.findByRole('dialog');
    const sections = [...dialog.querySelectorAll('section.lims-drawer-section')];
    expect(sections.length).toBeGreaterThanOrEqual(2);
    for (const s of sections) {
      expect(within(s as HTMLElement).getByRole('heading', { level: 3 })).toBeTruthy();
      expect(within(s as HTMLElement).getAllByRole('button', { name: /^Save\b/ }).length).toBe(1);
    }
    // every editable field lives in a section (no loose 40-field page)
    for (const input of dialog.querySelectorAll('input:not([type=hidden]), textarea')) expect(input.closest('section.lims-drawer-section'), `${(input as HTMLInputElement).name || input.id} outside a section`).not.toBeNull();
    // one primary per drawer: the section Saves are secondary
    expect(primaries(dialog).length).toBeLessThanOrEqual(1);
  });

  it('Save in the section that holds Name sends the same updateUnit call as before (changed field only, If-Match version)', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('button', { name: unit.name }));
    const dialog = await screen.findByRole('dialog');
    const name = byLabel(dialog, 'Name');
    await user.clear(name);
    await user.type(name, 'Renamed centre');
    const section = sectionOf(name);
    await user.click(within(section).getByRole('button', { name: /^Save\b/ }));
    await waitFor(() => expect(m.updateUnit).toHaveBeenCalledTimes(1));
    expect(m.updateUnit).toHaveBeenCalledWith(kind, kind === 'centres' ? centre.centre_id : branch.branch_id, unit.version, { name: 'Renamed centre' });
    expect(m.createUnit).not.toHaveBeenCalled();
  });

  it('Save with no change calls nothing', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('button', { name: unit.name }));
    const dialog = await screen.findByRole('dialog');
    const section = sectionOf(byLabel(dialog, 'Name'));
    await user.click(within(section).getByRole('button', { name: /^Save\b/ }));
    expect(m.updateUnit).not.toHaveBeenCalled();
  });

  it('a new unit: filling Code and Name and pressing Save in any section sends the same createUnit call', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('button', { name: `New ${noun}` }));
    const dialog = await screen.findByRole('dialog');
    await user.type(byLabel(dialog, 'Code'), 'C99');
    await user.type(byLabel(dialog, 'Name'), 'Brand new centre');
    const sections = [...dialog.querySelectorAll('section.lims-drawer-section')] as HTMLElement[];
    expect(sections.length).toBeGreaterThanOrEqual(2);
    await user.click(within(sections[sections.length - 1]!).getByRole('button', { name: /^Save\b/ }));
    await waitFor(() => expect(m.createUnit).toHaveBeenCalledTimes(1));
    expect(m.createUnit).toHaveBeenCalledWith(kind, expect.objectContaining({ code: 'C99', name: 'Brand new centre', ...(kind === 'centres' ? { branch_id: branch.branch_id } : {}) }));
    expect(m.updateUnit).not.toHaveBeenCalled();
  });

  it('an invalid new unit (empty Name) is refused client-side with the same message, no API call', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('button', { name: `New ${noun}` }));
    const dialog = await screen.findByRole('dialog');
    await user.type(byLabel(dialog, 'Code'), 'C99');
    const section = sectionOf(byLabel(dialog, 'Name'));
    await user.click(within(section).getByRole('button', { name: /^Save\b/ }));
    expect(await within(dialog).findByText('Enter 1–120 characters')).toBeTruthy();
    expect(m.createUnit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- s4 roles: PermissionMatrix + MFA badge
describe('s4 roles: PermissionMatrix with an MFA badge on roles that hold privileged permissions', () => {
  const chips = () => [...document.querySelectorAll('.lims-chip')].map((c) => norm(c.textContent));

  it('a role holding a privileged permission shows an MFA chip (word + tone, not colour only)', () => {
    render(withToast(<RoleEditor role={roleLab} catalog={catalog} canEdit />));
    const mfa = [...document.querySelectorAll('.lims-chip')].filter((c) => /\bMFA\b/.test(norm(c.textContent)));
    expect(mfa.length, `chips: ${JSON.stringify(chips())}`).toBeGreaterThanOrEqual(1);
    expect(mfa[0]!.getAttribute('data-tone')).toBeTruthy();
  });

  it('a role with no privileged permission and no MFA flag shows no MFA chip', () => {
    render(withToast(<RoleEditor role={roleFd} catalog={catalog} canEdit />));
    expect(chips().filter((c) => /\bMFA\b/.test(c))).toEqual([]);
  });

  it('behaviour kept: privileged permission still forces MFA required (switch on and disabled), matrix still lists the catalog', () => {
    render(withToast(<RoleEditor role={roleLab} catalog={catalog} canEdit />));
    const sw = screen.getByRole('switch', { name: /MFA required/ }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    expect(sw.disabled).toBe(true);
    expect(screen.getByText('Includes privileged permissions')).toBeTruthy();
  });

  it('behaviour kept: Save sends the same updateRole call (id, version, body)', async () => {
    const user = userEvent.setup();
    render(withToast(<RoleEditor role={roleLab} catalog={catalog} canEdit />));
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(m.updateRole).toHaveBeenCalledTimes(1));
    expect(m.updateRole).toHaveBeenCalledWith(roleLab.role_id, roleLab.version, { name: 'Lab admin', permission_codes: ['lab.result.approve'], mfa_required: true });
  });
});

// ---------------------------------------------------------------- keyboard-only path (guard)
describe('keyboard-only path through the main task', () => {
  // T0D-MSERIES-5 (LD-276): M1 board order = Work email, Forgot password? (on the password label row, before the field), Password, [Show/Hide], Continue.
  it('sign-in: Tab reaches Work email, Forgot password?, Password, then Continue; Enter on the button submits the same FormData', async () => {
    const action = ok();
    const user = userEvent.setup();
    render(<LoginForm action={action} />);
    const seen: string[] = [];
    const visit = async () => {
      await user.tab();
      const a = document.activeElement as HTMLElement;
      seen.push(a.getAttribute('name') ?? norm(a.textContent));
      return a;
    };
    expect((await visit()).getAttribute('name')).toBe('email');
    await user.keyboard('user@example.test');
    expect(norm((await visit()).textContent)).toBe('Forgot password?');
    expect((await visit()).getAttribute('name')).toBe('password');
    await user.keyboard('Correct-horse-1');
    let a = await visit();
    for (let i = 0; i < 3 && norm(a.textContent) !== 'Continue'; i++) a = await visit(); // the show/hide toggle may sit between
    expect(norm(a.textContent), `tab order: ${seen.join(' > ')}`).toBe('Continue');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const sent = Object.fromEntries((action.mock.calls[0]![0] as FormData).entries());
    expect(sent).toMatchObject({ email: 'user@example.test', password: 'Correct-horse-1' });
  });

  it('centres: the unit name is a button, Enter opens the drawer, focus moves into it, Escape closes it', async () => {
    const user = userEvent.setup();
    render(withToast(<OrgUnits kind="centres" units={[centre]} branches={[branch]} canEdit />));
    const trigger = screen.getByRole('button', { name: centre.name });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('role editor: the matrix is one tab stop; Save is reachable by keyboard', async () => {
    const user = userEvent.setup();
    render(withToast(<RoleEditor role={roleFd} catalog={catalog} canEdit />));
    const stops: HTMLElement[] = [];
    for (let i = 0; i < 40; i++) {
      await user.tab();
      const a = document.activeElement as HTMLElement;
      if (stops.includes(a)) break;
      stops.push(a);
    }
    expect(stops.some((s) => /^Save/.test(norm(s.textContent)))).toBe(true);
    expect(stops.filter((s) => s.getAttribute('type') === 'checkbox' && s.closest('[role=grid], [role=group], table, .lims-permission-matrix') !== null).length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- visual snapshots of the key screens (fail until recorded)
describe('visual snapshots of the key screens are recorded', () => {
  it('the snapshot file exists and holds every key screen', () => {
    const file = join(here, '__snapshots__', 'rs-c2.screens.test.tsx.snap');
    expect(existsSync(file), 'record with -u (see the header of this file)').toBe(true);
    const text = readFileSync(file, 'utf8');
    // T0D-MSERIES-5 (LD-276): the sign-in snapshot is retired; the structure of every entry screen is asserted by auth/__tests__/m5.entry.test.tsx (headings, order, chips, plate, no stepper).
    for (const s of ['users', 'roles-edit-privileged', 'centres drawer', 'settings']) expect(text, `snapshot "${s}"`).toContain(`snapshot: ${s} `);
    expect(text).not.toContain('snapshot: sign-in ');
  });

  it('snapshot: users', () => {
    render(<UsersTable rows={[user]} />);
    expect(snapHtml()).toMatchSnapshot();
  });
  it('snapshot: roles-edit-privileged', () => {
    render(withToast(<RoleEditor role={roleLab} catalog={catalog} canEdit />));
    expect(snapHtml()).toMatchSnapshot();
  });
  it('snapshot: centres drawer', async () => {
    const user = userEvent.setup();
    render(withToast(<OrgUnits kind="centres" units={[centre]} branches={[branch]} canEdit />));
    await user.click(screen.getByRole('button', { name: centre.name }));
    await screen.findByRole('dialog');
    expect(snapHtml()).toMatchSnapshot();
  });
  it('snapshot: settings', () => {
    render(withToast(<SettingsScreen settings={settings} flags={[]} annexes={[]} />));
    expect(snapHtml()).toMatchSnapshot();
  });
});
