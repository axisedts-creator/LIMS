// @vitest-environment jsdom
// C16.T-B6 / LD-146 — WeekdayTimeRangeEditor (CR-C16-016, 04-UI-UX §9.2): render, keyboard, axe, and source rules.
// Props: { value: { weekdays: number[]; start: string; end: string }; onChange(next: whole value); minuteStep?: 5 | 15 (default 15) }.
// weekdays = ISO numbers 1 (Mon) … 7 (Sun); start/end = 'HH:MM'. The editor does NOT validate (the T-B6 form owns the rules).
// ASSUMED DOM (spec silent): seven toggle chips (role button with aria-pressed, or checkbox) named by their visible Mon…Sun label; selected state is NOT
//   colour-only (selected chip carries an Icon <svg>, unselected none); two <input type="time"> labelled Start / End with step = minuteStep × 60.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { WeekdayTimeRangeEditor } from '../WeekdayTimeRangeEditor/WeekdayTimeRangeEditor';
import { seriousViolations, user } from './helpers';

type V = { weekdays: number[]; start: string; end: string };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WORK: V = { weekdays: [1, 2, 3, 4, 5], start: '07:00', end: '11:00' };
const chips = () => DAYS.map((d) => [...screen.queryAllByRole('button'), ...screen.queryAllByRole('checkbox')].find((e) => new RegExp(`^${d}`, 'i').test((e.textContent ?? '').trim() || e.getAttribute('aria-label') || ''))!);
const isOn = (e: Element) => e.getAttribute('aria-pressed') === 'true' || e.getAttribute('aria-checked') === 'true' || (e as HTMLInputElement).checked === true;
const start = () => screen.getByLabelText(/start/i) as HTMLInputElement;
const end = () => screen.getByLabelText(/end/i) as HTMLInputElement;
const src = (rel: string) => fileURLToPath(new NodeURL(`../${rel}`, import.meta.url));
const Host = ({ initial = WORK, spy, ...rest }: { initial?: V; spy?: (v: V) => void; minuteStep?: 5 | 15 }) => {
  const [v, setV] = useState(initial);
  return <WeekdayTimeRangeEditor value={v} onChange={(n) => { setV(n); spy?.(n); }} {...rest} />;
};

describe('render', () => {
  it('seven chips Mon…Sun with visible labels; selected = the value weekdays', () => {
    render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    expect(chips().map((c) => (c.textContent ?? '').trim()).map((t) => t.slice(0, 3))).toEqual(DAYS);
    expect(chips().map(isOn)).toEqual([true, true, true, true, true, false, false]);
  });

  it('selected state is not colour-only: selected chips carry an icon, unselected do not', () => {
    render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    const [mon, , , , , sat] = chips();
    expect(mon!.querySelector('svg')).not.toBeNull();
    expect(sat!.querySelector('svg')).toBeNull();
  });

  it('two time inputs show start and end as HH:MM', () => {
    render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    expect(start().type).toBe('time');
    expect(end().type).toBe('time');
    expect([start().value, end().value]).toEqual(['07:00', '11:00']);
  });

  it('minuteStep defaults to 15 (step 900 s) and 5 gives step 300 s', () => {
    const { unmount } = render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    expect([start().step, end().step]).toEqual(['900', '900']);
    unmount();
    render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} minuteStep={5} />);
    expect([start().step, end().step]).toEqual(['300', '300']);
  });

  it('controlled: rendering a new value updates chips and times', () => {
    const { rerender } = render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    rerender(<WeekdayTimeRangeEditor value={{ weekdays: [6, 7], start: '06:30', end: '09:45' }} onChange={() => {}} />);
    expect(chips().map(isOn)).toEqual([false, false, false, false, false, true, true]);
    expect([start().value, end().value]).toEqual(['06:30', '09:45']);
  });
});

