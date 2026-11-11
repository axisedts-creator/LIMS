// @vitest-environment jsdom
// T0D-13 / 04-UI-UX §2.5 (Timeline, StatTile, TimeSeriesChart, BarChart), §2.6 + §4 (KeyboardShortcutsDialog), §5 (a11y), CV §14, REQ-SEC-088, AC-0D-8.6.
// ASSUMED (spec gives behaviour/props, not DOM):
//   Timeline    -> <ol>/<li> in the order given (not re-sorted); `at` shown as 'DD/MM/YYYY hh:mm A' in Asia/Kathmandu; non-neutral tones carry a text word
//                  (Warning/Error/Critical/Success, same words as Banner via msg.toneText) so colour is never the only signal (§5.4).
//   StatTile    -> label + value text; delta direction in words (up/increase, down/decrease, flat/no change); `href` renders one <a> whose name contains label and value.
//   Charts      -> in-house <svg> (no foreignObject/script) + a visually hidden <table> (role=table, in the a11y tree) with the same data; values drawn as given
//                  (TimeSeriesChart: only M/L path commands = no smoothing). Heights in BarChart are read from <rect height>.
//   KeyboardShortcutsDialog props: { isOpen, onClose, groups: { id; title; shortcuts: { keys: string; description: string }[] }[] } (04-UI-UX:233 names it, no props are
//                  given; "lists global + current page shortcuts", §4). Title "Keyboard shortcuts".
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Timeline } from '../Timeline/Timeline';
import { StatTile } from '../StatTile/StatTile';
import { TimeSeriesChart } from '../TimeSeriesChart/TimeSeriesChart';
import { BarChart } from '../BarChart/BarChart';
import { KeyboardShortcutsDialog } from '../KeyboardShortcutsDialog/KeyboardShortcutsDialog';
import { DEVANAGARI, XSS, seriousViolations, user } from './helpers';

