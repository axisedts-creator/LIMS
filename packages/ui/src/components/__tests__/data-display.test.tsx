// @vitest-environment jsdom
// T0D-12 / 04-UI-UX §1.3, §2.5: StatusChip, FlagBadge (AC-0D-8.3), ResultValue, MoneyText, IdText, DescriptionList
// ASSUMED (spec silent): tone is exposed as data-tone="<tone>" on the chip/badge root.
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusChip } from '../StatusChip/StatusChip';
import { FlagBadge } from '../FlagBadge/FlagBadge';
import { ResultValue } from '../ResultValue/ResultValue';
import { MoneyText } from '../MoneyText/MoneyText';
import { IdText } from '../IdText/IdText';
import { DescriptionList } from '../DescriptionList/DescriptionList';
import { DEVANAGARI, XSS, user } from './helpers';

// [kind, status, tone, label] verbatim from 04-UI-UX §1.3
const MAP: [string, string, string, string][] = [
  ['specimen', 'ordered', 'neutral', 'Ordered'], ['specimen', 'collected', 'info', 'Collected'],
  ['specimen', 'in_transit', 'info', 'In transit'], ['specimen', 'received', 'info', 'Received'],
  ['specimen', 'aliquoted', 'info', 'Aliquoted'], ['specimen', 'in_process', 'info', 'In process'],
  ['specimen', 'resulted', 'warning', 'Resulted'], ['specimen', 'verified', 'warning', 'Verified'],
  ['specimen', 'approved', 'success', 'Approved'], ['specimen', 'reported', 'success', 'Reported'],
  ['specimen', 'rejected', 'danger', 'Rejected'], ['specimen', 'recollection_ordered', 'warning', 'Recollection ordered'],
  ['specimen', 'stored', 'neutral', 'Stored'], ['specimen', 'discarded', 'neutral', 'Discarded'],
  ['result', 'pending', 'neutral', 'Pending'], ['result', 'resulted', 'warning', 'Resulted'],
  ['result', 'verified', 'warning', 'Verified'], ['result', 'approved', 'success', 'Approved'],
  ['result', 'cancelled', 'neutral', 'Cancelled'],
  ['report_version', 'rendering', 'info', 'Rendering'], ['report_version', 'rendered', 'info', 'Ready to release'],
  ['report_version', 'render_failed', 'danger', 'Render failed'], ['report_version', 'released', 'success', 'Released'],
  ['report_version', 'superseded', 'neutral', 'Superseded'], ['report_version', 'discarded', 'neutral', 'Discarded'],
  ['order', 'pre_registered', 'neutral', 'Pre-registered'], ['order', 'registered', 'info', 'Registered'],
  ['order', 'in_progress', 'info', 'In progress'], ['order', 'completed', 'success', 'Completed'],
  ['order', 'cancelled', 'danger', 'Cancelled'],
  ['invoice', 'issued', 'success', 'Issued'], ['invoice', 'cancelled', 'danger', 'Cancelled'],
  ['payment_intent', 'settled', 'success', 'Paid'], ['payment_intent', 'created', 'info', ''],
  ['payment_intent', 'failed', 'danger', ''], ['payment_intent', 'held_for_review', 'warning', 'Under review'],
  ['payment_intent', 'refunded', 'neutral', ''],
  ['dead_letter', 'open', 'danger', 'Open'], ['dead_letter', 'replayed', 'success', 'Replayed'],
  ['dead_letter', 'discarded', 'neutral', 'Discarded'],
];

describe('StatusChip (AC-0D-8.3: status conveyed by text as well as colour)', () => {
  it.each(MAP)('%s/%s -> tone %s, text "%s"', (kind, status, tone, label) => {
    const { container } = render(<StatusChip kind={kind as any} status={status} />);
    const text = (container.textContent ?? '').trim();
    expect(text.length).toBeGreaterThan(0);
    if (label) expect(text).toBe(label);
    expect(container.querySelector(`[data-tone="${tone}"]`)).toBeTruthy();
  });

  it('result flags on_hold / qc_review_required are not result states (they are extra chips) — chips still render text', () => {
    const { container } = render(<StatusChip kind="generic" status="on_hold" label="QC hold" tone="warning" />);
    expect(container.textContent).toBe('QC hold');
    expect(container.querySelector('[data-tone="warning"]')).toBeTruthy();
  });

  it('unknown status renders a neutral chip with the raw code and never throws', () => {
    const { container } = render(<StatusChip kind="specimen" status="brand_new_state" />);
    expect(container.textContent).toContain('brand_new_state');
    expect(container.querySelector('[data-tone="neutral"]')).toBeTruthy();
  });

  it('unknown kind or empty status does not crash', () => {
    expect(() => render(<StatusChip kind={'nope' as any} status="" />)).not.toThrow();
  });

  it.each(XSS)('hostile status %j is text, not markup (REQ-SEC-088)', (payload) => {
    const { container } = render(<StatusChip kind="specimen" status={payload} />);
    expect(container.querySelector('img,script,svg[onload]')).toBeNull();
    expect(container.textContent).toContain(payload);
  });

  it('generic chip shows Devanagari label', () => {
    const { container } = render(<StatusChip kind="generic" status="x" label={DEVANAGARI} tone="info" />);
    expect(container.textContent).toBe(DEVANAGARI);
  });
});

