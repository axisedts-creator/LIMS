// @vitest-environment jsdom
// RM-T05 — admin screen "apply or re-apply a role pack, with a diff before save" (11-ROLE-MATRIX §8; LD-141: R6 packs are custom roles, re-apply never removes;
// LD-140: kit + PermissionMatrix only). ACs: diff shown before save; role without identity.role.manage cannot open it; axe.
// ASSUMED seams (writer: dispute if wrong; CR-C2-RM-001 fixes them): page at the staff_web route found by rm-t05.contract.ts, an async server component
// Page({searchParams, params}) like the other admin pages; reads GET <list-packs path> -> { data: [{ pack_code, name, roles: [{ code, name, mfa_required, permission_codes }] }] }
// and GET /v1/identity/roles (existing); pack picker = radio (or combobox) named by pack name; diff = a region/group named /diff/i, one entry per pack role
// (new = will be created; existing = permissions to add, or unchanged); NO removal is ever shown (R6: tenant edits win); the diff roles use the kit PermissionMatrix
// (read-only checkboxes named by permission code); button "Apply" POSTs { pack_code } only, with an Idempotency-Key when the operation declares x-idempotency.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  ID, api, calls, callsTo, bodyOf, resetApi, routes, json, problem, role, show, showOrThrown, norm, pageText, axeClean, ROLE_FD, ROLE_LAB, PERMISSIONS,
} from '../../__tests__/t20.harness';
import { listPacksOp, operation, packRoute } from './rm-t05.contract';