const noInjected = () => expect(document.querySelector('img[src=x],script,svg[onload],iframe')).toBeNull();
const flat = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('Timeline (StatusTimeline maps here)', () => {
  const items = [
    { at: '2025-04-14T06:15:00Z', label: 'Received', actor: 'Asha K.' },
    { at: '2025-04-14T09:00:00Z', label: 'Result entered', actor: 'Ravi T.' },
    { at: '2025-04-15T03:30:00Z', label: 'Report published' },
  ] as any;

  it('lists every item in the order given, as a list', () => {
    render(<Timeline items={items} />);
    const li = screen.getAllByRole('listitem');
    expect(li).toHaveLength(3);
    expect(li.map((x) => x.textContent)).toEqual([expect.stringContaining('Received'), expect.stringContaining('Result entered'), expect.stringContaining('Report published')]);
    expect(screen.getByRole('list').tagName).toBe('OL');
  });

  it('shows the actor when given and the time in the tenant timezone (06:15Z = 14/04/2025 12:00 PM)', () => {
    render(<Timeline items={items} />);
    const first = screen.getAllByRole('listitem')[0]!;
    expect(first.textContent).toContain('Asha K.');
    expect(flat(first)).toContain('14/04/2025 12:00 PM');
    expect(screen.getAllByRole('listitem')[2]!.textContent).not.toMatch(/Asha|Ravi/);
  });

  it.each([['success', /success/i], ['warning', /warning/i], ['danger', /error/i], ['critical', /critical/i]] as const)('tone %s is also spoken as text (colour is never the only signal)', (tone, re) => {
    render(<Timeline items={[{ at: '2025-04-14T06:15:00Z', label: 'Step', tone }] as any} />);
    expect(flat(screen.getByRole('listitem'))).toMatch(re);
  });

  it('empty items renders without throwing', () => {
    expect(() => render(<Timeline items={[]} />)).not.toThrow();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it.each(XSS)('label and actor are text: %s', (payload) => {
    render(<Timeline items={[{ at: '2025-04-14T06:15:00Z', label: payload, actor: payload }] as any} />);
    noInjected();
    expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
  });

  it('Devanagari label and actor are kept', () => {
    render(<Timeline items={[{ at: '2025-04-14T06:15:00Z', label: DEVANAGARI, actor: DEVANAGARI }] as any} />);
    expect(screen.getAllByText(DEVANAGARI).length).toBeGreaterThan(0);
  });

  it('axe', async () => {
    render(<Timeline items={[...items, { at: '2025-04-16T03:30:00Z', label: 'Amended', tone: 'warning' }]} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('StatTile (00 F1)', () => {
  it('shows label and value', () => {
    render(<StatTile label="Pending reports" value="14" />);
    expect(screen.getByText('Pending reports')).toBeTruthy();
    expect(screen.getByText('14')).toBeTruthy();
  });

  it.each([['up', /\b(up|increase)/i], ['down', /\b(down|decrease)/i], ['flat', /(flat|no change|unchanged)/i]] as const)('delta direction %s is in words, next to the delta value', (direction, re) => {
    const { container } = render(<StatTile label="TAT" value="42 min" delta={{ value: '5%', direction }} />);
    expect(flat(container)).toContain('5%');
    expect(flat(container)).toMatch(re);
  });

  it('isGood changes the rendering (good vs bad movement are told apart, not just up vs down)', () => {
    const a = render(<StatTile label="TAT" value="42" delta={{ value: '5%', direction: 'up', isGood: true }} />).container.innerHTML;
    document.body.innerHTML = '';
    const b = render(<StatTile label="TAT" value="42" delta={{ value: '5%', direction: 'up', isGood: false }} />).container.innerHTML;
    expect(a).not.toBe(b);
  });

  it('href: one link whose accessible name carries label and value; without href there is no link', () => {
    const a = render(<StatTile label="Pending reports" value="14" href="/lab/reports?status=pending" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/lab/reports?status=pending');
    expect(link.textContent).toContain('Pending reports');
    expect(link.textContent).toContain('14');
    a.unmount();
    render(<StatTile label="Pending reports" value="14" />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a javascript: href is never rendered as a link target (REQ-SEC-088)', () => {
    render(<StatTile label="X" value="1" href="javascript:alert(1)" />);
    for (const a of document.querySelectorAll('a[href]')) expect(a.getAttribute('href')).not.toMatch(/^\s*javascript:/i);
  });

  it.each(XSS)('label, value and delta are text: %s', (payload) => {
    render(<StatTile label={payload} value={payload} delta={{ value: payload, direction: 'up' }} />);
    noInjected();
  });

  it('axe: plain, with delta, as a link', async () => {
    render(<>
      <StatTile label="A" value="1" />
      <StatTile label="B" value="2" delta={{ value: '3%', direction: 'down', isGood: true }} />
      <StatTile label="C" value="3" href="/x" />
    </>);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('TimeSeriesChart (results trend, 00 C7)', () => {
  const series = [
    { id: 'hb', label: 'Haemoglobin', points: [
      { at: '2025-01-10T06:00:00Z', value: '12.10' }, { at: '2025-02-10T06:00:00Z', value: '13.50' }, { at: '2025-03-10T06:00:00Z', value: '9.25' },
      { at: '2025-04-10T06:00:00Z', value: '14.00' }, { at: '2025-05-10T06:00:00Z', value: '13.75' },
    ] },
    { id: 'ref', label: 'Previous lab', points: [{ at: '2025-01-10T06:00:00Z', value: '11.0' }, { at: '2025-03-10T06:00:00Z', value: '12.0' }, { at: '2025-05-10T06:00:00Z', value: '10.5' }] },
  ] as any;
  const svg = (c: Element = document.body) => c.querySelector('svg')!;

  it('has an accessible name from title and is an in-house SVG (no foreignObject/script/remote href)', () => {
    const { container } = render(<TimeSeriesChart title="Haemoglobin trend" series={series} />);
    expect(screen.getAllByText('Haemoglobin trend').length).toBeGreaterThan(0);
    expect(svg(container)).toBeTruthy();
    expect(container.querySelector('foreignObject,script,image[href^="http"],use[href^="http"]')).toBeNull();
    const named = container.querySelector('svg[role=img][aria-label], svg[aria-labelledby]') ?? container.querySelector('figure[aria-label], [role=img]');
    expect(named).toBeTruthy();
  });

  it('text alternative: a hidden data table with every point exactly as given (no rounding, "12.10" stays "12.10")', () => {
    render(<TimeSeriesChart title="Haemoglobin trend" series={series} unit="g/dL" />);
    const table = screen.getByRole('table');
    const text = flat(table);
    for (const v of ['12.10', '13.50', '9.25', '14.00', '13.75', '11.0', '12.0', '10.5']) expect(text).toContain(v);
    expect(text).toContain('Haemoglobin');
    expect(text).toContain('Previous lab');
    expect(within(table).getAllByRole('row').length).toBeGreaterThanOrEqual(5); // >= one row per time point (+ header)
    expect(text).toContain('10/01/2025'); // times formatted DD/MM/YYYY (Asia/Kathmandu)
  });

  it('axis labels carry the unit', () => {
    const { container } = render(<TimeSeriesChart title="Haemoglobin trend" series={series} unit="g/dL" />);
    expect(flat(container)).toContain('g/dL');
  });

  it('values are drawn as given: every path uses only M/L (no curve smoothing) and each series has one vertex per point', () => {
    const { container } = render(<TimeSeriesChart title="Haemoglobin trend" series={series} />);
    const counts: number[] = [];
    for (const p of container.querySelectorAll('svg path')) {
      const d = p.getAttribute('d') ?? '';
      expect(d).not.toMatch(/[CcSsQqTtAa]/);
      counts.push((d.match(/[ML]/gi) ?? []).length);
    }
    for (const pl of container.querySelectorAll('svg polyline')) counts.push((pl.getAttribute('points') ?? '').trim().split(/\s+/).length);
    expect(counts).toContain(5);
    expect(counts).toContain(3);
  });

  it('referenceBand: low and high are available as text', () => {
    const { container } = render(<TimeSeriesChart title="Haemoglobin trend" series={series} referenceBand={{ low: '11.5', high: '15.5' }} unit="g/dL" />);
    expect(flat(container)).toContain('11.5');
    expect(flat(container)).toContain('15.5');
    expect(container.querySelector('svg rect')).toBeTruthy();
  });

  it('height prop sizes the svg', () => {
    const { container } = render(<TimeSeriesChart title="t" series={series} height={333} />);
    const s = svg(container);
    expect(s.getAttribute('height') === '333' || s.style.height === '333px' || (s.parentElement as HTMLElement).style.height === '333px').toBe(true);
  });

  it('series are told apart by label text, not colour alone (legend)', () => {
    const { container } = render(<TimeSeriesChart title="t" series={series} />);
    const outsideTable = [...container.querySelectorAll('*')].filter((e) => !e.closest('table') && e.children.length === 0 && /Haemoglobin|Previous lab/.test(e.textContent ?? ''));
    expect(outsideTable.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['single point', [{ id: 'a', label: 'A', points: [{ at: '2025-01-10T06:00:00Z', value: '5.0' }] }]],
    ['all values equal', [{ id: 'a', label: 'A', points: [{ at: '2025-01-10T06:00:00Z', value: '5.0' }, { at: '2025-01-11T06:00:00Z', value: '5.0' }] }]],
    ['same timestamp twice', [{ id: 'a', label: 'A', points: [{ at: '2025-01-10T06:00:00Z', value: '5.0' }, { at: '2025-01-10T06:00:00Z', value: '6.0' }] }]],
    ['negative and zero', [{ id: 'a', label: 'A', points: [{ at: '2025-01-10T06:00:00Z', value: '-2.5' }, { at: '2025-01-11T06:00:00Z', value: '0.000' }] }]],
    ['no points', [{ id: 'a', label: 'A', points: [] }]],
    ['no series', []],
  ] as const)('degenerate input (%s) never produces NaN/Infinity coordinates', (_n, s) => {
    const { container } = render(<TimeSeriesChart title="t" series={s as any} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
  });

  it.each(XSS)('title and series labels are text: %s', (payload) => {
    render(<TimeSeriesChart title={payload} series={[{ id: 'x', label: payload, points: [{ at: '2025-01-10T06:00:00Z', value: '1' }] }] as any} />);
    noInjected();
    expect((window as any).__xss).toBeUndefined();
  });

  it('axe', async () => {
    render(<TimeSeriesChart title="Haemoglobin trend" series={series} referenceBand={{ low: '11.5', high: '15.5' }} unit="g/dL" />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('BarChart', () => {
  const cats = ['Jan', 'Feb', 'Mar'];
  const one = [{ id: 'n', label: 'Reports', values: [10, 20, 40] }];
  const two = [{ id: 'a', label: 'Walk-in', values: [5, 8, 3] }, { id: 'b', label: 'Referred', values: [7, 1, 9] }];
  const heights = (c: Element) => [...c.querySelectorAll('svg rect')].map((r) => Number(r.getAttribute('height'))).filter((h) => Number.isFinite(h) && h > 0);
  const hasRatio = (hs: number[], ratio: number[]) => hs.some((h) => ratio.every((k) => hs.some((x) => Math.abs(x - h * k) < h * 0.01 * k + 1e-6)));

  it('hidden data table: categories as rows, series as columns, every value present', () => {
    render(<BarChart title="Reports per month" categories={cats} series={two} />);
    const t = flat(screen.getByRole('table'));
    for (const s of ['Jan', 'Feb', 'Mar', 'Walk-in', 'Referred', '5', '8', '3', '7', '1', '9']) expect(t).toContain(s);
    expect(screen.getAllByText('Reports per month').length).toBeGreaterThan(0);
  });

  it('bars start at zero: heights are proportional to values (10 : 20 : 40)', () => {
    const { container } = render(<BarChart title="t" categories={cats} series={one} />);
    expect(hasRatio(heights(container), [1, 2, 4])).toBe(true);
  });

  it('draws one bar per category x series', () => {
    const { container } = render(<BarChart title="t" categories={cats} series={two} />);
    expect(container.querySelectorAll('svg rect').length).toBeGreaterThanOrEqual(6);
  });

  it('series are identified by legend text', () => {
    const { container } = render(<BarChart title="t" categories={cats} series={two} />);
    const out = [...container.querySelectorAll('*')].filter((e) => !e.closest('table') && e.children.length === 0 && /Walk-in|Referred/.test(e.textContent ?? ''));
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("valueFormat 'integer' and 'money' keep the digits of the value (grouping/decimals are the formatter's)", () => {
    const a = render(<BarChart title="t" categories={['x']} series={[{ id: 's', label: 'S', values: [1234567] }]} valueFormat="integer" />);
    expect(flat(a.container).replace(/\D/g, '')).toContain('1234567');
    a.unmount();
    const b = render(<BarChart title="t" categories={['x']} series={[{ id: 's', label: 'S', values: [1234567] }]} valueFormat="money" />);
    expect(flat(b.container).replace(/\D/g, '')).toMatch(/1234567/);
  });

  it.each([
    ['all zeros', cats, [{ id: 'z', label: 'Z', values: [0, 0, 0] }]],
    ['negative values', cats, [{ id: 'n', label: 'N', values: [-5, 0, 5] }]],
    ['values shorter than categories', cats, [{ id: 's', label: 'S', values: [1] }]],
    ['no categories', [], [{ id: 'e', label: 'E', values: [] }]],
    ['single bar', ['x'], [{ id: 's', label: 'S', values: [3] }]],
  ] as const)('degenerate input (%s) never produces NaN/Infinity', (_n, c, s) => {
    const { container } = render(<BarChart title="t" categories={c as any} series={s as any} />);
    expect(container.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
  });

  it.each(XSS)('title, categories and series labels are text: %s', (payload) => {
    render(<BarChart title={payload} categories={[payload]} series={[{ id: 'x', label: payload, values: [1] }]} />);
    noInjected();
    expect((window as any).__xss).toBeUndefined();
  });

  it('Devanagari category labels are kept', () => {
    render(<BarChart title="t" categories={[DEVANAGARI]} series={[{ id: 'x', label: 'X', values: [1] }]} />);
    expect(screen.getAllByText(DEVANAGARI).length).toBeGreaterThan(0);
  });

  it('axe', async () => {
    render(<BarChart title="Reports per month" categories={cats} series={two} />);
    expect(await seriousViolations()).toEqual([]);
  });
});

describe('KeyboardShortcutsDialog (04-UI-UX §4 `?` lists global + current page shortcuts)', () => {
  const groups = [
    { id: 'global', title: 'Global', shortcuts: [{ keys: '?', description: 'Show keyboard shortcuts' }, { keys: 'Alt+N', description: 'Focus navigation' }, { keys: 'g then s', description: 'Go to status board' }] },
    { id: 'page', title: 'This page', shortcuts: [{ keys: 'Alt+R', description: 'Receive specimen' }] },
  ];
  const open = (p: Partial<React.ComponentProps<typeof KeyboardShortcutsDialog>> = {}) => {
    const onClose = vi.fn();
    const r = render(<KeyboardShortcutsDialog isOpen onClose={onClose} groups={groups as any} {...(p as any)} />);
    return { onClose, ...r };
  };

  it('is a modal dialog titled "Keyboard shortcuts"', () => {
    open();
    const dlg = screen.getByRole('dialog', { name: /keyboard shortcuts/i });
    expect(dlg).toBeTruthy();
  });

  it('lists each group heading, key combination and description', () => {
    open();
    const dlg = screen.getByRole('dialog');
    for (const t of ['Global', 'This page', 'Show keyboard shortcuts', 'Focus navigation', 'Go to status board', 'Receive specimen']) expect(within(dlg).getByText(t)).toBeTruthy();
    for (const k of ['Alt+N', 'Alt+R']) expect(flat(dlg)).toContain(k);
  });

  it('key combinations are marked up as <kbd>', () => {
    open();
    expect(screen.getByRole('dialog').querySelectorAll('kbd').length).toBeGreaterThanOrEqual(4);
  });

  it('renders nothing when closed', () => {
    render(<KeyboardShortcutsDialog isOpen={false} onClose={() => {}} groups={groups as any} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Esc and the close button call onClose', async () => {
    const a = open();
    await user().keyboard('{Escape}');
    expect(a.onClose).toHaveBeenCalledTimes(1);
    a.unmount();
    const b = open();
    await user().click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    expect(b.onClose).toHaveBeenCalled();
  });

  it('focus moves into the dialog and returns to the opener on close', async () => {
    function Host() {
      const [o, setO] = useState(false);
      return <><button onClick={() => setO(true)}>Show help</button><KeyboardShortcutsDialog isOpen={o} onClose={() => setO(false)} groups={groups as any} /></>;
    }
    render(<Host />);
    const u = user();
    const opener = screen.getByRole('button', { name: 'Show help' });
    await u.click(opener);
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    await u.keyboard('{Escape}');
    expect(document.activeElement).toBe(opener);
  });

  it('an empty groups list still renders a valid dialog', async () => {
    render(<KeyboardShortcutsDialog isOpen onClose={() => {}} groups={[]} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
  });

  it.each(XSS)('descriptions and keys are text: %s', (payload) => {
    render(<KeyboardShortcutsDialog isOpen onClose={() => {}} groups={[{ id: 'g', title: payload, shortcuts: [{ keys: payload, description: payload }] }] as any} />);
    noInjected();
    expect((window as any).__xss).toBeUndefined();
  });

  it('axe', async () => {
    open();
    expect(await seriousViolations()).toEqual([]);
  });
});
