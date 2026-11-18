// @vitest-environment jsdom
// T0D-UIKIT-1 done_when (5) StatTile / StatTileRow and (6) ChartCard (LD-353 rules 4, 8, 10).
// CONTRACT chosen here (writer: follow it, or file a dispute):
//   StatTile:     new optional `isStale?: boolean` (+ `refreshedAt?: string`, `staleReason?: FreshnessReason`). The FreshnessBadge ("Data may be out of date") shows INSIDE the tile
//                 only when isStale === true. isStale false/undefined: no badge, no "Updated ..." chip, nothing (one freshness note per page, rule 8).
//   StatTileRow:  exported from StatTile/StatTile.tsx. `<StatTileRow lead?>` renders `div.lims-stat-row` whose DIRECT children are the tiles only (no wrapper per tile).
//                 `lead` puts data-lead="true" on the row: the first tile is wider. css: display grid, equal columns (1fr), tiles stretch to one height, min-width 0.
//   ChartCard:    components/ChartCard/ChartCard.tsx, props { title, period?: ReactNode, note?: string, isEmpty?: boolean, children: ReactNode (a TimeSeriesChart or BarChart) }.
//                 DOM: section.lims-chart-card > header (h2.lims-chart-card-title, div.lims-chart-period) + div.lims-chart-frame (the child; p.lims-chart-empty "No data yet" when isEmpty) + p.lims-chart-note (one line).
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarChart } from '../BarChart/BarChart';
import { ChartCard } from '../ChartCard/ChartCard';
import { StatTile, StatTileRow } from '../StatTile/StatTile';
import { TimeSeriesChart } from '../TimeSeriesChart/TimeSeriesChart';
import { declared, rulesMatching } from './uikit1-css';
import './helpers';

describe('StatTile: stale badge only when isStale is true', () => {
  it('no isStale: no badge, no "Updated" chip', () => {
    const { container } = render(<StatTile label="Pending" value="14" />);
    expect(container.textContent).not.toMatch(/out of date|Updated|Not yet calculated/);
    expect(container.querySelector('.lims-chip')).toBeNull();
  });
  it('isStale false even with a refreshedAt: still nothing', () => {
    const { container } = render(<StatTile label="Pending" value="14" isStale={false} refreshedAt="2026-11-17T10:00:00Z" />);
    expect(container.textContent).not.toMatch(/out of date|Updated/);
  });
  it('isStale true: the "Data may be out of date" badge is inside the tile', () => {
    const { container } = render(<StatTile label="Pending" value="14" isStale />);
    const tile = container.querySelector('.lims-stat') as HTMLElement;
    expect(within(tile).getByText('Data may be out of date')).toBeTruthy();
  });
  it('isStale true on a link tile: the tile stays one link (no nested interactive badge)', () => {
    const { container } = render(<StatTile label="Pending" value="14" href="/lab/reports" isStale />);
    const a = container.querySelector('a.lims-stat') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('/lab/reports');
    expect(a.querySelectorAll('a, button')).toHaveLength(0);
  });
  it('existing props unchanged: label, value, delta, unsafe href is not a link', () => {
    const { container } = render(<StatTile label="TAT" value="42 min" delta={{ value: '5%', direction: 'down', isGood: true }} href="javascript:alert(1)" />);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText('42 min')).toBeTruthy();
    expect(container.textContent).toMatch(/Down 5%/);
  });
});