vi.mock('next/navigation', async () => (await import('../../__tests__/t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('../../__tests__/t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
afterEach(() => cleanup());

const route = packRoute();
const REL = route?.rel ?? 'roles/packs'; // missing route => the import below fails with "Cannot find module", never a silent pass
const READ = listPacksOp()?.path ?? `${ID}/role-packs`;
const APPLY = operation('applyRolePack');
const APPLY_PATH = APPLY?.path ?? `${ID}/role-packs/{pack_code}/apply`;

// synthetic pack: corp_new (absent in tenant), corp_edit (tenant has it, plus a permission the tenant added), corp_same (identical)
const PACK = {
  pack_code: 'elabcorp_default', name: 'ELabCorp default',
  roles: [
    { code: 'corp_new', name: 'Corp new', mfa_required: false, permission_codes: ['frontdesk.order.read'] },
    { code: 'corp_edit', name: 'Corp edit', mfa_required: true, permission_codes: ['frontdesk.order.read', 'lab.result.approve'] },
    { code: 'corp_same', name: 'Corp same', mfa_required: false, permission_codes: ['lab.specimen.receive'] },
  ],
};
const PACK_B = { pack_code: 'elabassist_standard', name: 'ELabAssist standard', roles: [{ code: 'std_one', name: 'Std one', mfa_required: false, permission_codes: ['frontdesk.order.read'] }] };
const TENANT_ROLES = [
  role({ role_id: ROLE_FD, code: 'corp_edit', name: 'Corp edit', is_default: false, mfa_required: true, permission_codes: ['lab.specimen.receive', 'lab.result.approve'], member_count: 2 }),
  role({ role_id: ROLE_LAB, code: 'corp_same', name: 'Corp same', is_default: false, permission_codes: ['lab.specimen.receive'], member_count: 0 }),
];
const APPLIED = { pack_code: 'elabcorp_default', created: ['corp_new'], updated: ['corp_edit'], unchanged: ['corp_same'] };
const applyKey = () => `${APPLY?.method ?? 'POST'} ${APPLY_PATH.replace('{pack_code}', PACK.pack_code)}`;

function wire(opts: { roles?: unknown[]; packs?: unknown[]; apply?: () => Response } = {}) {
  resetApi(['identity.user.read', 'identity.role.manage']);
  routes[`GET ${READ}`] = json({ data: opts.packs ?? [PACK, PACK_B] });
  routes[`GET ${ID}/roles`] = json({ data: opts.roles ?? TENANT_ROLES });
  routes[`GET ${ID}/permissions`] = json({ data: PERMISSIONS });
  routes[applyKey()] = opts.apply ?? json(APPLIED);
}
const posts = () => calls.filter((c) => c.method !== 'GET');
const diffOf = () => screen.getByRole(screen.queryAllByRole('region', { name: /diff/i }).length ? 'region' : 'group', { name: /diff/i });
async function pick(name: RegExp) {
  const user = userEvent.setup();
  const radio = screen.queryAllByRole('radio', { name });
  if (radio.length) await user.click(radio[0]!);
  else await user.selectOptions(screen.getByRole('combobox', { name: /pack/i }), screen.getByRole('option', { name }));
  return user;
}
const applyBtn = () => screen.getByRole('button', { name: /^apply/i }) as HTMLButtonElement;

beforeEach(() => wire());

describe('access (07-SECURITY: gate before any API call)', () => {
  it('without identity.role.manage (read-only admin) the screen refuses and makes NO API call', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown(REL);
    expect(calls).toEqual([]);
    expect(screen.queryByRole('button', { name: /^apply/i })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
  it('without any admin permission: refuses, no API call', async () => {
    resetApi([]);
    await showOrThrown(REL);
    expect(calls).toEqual([]);
    expect(screen.queryByRole('button', { name: /^apply/i })).toBeNull();
  });
  it('a holder of identity.role.manage can open it: heading + the packs offered by the API', async () => {
    await show(REL);
    expect(screen.getByRole('heading', { level: 1, name: /role pack/i })).toBeTruthy();
    expect(pageText()).toContain('ELabCorp default');
    expect(pageText()).toContain('ELabAssist standard');
    expect(callsTo('GET', READ).length).toBeGreaterThan(0);
  });
});

describe('diff before save', () => {
  it('Apply is not available before a pack is chosen; choosing a pack shows the diff and writes NOTHING', async () => {
    await show(REL);
    expect(screen.queryByRole('button', { name: /^apply/i }) === null || applyBtn().disabled).toBe(true);
    await pick(/elabcorp/i);
    await waitFor(() => expect(diffOf()).toBeTruthy());
    expect(posts()).toEqual([]);
    expect(applyBtn().disabled).toBe(false);
  });
  it('diff lists new roles, roles that gain permissions (named), and unchanged roles', async () => {
    await show(REL);
    await pick(/elabcorp/i);
    const t = norm(await waitFor(() => diffOf()).then((d) => d.textContent));
    expect(t).toMatch(/corp_new.*(new|create)/i);
    expect(t).toMatch(/corp_edit/);
    expect(t).toMatch(/frontdesk\.order\.read/); // the one permission corp_edit lacks
    expect(t).toMatch(/corp_same.*(unchanged|no change)/i);
  });
  it('R6 / LD-141: the diff never offers removal — a permission the tenant added to a pack role is not shown as removed, no "remove"/"revoke" wording', async () => {
    wire({ roles: [role({ role_id: ROLE_FD, code: 'corp_edit', name: 'Corp edit', is_default: false, mfa_required: true, permission_codes: ['lab.result.approve', 'identity.role.manage'], member_count: 1 })] });
    await show(REL);
    await pick(/elabcorp/i);
    const t = norm((await waitFor(() => diffOf())).textContent);
    expect(t).not.toMatch(/remov|revok|delet|overwrit|reset/i);
    expect(t).not.toMatch(/identity\.role\.manage.*(will be|to be)/i);
  });
  it('re-apply: when every pack role already exists with its permissions the diff says there is nothing to apply and Apply is disabled', async () => {
    wire({ roles: [
      role({ role_id: ROLE_FD, code: 'corp_new', name: 'Corp new', is_default: false, permission_codes: ['frontdesk.order.read'] }),
      role({ role_id: ROLE_LAB, code: 'corp_edit', name: 'Corp edit', is_default: false, mfa_required: true, permission_codes: ['frontdesk.order.read', 'lab.result.approve', 'lab.specimen.receive'] }),
      role({ role_id: '01a1a98a-ac40-7000-8000-000000000099', code: 'corp_same', name: 'Corp same', is_default: false, permission_codes: ['lab.specimen.receive'] }),
    ] });
    await show(REL);
    await pick(/elabcorp/i);
    const t = norm((await waitFor(() => diffOf())).textContent);
    expect(t).toMatch(/no changes|nothing to apply|already applied/i);
    expect(applyBtn().disabled).toBe(true);
  });
  it('switching pack replaces the diff (no stale rows of the first pack)', async () => {
    await show(REL);
    const user = await pick(/elabcorp/i);
    await waitFor(() => expect(norm(diffOf().textContent)).toMatch(/corp_new/));
    await pick(/elabassist/i);
    await waitFor(() => expect(norm(diffOf().textContent)).toMatch(/std_one/));
    expect(norm(diffOf().textContent)).not.toMatch(/corp_new/);
    void user;
  });
  it('MFA badge (LD-140) on pack roles that require MFA', async () => {
    await show(REL);
    await pick(/elabcorp/i);
    const d = await waitFor(() => diffOf());
    const edit = within(d).getAllByText(/corp_edit/)[0]!.closest('li,tr,section,article,div')!;
    expect(norm(edit.textContent)).toMatch(/MFA/i);
  });
  it('PermissionMatrix (kit): a pack role opens a read-only matrix, one disabled checkbox per permission code, checked = the pack role\'s codes', async () => {
    await show(REL);
    const user = await pick(/elabcorp/i);
    const d = await waitFor(() => diffOf());
    await user.click(within(d).getAllByText(/corp_edit/)[0]!); // opens the role's matrix
    const box = (c: string) => screen.getByRole('checkbox', { name: c }) as HTMLInputElement;
    expect(box('lab.result.approve').checked).toBe(true);
    expect(box('lab.result.approve').disabled).toBe(true);
    expect(box('lab.specimen.receive').checked).toBe(false);
  });
});

describe('apply (save)', () => {
  it('Apply POSTs applyRolePack with exactly { pack_code }, Bearer token, and an Idempotency-Key when the operation requires one', async () => {
    expect(APPLY, 'applyRolePack missing from the contract (CR-C2-RM-001)').toBeDefined();
    await show(REL);
    const user = await pick(/elabcorp/i);
    await waitFor(() => diffOf());
    await user.click(applyBtn());
    await waitFor(() => expect(posts().length).toBe(1));
    const c = posts()[0]!;
    expect(`${c.method} ${c.url.pathname}`).toBe(applyKey());
    const b = bodyOf(c);
    if (c.url.pathname.includes(PACK.pack_code)) expect(b === null || Object.keys(b).every((k) => k === 'pack_code')).toBe(true);
    else expect(b).toEqual({ pack_code: PACK.pack_code });
    expect(JSON.stringify(b)).not.toMatch(/tenant|actor|membership|role_id|permission/i);
    expect(c.headers.get('authorization')).toMatch(/^Bearer /);
    if (APPLY!.op['x-idempotency'] === 'required') expect(c.headers.get('idempotency-key')).toBeTruthy();
  });
  it('after success it shows the result (created / updated / unchanged) and refreshes', async () => {
    await show(REL);
    const user = await pick(/elabcorp/i);
    await waitFor(() => diffOf());
    await user.click(applyBtn());
    await waitFor(() => expect(pageText()).toMatch(/applied|success/i));
    expect(pageText()).toMatch(/1 created/i);
    expect(pageText()).toMatch(/1 updated/i);
    expect(pageText()).toMatch(/1 unchanged/i);
  });
  it('a double click sends ONE request (button disabled while pending)', async () => {
    let n = 0;
    wire({ apply: () => { n += 1; return HttpResponse.json(APPLIED); } });
    await show(REL);
    const user = await pick(/elabcorp/i);
    await waitFor(() => diffOf());
    await user.dblClick(applyBtn());
    await waitFor(() => expect(n).toBeGreaterThan(0));
    expect(n).toBe(1);
  });
  it('403 / 422 problem responses show an alert with the server message and no success text; nothing is retried', async () => {
    wire({ apply: () => problem('auth.forbidden', 403) });
    await show(REL);
    const user = await pick(/elabcorp/i);
    await waitFor(() => diffOf());
    await user.click(applyBtn());
    await screen.findByRole('alert');
    expect(pageText()).not.toMatch(/applied successfully|1 created/i);
    expect(posts().length).toBe(1);
  });
  it('pack-list read failing (503) shows an error state, no picker, no Apply', async () => {
    wire();
    routes[`GET ${READ}`] = () => problem('common.dependency_unavailable', 503);
    await show(REL);
    expect(screen.queryByRole('button', { name: /^apply/i })).toBeNull();
    expect(screen.queryAllByRole('radio').length).toBe(0);
    expect(screen.queryAllByRole('alert').length + (/unavailable|try again|error/i.test(pageText()) ? 1 : 0)).toBeGreaterThan(0);
  });
});

describe('a11y', () => {
  it('axe: picker state', async () => { await show(REL); await axeClean(); });
  it('axe: diff state (matrix open)', async () => {
    await show(REL);
    await pick(/elabcorp/i);
    await waitFor(() => diffOf());
    await axeClean();
  });
});
