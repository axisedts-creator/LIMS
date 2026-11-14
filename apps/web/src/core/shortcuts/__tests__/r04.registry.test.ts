// T0D-UI-R04: Ctrl+K is a shell-owned global key (04-UI-UX §4; 10-DESIGN-SYSTEM §3 "Ctrl+K anywhere"), so a page can never bind it (AC-0D-7.5).
import { describe, expect, it } from 'vitest';
import { GLOBAL_KEYS, createShortcutRegistry } from '../registry.ts';

describe('shortcut registry knows Ctrl+K', () => {
  it('Ctrl+K is a global key and the existing ones are unchanged', () => {
    expect(GLOBAL_KEYS).toContain('Ctrl+K');
    for (const k of ['?', 'Alt+N', 'Alt+M', 'Alt+H', 'Escape']) expect(GLOBAL_KEYS).toContain(k);
  });
  it.each(['Ctrl+K', 'ctrl+k', 'CTRL+K', 'Ctrl+k'])('a page cannot register %s (clash with a global key)', (key) => {
    const r = createShortcutRegistry();
    expect(() => r.register('p', { key, description: 'x', run: () => {} })).toThrow(/global key/);
  });
  it('Cmd+K / Meta+K also clash (same chord on macOS)', () => {
    const r = createShortcutRegistry();
    for (const key of ['Meta+K', 'meta+k', 'Cmd+K']) expect(() => r.register('p', { key, description: 'x', run: () => {} })).toThrow(/global key/);
  });
  it('other Ctrl/Alt letters stay available to pages and still detect duplicates', () => {
    const r = createShortcutRegistry();
    expect(() => r.register('p', { key: 'Alt+K', description: 'x', run: () => {} })).not.toThrow();
    expect(() => r.register('p', { key: 'alt+k', description: 'y', run: () => {} })).toThrow(/duplicate/);
  });
});