describe('onChange (whole new value, ISO weekdays ascending, input not mutated)', () => {
  it('selecting Sat → weekdays [1,2,3,4,5,6], start/end unchanged', async () => {
    const spy = vi.fn();
    render(<WeekdayTimeRangeEditor value={WORK} onChange={spy} />);
    await user().click(chips()[5]!);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ weekdays: [1, 2, 3, 4, 5, 6], start: '07:00', end: '11:00' });
  });

  it('deselecting Mon → [2,3,4,5]; selecting Sun then Sat keeps ascending order', async () => {
    const spy = vi.fn();
    render(<Host spy={spy} />);
    const u = user();
    await u.click(chips()[0]!);
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [2, 3, 4, 5], start: '07:00', end: '11:00' });
    await u.click(chips()[6]!);
    await u.click(chips()[5]!);
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [2, 3, 4, 5, 6, 7], start: '07:00', end: '11:00' });
  });

  it('does not mutate the value it was given', async () => {
    const v: V = { weekdays: [1, 2], start: '07:00', end: '11:00' };
    const copy = JSON.stringify(v);
    render(<WeekdayTimeRangeEditor value={v} onChange={() => {}} />);
    await user().click(chips()[4]!);
    expect(JSON.stringify(v)).toBe(copy);
  });

  it('changing the start / end time → onChange with the new HH:MM and the same weekdays', () => {
    const spy = vi.fn();
    render(<WeekdayTimeRangeEditor value={WORK} onChange={spy} />);
    fireEvent.change(start(), { target: { value: '08:30' } });
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [1, 2, 3, 4, 5], start: '08:30', end: '11:00' });
    fireEvent.change(end(), { target: { value: '12:15' } });
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [1, 2, 3, 4, 5], start: '07:00', end: '12:15' });
  });

  it('does not validate: no weekday, or end before start, is emitted as typed and no error text appears', async () => {
    const spy = vi.fn();
    render(<Host initial={{ weekdays: [1], start: '07:00', end: '11:00' }} spy={spy} />);
    await user().click(chips()[0]!);
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [], start: '07:00', end: '11:00' });
    fireEvent.change(end(), { target: { value: '06:00' } });
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [], start: '07:00', end: '06:00' });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/invalid|required|must|at least/i);
  });
});

describe('keyboard', () => {
  it('Tab reaches the first chip; Space and Enter toggle the focused chip', async () => {
    const spy = vi.fn();
    render(<Host initial={{ weekdays: [], start: '07:00', end: '11:00' }} spy={spy} />);
    const u = user();
    await u.tab();
    expect(document.activeElement).toBe(chips()[0]);
    await u.keyboard(' ');
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [1], start: '07:00', end: '11:00' });
    await u.keyboard('{Enter}');
    expect(spy).toHaveBeenLastCalledWith({ weekdays: [], start: '07:00', end: '11:00' });
  });

  it('every chip and both time inputs are in the tab order, chips first (Mon → Sun → Start → End)', async () => {
    render(<Host />);
    const u = user();
    const order: Element[] = [];
    for (let i = 0; i < 9; i++) { await u.tab(); order.push(document.activeElement!); }
    expect(order).toEqual([...chips(), start(), end()]);
  });
});

describe('accessibility and kit rules', () => {
  it('axe: no serious/critical violations (with a selection, and empty)', async () => {
    const { unmount } = render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    expect(await seriousViolations()).toEqual([]);
    unmount();
    render(<WeekdayTimeRangeEditor value={{ weekdays: [], start: '07:00', end: '11:00' }} onChange={() => {}} />);
    expect(await seriousViolations()).toEqual([]);
  });

  it('chips and time inputs have accessible names', () => {
    render(<WeekdayTimeRangeEditor value={WORK} onChange={() => {}} />);
    for (const c of chips()) expect((c.textContent ?? '').trim() || c.getAttribute('aria-label')).toBeTruthy();
    expect(within(document.body).getAllByLabelText(/start|end/i)).toHaveLength(2);
  });

  it('LD-140: kit tokens only — no hex colour, inline style object, or pixel radius in the component source', () => {
    const f = src('WeekdayTimeRangeEditor/WeekdayTimeRangeEditor.tsx');
    expect(existsSync(f)).toBe(true);
    const s = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-]*\()/);
    expect(s).not.toMatch(/\bstyle=\{\{/);
    expect(s).not.toMatch(/border-?[rR]adius\s*:\s*['"`]?\d+px/);
  });

  it('ships a story file (LD-146) that imports the component', () => {
    const f = src('WeekdayTimeRangeEditor/WeekdayTimeRangeEditor.stories.tsx');
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/WeekdayTimeRangeEditor/);
  });
});
