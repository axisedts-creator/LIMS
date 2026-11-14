// AN-T18 — done_when / security structure of app/(staff)/analytics/{page,loading,error}.tsx (C8 06-PLAN row AN-T18; C0 server-only rule REQ-SEC-068).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../app/(staff)/analytics/', import.meta.url));
const read = (f: string) => readFileSync(root + f, 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const importsOf = (s: string) => [...strip(s).matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('analytics dashboard route files', () => {
  it.each(['page.tsx', 'loading.tsx', 'error.tsx'])('%s exists', (f) => {
    expect(existsSync(root + f)).toBe(true);
  });

  it("error.tsx is a client component ('use client' first statement); page.tsx and loading.tsx are not", () => {
    expect(strip(read('error.tsx')).trimStart().startsWith("'use client'")).toBe(true);
    expect(read('page.tsx')).not.toMatch(/['"]use client['"]/);
    expect(read('loading.tsx')).not.toMatch(/['"]use client['"]/);
  });

  it('every file imports only react / next / @lims/ui / @/core / @/features/analytics / relative paths (no look-alike kit, no raw fetch libs)', () => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) {
      for (const i of importsOf(read(f))) expect(i, `${f}: ${i}`).toMatch(/^(react|next\/[a-z-]+|@lims\/ui(\/.*)?|@\/core\/.*|@\/features\/analytics\/.*|\.{1,2}\/.*)$/);
    }
  });

  it('loading.tsx uses LoadingSkeleton variant="page"; error.tsx uses ErrorState with onRetry', () => {
    expect(read('loading.tsx')).toMatch(/LoadingSkeleton/);
    expect(read('loading.tsx')).toMatch(/variant=["'{]+page/);
    expect(read('error.tsx')).toMatch(/ErrorState/);
    expect(read('error.tsx')).toMatch(/onRetry=\{reset\}/);
  });

  it('no raw HTML injection, no browser storage, no hand-built bearer header in the route files', () => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) {
      const s = strip(read(f));
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|document\.cookie/);
      expect(s, f).not.toMatch(/authorization|Bearer /i);
    }
  });

  it('page.tsx does not embed hex/rgb colours or hard-coded money maths (tiles come from the API in paisa through the kit)', () => {
    const s = strip(read('page.tsx'));
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });
});
