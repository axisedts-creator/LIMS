// @vitest-environment jsdom
// T0D-UIKIT-2 (LD-436, LD-437; done_when 2, 3, 4, 5, 6): Card title row, StatusStepper marker, drawn state illustrations.
// CONTRACT chosen here (writer: follow it, or file a dispute):
//   * Card: new optional prop `caption?: string`. With a title: div.lims-card-head (first child of .lims-card) > h2.lims-card-title, then
//     span.lims-card-caption (not a heading) when a caption is given; no caption = no caption element. Existing `title` callers unchanged.
//   * StatusStepper: new optional prop `mostWaitingId?: string` (a step id). That ONE li holds span.lims-step-marker (aria-hidden) and the
//     words "Most waiting" (status is a word, never colour alone). Absent or unknown id = no marker. Completed stages keep the check icon.
//   * EmptyState, ErrorState, NotAvailable: each .lims-state holds exactly ONE svg.lims-state-art, with data-art="empty" | "error" | "not-available",
//     aria-hidden="true", focusable="false", numeric width and height <= 96, fill="none", strokes only, set by attribute to var(--lims-accent*)
//     or var(--lims-neutral-N); at least one accent and one neutral stroke; no image, style, animation or hex colour. It replaces the 32px icon.
//   * kit.css: only tokens in every new rule; .lims-step-done in accent; .lims-step-upcoming outlined in a neutral token;
//     .lims-step-marker = accent.highlight fill with an accent.subtle ring made with border or outline (a box-shadow ring is barred by ui-r03).
//   * CARD SURFACE, RULED (LD-438, CR-C0-0D-UIKIT2 option C): kit.css lims-card stays radius 24, no border, no shadow (m-series-kit and
//     ui-r03-kit-pass stay green, not edited). The staff web hairline + radius md + elevation.1 is in apps/web shell.css, tested by
//     apps/web/src/core/shell/__tests__/uikit2.shell.test.ts.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Card } from '../Card/Card';
import { StatusStepper } from '../StatusStepper/StatusStepper';
import { EmptyState } from '../EmptyState/EmptyState';
import { ErrorState } from '../ErrorState/ErrorState';
import { NotAvailable } from '../NotAvailable/NotAvailable';
import { declared, rulesMatching } from './uikit1-css';
import { XSS } from './helpers';

const COMPONENTS = join(process.cwd(), 'src', 'components'); // vitest root = packages/ui

