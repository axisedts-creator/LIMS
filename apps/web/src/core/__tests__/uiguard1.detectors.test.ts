// T0D-UIGUARD-1: the guard must really catch what it claims to catch (and leave good markup alone). One bad and one good fixture per rule.
import { describe, expect, it } from 'vitest';
import {
  cssViolations, errorBoundaryDrawsErrorState, handBuiltFilterRow, handlesFailedRead, hidesTableHeaderWhenEmpty, inlineStyleViolations,
  readsData, rendersPageHeader, routeMatches, routeOf, unwrappedCharts, STAFF,
} from './uiguard1.helpers';
import { join } from 'node:path';

describe('rule 1: PageHeader', () => {
  it('flags a bare h1, accepts the kit header', () => {
    expect(rendersPageHeader('<section><h1>Pending</h1></section>')).toBe(false);
    expect(rendersPageHeader("<PageHeader title={t('lab.nav.pending')} />")).toBe(true);
  });
});

describe('rule 2: FilterBar', () => {
  it('flags a hand built filter row (div, form, template class), accepts FilterBar', () => {
    expect(handBuiltFilterRow('<div role="search" className="lims-filter-bar"><input /></div>')).toBe(true);
    expect(handBuiltFilterRow('<form className="lims-filterbar" method="get">')).toBe(true);
    expect(handBuiltFilterRow('<div className={`lims-filter-bar ${x}`}>')).toBe(true);
    expect(handBuiltFilterRow('<form onSubmit={go} className="admin-filters">')).toBe(true);
    expect(handBuiltFilterRow('<FilterBar filters={F} value={v} onChange={set} />')).toBe(false);
    expect(handBuiltFilterRow('<div className="lims-card">')).toBe(false);
  });
});

describe('rule 3: weights and control heights', () => {
  it('flags 600/700/bold weights in CSS, accepts 400 and 500', () => {
    expect(cssViolations('.a { font-weight: 600; }')).toHaveLength(1);
    expect(cssViolations('.a { font-weight: 700 }')).toHaveLength(1);
    expect(cssViolations('.a { font-weight: bold }')).toHaveLength(1);
    expect(cssViolations('.a { font-weight: var(--lims-font-weight-bold); }')).toHaveLength(1);
    expect(cssViolations('.a { font-weight: 500; } .b { font-weight: var(--lims-font-weight-medium); } .c { font-weight: 400 }')).toEqual([]);
  });
  it('flags a px height on a control, ignores the visually hidden label trick and non-controls', () => {
    expect(cssViolations('.reg input { height: 28px; }')).toHaveLength(1);
    expect(cssViolations('.lims-reg-btn { min-height: 32px }')).toHaveLength(1);
    expect(cssViolations('select.x { height: 2rem }')).toEqual([]);
    expect(cssViolations('.f .lims-label { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); }')).toEqual([]);
    expect(cssViolations('.hero { height: 240px }')).toEqual([]);
    expect(cssViolations('/* .a { font-weight: 700 } */ .b { color: red }')).toEqual([]);
  });
  it('flags inline fontWeight 600/700 and inline px heights', () => {
    expect(inlineStyleViolations('<b style={{ fontWeight: 700 }} />')).toHaveLength(1);
    expect(inlineStyleViolations("<b style={{ fontWeight: 'bold' }} />")).toHaveLength(1);
    expect(inlineStyleViolations("<input style={{ height: '28px' }} />")).toHaveLength(1);
    expect(inlineStyleViolations('<b style={{ fontWeight: 500 }} />')).toEqual([]);
  });
});

describe('rule 4: failed reads', () => {
  it('knows a read and a handled failure', () => {
    expect(readsData("import { listItems } from '../server/read.server';")).toBe(true);
    expect(readsData("import { Button } from '@lims/ui/components/Button';")).toBe(false);
    expect(handlesFailedRead('return loadOr(title, cols, () => <X />)')).toBe(true);
    expect(handlesFailedRead('if (r.status === 501) return <NotAvailable title={t} />')).toBe(true);
    expect(handlesFailedRead('} catch (e) { throw e; }')).toBe(false);
  });
  it('accepts an error.tsx with ErrorState above the page, not a missing or bare one', () => {
    expect(errorBoundaryDrawsErrorState(join(STAFF, 'analytics', 'reports', 'page.tsx'))).toBe(true); // analytics/error.tsx draws ErrorState
    expect(errorBoundaryDrawsErrorState(join(STAFF, 'no-such-module', 'page.tsx'))).toBe(false);
  });
});

describe('rule 5: header kept when empty', () => {
  it('flags a table swapped for a paragraph or EmptyState when the list is empty', () => {
    expect(hidesTableHeaderWhenEmpty('{rows.length === 0 ? <p>No rules.</p> : (<table><thead /></table>)}')).toBe(true);
    expect(hidesTableHeaderWhenEmpty('{rows.length > 0 ? <table><thead /></table> : <EmptyState title="x" />}')).toBe(true);
    expect(hidesTableHeaderWhenEmpty('{rows.length ? <DataTable rows={rows} /> : null}')).toBe(true);
    expect(hidesTableHeaderWhenEmpty('{rows.length > 0 && <table />}')).toBe(true);
    expect(hidesTableHeaderWhenEmpty('if (rows.length === 0) { return <EmptyState title="x" />; } return <table />;')).toBe(true);
    expect(hidesTableHeaderWhenEmpty('if (!rows.length) return <p>none</p>; return <DataTable rows={rows} />;')).toBe(true);
  });
  it('accepts the empty state drawn inside the table body, and files with no table', () => {
    expect(hidesTableHeaderWhenEmpty('const state = rows?.length === 0 ? <EmptyState title={empty} /> : null; return <div><table><thead/>{state}</table></div>;')).toBe(false);
    expect(hidesTableHeaderWhenEmpty('<DataTable rows={rows} emptyState={{ title: "None" }} />')).toBe(false);
    expect(hidesTableHeaderWhenEmpty('{rows.length === 0 ? <p>none</p> : <ul />}')).toBe(false);
  });
});

describe('rule 6: charts in ChartCard', () => {
  it('counts charts without a card', () => {
    expect(unwrappedCharts('<Card><BarChart title="x" /></Card>')).toBe(1);
    expect(unwrappedCharts('<TimeSeriesChart a /><BarChart b />')).toBe(2);
    expect(unwrappedCharts('<ChartCard title="x"><BarChart title="x" /></ChartCard>')).toBe(0);
    expect(unwrappedCharts('<ChartCard title="a"><BarChart /></ChartCard><ChartCard title="b"><TimeSeriesChart /></ChartCard>')).toBe(0);
    expect(unwrappedCharts('<ChartCard title="a"><BarChart /></ChartCard><BarChart />')).toBe(1);
    expect(unwrappedCharts('<StatTile />')).toBe(0);
  });
});

describe('exceptions plumbing', () => {
  it('maps a page file to its route and matches exact and prefix patterns', () => {
    expect(routeOf(join(STAFF, 'frontdesk', 'registrations', 'new', 'page.tsx'))).toBe('/frontdesk/registrations/new');
    expect(routeMatches('/admin/*', '/admin/users/[membership_id]')).toBe(true);
    expect(routeMatches('/admin/*', '/administrator')).toBe(false);
    expect(routeMatches('/a/b', '/a/b')).toBe(true);
    expect(routeMatches('/a/b', '/a/bc')).toBe(false);
  });
});
