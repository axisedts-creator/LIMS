// @vitest-environment jsdom
// T0D-MSERIES-2 (LD-251; 13-M-SERIES s5; board spec/program/design-m-series/M1-entry.png): the staff sign-in screen, PRESENTATION ONLY.
// Green-to-lime hero, Metro Labs logo, white card, pill fields with the neutral.300 border, one primary pill button. Actions, validation, session and MFA stay untouched
// (the t12.* tests and the web-style tests keep running in the same verify). CONTRACT chosen by the tester (writer: follow it, or dispute in .orchestra/notes):
//   (auth)/layout.tsx renders the logo ONCE as an accessible <img alt="Metro Labs"> (self-hosted file from packages/ui/assets/brand, imported; no remote URL, no next/image);
//     any second copy (small-screen band, hero badge) is decorative: alt="" or aria-hidden. The hero <aside class="lims-auth-panel"> stays aria-hidden decoration.
//   LoginForm no longer draws the placeholder mark (svg.lims-mark) or the LIMS wordmark in the card.
//   shell.css: .lims-auth-card = white (neutral.0), radius xl (24), no border; fields keep the kit pill (radius full) and neutral.300 border (no override in the auth css);
//     the hero background is a linear-gradient that runs from accent.default to the lime (accent.brand or accent.highlight); at most ONE looping animation.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from '@/app/(auth)/layout';
import { LoginForm } from '../LoginForm';

afterEach(cleanup);
const WEB = join(import.meta.dirname, '..', '..', '..', '..', '..'); // apps/web
const css = readFileSync(join(WEB, 'src', 'core', 'shell', 'shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBodies = (sel: RegExp, inMedia = false) => {
  const out: string[] = [];
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const before = css.slice(0, m.index);
    const depth = (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    if ((depth > 0) !== inMedia) continue;
    if (m[1]!.split(',').some((s) => sel.test(s.trim().replace(/\s+/g, ' ')))) out.push(m[2]!);
  }
  return out.join(';');
};
const decl = (body: string, p: string) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1]!.trim()).at(-1);

describe('layout: logo and hero', () => {
  it('renders the Metro Labs logo once as an accessible, self-hosted image', () => {
    render(<AuthLayout><p>child</p></AuthLayout>);
    const logos = screen.getAllByRole('img', { name: 'Metro Labs' }) as HTMLImageElement[];
    expect(logos).toHaveLength(1);
    expect(logos[0]!.getAttribute('src')).toBeTruthy();
    expect(logos[0]!.getAttribute('src')).not.toMatch(/^(https?:)?\/\//);
    expect(screen.getByText('child')).toBeTruthy();
  });

  it('the hero stays decorative (aria-hidden) and no second accessible logo is announced', () => {
    const { container } = render(<AuthLayout><p>child</p></AuthLayout>);
    expect(container.querySelector('aside.lims-auth-panel')?.getAttribute('aria-hidden')).toBe('true');
    for (const img of Array.from(container.querySelectorAll('img'))) {
      const hidden = img.getAttribute('alt') === '' || !!img.closest('[aria-hidden="true"]');
      expect(hidden || img.getAttribute('alt') === 'Metro Labs', img.outerHTML).toBe(true);
    }
  });

  it('hero css: a linear-gradient from accent.default to the lime (accent.brand / accent.highlight)', () => {
    const bg = decl(ruleBodies(/^\.lims-auth-panel$/), 'background') ?? '';
    expect(bg).toMatch(/linear-gradient\((?:[^()]|\([^()]*\))*var\(--lims-accent\)(?:[^()]|\([^()]*\))*var\(--lims-accent-(brand|highlight)\)/);
  });
});

describe('white card, pill fields, one primary pill button', () => {
  it('card css: white, radius xl, no box border', () => {
    const body = ruleBodies(/^\.lims-auth-card$/);
    expect(decl(body, 'background')).toMatch(/^var\(--lims-neutral-0\)$/);
    expect(decl(body, 'border-radius')).toBe('var(--lims-radius-xl)');
    expect(decl(body, 'border') ?? 'none').toMatch(/^(0|none)\b/);
  });

  it('the auth css does not override the kit field shape: radius full, border colour neutral.300 (or a state colour on hover/focus only)', () => {
    const base = ruleBodies(/^\.lims-auth-card \.lims-input$/) + ';' + ruleBodies(/^\.lims-input-wrap \.lims-input$/);
    const r = decl(base, 'border-radius');
    if (r) expect(r).toBe('var(--lims-radius-full)');
    const bc = decl(base, 'border-color') ?? decl(base, 'border');
    if (bc) expect(bc).toContain('var(--lims-neutral-300)');
  });

  it('the primary button is a full-round pill (13 s2.3) of the touch height', () => {
    const body = ruleBodies(/^\.lims-auth-card \.lims-btn-primary$/);
    expect(decl(body, 'border-radius')).toBe('var(--lims-radius-full)');
  });

  it('the sign-in card has exactly one primary button and no placeholder mark / LIMS wordmark', () => {
    const { container } = render(<LoginForm action={async () => ({ ok: true })} />);
    expect(container.querySelectorAll('.lims-btn-primary')).toHaveLength(1);
    expect(container.querySelector('svg.lims-mark')).toBeNull();
    expect(container.querySelector('.lims-wordmark')).toBeNull();
    expect(within(container).getByRole('button', { name: /log in/i }).getAttribute('type')).toBe('submit');
  });
});

describe('behaviour untouched (regression of what t12.forms pins)', () => {
  it('invalid input shows the same messages and never calls the action', async () => {
    const action = vi.fn(async () => ({ ok: true as const }));
    render(<LoginForm action={action} />);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: /log in/i }));
    expect(screen.getByText('Enter a valid email address.')).toBeTruthy();
    expect(screen.getByText('Enter your password.')).toBeTruthy();
    expect(action).not.toHaveBeenCalled();
  });

  it('valid input posts email and password (FormData) once; fields keep their names, types and autocomplete', async () => {
    const action = vi.fn(async (_fd: FormData) => ({ ok: true as const }));
    const { container } = render(<LoginForm action={action} next="/lab/worklist" />);
    const u = userEvent.setup();
    await u.type(screen.getByLabelText(/^email/i), 'tech@lab.test');
    await u.type(screen.getByLabelText('Password', { exact: true }), 'Synthetic-pass-101');
    expect(container.querySelector('input[name="email"]')?.getAttribute('autocomplete')).toBe('username');
    expect(container.querySelector('input[name="password"]')?.getAttribute('autocomplete')).toBe('current-password');
    await u.click(screen.getByRole('button', { name: /log in/i }));
    expect(action).toHaveBeenCalledTimes(1);
    const fd = action.mock.calls[0]![0];
    expect(fd.get('email')).toBe('tech@lab.test');
    expect(fd.get('password')).toBe('Synthetic-pass-101');
    expect(fd.get('next')).toBe('/lab/worklist');
  });
});

describe('axe (critical + serious) on the entry screen', () => {
  it('layout with the sign-in card', async () => {
    const { container } = render(<AuthLayout><main><LoginForm action={async () => ({ ok: true })} /></main></AuthLayout>);
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