describe('StatTileRow: equal tiles', () => {
  const tiles = (n: number) => Array.from({ length: n }, (_, i) => <StatTile key={i} label={`Tile ${i}`} value={String(i)} />);
  it('is a div.lims-stat-row holding only the tiles as direct children', () => {
    const { container } = render(<StatTileRow>{tiles(4)}</StatTileRow>);
    const row = container.querySelector('.lims-stat-row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.children).toHaveLength(4);
    for (const c of row.children) expect(c.classList.contains('lims-stat')).toBe(true);
    expect(row.hasAttribute('data-lead')).toBe(false);
  });
  it('lead marks the row so the first tile can be wider', () => {
    const { container } = render(<StatTileRow lead>{tiles(3)}</StatTileRow>);
    expect(container.querySelector('.lims-stat-row')!.getAttribute('data-lead')).toBe('true');
  });
  it('css: a grid with equal 1fr columns, tiles stretch to the row height, min-width 0 so numbers never push the page', () => {
    expect(declared(/^\.lims-stat-row$/, 'display')).toBe('grid');
    const cols = declared(/^\.lims-stat-row$/, 'grid-template-columns') ?? '';
    expect(cols).toMatch(/1fr/);
    expect(cols, 'base row must have equal columns').not.toMatch(/[2-9]fr/);
    expect(declared(/^\.lims-stat-row$/, 'align-items') ?? 'stretch').toBe('stretch');
    expect(rulesMatching(/lims-stat-row/).some((r) => /^0(rem)?$/.test(r.decls.get('min-width') ?? ''))).toBe(true);
  });
  it('css: the lead tile is wider only under [data-lead] (a 2fr first column or a column span), never in the base row', () => {
    const lead = rulesMatching(/lims-stat-row\[data-lead/);
    expect(lead.length).toBeGreaterThan(0);
    const wide = lead.some((r) => /2fr|span 2|1\.5fr/.test([...r.decls.values()].join(' ')));
    expect(wide).toBe(true);
  });
});

const SERIES = [{ id: 's', label: 'Reports', points: [{ at: '2026-11-10T00:00:00Z', value: '4' }, { at: '2026-11-11T00:00:00Z', value: '9' }] }];

describe('ChartCard: card with title, period slot, chart, one note, and a frame that always draws', () => {
  it('title is an h2, the period slot and the note are shown, the chart child is inside the frame', () => {
    const { container } = render(
      <ChartCard title="Reports per day" period={<span>Last 7 days</span>} note="Counts finished reports only.">
        <TimeSeriesChart title="Reports per day" series={SERIES} />
      </ChartCard>,
    );
    const card = container.querySelector('section.lims-chart-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByRole('heading', { level: 2 }).textContent).toBe('Reports per day');
    expect(card.querySelector('.lims-chart-period')!.textContent).toBe('Last 7 days');
    expect(card.querySelector('.lims-chart-frame svg')).toBeTruthy();
    expect(card.querySelectorAll('.lims-chart-note')).toHaveLength(1);
    expect(card.querySelector('.lims-chart-note')!.textContent).toBe('Counts finished reports only.');
    expect(card.textContent).not.toMatch(/No data yet/);
  });
  it('the card is a labelled region (aria-labelledby points at the title)', () => {
    const { container } = render(<ChartCard title="Revenue"><BarChart title="Revenue" categories={['A']} series={[{ id: 'a', label: 'A', values: [1] }]} /></ChartCard>);
    const card = container.querySelector('section.lims-chart-card')!;
    const id = card.getAttribute('aria-labelledby')!;
    expect(id).toBeTruthy();
    expect(document.getElementById(id)!.textContent).toBe('Revenue');
  });
  it('isEmpty: the frame STILL draws the chart and holds a "No data yet" line inside it', () => {
    const { container } = render(
      <ChartCard title="Reports per day" isEmpty>
        <TimeSeriesChart title="Reports per day" series={[]} />
      </ChartCard>,
    );
    const frame = container.querySelector('.lims-chart-frame') as HTMLElement;
    expect(frame).toBeTruthy();
    expect(within(frame).getByText('No data yet')).toBeTruthy();
    expect(frame.querySelector('svg')).toBeTruthy();
  });
  it('isEmpty works for a BarChart with no categories too', () => {
    const { container } = render(<ChartCard title="Revenue" isEmpty><BarChart title="Revenue" categories={[]} series={[]} /></ChartCard>);
    expect(within(container.querySelector('.lims-chart-frame') as HTMLElement).getByText('No data yet')).toBeTruthy();
  });
  it('no note and no period: neither element is rendered (no empty gaps)', () => {
    const { container } = render(<ChartCard title="Plain"><TimeSeriesChart title="Plain" series={SERIES} /></ChartCard>);
    expect(container.querySelector('.lims-chart-note')).toBeNull();
    expect(container.querySelector('.lims-chart-period')).toBeNull();
  });
  it('a hostile title or note is text, not markup', () => {
    const { container } = render(<ChartCard title={'<img src=x onerror=alert(1)>'} note={'<script>1</script>'}><TimeSeriesChart title="t" series={SERIES} /></ChartCard>);
    expect(container.querySelector('img, script')).toBeNull();
  });
  it('css: the note is one line (nowrap + ellipsis); the frame is position relative so the empty line sits inside it; card radius is the card token', () => {
    expect(declared(/^\.lims-chart-note$/, 'white-space')).toBe('nowrap');
    expect(declared(/^\.lims-chart-note$/, 'text-overflow')).toBe('ellipsis');
    expect(declared(/^\.lims-chart-frame$/, 'position')).toBe('relative');
    expect(declared(/^\.lims-chart-empty$/, 'position')).toBe('absolute');
  });
  it('css: no gradient, glow or coloured fill on the chart card (rule 4)', () => {
    for (const r of rulesMatching(/lims-chart-(card|frame|empty|note|period)/)) for (const [k, v] of r.decls) {
      expect(`${k}: ${v}`, r.sels.join()).not.toMatch(/gradient|box-shadow: .*(?:rgba|#)|filter:\s*drop-shadow/);
    }
  });
});
