// @vitest-environment jsdom
// C16.T-Q4 / LD-143 (CR-C16-016): TokenSlip props { labName; heading; big; lines; issuedAt } (04-UI-UX §9.2).
// Renders ONLY those six fields — nothing else, never a patient name or phone (04-UI-UX lines 228, 249).
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TokenSlip } from '../TokenSlip/TokenSlip';

afterEach(cleanup);
const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const props = {
  labName: 'Metro Test Lab',
  heading: 'Registration',
  big: 'A-007',
  lines: ['Please wait for your number', 'Keep this slip'],
  issuedAt: '2026-01-15T06:30:00.000Z',
} as const;

describe('TokenSlip', () => {
  it('renders labName, heading, big, every line and an issuedAt date-time — and no other text', () => {
    const { container } = render(<TokenSlip {...props} lines={[...props.lines]} />);
    let rest = norm(container.textContent);
    for (const s of [props.labName, props.heading, props.big, ...props.lines]) {
      expect(rest, `missing "${s}"`).toContain(s);
      rest = rest.replace(s, '');
    }
    expect(rest).toMatch(/2026/); // issuedAt shown (format is the writer's choice; date part must be present)
    // what remains is only a formatted date-time: digits, separators, am/pm, zone, month name
    expect(rest.replace(/[\d\s:/.,\-+]|am|pm|utc|gmt|[tz]|jan(uary)?/gi, '')).toBe('');
  });

  it('renders each of several lines separately and nothing when lines is empty', () => {
    const many = render(<TokenSlip {...props} lines={['one', 'two', 'three']} />);
    for (const s of ['one', 'two', 'three']) expect(many.container.textContent).toContain(s);
    cleanup();
    const none = render(<TokenSlip {...props} lines={[]} />);
    const t = norm(none.container.textContent);
    expect(t).toContain('A-007');
    expect(t).not.toMatch(/undefined|null/);
  });

  it('shows no patient identity and no interactive controls', () => {
    const { container } = render(<TokenSlip {...props} lines={[...props.lines]} />);
    expect(container.querySelectorAll('button, a, input, img').length).toBe(0);
    expect(norm(container.textContent)).not.toMatch(/\+?\d{8,}|patient|phone|mobile/i);
  });

  it('escapes markup passed in text props', () => {
    const { container } = render(<TokenSlip {...props} labName={'<img src=x onerror=alert(1)>'} lines={['<b>x</b>']} />);
    expect(container.querySelector('img, b')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('source: kit tokens only (LD-140) — no hex colours, no inline style objects, 80 mm print width', () => {
    const src = readFileSync(fileURLToPath(new NodeURL('../TokenSlip/TokenSlip.tsx', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/style=\{\{/);
    const css = (src.match(/@media print[\s\S]*/) ?? [''])[0] + src;
    expect(css).toMatch(/80mm|80 mm/);
  });
});
