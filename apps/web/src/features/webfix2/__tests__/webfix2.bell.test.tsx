// @vitest-environment jsdom
// T0D-WEBFIX-2 (2): the notifications bell in the staff header is either working or says why it is not (LD-301 walkthrough 2026-11-17: a bare
// disabled button). Contract: when the bell is disabled it shows a short visible reason as its label and its tooltip, and cannot take focus.
// Drives the real <AppShell> with the T0D-MSERIES-2 harness (same mocks as m2.sidebar.test.tsx).
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ALL_PERMS, session } from '../../../core/shell/__tests__/m2.harness';
import { AppShell } from '@/core/shell/AppShell';

vi.mock('next/navigation', async () => (await import('../../../core/shell/__tests__/r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('../../../core/shell/__tests__/r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('../../../core/shell/__tests__/r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('../../../core/shell/__tests__/r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('../../../core/shell/__tests__/m2.harness')).generatedMock);

const REASON = /later release|not available yet|coming soon|not yet available/i;
const bell = () => {
  const el = document.querySelector<HTMLElement>('.lims-topbar-bell');
  if (!el) throw new Error('no .lims-topbar-bell in the top bar');
  return el;
};
const mount = () => render(<AppShell session={session(ALL_PERMS) as any} pathname="/lab/worklist"><p>page body</p></AppShell>);

describe('notifications bell (T0D-WEBFIX-2 item 2)', () => {
  it('is still named Notifications', () => {
    mount();
    expect(bell().getAttribute('aria-label') ?? bell().textContent).toMatch(/notifications/i);
  });

  it('while there is no notifications feature the bell says so as visible text and in the tooltip', () => {
    mount();
    const b = bell();
    const inert = b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true';
    if (!inert) return; // a working bell needs no reason (nothing to prove here)
    const root = (b.closest('[class*="topbar"]') ?? b.parentElement ?? document.body) as HTMLElement;
    const visible = root.textContent ?? '';
    expect(visible, 'a reason is visible next to / on the bell').toMatch(REASON);
    const tip = b.getAttribute('title') ?? b.parentElement?.getAttribute('title') ?? '';
    expect(tip, 'tooltip (title) carries the reason').toMatch(REASON);
    const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
    expect(name, 'accessible name carries the reason').toMatch(REASON);
  });

  it('an inert bell cannot take keyboard focus', () => {
    mount();
    const b = bell();
    const inert = b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true';
    if (!inert) return;
    b.focus();
    expect(document.activeElement, 'inert bell must not hold focus').not.toBe(b);
    expect(b.hasAttribute('disabled') || b.getAttribute('tabindex') === '-1', 'disabled attr or tabindex=-1').toBe(true);
  });

  it('a disabled bell with aria-disabled only (no disabled attr) is not in the tab order', () => {
    mount();
    const b = bell();
    if (b.getAttribute('aria-disabled') === 'true') expect(b.getAttribute('tabindex')).toBe('-1');
  });
});
