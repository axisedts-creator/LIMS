// T0B-OPSDOC-1 (audit RS-16, LD-277) done_when (1), (2), (5): docs/runbooks/environment.md lists every LIMS_* name that
// the API, the worker and the web read, found by the committed scan tests/docs/lims-env-scan.mjs; names only.
// Table format the document must use (one header row, then one row per name):
//   | Name | Module | Required | When unset |      Name in backticks; Required is `required` or `optional`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOC = join(ROOT, 'docs', 'runbooks', 'environment.md');
const SCAN = pathToFileURL(join(ROOT, 'tests', 'docs', 'lims-env-scan.mjs')).href;
const scan = async (root: string): Promise<Map<string, string[]>> => ((await import(SCAN)) as any).scanLimsEnv(root);

export interface DocRow { name: string; module: string; required: string; unset: string }
const plain = (c: string): string => c.replace(/[`*_]/g, '').trim();

/** Rows of every table whose header is Name | Module | Required | When unset. */
export function parseDoc(md: string): DocRow[] {
  const rows: DocRow[] = [];
  let inTable = false;
  for (const line of md.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { inTable = false; continue; }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.length >= 4 && /^name$/i.test(plain(cells[0]!)) && /module/i.test(cells[1]!) && /required/i.test(cells[2]!)) { inTable = true; continue; }
    if (!inTable || /^[-: ]+$/.test(cells[0]!.replace(/\|/g, ''))) continue;
    const m = /^`?(LIMS_[A-Z0-9_]*[A-Z0-9])`?$/.exec(cells[0]!);
    if (m) rows.push({ name: m[1]!, module: plain(cells[1]!), required: plain(cells[2]!).toLowerCase(), unset: cells.slice(3).join('|').trim() });
  }
  return rows;
}
export const readDoc = (): string => readFileSync(DOC, 'utf8');
/** Names the code reads that the document does not list. */
export const missingFromDoc = (scanned: Iterable<string>, md: string): string[] => {
  const listed = new Set(parseDoc(md).map((r) => r.name));
  return [...scanned].filter((n) => !listed.has(n));
};

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lims-env-scan-'));
  tmp.push(root);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

describe('T0B-OPSDOC-1 scan script (tests/docs/lims-env-scan.mjs)', () => {
  it('finds names in api, worker and web sources; skips tests, fixtures, type files and comment-only mentions', async () => {
    const root = fixtureTree({
      'services/api/src/m/config.ts': "export const a = process.env['LIMS_FIX_API_ONE']; // LIMS_FIX_IN_LINE_COMMENT\n",
      'services/worker/src/job.ts': 'const x = env.LIMS_FIX_WORKER_TWO;\n/* LIMS_FIX_IN_BLOCK_COMMENT */\n',
      'apps/web/src/app/page.tsx': 'const u = `${process.env.LIMS_FIX_WEB_THREE}`;\n',
      'services/api/src/m/__tests__/t.ts': "process.env.LIMS_FIX_IN_TESTS_DIR;\n",
      'services/api/src/m/a.test.ts': 'process.env.LIMS_FIX_IN_TEST_FILE;\n',
      'services/api/src/m/types.d.ts': 'declare const LIMS_FIX_IN_D_TS: string;\n',
      'services/api/src/m/__fixtures__/f.ts': 'process.env.LIMS_FIX_IN_FIXTURES;\n',
    });
    expect([...(await scan(root)).keys()]).toEqual(['LIMS_FIX_API_ONE', 'LIMS_FIX_WEB_THREE', 'LIMS_FIX_WORKER_TWO']);
  });

  it('on the real repository finds the names named in the audit (RS-16) and never a value', async () => {
    const found = await scan(ROOT);
    for (const n of [
      'LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS', 'LIMS_CORE_SCANNER_URL', 'LIMS_REPORTING_RENDERER_URL',
      'LIMS_REPORTING_RENDERER_TOKEN_FILE', 'LIMS_PARTNER_BFF_KEY_FILE', 'LIMS_PORTAL_BFF_KEY_FILE',
      'LIMS_CORE_ENV', 'LIMS_WEB_BFF_KEY_FILE', 'LIMS_MIGRATOR_DATABASE_URL', 'LIMS_CORE_WORKER_DATABASE_URL',
    ]) expect(found.has(n), n).toBe(true);
    for (const k of found.keys()) expect(k).toMatch(/^LIMS_[A-Z0-9_]*[A-Z0-9]$/);
  });
});

describe('T0B-OPSDOC-1 docs/runbooks/environment.md', () => {
  it('(1) lists every LIMS_* name the code reads, once each', async () => {
    const md = readDoc(); // fails now: the file does not exist
    const missing = missingFromDoc((await scan(ROOT)).keys(), md);
    expect(missing, `read by the code but not in docs/runbooks/environment.md: ${missing.join(', ')}`).toEqual([]);
    const names = parseDoc(md).map((r) => r.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i), 'duplicate rows').toEqual([]);
  });

  it('(1) each row has module, required|optional and a "when unset" sentence', () => {
    const rows = parseDoc(readDoc());
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(r.module, `${r.name} module`).not.toBe('');
      expect(['required', 'optional'], `${r.name} required column`).toContain(r.required);
      expect(r.unset.length, `${r.name} when unset`).toBeGreaterThanOrEqual(10);
    }
    expect(rows.some((r) => r.required === 'required'), 'at least one required name').toBe(true);
  });

  it('(1) module column matches the owner: core, worker, web or a modules/* name', () => {
    const modules = new Set(['core', 'worker', 'web']);
    for (const r of parseDoc(readDoc())) {
      expect(modules.has(r.module) || /^[a-z][a-z0-9_-]*$/.test(r.module), `${r.name}: "${r.module}"`).toBe(true);
    }
  });

  it('(1) the six names the audit found missing are documented with an effect', () => {
    const by = new Map(parseDoc(readDoc()).map((r) => [r.name, r]));
    for (const n of [
      'LIMS_IDENTITY_PLATFORM_ALLOWED_CIDRS', 'LIMS_CORE_SCANNER_URL', 'LIMS_REPORTING_RENDERER_URL',
      'LIMS_REPORTING_RENDERER_TOKEN_FILE', 'LIMS_PARTNER_BFF_KEY_FILE', 'LIMS_PORTAL_BFF_KEY_FILE',
    ]) expect(by.get(n)?.unset ?? '', n).not.toBe('');
  });

  it('(2) the check fails when the code reads a LIMS_* name the document lacks', async () => {
    const root = fixtureTree({ 'services/api/src/m/config.ts': "process.env['LIMS_FIX_NOT_DOCUMENTED'];\n" });
    const md = '| Name | Module | Required | When unset |\n|---|---|---|---|\n| `LIMS_FIX_OTHER` | m | optional | default is used |\n';
    expect(missingFromDoc((await scan(root)).keys(), md)).toEqual(['LIMS_FIX_NOT_DOCUMENTED']);
    const ok = md + '| `LIMS_FIX_NOT_DOCUMENTED` | m | optional | default is used |\n';
    expect(missingFromDoc((await scan(root)).keys(), ok)).toEqual([]);
  });

  it('(5) names only: no assignment, no URL with credentials, no key material, no long token', () => {
    const md = readDoc();
    expect(md, 'NAME=value').not.toMatch(/\bLIMS_[A-Z0-9_]+\s*=\s*[^\s|`]/);
    expect(md, '$env:NAME = "value"').not.toMatch(/\$env:LIMS_[A-Z0-9_]+\s*=\s*\S/);
    expect(md, 'scheme://user:pass@host').not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i);
    expect(md, 'PEM block').not.toMatch(/-----BEGIN [A-Z ]+-----/);
    expect(md, 'jwt').not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(md, 'hex or base64 run of 32+').not.toMatch(/\b[A-Fa-f0-9]{32,}\b|[A-Za-z0-9+]{40,}={0,2}/);
  });
});
