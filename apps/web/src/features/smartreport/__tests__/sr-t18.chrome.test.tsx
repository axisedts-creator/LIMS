// @vitest-environment jsdom
// C14.T18 — loading.tsx / error.tsx of app/(staff)/smartreport/summaries (04-UI-UX: every page has loading.tsx and error.tsx; 03-APP-FLOW §4 SR-01:
// Loading `LoadingSkeleton table`; Error `ErrorState` with request id + Retry). Same shape as analytics AN-T18 chrome tests. Never shows the raw message/stack.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

afterEach(cleanup);
const dir = '../../../app/(staff)/smartreport/summaries/';
const loadLoading = async () => ((await import(/* @vite-ignore */ `${dir}loading`)) as { default: any }).default;
const loadError = async () => ((await import(/* @vite-ignore */ `${dir}error`)) as { default: any }).default;
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('summaries loading.tsx (SR-01 Loading)', () => {
  it("renders the kit LoadingSkeleton variant='table' (and nothing else)", async () => {
    const Loading = await loadLoading();
    const a = render(<Loading />).container.innerHTML;
    cleanup();
    const b = render(<LoadingSkeleton variant="table" />).container.innerHTML;
    expect(a).toBe(b);
    expect(a).toContain('lims-skeleton-table');
  });

  it('announces itself as a busy status region and is axe-clean', async () => {
    const Loading = await loadLoading();
    render(<Loading />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    await axeClean();
  });
});

describe('summaries error.tsx (SR-01 Error)', () => {
  const boom = Object.assign(new Error('relation "smartreport.summaries" does not exist at /srv/api/db.ts:42'), { digest: 'req-7f3a9c' });

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
    for (const s of ['relation', 'smartreport.summaries', '/srv/api', 'db.ts']) expect(container.textContent).not.toContain(s);
  });

  it('renders without a reference line when there is no digest', async () => {
    const ErrorPage = await loadError();
    render(<ErrorPage error={new Error('x')} reset={() => {}} />);
    expect(screen.queryByText(/Reference:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
