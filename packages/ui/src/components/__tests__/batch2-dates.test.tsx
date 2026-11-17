// @vitest-environment jsdom
// T0D-13 / AC-0D-8.5 + 04-UI-UX §2.3 (DatePicker, DateTimePicker, DateRangePicker, DateText) — "B.S. picker golden subset".
// ORACLE: packages/test-fixtures/bsdate/golden-2000-2099.json only (04-UI-UX §2.3: tests never hard-code a conversion outside the golden table).
//   First-day rows give B.S. y-m-01 -> AD; the last day of a month is first-day + (days-1) AD days (plain A.D. arithmetic); `probes` give random ad<->bs pairs.
// ASSUMED (spec gives behaviour, not DOM/props): each component lives in components/<Name>/<Name>.tsx; manual entry is a real text input (role textbox)
//   named by `label` (DateTimePicker: ONE textbox, 'DD/MM/YYYY hh:mm A'; DateRangePicker: a role=group named by `label` holding two textboxes, from then to);
//   a button named /calendar/i opens a popover with role=grid; the field is committed on blur or Enter; A.D. hint text is rendered in the document (not in the input);
//   the picker reads "today" from Date.now() in the tenant timezone Asia/Kathmandu (CV §4.8). The B.S. wrapper `@lims/shared-ts/bsdate` is the writer's to wire (not imported here).
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url'; // jsdom replaces the global URL
import { useState } from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DatePicker } from '../DatePicker/DatePicker';
import { DateTimePicker } from '../DateTimePicker/DateTimePicker';
import { DateRangePicker } from '../DateRangePicker/DateRangePicker';
import { DateText } from '../DateText/DateText';
import { seriousViolations, user } from './helpers';

