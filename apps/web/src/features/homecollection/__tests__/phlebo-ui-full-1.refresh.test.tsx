// @vitest-environment jsdom
// PHLEBO-UI-FULL-1: the home-collection screens refresh every 30 s while visible, and not while hidden or paused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { BOARD_REFRESH_MS, useBoardRefresh } from '../hooks/useBoardRefresh';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

describe('useBoardRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    visibility = 'visible';
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('refreshes once per 30 s while visible', () => {
    renderHook(() => useBoardRefresh());
    vi.advanceTimersByTime(BOARD_REFRESH_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(BOARD_REFRESH_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('does nothing while hidden and catches up when the tab is shown again', () => {
    visibility = 'hidden';
    renderHook(() => useBoardRefresh());
    vi.advanceTimersByTime(BOARD_REFRESH_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('pauses while a dialog is open and stops after unmount', () => {
    const view = renderHook(({ paused }) => useBoardRefresh(paused), { initialProps: { paused: true } });
    vi.advanceTimersByTime(BOARD_REFRESH_MS * 2);
    expect(refresh).not.toHaveBeenCalled();
    view.rerender({ paused: false });
    vi.advanceTimersByTime(BOARD_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.unmount();
    vi.advanceTimersByTime(BOARD_REFRESH_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
