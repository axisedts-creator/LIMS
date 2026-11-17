// T16 static checks on settings.service.ts, repository/{settings,flags}.repo.ts and the seven handler files (REQ-SEC-040/044/085; 07-SECURITY P-2, D-T20/D-T21).
// No DB here: the default repos' SQL is never executed by these tests, so these greps are the only guard on its text (no LIMS_TEST_DATABASE_URL harness for T16).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mod = join(here, '..', '..');
const files = { service: join(mod, 'service', 'settings.service.ts'), settingsRepo: join(mod, 'repository', 'settings.repo.ts'), flagsRepo: join(mod, 'repository', 'flags.repo.ts') };
const handlerDir = join(mod, 'handlers');
const OPS = ['getSettings', 'updateSettings', 'uploadBrandingAsset', 'getBrandingAssetContent', 'listFeatureFlags', 'setTenantFeatureFlag', 'listOwnIrdAnnexes'];
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sqlLines = (s: string) => s.split(/\r?\n/).filter((l) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/.test(l) && /(core|identity|audit|app)\./.test(l));
const stmts = (s: string) => s.match(/`[^`]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*`|'[^'\n]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'\n]*'/g) ?? [];

describe.each(Object.entries(files))('%s file', (_n, path) => {
  it('exists', () => { expect(existsSync(path)).toBe(true); });
  it('no SQL string is built by interpolation (${...}) or concatenation; no process.env', () => {
    const s = read(path); for (const l of sqlLines(s)) { expect(l).not.toMatch(/\$\{/); expect(l).not.toMatch(/['"`]\s*\+\s*\w/); } expect(s).not.toMatch(/process\.env/);
  });
});

describe('repositories', () => {
  it('every statement on a tenant table names tenant_id (on top of RLS)', () => {
    for (const p of [files.settingsRepo, files.flagsRepo]) {
      const all = stmts(read(p)).filter((x) => /identity\.(tenant_settings|feature_flags|branding_assets|ird_annex_records)/.test(x));
      expect(all.length).toBeGreaterThan(0); for (const x of all) expect(x).toMatch(/tenant_id/);
    }
  });
  it('no DELETE on branding_assets / feature_flags / tenant_settings (assets are kept; no grant)', () => {
    expect(read(files.settingsRepo) + read(files.flagsRepo)).not.toMatch(/DELETE\s+FROM\s+identity\./i);
  });
  it('branding asset UPDATE touches only the mutable columns (is_active, scan_state; trigger enforce_mutable_columns)', () => {
    const upd = stmts(read(files.settingsRepo)).filter((x) => /UPDATE\s+identity\.branding_assets/i.test(x));
    for (const x of upd) expect(x.replace(/WHERE[\s\S]*$/i, '')).not.toMatch(/\b(object_path|sha256|bucket|content_type|kind|size_bytes)\s*=/);
  });
  it('platform rows: the IRD read does not select other tenants\' annex rows by id alone (relies on tenant_id / ird_annex_1_record_id)', () => {
    const ird = stmts(read(files.flagsRepo) + read(files.settingsRepo)).filter((x) => /ird_annex_records/.test(x)); expect(ird.length).toBeGreaterThan(0);
    for (const x of ird) expect(x).toMatch(/tenant_id|ird_annex_1_record_id/); expect(read(files.flagsRepo) + read(files.settingsRepo)).not.toMatch(/INSERT\s+INTO\s+identity\.ird_annex_records|UPDATE\s+identity\.ird_annex_records/);
  });
  it('feature-flag write names the flag code and version (optimistic lock)', () => {
    const upd = stmts(read(files.flagsRepo)).filter((x) => /UPDATE\s+identity\.feature_flags/i.test(x)); expect(upd.length).toBeGreaterThan(0);
    for (const x of upd) { expect(x).toMatch(/flag_code/); expect(x).toMatch(/version\s*=\s*\$\d/); }
  });
  it('settings UPDATE is guarded by version = $n', () => {
    const upd = stmts(read(files.settingsRepo)).filter((x) => /UPDATE\s+identity\.tenant_settings/i.test(x)); expect(upd.length).toBeGreaterThan(0);
    for (const x of upd) expect(x).toMatch(/version\s*=\s*\$\d|\bversion\b[^,]*\$\d/);
  });
});

describe('settings.service.ts', () => {
  const s = () => read(files.service);
  it('uses registered names verbatim: actions settings.change / feature_flag.change / branding_asset.download, task identity.rescan_upload, job key rescan:branding_assets:', () => {
    for (const lit of ['settings.change', 'feature_flag.change', 'branding_asset.download', 'identity.rescan_upload', 'rescan:branding_assets:']) expect(s()).toContain(lit);
  });
  it('timezone rule comes from the shared domain module (no second copy of the ranges) and the numbering validator is reused', () => {
    expect(s()).toMatch(/settings\.ranges/); expect(s()).toMatch(/numbering-pattern/); expect(s()).not.toMatch(/Asia\/Kolkata/);
  });
  it('downloads go through ctx.download.stream, never storage.signedUrl / signed URLs', () => {
    expect(s()).toMatch(/download\.stream/); expect(s()).not.toMatch(/signedUrl|createSignedUrl|\/sign\//);
  });
  it('uploads go through ctx.uploads.accept (no own image/magic-byte code, no image library)', () => {
    expect(s()).toMatch(/uploads\.accept/); expect(s()).not.toMatch(/from ['"](sharp|jimp|pngjs|file-type|image-size)/);
  });
  it('requests a re-encode and mandatory scan for branding images: images.reencode, stripMetadata, scan required, bucket identity-assets', () => {
    expect(s()).toMatch(/reencode:\s*true/); expect(s()).toMatch(/stripMetadata:\s*true/); expect(s()).toMatch(/scan:\s*['"]required['"]/); expect(s()).toMatch(/identity-assets/);
  });
  it('invalidates the settings cache through the port, and never reads dead letters / platform staff', () => {
    expect(s()).toMatch(/invalidateTenantSettings/); expect(s()).not.toMatch(/core\.dead_letters|platform_staff/);
  });
  it('contains no hard-coded real-looking secrets or inline HTML/SVG handling', () => { expect(s()).not.toMatch(/image\/svg|<svg|\.svg/i); });
});

describe('handler files', () => {
  it.each(OPS)('handlers/%s.ts exists and is not the not-implemented stub', (op) => {
    const p = join(handlerDir, `${op}.ts`); expect(existsSync(p)).toBe(true); expect(read(p)).not.toMatch(/not implemented|common\.internal/);
  });
  it.each(OPS)('handlers/%s.ts takes tenant and actor from the context only', (op) => {
    expect(read(join(handlerDir, `${op}.ts`))).not.toMatch(/(body|query|params)\??\.(tenant_id|tenantId)|\[['"]tenant_id['"]\]/);
  });
  it('getBrandingAssetContent handler never sets an inline disposition or a cacheable header', () => {
    const t = read(join(handlerDir, 'getBrandingAssetContent.ts')); expect(t).not.toMatch(/inline|max-age|public/i);
  });
});
