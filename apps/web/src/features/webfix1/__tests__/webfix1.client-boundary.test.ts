// T0D-WEBFIX-1 (a), LD-301 — static guard for the engagement error page ("The bookings could not be loaded", staging 2026-11-17).
// Cause: a server component rendered @lims/ui PageHeader, whose help control passes an inline onPress to the client Button; RSC refuses
// function props across a client boundary, so the page crashed AFTER the API answered 200. jsdom renders cannot see this (no RSC serializer),
// so this test reads the sources: every @lims/ui component imported by a server page file that takes an on*={...} handler must itself be
// a client module ('use client' as the first statement). Fails with packages/ui/src/components/PageHeader/PageHeader.tsx:1 removed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const UI = join(WEB, '..', '..', 'packages', 'ui', 'src', 'components');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' || e.name === '__tests__' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
const read = (f: string) => readFileSync(f, 'utf8');
/** The component creates its own closure for a handler (`onPress={() => ...}`): a server component cannot render that, so it needs the client boundary.
 *  A plain forward (`onPress={action.onPress}`, as in ErrorState/EmptyState) is the caller's concern and is not flagged. */
const CLOSURE_HANDLER = /\bon[A-Z]\w*=\{\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/;
/** First statement is the 'use client' directive (comments and blank lines may precede it). */
const isClientModule = (src: string) => /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/.test(src);

const serverFiles = walk(join(WEB, 'src'))
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => (/\/features\/[^/]+\/server\/[^/]*-pages\.tsx$/.test(f) || /\/app\/.*\/page\.tsx$/.test(f)) && !isClientModule(read(f)));

/** component name -> server files importing it from @lims/ui/components/<name> */
const importers = new Map<string, string[]>();
for (const f of serverFiles) {
  for (const m of read(f).matchAll(/from\s+['"]@lims\/ui\/components\/([A-Za-z0-9_]+)['"]/g)) importers.set(m[1]!, [...(importers.get(m[1]!) ?? []), f]);
}

describe('(a) server pages only import function-prop UI components that are client modules', () => {
  it('scans real files (guards against a vacuous pass) and sees PageHeader used by the engagement booking pages', () => {
    expect(serverFiles.length).toBeGreaterThan(20);
    expect(importers.get('PageHeader')?.some((f) => f.endsWith('/features/engagement/server/booking-pages.tsx'))).toBe(true);
  });

  it('PageHeader (inline onPress to the client Button) is a client module', () => {
    const src = read(join(UI, 'PageHeader', 'PageHeader.tsx'));
    expect(CLOSURE_HANDLER.test(src)).toBe(true);
    expect(isClientModule(src)).toBe(true);
  });

  it('every @lims/ui component imported by a server page file that creates an inline on*={() => ...} handler starts with "use client"', () => {
    const offenders: string[] = [];
    for (const [name, files] of importers) {
      let src: string;
      try { src = read(join(UI, name, `${name}.tsx`)); } catch { continue; } // not a single-file component (package export is components/*/*.tsx)
      if (CLOSURE_HANDLER.test(src) && !isClientModule(src)) offenders.push(`${name} (imported by ${files.map((f) => f.slice(WEB.length)).join(', ')})`);
    }
    expect(offenders).toEqual([]);
  });

  it('the directive detector itself: accepts comment-prefixed use client, rejects a late or missing one', () => {
    expect(isClientModule("'use client';\nexport const A = 1;")).toBe(true);
    expect(isClientModule("// note\n\n'use client';\n")).toBe(true);
    expect(isClientModule("import x from 'y';\n'use client';\n")).toBe(false);
    expect(isClientModule('export const A = 1;')).toBe(false);
    expect(CLOSURE_HANDLER.test('<Button onPress={() => onHelp?.(k)}>')).toBe(true);
    expect(CLOSURE_HANDLER.test('<Button onPress={action.onPress}>')).toBe(false);
  });
});
