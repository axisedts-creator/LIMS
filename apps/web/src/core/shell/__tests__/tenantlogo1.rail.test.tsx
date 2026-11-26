// @vitest-environment jsdom
// CR TENANT-LOGO-1 (changes LD-251 / 13-M-SERIES s3 for staff sessions): the staff sidebar shows the signed-in lab's own logo in place of
// the default (Metro Labs) logo. The image address names no tenant the server trusts: /tenant-logo answers for the session's tenant only;
// `?t=` merely keys the browser cache. Any load failure falls back to the default logo. The platform console keeps the default logo.
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import { ALL_PERMS, platformSession, session, sidebar } from './m2.harness';
import { AppShell, TENANT_LOGO_PATH } from '../AppShell';
import { LOGO_ON_DARK } from '../brand';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('./m2.harness')).generatedMock);

const mount = (sess: unknown) => render(<AppShell session={sess as any} pathname="/lab/worklist"><p>page body</p></AppShell>);
const logo = () => within(sidebar()).getAllByRole('img').find((i) => i.classList.contains('lims-rail-logo')) as HTMLImageElement;
const srcOf = (i: HTMLImageElement) => i.getAttribute('src');

describe('staff sidebar logo', () => {
  it('a staff session gets its own lab logo: src /tenant-logo?t=<tenant code>, alt = the tenant, drawn on the white plate', () => {
    const s = session(ALL_PERMS); mount(s);
    expect(TENANT_LOGO_PATH).toBe('/tenant-logo');
    expect(srcOf(logo())).toBe(`/tenant-logo?t=${encodeURIComponent(s.actor.tenantCode)}`);
    expect(logo().alt).toBe(s.actor.tenantCode); expect(logo().classList.contains('lims-rail-logo-own')).toBe(true);
    expect(within(sidebar()).getAllByRole('img').filter((i) => i.classList.contains('lims-rail-logo'))).toHaveLength(1);
  });
  it('two tenants never share an address (per-tenant browser cache key) and the address is same-origin (CSP img-src self)', () => {
    const a = session(ALL_PERMS, { actor: { ...session(ALL_PERMS).actor, tenantCode: 'synthetic_alpha' } });
    const b = session(ALL_PERMS, { actor: { ...session(ALL_PERMS).actor, tenantCode: 'synthetic_beta' } });
    const ra = mount(a); const srcA = srcOf(logo()); ra.unmount();
    mount(b); const srcB = srcOf(logo());
    expect(srcA).toBe('/tenant-logo?t=synthetic_alpha'); expect(srcB).toBe('/tenant-logo?t=synthetic_beta');
    for (const s of [srcA!, srcB!]) expect(s).toMatch(/^\/tenant-logo\?t=[a-z0-9_]+$/);
  });
  it('a tenant code with URL characters is encoded, never spliced into the address', () => {
    mount(session(ALL_PERMS, { actor: { ...session(ALL_PERMS).actor, tenantCode: 'x&t=other/../y' } }));
    expect(srcOf(logo())).toBe(`/tenant-logo?t=${encodeURIComponent('x&t=other/../y')}`);
  });
  it('load failure (no logo set, not yet scanned, API down) -> the default logo, alt "Metro Labs", no white plate; a second error does not loop', () => {
    mount(session(ALL_PERMS));
    fireEvent.error(logo());
    expect(srcOf(logo())).toBe(LOGO_ON_DARK); expect(logo().alt).toBe('Metro Labs'); expect(logo().classList.contains('lims-rail-logo-own')).toBe(false);
    fireEvent.error(logo());
    expect(srcOf(logo())).toBe(LOGO_ON_DARK);
  });
  it('the platform console keeps the default logo and never asks for a tenant logo', () => {
    mount(platformSession(ALL_PERMS));
    expect(srcOf(logo())).toBe(LOGO_ON_DARK); expect(logo().alt).toBe('Metro Labs'); expect(document.body.innerHTML).not.toContain('/tenant-logo');
  });
  it('a staff session without a tenant code keeps the default logo', () => {
    mount(session(ALL_PERMS, { actor: { ...session(ALL_PERMS).actor, tenantCode: '' } }));
    expect(srcOf(logo())).toBe(LOGO_ON_DARK);
  });
});