describe('FlagBadge (04 §1.3 result-flag rows)', () => {
  it('N renders nothing unless showNormal', () => {
    const { container, rerender } = render(<FlagBadge flag="N" />);
    expect((container.textContent ?? '').trim()).toBe('');
    rerender(<FlagBadge flag="N" showNormal />);
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0);
  });

  it.each([
    ['L', 'danger', 'Low'], ['H', 'danger', 'High'], ['A', 'danger', 'Abnormal'],
    ['LL', 'critical', 'Critical low'], ['HH', 'critical', 'Critical high'],
  ])('%s -> %s tone, text "%s"', (flag, tone, text) => {
    const { container } = render(<FlagBadge flag={flag as any} />);
    expect(container.textContent).toContain(text);
    expect(container.querySelector(`[data-tone="${tone}"]`)).toBeTruthy();
  });

  it.each(['LL', 'HH'])('critical %s carries an icon (decorative) plus text', (flag) => {
    const { container } = render(<FlagBadge flag={flag as any} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).toMatch(/Critical/);
  });
});

describe('ResultValue', () => {
  it('shows value, unit and, when abnormal, the text flag', () => {
    const { container } = render(<ResultValue value="12.4" unit="g/dL" flag="H" />);
    expect(container.textContent).toContain('12.4');
    expect(container.textContent).toContain('g/dL');
    expect(container.textContent).toContain('High');
  });
  it('normal / no flag shows no flag text', () => {
    const { container } = render(<ResultValue value="5.0" unit="mmol/L" flag="N" />);
    expect(container.textContent).not.toMatch(/High|Low|Critical|Abnormal/);
  });
  it('decimals pads with zeros without touching larger precision as float', () => {
    const { container, rerender } = render(<ResultValue value="5.5" decimals={2} />);
    expect(container.textContent).toContain('5.50');
    rerender(<ResultValue value="123456789012345678.123456789" decimals={9} />);
    expect(container.textContent).toContain('123456789012345678.123456789');
  });
  it('non-numeric text results pass through; missing value does not crash', () => {
    const { container, rerender } = render(<ResultValue value="Positive" flag="A" />);
    expect(container.textContent).toContain('Positive');
    rerender(<ResultValue />);
    expect(container).toBeTruthy();
  });
  it('hostile text value is text, not markup', () => {
    const { container } = render(<ResultValue value={XSS[0]} />);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('MoneyText (integer paisa -> display only)', () => {
  const m = { amount_paisa: 123456789, currency: 'NPR' } as const;
  it('default is lakh grouping: Rs. 12,34,567.89', () => {
    const { container } = render(<MoneyText value={m} />);
    expect(container.textContent).toBe('Rs. 12,34,567.89');
  });
  it('international grouping: Rs. 1,234,567.89', () => {
    const { container } = render(<MoneyText value={m} grouping="international" />);
    expect(container.textContent).toBe('Rs. 1,234,567.89');
  });
  it('zero and sub-rupee amounts', () => {
    const { container, rerender } = render(<MoneyText value={{ amount_paisa: 0, currency: 'NPR' }} />);
    expect(container.textContent).toBe('Rs. 0.00');
    rerender(<MoneyText value={{ amount_paisa: 7, currency: 'NPR' }} />);
    expect(container.textContent).toBe('Rs. 0.07');
  });
});

describe('IdText', () => {
  const uuid = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  it('truncates to 8 chars by default but keeps the full id in the DOM', () => {
    const { container } = render(<IdText value={uuid} />);
    expect((container.textContent ?? '').trim()).toContain('0190a1b2');
    expect(container.textContent).not.toContain('c3d4-7e5f');
    expect(container.innerHTML).toContain(uuid);
  });
  it('truncate prop and short ids', () => {
    const { container, rerender } = render(<IdText value={uuid} truncate={12} />);
    expect(container.textContent).toContain('0190a1b2-c3d');
    rerender(<IdText value="INV-1" />);
    expect(container.textContent).toContain('INV-1');
  });
  it('copyable: button copies the FULL value', async () => {
    const u = user();
    render(<IdText value={uuid} copyable />);
    await u.click(screen.getByRole('button', { name: /copy/i }));
    expect(await navigator.clipboard.readText()).toBe(uuid);
  });
  it('not copyable by default', () => {
    render(<IdText value={uuid} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('DescriptionList', () => {
  it('renders term/value pairs as dl/dt/dd, values may be nodes, Devanagari intact', () => {
    const { container } = render(
      <DescriptionList items={[{ term: 'Name', value: DEVANAGARI }, { term: 'Status', value: <b>Active</b> }]} columns={2} />,
    );
    expect(container.querySelector('dl')).toBeTruthy();
    expect([...container.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Name', 'Status']);
    expect([...container.querySelectorAll('dd')].map((d) => d.textContent)).toEqual([DEVANAGARI, 'Active']);
  });
  it('empty list does not crash', () => {
    expect(() => render(<DescriptionList items={[]} />)).not.toThrow();
  });
});
