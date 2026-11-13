// @vitest-environment jsdom
// T-Q5 / LD-145 / 04-UI-UX §9.2 + D1: QueueBoard render test. Synthetic tokens only.
// ASSUMED (spec gives no marker name): the isNew flash is a `data-new="true"` attribute or a class containing "flash" on the row.
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueBoard } from '../QueueBoard/QueueBoard';
import './helpers';

const row = (n: number, isNew = false) => ({ token: `A-${String(n).padStart(3, '0')}`, counter: `Counter ${n}`, queue: 'Blood', isNew });
const base = {
  title: 'Demo Lab',
  subtitle: 'Central',
  nowCalling: [row(12)],
  waiting: [{ queue: 'Blood', count: 7 }, { queue: 'X-ray', count: 2 }],
  serverTime: '2026-11-13T09:00:00Z',
  connection: 'live' as const,
  soundEnabled: false,
};
const flashed = (el: HTMLElement) =>
  !!el.closest('[data-new="true"]') || [...document.querySelectorAll('[class*="flash"]')].some((n) => n.contains(el));

let ctor: ReturnType<typeof vi.fn>;
function stubAudio() {
  ctor = vi.fn(() => ({
    createOscillator: () => ({ connect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {} }, type: '' }),
    createGain: () => ({ connect() {}, gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }),
    destination: {},
    currentTime: 0,
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }));
  (globalThis as any).AudioContext = ctor;
  (globalThis as any).webkitAudioContext = ctor;
}
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).AudioContext;
  delete (globalThis as any).webkitAudioContext;
});

describe('QueueBoard', () => {
  it('header shows title, subtitle; footer text is exact', () => {
    render(<QueueBoard {...base} />);
    expect(screen.getByText('Demo Lab')).toBeTruthy();
    expect(screen.getByText('Central')).toBeTruthy();
    expect(screen.getByText('Please keep your token slip')).toBeTruthy();
  });

  it('now calling: at most 5 rows even when given 8', () => {
    render(<QueueBoard {...base} nowCalling={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => row(n))} />);
    for (const n of [1, 2, 3, 4, 5]) expect(screen.getByText(`A-00${n}`)).toBeTruthy();
    for (const n of [6, 7, 8]) expect(screen.queryByText(`A-00${n}`)).toBeNull();
  });

  it('now calling row shows token and counter; waiting shows one row per queue with its count', () => {
    render(<QueueBoard {...base} />);
    expect(screen.getByText('A-012')).toBeTruthy();
    expect(screen.getByText(/Counter 12/)).toBeTruthy();
    const x = screen.getByText('X-ray').closest('li,tr,div') as HTMLElement;
    expect(x.textContent).toContain('2');
    const b = screen.getByText('Blood', { selector: 'li *, tr *, div *' });
    expect(b).toBeTruthy();
    expect(screen.getAllByText(/^7$/).length).toBeGreaterThan(0);
  });

  it('isNew row carries the flash marker and clears after 3 s; other rows do not', () => {
    vi.useFakeTimers();
    render(<QueueBoard {...base} nowCalling={[row(12, true), row(11)]} />);
    expect(flashed(screen.getByText('A-012'))).toBe(true);
    expect(flashed(screen.getByText('A-011'))).toBe(false);
    act(() => void vi.advanceTimersByTime(3100));
    expect(flashed(screen.getByText('A-012'))).toBe(false);
  });

  it('stale shows the last-update time derived from staleSince', () => {
    render(<QueueBoard {...base} connection="stale" staleSince="2026-11-13T09:05:00Z" />);
    const banner = screen.getByRole('status');
    // 09:05Z in Asia/Kathmandu (UTC+05:45) per 02-CONVENTIONS.md:438 / :1164 -> 02:50 PM
    expect(banner.textContent).toMatch(/\b(02:50\s?PM|14:50)\b/);
  });

  it('live shows no stale banner', () => {
    render(<QueueBoard {...base} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('unpaired reuses the page wording "Not paired"', () => {
    render(<QueueBoard {...base} connection="unpaired" nowCalling={[]} waiting={[]} />);
    expect(screen.getByText(/Not paired/)).toBeTruthy();
  });

  it('clock starts from serverTime and advances every second', () => {
    vi.useFakeTimers();
    const { container } = render(<QueueBoard {...base} />);
    const before = container.textContent;
    act(() => void vi.advanceTimersByTime(2000));
    expect(container.textContent).not.toBe(before);
  });

  it('soundEnabled=false: no AudioContext created, even when a new token arrives', () => {
    stubAudio();
    const { rerender } = render(<QueueBoard {...base} />);
    rerender(<QueueBoard {...base} nowCalling={[row(13, true), row(12)]} />);
    expect(ctor).not.toHaveBeenCalled();
  });

  it('soundEnabled=true: a new token plays a Web Audio tone (no audio file)', () => {
    stubAudio();
    const { rerender, container } = render(<QueueBoard {...base} soundEnabled />);
    rerender(<QueueBoard {...base} soundEnabled nowCalling={[row(13, true), row(12)]} />);
    expect(ctor).toHaveBeenCalled();
    expect(container.querySelector('audio')).toBeNull();
  });
});
