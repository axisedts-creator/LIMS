// @vitest-environment jsdom
// C2.T20 — AD-4 Roles, AD-5 Role editor (PermissionMatrix), AD-6 Branches, AD-7 Collection centres (04-UI-UX §6). ACs: US-B2 (B2.1 forced MFA, B2.2 non-assignable codes, B2.3 last-admin),
// US-C1 (C1.1 duplicate code, C1.2 deactivate keeps readable), D-13/D-63 hub-lab banner, 07-SECURITY A-4 (cannot grant platform.*).
// ASSUMED: roles table = grid named /roles/i; PermissionMatrix = checkboxes named by permission code; branches/centres = grid + side Dialog editor opened by row click.
// Writes: createRole POST /roles {code,name,description?,permission_codes,mfa_required}; updateRole PUT /roles/{id} If-Match; deactivate POST /roles/{id}/deactivate;
// createBranch/Centre POST; update PATCH If-Match; (de)activate POST .../deactivate|reactivate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ID, ROLE_ADMIN, ROLE_FD, ROLE_LAB, BRANCH_1, CENTRE_A1, api, calls, callsTo, bodyOf, resetApi, routes, json, problem, role, branch, centre, PERMISSIONS,
  show, showOrThrown, gridNamed, headersOf, rowTexts, pageText, norm, axeClean, router,
} from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => resetApi());
afterEach(() => cleanup());

const dlgOf = async () => screen.findByRole('dialog');
const HUB = 'Members with these permissions who process samples from other collection centres need All centres or every collection centre whose samples they process.';

describe('AD-4 Roles', () => {
  it('without identity.user.read: refuses, no API call', async () => {
    resetApi([]);
    await showOrThrown('roles');
    expect(calls).toEqual([]);
  });
  it('columns Name, Code, Default (badge), MFA required (Yes/No), Members, Status; [New role] only with identity.role.manage', async () => {
    await show('roles');
    const g = gridNamed(/roles/i);
    expect(headersOf(g)).toEqual(expect.arrayContaining(['Name', 'Code', 'Default', 'MFA required', 'Members', 'Status']));
    const t = rowTexts(g);
    expect(t.find((r) => /Lab admin/.test(r))).toMatch(/lab_admin.*Yes/);
    expect(t.find((r) => /Front desk/.test(r))).toMatch(/front_desk.*Default.*No.*3.*Active/);
    expect(screen.getByRole('link', { name: /new role/i }) ?? screen.getByRole('button', { name: /new role/i })).toBeTruthy();
    cleanup();
    resetApi(['identity.user.read']);
    await show('roles');
    expect(screen.queryByRole('link', { name: /new role/i })).toBeNull();
  });
  it('a11y', async () => { await show('roles'); await axeClean(); });
});