type Month = { bs_year: number; bs_month: number; days: number; ad_first_day: string };
const golden = JSON.parse(readFileSync(fileURLToPath(new NodeURL('../../../../test-fixtures/bsdate/golden-2000-2099.json', import.meta.url)), 'utf8')) as {
  months: Month[];
  probes: { ad: string; bs: string }[];
};
const month = (y: number, m: number): Month => golden.months.find((r) => r.bs_year === y && r.bs_month === m)!;
const p2 = (n: number) => String(n).padStart(2, '0');
const addDays = (ad: string, n: number) => new Date(Date.parse(`${ad}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dmy = (ad: string) => `${ad.slice(8, 10)}/${ad.slice(5, 7)}/${ad.slice(0, 4)}`;
const bsIso = (y: number, m: number, d: number) => `${y}-${p2(m)}-${p2(d)}`;
const flat = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

// golden subset: first and last day of boundary months + every 20th random probe
const MONTHS: [number, number][] = [[2000, 1], [2000, 2], [2043, 6], [2060, 3], [2082, 3], [2082, 4], [2082, 12], [2099, 12]];
const MONTH_CASES = MONTHS.flatMap(([y, m]) => {
  const r = month(y, m);
  return [
    { id: `${y}-${p2(m)} first`, bs: bsIso(y, m, 1), ad: r.ad_first_day },
    { id: `${y}-${p2(m)} last (${r.days})`, bs: bsIso(y, m, r.days), ad: addDays(r.ad_first_day, r.days - 1) },
  ];
});
const PROBE_CASES = golden.probes.filter((_, i) => i % 20 === 0).map((p) => ({ id: `probe ${p.bs}`, bs: p.bs, ad: p.ad }));
const CASES = [...MONTH_CASES, ...PROBE_CASES];

const NOW = '2025-07-20T06:00:00Z'; // Kathmandu 2025-07-20 11:45
afterEach(() => vi.useRealTimers());

function Pick(props: Partial<React.ComponentProps<typeof DatePicker>> & { initial?: string; spy?: (v: string | undefined) => void }) {
  const { initial, spy, ...rest } = props;
  const [v, setV] = useState<string | undefined>(initial);
  return <DatePicker label="Collected on" name="collected_on" value={v as any} onChange={(x) => { setV(x); spy?.(x); }} {...(rest as any)} />;
}
const field = () => screen.getByRole('textbox', { name: /collected on/i }) as HTMLInputElement;
async function typeInto(input: HTMLInputElement, text: string, how: 'blur' | 'enter' = 'blur') {
  const u = user();
  await u.clear(input);
  await u.type(input, how === 'enter' ? `${text}{Enter}` : text);
  if (how === 'blur') await u.tab();
}
const lastCall = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0];

describe('DateText (04-UI-UX §2.3 display rules)', () => {
  const ad = '2025-04-14'; // = B.S. 2082-01-01 per golden month (2082,1)
  const bs = month(2082, 1);
  it('golden fixture sanity: (2082,1) starts on 2025-04-14', () => expect(bs.ad_first_day).toBe(ad));

  it('AD -> DD/MM/YYYY', () => {
    const { container } = render(<DateText value={ad as any} mode="AD" />);
    expect(flat(container)).toBe('14/04/2025');
  });
  it('BS -> YYYY-MM-DD B.S.', () => {
    const { container } = render(<DateText value={ad as any} mode="BS" />);
    expect(flat(container)).toBe('2082-01-01 B.S.');
  });
  it('AD_BS -> DD/MM/YYYY (YYYY-MM-DD B.S.)', () => {
    const { container } = render(<DateText value={ad as any} mode="AD_BS" />);
    expect(flat(container)).toBe('14/04/2025 (2082-01-01 B.S.)');
  });
  it('BS_AD -> the reverse: YYYY-MM-DD B.S. (DD/MM/YYYY)', () => {
    const { container } = render(<DateText value={ad as any} mode="BS_AD" />);
    expect(flat(container)).toBe('2082-01-01 B.S. (14/04/2025)');
  });

  it.each(CASES)('golden $id: AD_BS shows the library/golden B.S. date', ({ ad, bs }) => {
    const { container } = render(<DateText value={ad as any} mode="AD_BS" />);
    expect(flat(container)).toBe(`${dmy(ad)} (${bs} B.S.)`);
  });

  it('IsoUtc + withTime (AD): DD/MM/YYYY hh:mm A in Asia/Kathmandu (06:15Z = 12:00 PM NPT)', () => {
    const { container } = render(<DateText value={'2025-04-14T06:15:00Z' as any} mode="AD" withTime />);
    expect(flat(container)).toBe('14/04/2025 12:00 PM');
  });
  it('IsoUtc day boundary: 2025-04-13T20:00Z is already 14/04/2025 (01:45 AM) in Kathmandu, B.S. 2082-01-01', () => {
    const a = render(<DateText value={'2025-04-13T20:00:00Z' as any} mode="AD" withTime />);
    expect(flat(a.container)).toBe('14/04/2025 01:45 AM');
    a.unmount();
    const b = render(<DateText value={'2025-04-13T20:00:00Z' as any} mode="BS" />);
    expect(flat(b.container)).toContain('2082-01-01 B.S.');
  });
  it('output is plain text (no injected elements)', () => {
    const { container } = render(<DateText value={ad as any} mode="AD_BS" />);
    expect(container.querySelector('script,img,iframe')).toBeNull();
  });
});

describe('DatePicker calendar="BS": value is A.D., display is B.S. (AC-0D-8.5)', () => {
  it('AC-0D-8.5: user enters a B.S. date -> onChange gets the A.D. IsoDate; field shows "YYYY-MM-DD B.S." and the A.D. hint', async () => {
    const spy = vi.fn();
    render(<Pick calendar="BS" spy={spy} />);
    await typeInto(field(), '2082-04-01');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('2025-07-17');
    expect(field().value).toBe('2082-04-01 B.S.');
    expect(screen.getAllByText(/17\/07\/2025/).length).toBeGreaterThan(0); // A.D. hint under the field
  });

  it('Enter commits as well as blur', async () => {
    const spy = vi.fn();
    render(<Pick calendar="BS" spy={spy} />);
    await typeInto(field(), '2082-04-01', 'enter');
    expect(lastCall(spy)).toBe('2025-07-17');
  });

  it('AC-0D-8.5 via the calendar grid: header "2082 Shrawan" + A.D. range; arrows + Enter pick a day; onChange gets A.D.', async () => {
    const spy = vi.fn();
    render(<Pick calendar="BS" initial="2025-07-17" spy={spy} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /calendar/i }));
    const grid = screen.getByRole('grid');
    const dialog = grid.closest('[role=dialog]') ?? document.body;
    expect(within(dialog as HTMLElement).getByText(/2082\s+Shrawan/)).toBeTruthy();
    const dlg = flat(dialog as HTMLElement);
    expect(dlg).toContain('17/07/2025'); // A.D. range start (golden (2082,4).ad_first_day)
    expect(dlg).toContain('16/08/2025'); // ... and end (+30 days, 31-day month)
    expect(grid.contains(document.activeElement)).toBe(true);
    await u.keyboard('{ArrowRight}{ArrowRight}{Enter}');
    expect(lastCall(spy)).toBe('2025-07-19'); // B.S. 2082-04-03
    expect(field().value).toBe('2082-04-03 B.S.');
    expect(screen.queryByRole('grid')).toBeNull(); // closes after picking
  });

  it('the grid has exactly daysInBsMonth cells (golden: Shrawan 2082 = 31)', async () => {
    render(<Pick calendar="BS" initial="2025-07-17" />);
    await user().click(screen.getByRole('button', { name: /calendar/i }));
    const grid = screen.getByRole('grid');
    expect(within(grid).getAllByRole('gridcell').filter((c) => c.getAttribute('aria-disabled') !== 'true' && !c.hasAttribute('data-outside-month')).length).toBe(month(2082, 4).days);
  });

  it('PageDown/PageUp move one B.S. month, Shift+PageDown one B.S. year (golden first-days)', async () => {
    const spy = vi.fn();
    render(<Pick calendar="BS" initial="2025-07-17" spy={spy} />);
    const u = user();
    const open = async () => u.click(screen.getByRole('button', { name: /calendar/i }));
    await open();
    await u.keyboard('{PageDown}{Enter}');
    expect(lastCall(spy)).toBe(month(2082, 5).ad_first_day);
    await typeInto(field(), '2082-04-01');
    await open();
    await u.keyboard('{PageUp}{Enter}');
    expect(lastCall(spy)).toBe(month(2082, 3).ad_first_day);
    await typeInto(field(), '2082-04-01');
    await open();
    await u.keyboard('{Shift>}{PageDown}{/Shift}{Enter}');
    expect(lastCall(spy)).toBe(month(2083, 4).ad_first_day);
  });

  it('Esc closes the grid without changing the value', async () => {
    const spy = vi.fn();
    render(<Pick calendar="BS" initial="2025-07-17" spy={spy} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /calendar/i }));
    await u.keyboard('{ArrowRight}{Escape}');
    expect(screen.queryByRole('grid')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(field().value).toBe('2082-04-01 B.S.');
  });

  it('"C" toggles the grid between B.S. and A.D., and back', async () => {
    render(<Pick calendar="BS" initial="2025-07-17" />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /calendar/i }));
    const text = () => flat(screen.getByRole('grid').closest('[role=dialog]') ?? document.body);
    expect(text()).toMatch(/Shrawan/);
    await u.keyboard('c');
    expect(text()).not.toMatch(/Shrawan/);
    expect(text()).toMatch(/2025/);
    await u.keyboard('c');
    expect(text()).toMatch(/Shrawan/);
  });

  it('"T" jumps to today (tenant date, Asia/Kathmandu) and Enter selects it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
    const spy = vi.fn();
    render(<Pick calendar="BS" initial="2025-01-01" spy={spy} />);
    const u = user();
    await u.click(screen.getByRole('button', { name: /calendar/i }));
    await u.keyboard('t{Enter}');
    expect(lastCall(spy)).toBe('2025-07-20');
  });

  it('showAlternate={false} hides the A.D. hint; default shows it', () => {
    const a = render(<Pick calendar="BS" initial="2025-07-17" />);
    expect(screen.getAllByText(/17\/07\/2025/).length).toBeGreaterThan(0);
    a.unmount();
    render(<Pick calendar="BS" initial="2025-07-17" showAlternate={false} />);
    expect(screen.queryByText(/17\/07\/2025/)).toBeNull();
  });
});

describe('DatePicker calendar="AD" (04-UI-UX §2.3)', () => {
  it('manual DD/MM/YYYY -> IsoDate; field shows DD/MM/YYYY; B.S. hint "YYYY-MM-DD B.S." shown', async () => {
    const spy = vi.fn();
    render(<Pick calendar="AD" spy={spy} />);
    await typeInto(field(), '17/07/2025');
    expect(spy).toHaveBeenCalledWith('2025-07-17');
    expect(field().value).toBe('17/07/2025');
    expect(screen.getAllByText(/2082-04-01 B\.S\./).length).toBeGreaterThan(0);
  });

  it('allowManualEntry={false}: the text input is read-only (picking only through the calendar)', () => {
    render(<Pick calendar="AD" initial="2025-07-17" allowManualEntry={false} />);
    expect(field().readOnly).toBe(true);
  });

  it('FieldBase: label, name, required, disabled, readOnly are honoured', () => {
    const { rerender } = render(<DatePicker label="Collected on" name="collected_on" isRequired calendar="AD" />);
    expect(field().name).toBe('collected_on');
    expect(field().required || field().getAttribute('aria-required') === 'true').toBe(true);
    rerender(<DatePicker label="Collected on" name="collected_on" isDisabled calendar="AD" />);
    expect(field().disabled).toBe(true);
    rerender(<DatePicker label="Collected on" name="collected_on" isReadOnly calendar="AD" />);
    expect(field().readOnly).toBe(true);
  });

  it('error prop is text linked by aria-describedby', () => {
    render(<DatePicker label="Collected on" name="collected_on" calendar="AD" error="Choose the collection date" />);
    expect(field().getAttribute('aria-invalid')).toBe('true');
    const d = (field().getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(d).toContain('Choose the collection date');
  });
});

describe('DatePicker invalid / out-of-range / min-max (ui.validation.date_invalid, date_out_of_range)', () => {
  it.each([
    ['A.D. not a date', 'AD', 'abc'],
    ['A.D. 31/02', 'AD', '31/02/2025'],
    ['A.D. wrong format (ISO typed into DD/MM/YYYY)', 'AD', '2025-07-17'],
    ['B.S. month 13', 'BS', '2082-13-01'],
    ['B.S. day 33', 'BS', '2082-04-33'],
    ['B.S. day beyond month length (Shrawan 2082 has 31)', 'BS', '2082-04-32'],
  ] as const)('%s -> "Enter a date like …", no onChange value, aria-invalid', async (_n, cal, text) => {
    const spy = vi.fn();
    render(<Pick calendar={cal} spy={spy} />);
    await typeInto(field(), text);
    expect(screen.getByText(/Enter a date like/)).toBeTruthy();
    expect(field().getAttribute('aria-invalid')).toBe('true');
    for (const c of spy.mock.calls) expect(c[0]).toBeUndefined();
  });

  it.each([['1974-12-30'], ['2100-01-01']])('B.S. %s is outside 1975–2099 -> "Dates must be between …", no value', async (text) => {
    const spy = vi.fn();
    render(<Pick calendar="BS" spy={spy} />);
    await typeInto(field(), text);
    expect(screen.getByText(/Dates must be between/)).toBeTruthy();
    for (const c of spy.mock.calls) expect(c[0]).toBeUndefined();
  });

  it('B.S. upper range edge is accepted: 2099-12-30 (last golden day)', async () => {
    const spy = vi.fn();
    render(<Pick calendar="BS" spy={spy} />);
    await typeInto(field(), '2099-12-30');
    expect(lastCall(spy)).toBe(addDays(month(2099, 12).ad_first_day, 29));
  });

  it('clearing the text reports undefined', async () => {
    const spy = vi.fn();
    render(<Pick calendar="AD" initial="2025-07-17" spy={spy} />);
    await user().clear(field());
    await user().tab();
    expect(lastCall(spy)).toBeUndefined();
  });

  it('min/max: an A.D. value outside the bounds is not emitted and the field is marked invalid', async () => {
    const spy = vi.fn();
    render(<Pick calendar="AD" min={'2025-07-17' as any} max={'2025-08-17' as any} spy={spy} />);
    await typeInto(field(), '10/07/2025');
    expect(spy).not.toHaveBeenCalledWith('2025-07-10');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    await typeInto(field(), '17/07/2025');
    expect(lastCall(spy)).toBe('2025-07-17'); // bound itself is inclusive
  });
});

describe('B.S. golden subset through the picker (AC-0D-8.5, CV §12 gate 15 spirit)', () => {
  it.each(CASES)('golden $id: typing B.S. $bs gives A.D. $ad and shows "$bs B.S."', async ({ bs, ad }) => {
    const spy = vi.fn();
    render(<Pick calendar="BS" spy={spy} />);
    await typeInto(field(), bs);
    expect(lastCall(spy)).toBe(ad);
    expect(field().value).toBe(`${bs} B.S.`);
  });

  it.each(CASES)('golden $id: typing A.D. $ad shows B.S. hint "$bs B.S."', async ({ bs, ad }) => {
    const spy = vi.fn();
    render(<Pick calendar="AD" spy={spy} />);
    await typeInto(field(), dmy(ad));
    expect(lastCall(spy)).toBe(ad);
    expect(screen.getAllByText(new RegExp(`${bs} B\\.S\\.`)).length).toBeGreaterThan(0);
  });
});

describe('DateTimePicker (value is IsoUtc, default timezone Asia/Kathmandu)', () => {
  const Dt = (p: Partial<React.ComponentProps<typeof DateTimePicker>> & { initial?: string; spy?: (v: string | undefined) => void }) => {
    const { initial, spy, ...rest } = p;
    const [v, setV] = useState<string | undefined>(initial);
    return <DateTimePicker label="Received at" name="received_at" value={v as any} onChange={(x) => { setV(x); spy?.(x); }} {...(rest as any)} />;
  };
  const box = () => screen.getByRole('textbox', { name: /received at/i }) as HTMLInputElement;
  const iso = (spy: ReturnType<typeof vi.fn>) => new Date(lastCall(spy)).toISOString();

  it('shows an IsoUtc value as DD/MM/YYYY hh:mm A in the tenant timezone', () => {
    render(<Dt calendar="AD" initial="2025-04-14T06:15:00Z" />);
    expect(box().value).toBe('14/04/2025 12:00 PM');
  });
  it('typed local time is converted to UTC (12:00 PM NPT -> 06:15Z)', async () => {
    const spy = vi.fn();
    render(<Dt calendar="AD" spy={spy} />);
    await typeInto(box(), '14/04/2025 12:00 PM');
    expect(iso(spy)).toBe('2025-04-14T06:15:00.000Z');
  });
  it('explicit timezone prop wins (UTC: 06:15 AM = 06:15Z)', async () => {
    const spy = vi.fn();
    render(<Dt calendar="AD" timezone="UTC" spy={spy} />);
    await typeInto(box(), '14/04/2025 06:15 AM');
    expect(iso(spy)).toBe('2025-04-14T06:15:00.000Z');
  });
  it('calendar="BS": B.S. date + time typed -> UTC instant; display carries "B.S."', async () => {
    const spy = vi.fn();
    render(<Dt calendar="BS" spy={spy} />);
    await typeInto(box(), '2082-01-01 12:00 PM');
    expect(iso(spy)).toBe('2025-04-14T06:15:00.000Z');
    expect(box().value).toContain('2082-01-01');
    expect(box().value).toContain('B.S.');
  });
  it('invalid text -> "Enter a date like …", no value', async () => {
    const spy = vi.fn();
    render(<Dt calendar="AD" spy={spy} />);
    await typeInto(box(), '99/99/2025 25:61 PM');
    expect(screen.getByText(/Enter a date like/)).toBeTruthy();
    for (const c of spy.mock.calls) expect(c[0]).toBeUndefined();
  });
});

describe('DateRangePicker (value {from,to} A.D. IsoDate)', () => {
  const Rg = (p: Partial<React.ComponentProps<typeof DateRangePicker>> & { spy?: (v: any) => void }) => {
    const { spy, ...rest } = p;
    const [v, setV] = useState<any>(undefined);
    return <DateRangePicker label="Period" name="period" value={v} onChange={(x) => { setV(x); spy?.(x); }} {...(rest as any)} />;
  };
  const boxes = () => within(screen.getByRole('group', { name: /period/i })).getAllByRole('textbox') as HTMLInputElement[];

  it('two B.S. entries -> onChange({from,to}) in A.D.', async () => {
    const spy = vi.fn();
    render(<Rg calendar="BS" spy={spy} />);
    const [from, to] = boxes();
    await typeInto(from!, '2082-04-01');
    await typeInto(to!, '2082-04-31');
    expect(lastCall(spy)).toEqual({ from: '2025-07-17', to: '2025-08-16' });
  });
  it('to before from -> no range emitted, marked invalid', async () => {
    const spy = vi.fn();
    render(<Rg calendar="AD" spy={spy} />);
    const [from, to] = boxes();
    await typeInto(from!, '20/07/2025');
    await typeInto(to!, '10/07/2025');
    for (const c of spy.mock.calls) expect(c[0]).toBeUndefined();
    expect(boxes().some((b) => b.getAttribute('aria-invalid') === 'true')).toBe(true);
  });
  it('maxDays: a longer span is not emitted', async () => {
    const spy = vi.fn();
    render(<Rg calendar="AD" maxDays={10} spy={spy} />);
    const [from, to] = boxes();
    await typeInto(from!, '01/07/2025');
    await typeInto(to!, '30/07/2025');
    for (const c of spy.mock.calls) expect(c[0]).toBeUndefined();
    await typeInto(to!, '10/07/2025');
    expect(lastCall(spy)).toEqual({ from: '2025-07-01', to: '2025-07-10' });
  });
});

describe('axe over the date components (AC-0D-8.6)', () => {
  it('closed and with the calendar open: no critical/serious violation', async () => {
    const a = render(<Pick calendar="BS" initial="2025-07-17" />);
    expect(await seriousViolations()).toEqual([]);
    await user().click(screen.getByRole('button', { name: /calendar/i }));
    expect(await seriousViolations()).toEqual([]);
    a.unmount();
    render(<>
      <DateText value={'2025-04-14' as any} mode="AD_BS" />
      <DateTimePicker label="Received at" name="r" calendar="AD" />
      <DateRangePicker label="Period" name="p" calendar="AD" />
    </>);
    expect(await seriousViolations()).toEqual([]);
  });
});
