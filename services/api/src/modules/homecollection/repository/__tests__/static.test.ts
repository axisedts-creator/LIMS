// HC-T03 static guard (no DB): "all queries parameterised, explicit tenant_id filter" — cheap source checks that run before the integration suite.
// The behavioural proof (superuser = RLS bypassed + hostile values + column allow-list) lives in repositories.test.ts; this only catches the obvious regressions.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = () => readdirSync(dir).filter((f) => f.endsWith('.repo.ts'));
const GLOBAL_OK = new Set(['reasons.repo.ts']); // homecollection.g_cs_reasons is a global seed table (no tenant_id)
const EXPECTED = ['bookingRefs', 'collections', 'devices', 'handovers', 'mutations', 'reasons', 'routes', 'settings', 'syncBatches', 'visitAssignments', 'visitFlags',
  'visitLocations', 'visitSpecimens', 'visitTransitions', 'visits'];

describe('homecollection/repository/*.repo.ts (static)', () => {
  it('one repo file per table group exists', () => {
    for (const f of EXPECTED) expect(files(), `${f}.repo.ts`).toContain(`${f}.repo.ts`);
  });
  it('every repo is tenant-filtered, schema-qualified and never bypasses RLS', () => {
    expect(files().length, 'no repo files yet').toBeGreaterThan(0);
    for (const f of files()) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (!GLOBAL_OK.has(f)) expect(src, `${f} must bind tenant_id explicitly`).toMatch(/tenant_id\s*=\s*\$1/);
      expect(src, `${f} must schema-qualify tables (login role has search_path '')`).toMatch(/homecollection\./);
      expect(src, `${f}: no RLS bypass / role switching`).not.toMatch(/SET\s+(LOCAL\s+)?ROLE|BYPASSRLS|lims_owner|row_security|set_config\(\s*'request\.jwt/i);
    }
  });
  it('no SQL string is built by concatenation with + (values are $n parameters)', () => {
    expect(files().length, 'no repo files yet').toBeGreaterThan(0);
    for (const f of files()) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/\.query\(\s*(['"`])[^'"`]*\1\s*\+/);
      expect(src, f).not.toMatch(/\.query\(\s*[A-Za-z_.]+\s*\+/);
    }
  });
  it('a value is never interpolated into SQL text: template literals handed to query() may interpolate only identifiers/lists, never request-looking names', () => {
    expect(files().length, 'no repo files yet').toBeGreaterThan(0);
    for (const f of files()) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*`/gis))
        for (const x of m[0].matchAll(/\$\{([^}]*)\}/g))
          expect(x[1], `${f}: \${${x[1]}} in SQL text`).not.toMatch(/\b(tenantId|tenant_id|id|row|body|input|req|query|value|values|status|code|patch\[)\b(?!\s*\.\s*join)/);
    }
  });
});
