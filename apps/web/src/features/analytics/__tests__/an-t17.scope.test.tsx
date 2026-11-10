// @vitest-environment jsdom
// AN-T17 — ScopeBanner (C8 04-UI-UX §2 "Tenant-wide notice": Banner tone='info', key analytics.scope.tenant_wide_only; no banner when nothing is hidden).
// ASSUMED contract (spec fixes only the file + kit primitives): apps/web/src/features/analytics/components/ScopeBanner.tsx exports
//   ScopeBanner({ scope: { all_centres: boolean; centre_ids: string[]; tenant_wide_sections_hidden: string[] } })   // = API `scope` object, verbatim
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';

const TEXT = 'Some figures are only available to users with access to all centres.';
const CENTRE = '01a1a98a-ac40-7000-8000-000000000002';
afterEach(cleanup);
const load = async () => ((await import(/* @vite-ignore */ '../components/ScopeBanner')) as { ScopeBanner: any }).ScopeBanner;
// `region` is a page-level rule (a fragment has no landmarks); colour contrast needs layout that jsdom lacks.
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('ScopeBanner', () => {
  it('shows the verbatim tenant-wide notice (info tone, with a text cue besides colour) when sections are hidden', async () => {
    const ScopeBanner = await load();
    const { container } = render(<ScopeBanner scope={{ all_centres: false, centre_ids: [CENTRE], tenant_wide_sections_hidden: ['collections'] }} />);
    expect(screen.getByText(TEXT, { exact: false })).toBeTruthy();
    expect(container.querySelector('[data-tone="info"]')).not.toBeNull();
    await axeClean();
  });

  it.each([
    ['all centres', { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }],
    ['single centre, nothing hidden', { all_centres: false, centre_ids: [CENTRE], tenant_wide_sections_hidden: [] }],
  ])('renders nothing when no section is hidden (%s)', async (_n, scope) => {
    const ScopeBanner = await load();
    const { container } = render(<ScopeBanner scope={scope} />);
    expect(screen.queryByText(TEXT, { exact: false })).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('does not leak centre ids into the DOM', async () => {
    const ScopeBanner = await load();
    const { container } = render(<ScopeBanner scope={{ all_centres: false, centre_ids: [CENTRE], tenant_wide_sections_hidden: ['collections'] }} />);
    expect(container.innerHTML).not.toContain(CENTRE);
  });

  it('treats hostile section strings as text, never markup', async () => {
    const ScopeBanner = await load();
    const { container } = render(<ScopeBanner scope={{ all_centres: false, centre_ids: [], tenant_wide_sections_hidden: ['<img src=x onerror=alert(1)>'] }} />);
    expect(container.querySelector('img')).toBeNull();
  });
});
