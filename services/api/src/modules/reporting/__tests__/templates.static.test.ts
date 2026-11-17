// C6-T18 — static guards for report templates admin (05-SCHEMA §2.12 immutability, REQ-SEC-024 tenant predicate, 07-SECURITY A11, 02-TRD §6.5):
// validation goes through domain/templates.ts only; SQL is static and tenant-scoped; config of a version row can only be written while it is a draft.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => (existsSync(join(R, p)) ? readFileSync(join(R, p), 'utf8') : '');
const service = read('service/templates.service.ts');
const repo = read('repository/templates.repo.ts');
const handlers = read('handlers/templates.handlers.ts');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** Every string/template literal that holds SQL touching the template tables. */
const sql = (s: string) => [...code(s).matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2]!).filter((x) => /\breporting\.report_template/i.test(x));

describe('templates sources (non-test)', () => {
  it('service, repository and handlers exist', () => {
    expect(service, 'service/templates.service.ts').not.toBe(''); expect(repo, 'repository/templates.repo.ts').not.toBe(''); expect(handlers, 'handlers/templates.handlers.ts').not.toBe('');
  });
  it('the service exports createTemplatesService and the handlers are wired into the manifest', () => {
    expect(service).toMatch(/export\s+function\s+createTemplatesService\b/);
    expect(read('index.ts')).toMatch(/templates\.handlers/);
  });
  it('TemplateConfig is validated by domain/templates.ts (no second hand-rolled schema in the service)', () => {
    expect(service).toMatch(/validateTemplateConfig/); expect(service).toMatch(/domain\/templates\.js/);
    expect(code(service)).not.toMatch(/additionalProperties|maxLength\s*:\s*200|\.length\s*>\s*200/);
  });
  it('no outbound access from the templates path (no URL fetch of a config value: 07 A11)', () => {
    for (const s of [service, repo, handlers]) expect(code(s)).not.toMatch(/\bfetch\s*\(|node:https?|\baxios\b|new\s+URL\s*\(/);
  });
});

describe('templates SQL', () => {
  it('statements exist', () => expect(sql(repo).length).toBeGreaterThan(0));
  it('static text: no template-literal interpolation or string concatenation into a statement', () => {
    for (const s of sql(repo)) expect(s).not.toMatch(/\$\{|'\s*\+|\+\s*'/);
    expect(code(repo)).not.toMatch(/`[^`]*reporting\.report_template[^`]*\$\{/);
  });
  it('every SELECT / UPDATE carries an explicit tenant predicate bound to a parameter (REQ-SEC-024)', () => {
    for (const s of sql(repo).filter((x) => /^\s*(select|update)/i.test(x))) expect(s, s).toMatch(/\btenant_id\s*=\s*\$\d+/);
  });
  it('INSERTs name tenant_id', () => { for (const s of sql(repo).filter((x) => /^\s*insert/i.test(x))) expect(s, s).toMatch(/\btenant_id\b/); });
  it('nothing deletes template rows (no DELETE grant; versions are immutable history)', () => { for (const s of sql(repo)) expect(s).not.toMatch(/\bdelete\s+from\b/i); });
  it('the config of a version row can only be written while it is a draft (status guard in the UPDATE)', () => {
    const upd = sql(repo).filter((x) => /^\s*update\s+reporting\.report_template_versions/i.test(x) && /\bconfig\b\s*=/i.test(x.replace(/\bwhere\b[\s\S]*$/i, '')));
    expect(upd.length, 'a draft-config UPDATE').toBeGreaterThan(0);
    for (const s of upd) expect(s, s).toMatch(/\bstatus\s*=\s*'draft'/i);
  });
  it('publishing is guarded: promoting writes only from a draft, retiring only from published', () => {
    const toPublished = sql(repo).filter((x) => /^\s*update\s+reporting\.report_template_versions/i.test(x) && /\bset\b[\s\S]*published_at/i.test(x));
    expect(toPublished.length).toBeGreaterThan(0); for (const s of toPublished) expect(s, s).toMatch(/\bstatus\s*=\s*'draft'/i);
    const retire = sql(repo).filter((x) => /^\s*update\s+reporting\.report_template_versions/i.test(x) && /'retired'/i.test(x));
    expect(retire.length).toBeGreaterThan(0); for (const s of retire) expect(s, s).toMatch(/\bstatus\s*=\s*'published'/i);
  });
  it('the template header UPDATEs use optimistic locking (version = $n ... version + 1)', () => {
    const upd = sql(repo).filter((x) => /^\s*update\s+reporting\.report_templates\b/i.test(x));
    expect(upd.length).toBeGreaterThan(0); for (const s of upd) { expect(s, s).toMatch(/\bversion\s*=\s*version\s*\+\s*1/i); }
    expect(upd.some((s) => /\bversion\s*=\s*\$\d+/i.test(s.replace(/\bset\b[\s\S]*?\bwhere\b/i, 'where')))).toBe(true);
  });
});
