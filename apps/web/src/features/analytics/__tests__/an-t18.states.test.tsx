// @vitest-environment jsdom
// AN-T18 — loading.tsx / error.tsx of app/(staff)/analytics (C8 03-APP-FLOW §5 row S1: Loading `LoadingSkeleton variant='page'`;
// Error `ErrorState` with request id + retry). Same shape as billing/{loading,error}.tsx. Never shows the raw message/stack.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

afterEach(cleanup);
const dir = '../../../app/(staff)/analytics/';
const loadLoading = async () => ((await import(/* @vite-ignore */ `${dir}loading`)) as { default: any }).default;
const loadError = async () => ((await import(/* @vite-ignore */ `${dir}error`)) as { default: any }).default;
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('analytics loading.tsx (S1 Loading)', () => {
  it("renders the kit LoadingSkeleton variant='page' (and nothing else)", async () => {
    const Loading = await loadLoading();
    const a = render(<Loading />).container.innerHTML;
    cleanup();
    const b = render(<LoadingSkeleton variant="page" />).container.innerHTML;
    expect(a).toBe(b);
    expect(a).toContain('lims-skeleton-page');
  });

  it('announces itself as a busy status region and is axe-clean', async () => {
    const Loading = await loadLoading();
    render(<Loading />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    await axeClean();
  });
});

describe('analytics error.tsx (S1 Error)', () => {
  const boom = Object.assign(new Error('relation "analytics.income_daily" does not exist at /srv/api/db.ts:42'), { digest: 'req-7f3a9c' });

  it('shows an ErrorState with the request id (digest) as "Reference: …" and a Retry button that calls reset', async () => {
    const ErrorPage = await loadError();
    const reset = vi.fn();
    render(<ErrorPage error={boom} reset={reset} />);
    expect(screen.getByText('Reference: req-7f3a9c')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(reset).toHaveBeenCalledTimes(1);
    await axeClean();
  });

  it('never leaks the raw error message, SQL or stack path into the DOM', async () => {
    const ErrorPage = await loadError();
    const { container } = render(<ErrorPage error={boom} reset={() => {}} />);
    for (const s of ['relation', 'analytics.income_daily', '/srv/api', 'db.ts']) expect(container.textContent).not.toContain(s);
  });

  it('renders without a reference line when there is no digest', async () => {
    const ErrorPage = await loadError();
    render(<ErrorPage error={new Error('x')} reset={() => {}} />);
    expect(screen.queryByText(/Reference:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
