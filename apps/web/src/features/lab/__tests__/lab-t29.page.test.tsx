// C5.T-29 — page wiring for `/lab/settings` (server component; node env). 04-UI-UX §1 nav row (`lab.config.manage`, CR-C5-004), §3.13.
// ASSUMED contract: app/(staff)/lab/settings/page.tsx default async Page() → <LabSettingsPage permissions/> (components/settings/LabSettingsPage.tsx, see lab-t29.settings.test.tsx), permissions = session permissions.
//   Without `lab.config.manage` the route is not available: the page calls notFound() (the nav hides it; a direct URL must not render a settings screen to a role that cannot manage it). The page itself reads no lab data (the client
//   component does), so a failing API never crashes the page. Sibling folders error.tsx / loading.tsx exist like every other lab route.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: ['lab.config.manage', 'lab.worklist.read'] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Lab Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/settings',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));

const render = async () => (await (await import('@/app/(staff)/lab/settings/page')).default()) as ReactElement;
const dir = fileURLToPath(new URL('../../../app/(staff)/lab/settings/', import.meta.url));

describe('/lab/settings page', () => {
  it('renders <LabSettingsPage> with the session permissions', async () => {
    session.permissions = ['lab.config.manage', 'lab.worklist.read'];
    const el = await render();
    const { LabSettingsPage } = await import('../components/settings/LabSettingsPage');
    expect(el.type).toBe(LabSettingsPage);
    expect((el.props as { permissions: string[] }).permissions).toEqual(session.permissions);
  });

  it('a session without lab.config.manage gets notFound() (S-15: no settings screen for technologists / front desk)', async () => {
    session.permissions = ['lab.worklist.read', 'lab.result.read', 'lab.specimen.read'];
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('the route folder carries page.tsx, error.tsx and loading.tsx like its siblings', () => {
    for (const f of ['page.tsx', 'error.tsx', 'loading.tsx']) expect(existsSync(`${dir}${f}`), f).toBe(true);
  });
});
