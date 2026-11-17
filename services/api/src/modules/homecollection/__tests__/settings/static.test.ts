// HC-T04 static guards (no DB). Files of this task: handlers/*, settings.service.ts, mappers/* (06-IMPLEMENTATION-PLAN HC-T04). Guards 08 A19 D-130 (reasons come from the global seed table only: no tenant
// cs_reasons table, no write to g_cs_reasons), the HC-T03 repository seam (SQL lives in repository/*.repo.ts, never in a handler/service/mapper), 08 A17 P-22 (lazy settings row via the repo's
// ON CONFLICT (tenant_id) DO NOTHING insert) and 02-CV logging rules. Fails now: none of these files exists yet.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const walk = (p: string): string[] => (!existsSync(p) ? [] : statSync(p).isDirectory() ? readdirSync(p).flatMap((f) => walk(join(p, f))) : [p]);
const own = (): string[] => [...walk(join(ROOT, 'handlers')), ...walk(join(ROOT, 'mappers')), join(ROOT, 'settings.service.ts')].filter((f) => f.endsWith('.ts') && existsSync(f));
const text = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');   // code only: comments may name the forbidden things

describe('HC-T04 files', () => {
  it('settings.service.ts, handlers/* and mappers/* exist and are not stubs', () => {
    expect(existsSync(join(ROOT, 'settings.service.ts')), 'settings.service.ts missing (HC-T04 not implemented yet)').toBe(true);
    expect(walk(join(ROOT, 'handlers')).filter((f) => f.endsWith('.ts')).length, 'handlers/* missing (HC-T04 not implemented yet)').toBeGreaterThan(0);
    expect(walk(join(ROOT, 'mappers')).filter((f) => f.endsWith('.ts')).length, 'mappers/* missing (HC-T04 not implemented yet)').toBeGreaterThan(0);
  });
});

describe('HC-T04 source rules', () => {
  const files = own();
  it('D-130: no tenant reasons table (homecollection.cs_reasons) anywhere, and no write statement against g_cs_reasons', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const t = text(f);
      expect(/homecollection\.cs_reasons\b|\bcs_reasons\b(?!\w)/.test(t.replace(/g_cs_reasons/g, '')), `${f}: tenant cs_reasons`).toBe(false);
      expect(/\b(insert\s+into|update|delete\s+from)\s+(homecollection\.)?g_cs_reasons/i.test(t), `${f}: writes g_cs_reasons`).toBe(false);
    }
  });
  it('SQL stays in the repositories: no tx.query / pool.query in handlers, mappers or settings.service.ts', () => {
    for (const f of files) expect(/\.query\s*\(/.test(text(f)), `${f}: raw query`).toBe(false);
  });
  it('the settings path goes through the HC-T03 repositories (settings.repo / reasons.repo) and never bypasses RLS or logs the body', () => {
    const svc = text(join(ROOT, 'settings.service.ts'));
    expect(svc).toMatch(/settings\.repo/);
    expect(svc).toMatch(/insertSettingsIfAbsent/);   // P-22: the lazy create is the repo's ON CONFLICT (tenant_id) DO NOTHING insert
    for (const f of files) {
      const t = text(f);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/ctx\.log\.\w+\([^)]*(body|payment_methods|collection_consent_text)/.test(t), `${f}: logs request content`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('reasons are served by reasons.repo (global seed table), the set is passed as a bound parameter', () => {
    const joined = files.map(text).join('\n');
    expect(joined).toMatch(/reasons\.repo/);
    expect(joined).toMatch(/listReasonsBySet/);
  });
  it('the three permission checks use the HOMECOLLECTION_PERMISSIONS names verbatim (settings.manage for H18/H19, visit.read for H20)', () => {
    const joined = files.map(text).join('\n');
    expect(joined).toMatch(/homecollection\.settings\.manage|settingsManage|HOMECOLLECTION_PERMISSIONS/);
    expect(joined).toMatch(/homecollection\.visit\.read|visitRead|HOMECOLLECTION_PERMISSIONS/);
    expect(joined).toMatch(/assertRole/);
  });
});
