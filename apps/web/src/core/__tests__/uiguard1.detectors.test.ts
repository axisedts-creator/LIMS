// T0D-UIGUARD-1: the guard must really catch what it claims to catch (and leave good markup alone). One bad and one good fixture per rule.
import { describe, expect, it } from 'vitest';
import {
  cssViolations, errorBoundaryDrawsErrorState, handBuiltFilterRow, handlesFailedRead, hidesTableHeaderWhenEmpty, inlineStyleViolations,
  rawStructureViolations, readsData, rendersPageHeader, routeMatches, routeOf, staleExceptions, unexcused, unwrappedCharts, AREAS, RULES, STAFF,
  type Findings, type GuardException,
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

describe('rule 7: no raw h1 to h4 and no raw ul or ol for page structure (T0D-UIGUARD-2, LD-436 R7)', () => {
  it('failing samples: a raw heading or list written as page structure is flagged, one finding per element', () => {
    expect(rawStructureViolations('<section><h1>Pending</h1></section>')).toHaveLength(1);
    expect(rawStructureViolations('<h2 className="x">Orders</h2>')).toHaveLength(1);
    expect(rawStructureViolations('<h3>a</h3><h4>b</h4>')).toHaveLength(2);
    expect(rawStructureViolations('<ul className="lims-list"><li>a</li></ul>')).toHaveLength(1);
    expect(rawStructureViolations('<ol>\n  <li>a</li>\n</ol>')).toHaveLength(1);
    expect(rawStructureViolations('<ul>{items.map((i) => <li key={i}>{i}</li>)}</ul><ol start={2}><li /></ol>')).toHaveLength(2);
    expect(rawStructureViolations('return <h2\n  className="t"\n>x</h2>;')).toHaveLength(1);
  });
  it('passing samples: kit parts, h5/h6, hr, header, other tags and prose are not flagged', () => {
    expect(rawStructureViolations('<PageHeader title={t("lab.nav.pending")} /><Card title="Orders"><DataTable rows={rows} /></Card>')).toEqual([]);
    expect(rawStructureViolations('<ActionList items={a} /><StatusStepper steps={s} /><Tabs items={t} />')).toEqual([]);
    expect(rawStructureViolations('<h5>small</h5><h6>smaller</h6><hr /><header>x</header><head /><ulx /><Heading level={2} /><Ul />')).toEqual([]);
    expect(rawStructureViolations('const text = "an h1 and a ul are not elements"; return <p>Use a list (ul) here</p>;')).toEqual([]);
  });
  it('comments do not count (line, block and JSX comments); a URL is not a line comment', () => {
    expect(rawStructureViolations('// <h1>old</h1>\nreturn <p />;')).toEqual([]);
    expect(rawStructureViolations('/* <ul><li /></ul> */ return <p />;')).toEqual([]);
    expect(rawStructureViolations('return <div>{/* <h2>x</h2> */}<p /></div>;')).toEqual([]);
    expect(rawStructureViolations('const u = "https://x.test/a"; return <h2>x</h2>;')).toHaveLength(1);
  });
  it('a plain list of values inside a DataTable cell renderer is allowed; a heading there, or a list outside the cell, is not', () => {
    const cols = "const columns = [\n  { id: 'tags', header: 'Tags', cell: (r) => <ul className=\"lims-values\">{r.tags.map((t) => <li key={t}>{t}</li>)}</ul> },\n  { id: 'n', header: 'N', cell: (r) => r.n },\n];\n";
    expect(rawStructureViolations(cols)).toEqual([]);
    expect(rawStructureViolations("const columns = [{ id: 'a', header: 'A', cell: (r) => (<ol><li>{r.a}</li></ol>) }];")).toEqual([]);
    expect(rawStructureViolations("const columns = [{ id: 'a', header: 'A', cell: (r) => <h3>{r.a}</h3> }];")).toHaveLength(1);
    expect(rawStructureViolations(cols + 'export const Page = () => <ul><li>x</li></ul>;')).toHaveLength(1);
    expect(rawStructureViolations("const columns = [\n  { id: 'a', cell: (r) => r.a },\n  { id: 'b', header: <ul><li>h</li></ul>, cell: (r) => r.b },\n];")).toHaveLength(1);
  });
});

describe('rule 7: registry plumbing (stale entries fail, so the baseline shrinks as the follow-ups land)', () => {
  const found: Findings = new Map([
    ['/catalog/tests', new Map([[7, ['2 raw heading/list element(s) in features/catalog/components/TestsList.tsx']]])],
    ['/lab/pending', new Map([[7, ['1 raw'], ], [2, ['hand built filter row']]])],
  ]);
  const entry = (route: string, rule: GuardException['rule'], reason = 'legacy baseline LD-436, fix in T0D-UIGUARD-1-CATALOG: rule 7'): GuardException => ({ route, rule, reason });
  it('unexcused: a rule 7 finding without an entry is an offender; an entry for that route and rule clears it, an entry for another rule does not', () => {
    expect(unexcused(found, [], 7).map((l) => l.split('  ->  ')[0])).toEqual(['/catalog/tests', '/lab/pending']);
    expect(unexcused(found, [entry('/catalog/tests', 7)], 7).map((l) => l.split('  ->  ')[0])).toEqual(['/lab/pending']);
    expect(unexcused(found, [entry('/catalog/tests', 2)], 7)).toHaveLength(2);
    expect(unexcused(found, [entry('/catalog/tests', 7), entry('/lab/pending', 7)], 7)).toEqual([]);
  });
  it('staleExceptions: an entry whose page no longer breaks rule 7 is stale, a live one is not', () => {
    expect(staleExceptions(found, [entry('/catalog/tests', 7)])).toEqual([]);
    expect(staleExceptions(found, [entry('/catalog/tests', 7), entry('/catalog/panels', 7)]).map((e) => e.route)).toEqual(['/catalog/panels']);
    expect(staleExceptions(found, [entry('/lab/pending', 3)]).map((e) => e.route)).toEqual(['/lab/pending']);
    const fixed: Findings = new Map([['/catalog/tests', new Map()]]);
    expect(staleExceptions(fixed, [entry('/catalog/tests', 7)]).map((e) => e.route)).toEqual(['/catalog/tests']);
  });
  it('the guard knows seven rules and the 18 area names of LD-439 (c)', () => {
    expect(RULES).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(AREAS).toHaveLength(18);
    expect(new Set(AREAS).size).toBe(18);
    for (const a of ['ANALYTICS', 'BILLING', 'CATALOG', 'ENGAGEMENT', 'FRONTDESK', 'HOMECOLLECTION', 'INSTRUMENTS', 'INVENTORY', 'LAB', 'OFFLINE', 'PARTNERS', 'QUALITY', 'SMARTREPORT', 'ADMIN', 'ANATOMIC', 'MICRO', 'PAYMENTS', 'REPORTING']) expect(AREAS).toContain(a);
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
