'use client';
// 04-UI-UX §3.7 (and §3.2 A: "↑/↓ moves, Enter selects"): with the result list open and no option active yet, Enter picks the FIRST result, so the
// keyboard script needs no arrow key. The kit Combobox (react-aria) activates no option until ↓, so Enter would just close the list.
// ponytail: workaround on the page side; drop it once the kit Combobox makes the first option active (CR FD-T13-combobox-first-option).
import type { KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';

export function enterPicksFirst(e: KeyboardEvent<HTMLElement>): void {
  const input = e.target as HTMLElement;
  if (e.key !== 'Enter' || input.tagName !== 'INPUT' || input.getAttribute('aria-expanded') !== 'true' || input.getAttribute('aria-activedescendant')) return;
  const list = input.getAttribute('aria-controls');
  if (!list || !document.getElementById(list)?.querySelector('[role="option"]')) return; // nothing to pick: Enter keeps its normal meaning
  e.preventDefault();
  e.stopPropagation();
  const press = (key: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  flushSync(() => press('ArrowDown')); // activates the first option; flushed so the Enter below sees it
  press('Enter');
}
