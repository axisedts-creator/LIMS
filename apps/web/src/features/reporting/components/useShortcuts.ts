'use client';
// Registers page shortcuts (04-UI-UX §1.1) in the shared registry AND binds one document keydown listener that dispatches them.
// Skipped while an IME composition is active (C0 §4); "/" never fires while typing in a field.
import { useEffect, useRef } from 'react';
import { shortcuts, type Shortcut } from '@/core/shortcuts/registry';

const editable = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
function matches(key: string, e: KeyboardEvent): boolean {
  const parts = key.toLowerCase().split('+');
  const k = parts.pop()!;
  if (parts.includes('alt') !== e.altKey || parts.includes('ctrl') !== (e.ctrlKey || e.metaKey)) return false;
  if (k === '/' && editable(e.target)) return false;
  return e.key.toLowerCase() === k || e.code.toLowerCase() === `digit${k}` || e.code.toLowerCase() === `key${k}`;
}

export function useShortcuts(pageId: string, list: readonly Shortcut[], deps: readonly unknown[]) {
  const ref = useRef(list);
  ref.current = list;
  useEffect(() => {
    if (list.length === 0) return;
    const off = shortcuts.register(pageId, ...list);
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return;
      const hit = ref.current.find((s) => matches(s.key, e));
      if (hit) { e.preventDefault(); hit.run(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { off(); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, ...deps]);
}