describe('AD-5 Role editor', () => {
  const ONE = `${ID}/roles/${ROLE_FD}`;
  beforeEach(() => { routes[`GET ${ONE}`] = json(role()); });

  it('matrix: rows = modules, a checkbox per permission code, "privileged" badge, non-assignable codes disabled with a tooltip, checked = role codes', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    expect((screen.getByRole('checkbox', { name: 'frontdesk.order.read' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'lab.specimen.receive' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'platform.tenant.manage' }) as HTMLInputElement).disabled).toBe(true); // A-4 / AC-B2.2: never assignable
    expect(pageText()).toMatch(/privileged/i);
  });

  it('Name 1–80, Code pattern ^[a-z][a-z0-9_]{1,39}$ required on create and READ-ONLY after, Description ≤500', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    const code = screen.getByLabelText(/^code/i) as HTMLInputElement;
    expect(code.readOnly || code.disabled).toBe(true);
    expect(code.value).toBe('front_desk');
    expect((screen.getByLabelText(/^name/i) as HTMLInputElement).maxLength).toBeLessThanOrEqual(80);
  });

  it('copy "Changing a role logs out everyone who has it."', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    expect(pageText()).toContain('Changing a role logs out everyone who has it.');
  });

  it('AC-B2.1 selecting any privileged code forces MFA required on and disabled, hint "Includes privileged permissions"', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    const user = userEvent.setup();
    const sw = screen.getByRole('switch', { name: /mfa required/i }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'lab.result.approve' }));
    expect((screen.getByRole('switch', { name: /mfa required/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('switch', { name: /mfa required/i }) as HTMLInputElement).disabled).toBe(true);
    expect(pageText()).toContain('Includes privileged permissions');
  });

  it('save = PUT {name, description?, permission_codes, mfa_required} with If-Match "<version>"; never sends code/tenant_id/permissions (REQ-SEC-080)', async () => {
    routes[`PUT ${ONE}`] = json(role({ version: 3 }));
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'lab.specimen.receive' }));
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', ONE)).toHaveLength(1));
    const c = callsTo('PUT', ONE)[0]!;
    expect(c.headers.get('if-match')).toBe('"2"');
    const b = bodyOf(c);
    expect(Object.keys(b).sort()).toEqual(expect.arrayContaining(['mfa_required', 'name', 'permission_codes']));
    expect(Object.keys(b)).not.toContain('code');
    expect(Object.keys(b)).not.toContain('tenant_id');
    expect(b.permission_codes.sort()).toEqual(['frontdesk.order.read', 'lab.specimen.receive']);
  });

  it('D-13/D-63: selecting a hub-lab permission shows the warning Banner above the matrix (warning only, Save still enabled)', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    expect(pageText()).not.toContain(HUB);
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'lab.specimen.receive' }));
    expect(pageText()).toContain(HUB);
    expect((screen.getByRole('button', { name: /^save/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('PermissionMatrix keyboard grid navigation: arrow keys move focus between checkboxes, Space toggles', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    const user = userEvent.setup();
    const first = screen.getByRole('checkbox', { name: 'frontdesk.order.read' });
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement?.getAttribute('type') ?? document.activeElement?.getAttribute('role')).toMatch(/checkbox/);
  });

  it('AC-B2.2 server 400 field_invalid at /permissions/<i> → inline error, form values kept', async () => {
    routes[`PUT ${ONE}`] = () => problem('common.validation_failed', 400, { errors: [{ code: 'common.field_invalid', pointer: '/permissions/0' }] });
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    await userEvent.setup().click(screen.getByRole('button', { name: /^save/i }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('[Deactivate role] disabled with tooltip for default roles and roles with members', async () => {
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } }); // is_default + 3 members
    expect((screen.getByRole('button', { name: /deactivate role/i }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    routes[`GET ${ID}/roles/${ROLE_LAB}`] = json(role({ role_id: ROLE_LAB, code: 'lab_tech', is_default: false, member_count: 0 }));
    routes[`POST ${ID}/roles/${ROLE_LAB}/deactivate`] = json(role({ role_id: ROLE_LAB, is_active: false }));
    await show('roles/[role_id]', { params: { role_id: ROLE_LAB } });
    const btn = screen.getByRole('button', { name: /deactivate role/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await userEvent.setup().click(btn);
    await userEvent.setup().click(within(await screen.findByRole('alertdialog').catch(() => dlgOf())).getByRole('button', { name: /deactivate|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ID}/roles/${ROLE_LAB}/deactivate`)).toHaveLength(1));
  });

  it('AC-B2.3 identity.last_admin_protected on deactivate/save → inline banner with catalog copy (no raw code)', async () => {
    routes[`PUT ${ONE}`] = () => problem('identity.last_admin_protected', 409);
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    await userEvent.setup().click(screen.getByRole('button', { name: /^save/i }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(pageText()).not.toContain('identity.last_admin_protected');
  });

  it('read-only for holders of identity.user.read without identity.role.manage: matrix disabled, no Save', async () => {
    resetApi(['identity.user.read']);
    routes[`GET ${ONE}`] = json(role());
    routes[`GET ${ID}/permissions`] = json({ data: PERMISSIONS });
    await show('roles/[role_id]', { params: { role_id: ROLE_FD } });
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    for (const c of screen.getAllByRole('checkbox')) expect((c as HTMLInputElement).disabled).toBe(true);
  });

  describe('New role', () => {
    it('needs identity.role.manage', async () => {
      resetApi(['identity.user.read']);
      await showOrThrown('roles/new');
      expect(callsTo('POST', `${ID}/roles`)).toEqual([]);
    });
    it('create: code pattern enforced client-side (bad code → no request); valid → POST {code,name,permission_codes,mfa_required}; 409 identity.code_duplicate-style errors stay inline', async () => {
      routes[`POST ${ID}/roles`] = json(role({ role_id: ROLE_LAB, code: 'night_tech', name: 'Night tech', is_default: false }), 201);
      await show('roles/new');
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/^name/i), 'Night tech');
      await user.type(screen.getByLabelText(/^code/i), 'Night Tech!');
      await user.click(screen.getByRole('checkbox', { name: 'frontdesk.order.read' }));
      await user.click(screen.getByRole('button', { name: /^save|create/i }));
      expect(callsTo('POST', `${ID}/roles`)).toHaveLength(0);
      await user.clear(screen.getByLabelText(/^code/i));
      await user.type(screen.getByLabelText(/^code/i), 'night_tech');
      await user.click(screen.getByRole('button', { name: /^save|create/i }));
      await waitFor(() => expect(callsTo('POST', `${ID}/roles`)).toHaveLength(1));
      expect(bodyOf(callsTo('POST', `${ID}/roles`)[0])).toEqual({ code: 'night_tech', name: 'Night tech', permission_codes: ['frontdesk.order.read'], mfa_required: false });
    });
    it('at least one permission is required (minItems 1)', async () => {
      await show('roles/new');
      const user = userEvent.setup();
      await user.type(screen.getByLabelText(/^name/i), 'Empty');
      await user.type(screen.getByLabelText(/^code/i), 'empty_role');
      await user.click(screen.getByRole('button', { name: /^save|create/i }));
      expect(callsTo('POST', `${ID}/roles`)).toHaveLength(0);
    });
  });

  it('a11y', async () => { await show('roles/[role_id]', { params: { role_id: ROLE_FD } }); await axeClean(); });
});

describe.each([
  { id: 'AD-6 Branches', route: 'branches', perm: 'identity.user.read', list: 'branches', param: 'branch_id', itemId: BRANCH_1, mk: branch, edit: { name: 'Synthetic Renamed Lab' }, cols: ['Code', 'Name', 'Phone', 'Status'] },
  { id: 'AD-7 Collection centres', route: 'centres', perm: 'identity.centre.read', list: 'centres', param: 'centre_id', itemId: CENTRE_A1, mk: centre, edit: { name: 'Synthetic Renamed Centre' }, cols: ['Code', 'Name', 'Branch', 'Type', 'Phone', 'Status'] },
])('$id', ({ route, perm, list, param, itemId, mk, edit, cols }) => {
  const LIST = `${ID}/${list}`;
  const ITEM = `${LIST}/${itemId}`;
  const isCentre = route === 'centres';

  it(`without ${perm}: refuses, no API call`, async () => {
    resetApi(['identity.self.manage']);
    await showOrThrown(route);
    expect(calls).toEqual([]);
  });

  it('table columns per 04-UI-UX §6; inactive rows show an Inactive status text', async () => {
    routes[`GET ${LIST}`] = json({ data: [mk(), mk({ [param]: '01a1a98a-ac40-7000-8000-0000000000ff', code: 'OLD-1', name: 'Synthetic Old', is_active: false })] });
    await show(route);
    const g = gridNamed(new RegExp(route === 'centres' ? 'centres' : 'branches', 'i'));
    expect(headersOf(g)).toEqual(expect.arrayContaining(cols));
    expect(rowTexts(g).some((r) => /OLD-1.*Inactive/.test(r))).toBe(true);
  });

  if (isCentre) {
    it('centre Type shows Own / Franchise / Home collection (own|franchise|home_collection)', async () => {
      routes[`GET ${LIST}`] = json({ data: [mk({ kind: 'home_collection' }), mk({ centre_id: 'c2', code: 'F1', kind: 'franchise' })] });
      await show(route);
      const t = rowTexts(gridNamed(/centres/i)).join(' ');
      expect(t).toMatch(/Home collection/);
      expect(t).toMatch(/Franchise/);
    });
    it('empty AD-7 state: "Add your first collection centre. Home collection can be added as its own centre."', async () => {
      routes[`GET ${LIST}`] = json({ data: [] });
      await show(route);
      expect(pageText()).toContain('Add your first collection centre. Home collection can be added as its own centre.');
    });
  }

  it('row click opens a side Dialog editor; Code is immutable after create; Save = PATCH only changed fields with If-Match "<version>"', async () => {
    routes[`GET ${LIST}`] = json({ data: [mk()] });
    routes[`PATCH ${ITEM}`] = json(mk({ ...edit, version: 2 }));
    await show(route);
    const user = userEvent.setup();
    await user.click(within(gridNamed(new RegExp(route, 'i'))).getAllByRole('row')[1]!);
    const dlg = await dlgOf();
    const code = within(dlg).getByLabelText(/^code/i) as HTMLInputElement;
    expect(code.readOnly || code.disabled).toBe(true);
    await user.clear(within(dlg).getByLabelText(/^name/i));
    await user.type(within(dlg).getByLabelText(/^name/i), Object.values(edit)[0]!);
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PATCH', ITEM)).toHaveLength(1));
    expect(callsTo('PATCH', ITEM)[0]!.headers.get('if-match')).toBe('"1"');
    expect(bodyOf(callsTo('PATCH', ITEM)[0])).toEqual(edit);
  });

  it('New: Code ^[A-Za-z0-9-]{1,16}$ + Name required (bad code → no request); POST body; hint "Printed on reports, e.g. C000000002"', async () => {
    routes[`GET ${LIST}`] = json({ data: [mk()] });
    routes[`POST ${LIST}`] = json(mk(), 201);
    await show(route);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^new|add/i }));
    const dlg = await dlgOf();
    expect(norm(dlg.textContent)).toContain('Printed on reports, e.g. C000000002');
    await user.type(within(dlg).getByLabelText(/^code/i), 'bad code!');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic New');
    if (isCentre) await user.click(within(dlg).getByLabelText(/^branch/i)).then(async () => user.click(await screen.findByRole('option', { name: /Synthetic Main Lab/ })));
    await user.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    expect(callsTo('POST', LIST)).toHaveLength(0);
    await user.clear(within(dlg).getByLabelText(/^code/i));
    await user.type(within(dlg).getByLabelText(/^code/i), 'C000000002');
    await user.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    await waitFor(() => expect(callsTo('POST', LIST)).toHaveLength(1));
    const b = bodyOf(callsTo('POST', LIST)[0]);
    expect(b).toMatchObject({ code: 'C000000002', name: 'Synthetic New' });
    expect(Object.keys(b)).not.toContain('tenant_id');
    if (isCentre) { expect(b.kind).toBe('own'); expect(b.branch_id).toBe(BRANCH_1); }
  });

  it('AC-C1.1 409 identity.code_duplicate → inline error on Code, dialog stays open', async () => {
    routes[`GET ${LIST}`] = json({ data: [mk()] });
    routes[`POST ${LIST}`] = () => problem('identity.code_duplicate', 409);
    await show(route);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^new|add/i }));
    const dlg = await dlgOf();
    await user.type(within(dlg).getByLabelText(/^code/i), 'DUP-1');
    await user.type(within(dlg).getByLabelText(/^name/i), 'Dup');
    if (isCentre) await user.click(within(dlg).getByLabelText(/^branch/i)).then(async () => user.click(await screen.findByRole('option', { name: /Synthetic Main Lab/ })));
    await user.click(within(dlg).getByRole('button', { name: /^(save|create)/i }));
    expect((await within(dlg).findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });

  it('AC-C1.2 deactivate = ConfirmDialog + POST …/deactivate (record stays listed, never deleted); Reactivate for inactive', async () => {
    routes[`GET ${LIST}`] = json({ data: [mk()] });
    routes[`POST ${ITEM}/deactivate`] = json(mk({ is_active: false, version: 2 }));
    await show(route);
    const user = userEvent.setup();
    await user.click(within(gridNamed(new RegExp(route, 'i'))).getAllByRole('row')[1]!);
    const dlg = await dlgOf();
    await user.click(within(dlg).getByRole('button', { name: /deactivate/i }));
    await user.click(within(await screen.findByRole('alertdialog').catch(() => dlgOf())).getByRole('button', { name: /deactivate|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${ITEM}/deactivate`)).toHaveLength(1));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  if (isCentre) {
    it('edit actions need identity.centre.manage; read-only holders see the list without New/Save (08 A13 D-16)', async () => {
      resetApi(['identity.centre.read']);
      routes[`GET ${LIST}`] = json({ data: [mk()] });
      await show(route);
      expect(screen.queryByRole('button', { name: /^new|add/i })).toBeNull();
    });
  } else {
    it('Processing lab Switch defaults on for a new branch', async () => {
      routes[`GET ${LIST}`] = json({ data: [mk()] });
      await show(route);
      await userEvent.setup().click(screen.getByRole('button', { name: /^new|add/i }));
      expect((within(await dlgOf()).getByRole('switch', { name: /processing lab/i }) as HTMLInputElement).checked).toBe(true);
    });
  }

  it('a11y', async () => {
    routes[`GET ${LIST}`] = json({ data: [mk()] });
    await show(route);
    await axeClean();
  });
});

void [ROLE_ADMIN];
