// @vitest-environment jsdom
// T0D-UIKIT-2 (LD-436, LD-437; done_when 1 and 5): ActionList, the "Needs you" list of the approved Today mock.
// CONTRACT chosen here (writer: follow it, or file a dispute):
//   * components/ActionList/ActionList.tsx exports ActionList and type ActionListItem.
//     props: { items: readonly ActionListItem[]; label?: string (aria-label of the list); 'data-testid'?: string }
//     item:  { id: string; title: string; detail: string; count: number; tone: Tone; icon: IconName } & ({ href: string } | { onPress: () => void })
//   * markup: ul.lims-action-list > li > (a | button).lims-action-row, in the given order (the kit never sorts: the caller puts the most urgent first).
//     row children, in this order: span.lims-action-chip[data-tone] (holds an aria-hidden svg), a text block holding
//     .lims-action-title and .lims-action-detail, a Badge (span.lims-chip[data-tone]) with the count, svg.lims-action-chevron (aria-hidden).
//   * kit.css: .lims-action-row has own :hover and :focus-visible rules, a 150 ms token transition, and a prefers-reduced-motion block.
//   * the Icon set has no chevron-right today: add it additively (the chevron must not be a text glyph).
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionList } from '../ActionList/ActionList';
import { rulesMatching } from './uikit1-css';
import { seriousViolations, user, XSS } from './helpers';

const items = (onPress: () => void = () => {}) =>
  [
    { id: 'a', title: 'Overdue results', detail: 'Past their promised time', count: 4, tone: 'danger', icon: 'warning', href: '/results/overdue' },
    { id: 'b', title: 'Awaiting collection', detail: 'Waiting at the counter', count: 12, tone: 'warning', icon: 'info', onPress },
    { id: 'c', title: 'Ready to release', detail: 'Checked and signed off', count: 7, tone: 'success', icon: 'success', href: '/results/ready' },
  ] as const;

const rows = (c: HTMLElement) => [...c.querySelectorAll('.lims-action-row')] as HTMLElement[];

