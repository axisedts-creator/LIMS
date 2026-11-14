'use client';
// Registration shortcuts (04-UI-UX §3.5). One document-level keydown listener; handlers are read through a ref so they are always current.
// Reserved browser keys (04-UI-UX §1) are never matched, so they are never prevented.
import { useEffect, useRef } from 'react';

export type ShortcutMap = Record<string, () => void>;

/** Canonical id of a key event: "F2", "Alt+N", "Ctrl+Enter", "Ctrl+Shift+N", "?". */
export function shortcutId(e: KeyboardEvent): string | null {
  const k = e.key;
  if (/^F\d{1,2}$/.test(k)) return e.ctrlKey || e.altKey || e.metaKey ? null : k;
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey) {
    if (k === 'Enter' && !e.shiftKey) return 'Ctrl+Enter';
    if (e.shiftKey && k.toLowerCase() === 'n') return 'Ctrl+Shift+N';
    return null;
  }
  if (e.altKey && !e.ctrlKey && !e.shiftKey && k.length === 1) return `Alt+${k.toUpperCase()}`;
  if (k === '?' && !e.altKey && !e.ctrlKey) return '?';
  return null;
}

export const isTextTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export function useShortcuts(map: ShortcutMap): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const id = shortcutId(e);
      const fn = id ? ref.current[id] : undefined;
      if (!fn) return;
      if (id === '?' && isTextTarget(e.target)) return; // "?" typed into a field is text
      e.preventDefault();
      fn();
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, []);
}
