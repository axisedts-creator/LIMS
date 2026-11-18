// T0D-UICONSOLE-1 shared PAGE + error.tsx contract for payments and inventory (tester-owned, not a test file). Same rules as the lab file (LD-353 rule 6):
// a 501 operation_pending shows NotAvailable under the menu title with the list header row and no red alert; a 500 either throws to error.tsx or (inventory, which renders
// its own ErrorState) keeps the menu title and shows the reference; every error.tsx keeps the h1, shows the digest and Retry, and never the message.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { norm, titles } from './uiconsole1.helpers';

export interface PageCase {
  name: string;
  load: () => Promise<{ default: unknown }>;
  menuKey: string;
  perms: readonly string[];
  /** 'throws': the page rethrows a 500 to error.tsx; 'inline-alert': the page renders ErrorState itself (title kept, reference shown, role alert) */
  on500: 'throws' | 'inline-alert';
}
export interface ErrorCase { name: string; load: () => Promise<{ default: unknown }>; menuKey: string }

const problem = (status: number) => HttpResponse.json(
  { type: 'about:blank', title: 'x', status, code: status === 501 ? 'operation_pending' : 'common.internal', request_id: 'req-synthetic' },
  { status, headers: { 'content-type': 'application/problem+json' } },
);

export function consolePages(origin: string, setPerms: (p: string[]) => void, pages: readonly PageCase[], errors: readonly ErrorCase[]) {
  let answer = 501;
  const api = setupServer(http.all(`${origin}/*`, () => problem(answer)));
  beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => { answer = 501; });
  afterAll(() => api.close());

  const run = async (p: PageCase) => {
    setPerms([...p.perms]);
    const mod = await p.load();
    return (mod.default as (a: never) => Promise<ReactNode>)({ searchParams: Promise.resolve({}) } as never);
  };

  describe.each(pages)('$name page: pending operation and failures', (p) => {
    it('501 operation_pending: NotAvailable under the menu title, a list header row (age first) stays, no red error', async () => {
      const { container } = render(<ToastProvider>{await run(p)}</ToastProvider>);
      await screen.findByText(/not available yet/i);
      expect(titles(container)).toEqual([t(p.menuKey)]);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.body.textContent).not.toMatch(/something went wrong/i);
      const heads = [...container.querySelectorAll('thead th, [role="columnheader"]')].map((h) => norm(h.textContent));
      expect(heads.length).toBeGreaterThan(1);
      expect(heads[0]).toMatch(/^age/i);
    });

    it('500: ' + 'the page keeps its title and shows the reference, or throws to error.tsx', async () => {
      answer = 500;
      if (p.on500 === 'throws') { await expect(run(p)).rejects.toBeTruthy(); return; }
      const { container } = render(<ToastProvider>{await run(p)}</ToastProvider>);
      expect(titles(container)).toEqual([t(p.menuKey)]);
      expect((await screen.findByRole('alert')).textContent).toContain('req-synthetic');
    });
  });

  describe.each(errors)('$name error.tsx (rule 6)', (e) => {
    it('keeps the page title, shows the reference and Retry, never the message', async () => {
      const reset = vi.fn();
      const Boundary = (await e.load()).default as (p: { error: Error & { digest?: string }; reset: () => void }) => ReactNode;
      const { container } = render(<Boundary error={Object.assign(new Error('boom secret detail'), { digest: 'dig-123' })} reset={reset} />);
      expect(titles(container)).toEqual([t(e.menuKey)]);
      expect(document.body.textContent).toContain('dig-123');
      expect(document.body.textContent).not.toContain('boom secret detail');
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(reset).toHaveBeenCalledTimes(1);
    });
  });
}
