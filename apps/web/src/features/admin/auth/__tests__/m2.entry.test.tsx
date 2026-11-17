// @vitest-environment jsdom
// T0D-MSERIES-2 (LD-251; 13-M-SERIES s5; board M1-entry.png) kept guards, REWRITTEN by T0D-MSERIES-5 (LD-276, tester-owned).
// Superseded and moved to m5.entry.test.tsx: white card (radius xl), pill (radius full) fields, hero aside aria-hidden as a whole, the green-to-lime
// hero check (now the 145deg gradient of the board), "at most one looping animation" (the board has the plate, wells, chips and a pulse ring).
// Kept here: the logo is rendered once as an accessible self-hosted image, the placeholder mark / LIMS wordmark are not in the card, and the sign-in behaviour.
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from '@/app/(auth)/layout';
import { LoginForm } from '../LoginForm';

afterEach(cleanup);

describe('layout: logo', () => {
  it('renders the Metro Labs logo once as an accessible, self-hosted image', () => {
    render(<AuthLayout><p>child</p></AuthLayout>);
    const logos = screen.getAllByRole('img', { name: 'Metro Labs' }) as HTMLImageElement[];
    expect(logos).toHaveLength(1);
    expect(logos[0]!.getAttribute('src')).toBeTruthy();
    expect(logos[0]!.getAttribute('src')).not.toMatch(/^(https?:)?\/\//);
    expect(screen.getByText('child')).toBeTruthy();
  });

  it('no second accessible logo: every other <img> is decoration (alt="" or inside aria-hidden)', () => {
    const { container } = render(<AuthLayout><p>child</p></AuthLayout>);
    for (const img of Array.from(container.querySelectorAll('img'))) {
      const hidden = img.getAttribute('alt') === '' || !!img.closest('[aria-hidden="true"]');
      expect(hidden || img.getAttribute('alt') === 'Metro Labs', img.outerHTML).toBe(true);
    }
  });
});

describe('sign-in card content', () => {
  it('exactly one primary button; no placeholder mark and no LIMS wordmark in the card', () => {
    const { container } = render(<LoginForm action={async () => ({ ok: true })} />);
    expect(container.querySelectorAll('.lims-btn-primary')).toHaveLength(1);
    expect(container.querySelector('svg.lims-mark')).toBeNull();
    expect(container.querySelector('.lims-wordmark')).toBeNull();
    expect(within(container).getByRole('button', { name: 'Continue' }).getAttribute('type')).toBe('submit');
  });
});

describe('behaviour untouched (regression of what t12.forms pins)', () => {
  it('invalid input shows the same messages and never calls the action', async () => {
    const action = vi.fn(async () => ({ ok: true as const }));
    render(<LoginForm action={action} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
  });

  it('valid input posts email and password (FormData) once; fields keep their names, types and autocomplete', async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    const { container } = render(<LoginForm action={action} next="/lab/worklist" />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^work email/i), 'tech@lab.test');
    await u.type(screen.getByLabelText('Password', { exact: true }), 'Synthetic-pass-101');
    expect(container.querySelector('input[name="email"]')?.getAttribute('autocomplete')).toBe('username');
    expect(container.querySelector('input[name="password"]')?.getAttribute('autocomplete')).toBe('current-password');
    await u.click(screen.getByRole('button', { name: 'Continue' }));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0]![0];
    expect(fd.get('email')).toBe('tech@lab.test');
    expect(fd.get('password')).toBe('Synthetic-pass-101');
    expect(fd.get('next')).toBe('/lab/worklist');
  });
});

describe('axe (critical + serious) on the entry screen', () => {
  it('layout with the sign-in form', async () => {
    const { container } = render(<AuthLayout><main><LoginForm action={async () => ({ ok: true })} /></main></AuthLayout>);
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