describe('ActionList: structure and order (done_when 1)', () => {
  it('is a list of one row per item, in the order given (the kit never re-sorts: first row = most urgent)', () => {
    // counts ascending on purpose: a kit that sorted by count would reorder
    const { container } = render(<ActionList label="Needs you" items={items()} />);
    expect(screen.getByRole('list', { name: 'Needs you' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(rows(container).map((r) => r.querySelector('.lims-action-title')?.textContent)).toEqual(['Overdue results', 'Awaiting collection', 'Ready to release']);
  });

  it('a row with href is a link and a row with onPress is a button (never a div with a click handler)', async () => {
    const onPress = vi.fn();
    const { container } = render(<ActionList items={items(onPress)} />);
    const [a, b, c] = rows(container);
    expect(a.tagName).toBe('A');
    expect((a as HTMLAnchorElement).getAttribute('href')).toBe('/results/overdue');
    expect(b.tagName).toBe('BUTTON');
    expect(c.tagName).toBe('A');
    await user().click(screen.getByRole('button', { name: /Awaiting collection/ }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a button row works from the keyboard: Enter and Space', async () => {
    const onPress = vi.fn();
    render(<ActionList items={items(onPress)} />);
    const u = user();
    screen.getByRole('button', { name: /Awaiting collection/ }).focus();
    await u.keyboard('{Enter}');
    await u.keyboard(' ');
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it('Tab moves through the rows in order (every row is focusable)', async () => {
    const { container } = render(<ActionList items={items()} />);
    const u = user();
    const [a, b, c] = rows(container);
    await u.tab();
    expect(document.activeElement).toBe(a);
    await u.tab();
    expect(document.activeElement).toBe(b);
    await u.tab();
    expect(document.activeElement).toBe(c);
  });
});

describe('ActionList: one row = tone icon chip, title, one detail line, count Badge, chevron (done_when 1)', () => {
  it('each row holds the five parts, in that order', () => {
    const { container } = render(<ActionList items={items()} />);
    rows(container).forEach((row, i) => {
      const it = items()[i];
      const chip = row.querySelector('.lims-action-chip') as HTMLElement;
      const title = row.querySelector('.lims-action-title') as HTMLElement;
      const detail = row.querySelector('.lims-action-detail') as HTMLElement;
      const badge = row.querySelector('.lims-chip') as HTMLElement;
      const chevron = row.querySelector('svg.lims-action-chevron') as SVGElement;
      for (const el of [chip, title, detail, badge, chevron]) expect(el, `row ${i} lacks a part`).toBeTruthy();
      expect(chip.getAttribute('data-tone')).toBe(it.tone);
      expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(title.textContent).toBe(it.title);
      expect(row.querySelectorAll('.lims-action-title')).toHaveLength(1);
      expect(row.querySelectorAll('.lims-action-detail')).toHaveLength(1); // ONE detail line
      expect(detail.textContent).toBe(it.detail);
      expect(badge.textContent).toBe(String(it.count));
      expect(badge.getAttribute('data-tone')).toBe(it.tone);
      expect(chevron.getAttribute('aria-hidden')).toBe('true');
      const before = (x: Node, y: Node) => !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(before(chip, title) && before(title, detail) && before(detail, badge) && before(badge, chevron), `row ${i} part order`).toBe(true);
    });
  });

  it('the accessible name carries title, detail and count: nothing is colour or icon only', () => {
    render(<ActionList items={items()} />);
    expect(screen.getByRole('link', { name: /Overdue results.*Past their promised time.*4/ })).toBeTruthy();
  });

  it('a count of 0 is still shown (the row does not hide a zero)', () => {
    const { container } = render(<ActionList items={[{ id: 'z', title: 'Nothing due', detail: 'All clear', count: 0, tone: 'neutral', icon: 'neutral', href: '/x' }]} />);
    expect(container.querySelector('.lims-chip')?.textContent).toBe('0');
  });

  it('forwards data-testid to the list', () => {
    render(<ActionList items={items()} data-testid="needs-you" />);
    expect(screen.getByTestId('needs-you').tagName).toBe('UL');
  });
});

describe('ActionList: hostile input (07-SECURITY: no markup injection, no script URL)', () => {
  it('title and detail are text, not markup', () => {
    const { container } = render(<ActionList items={[{ id: 'h', title: XSS[0], detail: XSS[1], count: 1, tone: 'info', icon: 'info', href: '/ok' }]} />);
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelector('.lims-action-title')?.textContent).toBe(XSS[0]);
    expect(container.querySelector('.lims-action-detail')?.textContent).toBe(XSS[1]);
  });

  it('a javascript: href is never rendered as a link target', () => {
    const { container } = render(<ActionList items={[{ id: 'j', title: 'Bad link', detail: 'x', count: 1, tone: 'info', icon: 'info', href: 'javascript:alert(1)' }]} />);
    expect(container.querySelector('[href^="javascript" i]')).toBeNull();
  });
});

describe('ActionList: keyboard focus, hover, 150 ms token motion, reduced motion (done_when 1 and 5)', () => {
  const rowRules = () => rulesMatching(/^\.lims-action-row\b/);
  const decls = (pred: (s: string) => boolean, prop: string, media = '') =>
    rulesMatching(/\.lims-action-row/, media).filter((r) => r.sels.some(pred)).map((r) => r.decls.get(prop)).filter(Boolean) as string[];

  it('kit.css styles the row', () => {
    expect(rowRules().length).toBeGreaterThan(0);
  });

  it('visible keyboard focus: a :focus-visible rule draws an outline in the focus-ring token (buttons are not covered by the global anchor rule)', () => {
    const outlines = decls((s) => /:focus-visible/.test(s), 'outline');
    expect(outlines.length, 'no .lims-action-row:focus-visible outline').toBeGreaterThan(0);
    for (const o of outlines) {
      expect(o).toContain('var(--lims-focus-ring)');
      expect(o).not.toMatch(/^(0|none)\b/);
    }
  });

  it('hover has its own rule', () => {
    expect(decls((s) => /:hover/.test(s), 'background').length).toBeGreaterThan(0);
  });

  it('the transition uses the 150 ms token and the one easing curve, no literal time and no curve', () => {
    const t = decls((s) => !/:/.test(s), 'transition');
    expect(t.length, 'no transition on .lims-action-row').toBeGreaterThan(0);
    for (const v of t) {
      expect(v).toContain('var(--lims-motion-duration-fast)');
      expect(v).toContain('var(--lims-motion-easing)');
      expect(v).not.toMatch(/\d+m?s\b|cubic-bezier|\ball\b/);
    }
  });

  it('prefers-reduced-motion switches the row transition off', () => {
    const reduced = rulesMatching(/\.lims-action-row/).filter((r) => /prefers-reduced-motion/.test(r.media));
    expect(reduced.length, 'no reduced-motion rule for .lims-action-row').toBeGreaterThan(0);
    expect(reduced.some((r) => r.decls.get('transition') === 'none' || /^0(s|ms)?$/.test(r.decls.get('transition-duration') ?? ''))).toBe(true);
  });

  it('nothing loops: no animation on any action-list rule', () => {
    for (const r of rulesMatching(/\.lims-action-/)) {
      expect([...r.decls.keys()].filter((k) => k.startsWith('animation')), r.sels.join(',')).toEqual([]);
    }
  });

  it('tokens only: no colour literal, gradient or literal shadow in any action-list rule; weights are 400 or 500', () => {
    for (const r of rulesMatching(/\.lims-action-/)) {
      for (const [k, v] of r.decls) {
        expect(v, `${r.sels.join(',')} { ${k} }`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|gradient\(/i);
        if (k === 'box-shadow') expect(v).toMatch(/^(none|var\(--lims-elevation-[01]\))$/);
        if (k === 'font-weight') expect(v).toMatch(/^(400|500|var\(--lims-font-weight-(regular|normal|medium)\))$/);
      }
    }
  });
});

describe('ActionList: sample data and axe', () => {
  it('has no serious or critical axe violation', async () => {
    const { container } = render(<ActionList label="Needs you" items={items()} />);
    expect(await seriousViolations(container)).toEqual([]);
  });

  it('the kit docs page (story) shows it with at least three sample rows', async () => {
    const mod = await import('../ActionList/ActionList.stories');
    expect(typeof mod.default.title).toBe('string');
    expect(mod.default.component).toBe(ActionList);
    const named = Object.entries(mod).filter(([k]) => k !== 'default');
    expect(named.length).toBeGreaterThan(0);
    const withItems = named.map(([, s]) => (s as { args?: { items?: unknown[] } }).args?.items).filter(Array.isArray) as Record<string, unknown>[][];
    expect(withItems.length).toBeGreaterThan(0);
    for (const list of withItems) {
      expect(list.length).toBeGreaterThanOrEqual(3);
      for (const it of list) for (const k of ['id', 'title', 'detail', 'count', 'tone', 'icon']) expect(it[k], `story item lacks ${k}`).not.toBeUndefined();
    }
    const first = within(render(<ActionList {...(named[0][1] as { args: { items: never } }).args} />).container);
    expect(first.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
  });
});
