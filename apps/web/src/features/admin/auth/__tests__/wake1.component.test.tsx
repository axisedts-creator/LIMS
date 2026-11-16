// @vitest-environment jsdom
// T0D-WAKE-1 (LD-277, audit RS-07): the "server is waking up" state and the forms that show it.
// CONTRACT chosen by the tester (writer: follow it, or dispute in .orchestra/notes):
//   features/admin/auth/WakingState.tsx exports WakingState({ onRetry?: () => void | Promise<void> }):
//     div.lims-auth-card > h1 "The server is waking up", a line containing "This can take up to a minute after a quiet period", button "Retry".
//     Retry click calls onRetry. ONE automatic call of onRetry 15000 ms after mount, then never again (a re-render with a new onRetry does not restart the timer).
//     No onRetry given (the /auth/waking page, a server component) -> it calls useRouter().refresh() from next/navigation.
//     No raw colour in the file (tokens / packages/ui only). Inside AuthLayout it is axe clean.
//   LoginForm, MfaChallengeForm, SetPasswordForm: an action result { ok:false, waking:true, code } shows WakingState INSTEAD of the red unavailable banner;
//     the automatic retry (15 s) and the Retry button run the SAME submit again (the action is called again with the same values), once automatically; a retry
//     that succeeds removes the state; a failure WITHOUT waking shows the usual banner and never the waking state.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthLayout from '@/app/(auth)/layout';
import { LoginForm } from '../LoginForm';
import { MfaChallengeForm } from '../MfaChallengeForm';
import { SetPasswordForm } from '../SetPasswordForm';
import { WakingState } from '../WakingState';

const refresh = vi.fn();
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh }) }));
vi.mock('@/features/admin/auth/actions', () => ({ logoutAction: vi.fn(), loginStaffAction: vi.fn() }));

const HEADING = 'The server is waking up';
const LINE = /This can take up to a minute after a quiet period/;
const WAKING = { ok: false as const, code: 'common.dependency_unavailable', waking: true as const };
const OK = { ok: true as const };

beforeEach(() => refresh.mockReset());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (globalThis as { jest?: unknown }).jest;
});

describe('WakingState (presentation)', () => {
  it('shows the heading, the line and a Retry button', () => {
    render(<WakingState onRetry={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: HEADING })).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(document.querySelector('.lims-auth-card')).not.toBeNull();
  });

  it('retries once by itself after 15 seconds, then stops', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<WakingState onRetry={onRetry} />);
    await act(() => vi.advanceTimersByTimeAsync(14_999));
    expect(onRetry).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a re-render with a new onRetry neither restarts nor repeats the one automatic retry', async () => {
    vi.useFakeTimers();
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = render(<WakingState onRetry={a} />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    rerender(<WakingState onRetry={b} />);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
  });

  it('the Retry button calls onRetry on every click', () => {
    const onRetry = vi.fn();
    render(<WakingState onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('without onRetry it refreshes the router: on Retry and once automatically after 15 s', async () => {
    vi.useFakeTimers();
    render(<WakingState />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('inside the auth layout: axe has zero critical or serious violations', async () => {
    const { container } = render(<AuthLayout><main><WakingState onRetry={vi.fn()} /></main></AuthLayout>);
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 100)}`)).toEqual([]);
  });

  it('uses no raw colour (hex, rgb(), hsl(), named in a style prop) in the component source', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'WakingState.tsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });
});

// ------------------------------------------------------------------ the forms
const sequence = (...results: unknown[]) => {
  const fn = vi.fn();
  results.forEach((r, i) => fn.mockImplementationOnce(async () => (i === results.length - 1 ? r : r)));
  fn.mockImplementation(async () => results[results.length - 1]);
  return fn;
};
const sent = (fn: ReturnType<typeof vi.fn>, i: number) => Object.fromEntries((fn.mock.calls[i]![0] as FormData).entries());

interface Case {
  name: string;
  draw: (action: ReturnType<typeof vi.fn>) => void;
  submit: (u: ReturnType<typeof userEvent.setup>) => Promise<void>;
  values: Record<string, string>;
}
const CASES: Case[] = [
  {
    name: 'LoginForm',
    draw: (action) => void render(<LoginForm action={action} />),
    submit: async (u) => {
      await u.type(screen.getByLabelText(/^work email/i), 'user@example.test');
      await u.type(screen.getByLabelText('Password'), 'Correct-horse-1');
      await u.click(screen.getByRole('button', { name: 'Continue' }));
    },
    values: { email: 'user@example.test', password: 'Correct-horse-1' },
  },
  {
    name: 'MfaChallengeForm',
    draw: (action) => void render(<MfaChallengeForm action={action} logoutAction={vi.fn()} />),
    submit: async (u) => {
      await u.click(screen.getAllByRole('textbox')[0]!);
      await u.paste('123456');
      await u.click(screen.getByRole('button', { name: 'Verify' }));
    },
    values: { code: '123456' },
  },
  {
    name: 'SetPasswordForm',
    draw: (action) => void render(<SetPasswordForm action={action} variant="recovery" />),
    submit: async (u) => {
      await u.type(screen.getByLabelText('New password'), 'Correct-horse-battery-1');
      await u.type(screen.getByLabelText('Confirm password'), 'Correct-horse-battery-1');
      await u.click(screen.getByRole('button', { name: /set password/i }));
    },
    values: { new_password: 'Correct-horse-battery-1', confirm_password: 'Correct-horse-battery-1' },
  },
];

describe.each(CASES)('$name on no answer from the API', ({ draw, submit, values }) => {
  // fake only the timers the state uses; userEvent runs with delay:null so it never waits on a timer
  const setup = async (action: ReturnType<typeof vi.fn>) => {
    draw(action);
    const u = userEvent.setup({ delay: null });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // RTL's asyncWrapper only advances faked timers when a global `jest` exists (ruling T0D-WAKE-1)
    (globalThis as { jest?: unknown }).jest = { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) };
    await act(async () => { await submit(u); });
  };
  const settle = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('shows the waking state (not the unavailable banner), then retries exactly once by itself and stops', async () => {
    const action = sequence(WAKING);
    await setup(action);
    expect(screen.getByRole('heading', { name: HEADING })).toBeTruthy();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull();
    expect(action).toHaveBeenCalledTimes(1);
    await settle(14_999);
    expect(action).toHaveBeenCalledTimes(1);
    await settle(1);
    expect(action).toHaveBeenCalledTimes(2);
    expect(sent(action, 1)).toMatchObject(values); // the same values go again
    await settle(10 * 60_000); // the retry also got "waking": it stops, the state stays with its Retry button
    expect(action).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: HEADING })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('the Retry button submits again with the same values', async () => {
    const action = sequence(WAKING);
    await setup(action);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(action.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sent(action, 1)).toMatchObject(values);
  });

  it('a retry that succeeds removes the waking state', async () => {
    const action = sequence(WAKING, OK);
    await setup(action);
    await settle(15_000);
    expect(action).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
  });

  it('a failure WITHOUT waking shows the usual banner and never the waking state', async () => {
    const action = sequence({ ok: false, code: 'common.dependency_unavailable' });
    await setup(action);
    expect(screen.queryByRole('heading', { name: HEADING })).toBeNull();
    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy();
    await settle(60_000);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