describe('Card title row (done_when 2)', () => {
  it('title is the h2 and the caption sits after it in the same head row, as plain text, not a heading', () => {
    const { container } = render(<Card title="Pipeline" caption="Last 7 days">body</Card>);
    const card = container.querySelector('.lims-card') as HTMLElement;
    const head = card.firstElementChild as HTMLElement;
    expect(head.className).toContain('lims-card-head');
    const h2 = head.querySelector(':scope > h2.lims-card-title') as HTMLElement;
    const cap = head.querySelector(':scope > .lims-card-caption') as HTMLElement;
    expect(h2.textContent).toBe('Pipeline');
    expect(cap.textContent).toBe('Last 7 days');
    expect(cap.matches('h1,h2,h3,h4,h5,h6')).toBe(false);
    expect(h2.compareDocumentPosition(cap) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(head.nextSibling?.textContent).toBe('body');
  });

  it('no caption = no caption element; the title stays an h2 (existing callers unchanged)', () => {
    const { container } = render(<Card title="T">body</Card>);
    expect(container.querySelector('.lims-card-caption')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('T');
  });

  it('a hostile caption is text, not markup', () => {
    const { container } = render(<Card title="T" caption={XSS[0]}>x</Card>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.lims-card-caption')?.textContent).toBe(XSS[0]);
  });

  it('the head row puts title left and caption right (flex, space-between)', () => {
    expect(declared(/^\.lims-card-head$/, 'display')).toBe('flex');
    expect(declared(/^\.lims-card-head$/, 'justify-content')).toBe('space-between');
    expect(declared(/^\.lims-card-head$/, 'align-items')).toBe('baseline'); // mock: title and caption share a baseline
  });

  it('title weight 500, md size; caption small and neutral (weights 400 and 500 only)', () => {
    expect(declared(/^\.lims-card-title$/, 'font-weight')).toMatch(/^(500|var\(--lims-font-weight-medium\))$/);
    expect(declared(/^\.lims-card-title$/, 'font-size')).toBe('var(--lims-font-size-md-size)');
    expect(declared(/^\.lims-card-caption$/, 'color')).toMatch(/^var\(--lims-neutral-(500|600)\)$/);
    expect(declared(/^\.lims-card-caption$/, 'font-weight') ?? 'var(--lims-font-weight-regular)').not.toMatch(/600|700|semibold|bold/);
  });

  // LD-438 (option C): the kit base card STAYS the M series card; the hairline, radius md and elevation.1 live in apps/web shell.css
  // (apps/web/src/core/shell/__tests__/uikit2.shell.test.ts). This guard fails if the kit rule is changed.
  it('kit.css lims-card is unchanged: white fill, radius xl (24), no border, no shadow (LD-438)', () => {
    expect(declared(/^\.lims-card$/, 'background')).toBe('var(--lims-neutral-0)');
    expect(declared(/^\.lims-card$/, 'border-radius')).toBe('var(--lims-radius-xl)');
    expect(declared(/^\.lims-card$/, 'border')).toMatch(/^(0|none)$/);
    expect(declared(/^\.lims-card$/, 'box-shadow')).toBe('none');
  });
});

describe('StatusStepper (done_when 3)', () => {
  const steps = ['Received', 'In testing', 'Review', 'Ready'].map((label, i) => ({ id: `s${i}`, label }));
  const CHECK = 'M5 12l5 5L20 7';
  const lis = (c: HTMLElement) => [...c.querySelectorAll('li.lims-step')] as HTMLElement[];
  const paths = (el: Element) => [...el.querySelectorAll('svg path')].map((p) => p.getAttribute('d'));

  it('completed stages carry a check; later stages do not', () => {
    const { container } = render(<StatusStepper steps={steps} currentId="s2" />);
    const [a, b, c, d] = lis(container);
    expect(paths(a)).toContain(CHECK);
    expect(paths(b)).toContain(CHECK);
    expect(paths(c)).not.toContain(CHECK);
    expect(paths(d)).not.toContain(CHECK);
  });

  it('ONE marker on the stage the page names, with the words "Most waiting" (not colour alone), aria-hidden dot', () => {
    const { container } = render(<StatusStepper steps={steps} currentId="s2" mostWaitingId="s1" />);
    const markers = container.querySelectorAll('.lims-step-marker');
    expect(markers).toHaveLength(1);
    const li = lis(container)[1];
    expect(li.contains(markers[0])).toBe(true);
    expect(markers[0].getAttribute('aria-hidden')).toBe('true');
    expect(within(li).getByText(/most waiting/i)).toBeTruthy();
    expect(within(container).getAllByText(/most waiting/i)).toHaveLength(1);
  });

  it('the marker may sit on an upcoming stage too; unknown or missing id draws none', () => {
    expect(lis(render(<StatusStepper steps={steps} currentId="s0" mostWaitingId="s3" />).container)[3].querySelector('.lims-step-marker')).toBeTruthy();
    expect(render(<StatusStepper steps={steps} currentId="s1" mostWaitingId="nope" />).container.querySelector('.lims-step-marker')).toBeNull();
    expect(render(<StatusStepper steps={steps} currentId="s1" />).container.querySelector('.lims-step-marker')).toBeNull();
  });

  it('existing behaviour kept: aria-current on the current stage, state words, outcome alert', () => {
    const { container } = render(<StatusStepper steps={steps} currentId="s1" outcome={{ kind: 'failed', label: 'Stopped' }} />);
    expect(lis(container)[1].getAttribute('aria-current')).toBe('step');
    expect(lis(container)[0].textContent).toContain('Complete');
    expect(screen.getByRole('alert').textContent).toBe('Stopped');
  });

  const all = (re: RegExp, props: string[]) =>
    rulesMatching(re).flatMap((r) => props.map((p) => r.decls.get(p)).filter(Boolean) as string[]).join(' ');

  it('completed stages are drawn in accent', () => {
    expect(all(/\.lims-step-done\b/, ['color', 'background', 'border', 'border-color'])).toContain('var(--lims-accent');
  });

  it('later stages are outlined in a neutral token', () => {
    expect(all(/\.lims-step-upcoming\b/, ['border', 'outline', 'border-color'])).toMatch(/var\(--lims-neutral-\d+\)/);
  });

  it('the marker is accent.highlight with an accent.subtle ring (border or outline, never a literal shadow)', () => {
    expect(declared(/^\.lims-step-marker$/, 'background')).toBe('var(--lims-accent-highlight)');
    expect(all(/^\.lims-step-marker$/, ['border', 'outline', 'border-color'])).toContain('var(--lims-accent-subtle)');
    expect(declared(/^\.lims-step-marker$/, 'box-shadow') ?? 'none').toBe('none');
  });
});

describe('drawn state illustrations (done_when 4)', () => {
  const FORBIDDEN = 'image, img, style, script, foreignObject, animate, animateTransform, animateMotion, set, use';
  const SHAPES = 'path, circle, rect, line, ellipse, polyline, polygon';
  const art = (c: HTMLElement) => [...c.querySelectorAll('.lims-state svg')] as SVGElement[];
  const cases: [string, () => HTMLElement, string][] = [
    ['EmptyState', () => render(<EmptyState title="No samples" body="Samples appear here." />).container, 'empty'],
    ['ErrorState', () => render(<ErrorState title="Could not load" requestId="r1" onRetry={() => {}} />).container, 'error'],
    ['NotAvailable', () => render(<NotAvailable title="Lab" />).container, 'not-available'],
  ];

  it.each(cases)('%s draws exactly one aria-hidden, small svg.lims-state-art', (_n, make, kind) => {
    const svgs = art(make());
    expect(svgs).toHaveLength(1);
    const s = svgs[0];
    expect(s.classList.contains('lims-state-art')).toBe(true);
    expect(s.getAttribute('data-art')).toBe(kind);
    expect(s.getAttribute('aria-hidden')).toBe('true');
    expect(s.getAttribute('focusable')).toBe('false');
    expect(s.querySelector('title')).toBeNull();
    for (const a of ['width', 'height']) {
      const n = Number(s.getAttribute(a));
      expect(n, `${a} must be a number <= 96`).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(96);
    }
  });

  it.each(cases)('%s illustration is stroke only: fill none, token strokes, accent and neutral, no image or animation', (_n, make) => {
    const s = art(make())[0];
    expect(s.getAttribute('fill')).toBe('none');
    expect(s.hasAttribute('style')).toBe(false);
    expect(s.querySelector(FORBIDDEN)).toBeNull();
    const shapes = [...s.querySelectorAll(SHAPES)];
    expect(shapes.length).toBeGreaterThan(1);
    const strokes = shapes.map((e) => e.getAttribute('stroke'));
    for (const e of shapes) {
      expect(['none', null], `${e.tagName} fill`).toContain(e.getAttribute('fill'));
      expect(e.hasAttribute('style')).toBe(false);
    }
    for (const v of strokes) expect(v, 'stroke must be a token').toMatch(/^var\(--lims-(accent|neutral-\d+)[\w-]*\)$/);
    expect(strokes.some((v) => /accent/.test(v ?? '')), 'no accent stroke').toBe(true);
    expect(strokes.some((v) => /neutral/.test(v ?? '')), 'no neutral stroke').toBe(true);
    expect(s.outerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|gradient|url\(|data:/i);
  });

  it('the three drawings are different pictures', () => {
    const html = cases.map(([, make]) => art(make())[0].innerHTML);
    expect(new Set(html).size).toBe(3);
  });

  it('NotAvailable with a header row keeps it and still carries one illustration (rule 5 + done_when 4)', () => {
    const { container } = render(<NotAvailable title="Lab" columns={['Sample', 'Patient']} />);
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
    expect(container.querySelectorAll('td svg.lims-state-art')).toHaveLength(1);
  });

  it('ErrorState with pageTitle keeps the h1 and one illustration; Retry still works as a button', () => {
    const { container } = render(<ErrorState pageTitle="Reporting" title="Could not load" onRetry={() => {}} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reporting');
    expect(art(container)).toHaveLength(1);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('source of the four parts holds no stock picture, data URI, hex colour or image import', () => {
    for (const n of ['EmptyState', 'ErrorState', 'NotAvailable']) {
      const src = readFileSync(join(COMPONENTS, n, `${n}.tsx`), 'utf8');
      expect(src, n).not.toMatch(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?![\w-])|data:image|<img|<image|\.(png|jpe?g|gif|webp|svg)['"]/i);
    }
  });
});

describe('kit.css: tokens only, 150 ms motion, nothing loops (done_when 5; rule: CSS added uses tokens only)', () => {
  const NEW = /\.lims-(action-|card-head|card-caption|step-(marker|done|upcoming|current)|state-art)/;

  it('there are new rules to check (card head, step marker, state art)', () => {
    for (const re of [/\.lims-card-head/, /\.lims-step-marker/, /\.lims-state-art/]) expect(rulesMatching(re).length, String(re)).toBeGreaterThan(0);
  });

  it('no colour literal, gradient, literal shadow, literal duration or curve; weights 400 or 500 only', () => {
    for (const r of rulesMatching(NEW)) {
      for (const [k, v] of r.decls) {
        expect(v, `${r.sels.join(',')} { ${k} }`).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|gradient\(|cubic-bezier|\b\d+m?s\b/i);
        if (k === 'box-shadow') expect(v).toMatch(/^(none|var\(--lims-elevation-[0-3]\))$/);
        if (k === 'font-weight') expect(v).toMatch(/^(400|500|var\(--lims-font-weight-(regular|normal|medium)\))$/);
      }
    }
  });

  it('no animation or keyframes on the new rules; any transition is the 150 ms token with the one easing', () => {
    for (const r of rulesMatching(NEW)) {
      expect([...r.decls.keys()].filter((k) => k.startsWith('animation')), r.sels.join(',')).toEqual([]);
      const t = r.decls.get('transition');
      if (t && t !== 'none') {
        expect(t).toContain('var(--lims-motion-duration-fast)');
        expect(t).toContain('var(--lims-motion-easing)');
      }
    }
  });
});

describe('guards (done_when 6; hard limits)', () => {
  it('packages/ui/tokens/tokens.json is unchanged', () => {
    const raw = readFileSync(join(process.cwd(), 'tokens', 'tokens.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(raw).digest('hex')).toBe('9aa985ac98bca87b38943a39f7b689959e1644041dd9492cf425cd19c5200915');
  });
});

describe('kit docs page: each changed part is shown with sample data (done_when 6)', () => {
  const stories = async (p: string) => Object.entries(await import(p)).filter(([k]) => k !== 'default').map(([, v]) => v as { args?: Record<string, unknown> });

  it('Card has a story with a title and a caption', async () => {
    const s = await stories('../Card/Card.stories');
    expect(s.some((x) => typeof x.args?.title === 'string' && typeof x.args?.caption === 'string')).toBe(true);
  });

  it('StatusStepper has a story that names a most-waiting stage that exists', async () => {
    const s = await stories('../StatusStepper/StatusStepper.stories');
    const withMarker = s.filter((x) => typeof x.args?.mostWaitingId === 'string');
    expect(withMarker.length).toBeGreaterThan(0);
    for (const x of withMarker) expect((x.args!.steps as { id: string }[]).map((t) => t.id)).toContain(x.args!.mostWaitingId);
  });

  it.each(['EmptyState', 'ErrorState', 'NotAvailable'])('%s still has a story', async (n) => {
    expect((await stories(`../${n}/${n}.stories`)).length).toBeGreaterThan(0);
  });
});
