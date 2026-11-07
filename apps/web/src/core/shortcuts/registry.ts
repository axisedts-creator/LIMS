// Shortcut registry (04-UI-UX §4). Global keys are owned by the shell; page-level `Alt+<letter>` keys are registered
// per page. Duplicates within a page, or a clash with a global key, throw (AC-0D-7.5; the build check covers chords).
export const GLOBAL_KEYS = ['?', 'Alt+N', 'Alt+M', 'Alt+H', 'Escape'] as const;

export interface Shortcut { readonly key: string; readonly description: string; readonly run: () => void }

export function createShortcutRegistry() {
  const pages = new Map<string, Map<string, Shortcut>>();
  const norm = (k: string) => k.replace(/^alt\+/i, 'Alt+').replace(/\+([a-z])$/, (_, c: string) => `+${c.toUpperCase()}`);
  return {
    register(pageId: string, ...shortcuts: Shortcut[]): () => void {
      const page = pages.get(pageId) ?? new Map<string, Shortcut>();
      const keys = shortcuts.map((s) => norm(s.key));
      keys.forEach((key, i) => {
        if ((GLOBAL_KEYS as readonly string[]).includes(key)) throw new Error(`shortcut ${key} on page "${pageId}" conflicts with a global key`);
        if (page.has(key) || keys.indexOf(key) !== i) throw new Error(`duplicate shortcut ${key} on page "${pageId}"`);
      });
      shortcuts.forEach((s, i) => page.set(keys[i]!, s));
      pages.set(pageId, page);
      return () => { for (const s of shortcuts) page.delete(norm(s.key)); };
    },
    list(pageId: string): readonly Shortcut[] { return [...(pages.get(pageId)?.values() ?? [])]; },
  };
}

export const shortcuts = createShortcutRegistry();
