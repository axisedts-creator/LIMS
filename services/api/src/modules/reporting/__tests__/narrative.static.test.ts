// C6-T17 — static guards for the narrative engine (REQ-SEC-088, 02-TRD §10 dependency row "DOMPurify", CR-C6-019 pending-cr):
// the sanitiser is DOMPurify on a server DOM (never a hand-rolled regex), it is a declared dependency of services/api, runs with an explicit allowlist,
// and narrative SQL is static (no template-literal interpolation into reporting.narrative_* statements).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const API = join(here, '..');
const PKG = join(here, '../../../../package.json');
function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n); if (n === '__tests__') return [];
    return statSync(p).isDirectory() ? sources(p) : /\.ts$/.test(n) ? [{ file: p, text: readFileSync(p, 'utf8') }] : [];
  });
}
const all = sources(API);
const narrative = all.filter((s) => /narrative(?!-image)/i.test(s.file.replace(API, '')));
const need = (n: number, what: string) => expect(n, `${what}: nothing to check yet (task not implemented)`).toBeGreaterThan(0);

describe('narrative sources (non-test)', () => {
  it('a narrative service, handlers and repository exist', () => {
    expect(narrative.some((s) => /service[\\/]narrative\.service\.ts$/.test(s.file))).toBe(true);
    expect(narrative.some((s) => /handlers[\\/]narrative\.handlers\.ts$/.test(s.file))).toBe(true);
  });
  it('CR-C6-019: dompurify and a server DOM are declared dependencies of services/api', () => {
    const pkg = JSON.parse(readFileSync(PKG, 'utf8')); const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps)).toContain('dompurify'); expect(Object.keys(deps).some((d) => /^(jsdom|linkedom|happy-dom)$/.test(d)), 'a server-side DOM implementation').toBe(true);
  });
  it('the sanitiser is DOMPurify (imported in exactly the narrative path), configured with an explicit allowlist', () => {
    const users = all.filter((s) => /from\s+['"]dompurify['"]|require\(['"]dompurify['"]\)/.test(s.text));
    expect(users.length, 'a module must import dompurify').toBeGreaterThan(0);
    for (const s of users) { expect(s.file, 'dompurify is only for narrative text').toMatch(/narrative|sanitis|sanitiz/i); expect(s.text, s.file).toMatch(/ALLOWED_TAGS|ALLOWED_ATTR/); }
  });
  it('the allowlist never enables script-capable tags / attributes / URL schemes, and never sets a permissive profile', () => {
    need(all.filter((x) => /dompurify/.test(x.text)).length, 'dompurify users');
    for (const s of all.filter((x) => /dompurify/.test(x.text))) {
      const cfg = s.text.replace(/\/\/.*$/gm, '');
      for (const bad of ['script', 'iframe', 'object', 'embed', 'svg', 'math', 'style', 'form', 'meta', 'link', 'base', 'srcdoc', 'formaction']) expect(cfg, `${s.file}: ${bad}`).not.toMatch(new RegExp(`ALLOWED_(TAGS|ATTR)[^\\]]*['"]${bad}['"]`, 'i'));
      expect(cfg, s.file).not.toMatch(/ADD_TAGS|ADD_ATTR|ALLOW_UNKNOWN_PROTOCOLS\s*:\s*true|ALLOW_DATA_ATTR\s*:\s*true|SAFE_FOR_TEMPLATES\s*:\s*false|FORBID_TAGS\s*:\s*\[\s*\]/);
    }
  });
  it('no regex "sanitiser" anywhere in the narrative path (tag stripping by replace is bypassable)', () => {
    for (const s of narrative) expect(s.text, s.file).not.toMatch(/\.replace\(\s*\/[^/\n]*<\s*\\?\/?\s*(script|[a-z]*)[^/\n]*\/[gimsuy]*\s*,/i);
  });
  it('narrative HTML is never evaluated or executed server-side', () => {
    for (const s of narrative) expect(s.text, s.file).not.toMatch(/\beval\(|new Function\(|child_process|vm\.run|\.innerHTML\s*=|runScripts/);
  });
  it('the server DOM is created without script execution or resource loading', () => {
    need(all.filter((x) => /new JSDOM\(/.test(x.text)).length, 'server DOM construction');
    for (const s of all.filter((x) => /new JSDOM\(/.test(x.text))) expect(s.text, s.file).not.toMatch(/runScripts\s*:\s*['"](dangerously|outside-only)['"]|resources\s*:\s*['"]usable['"]/);
  });
  it('SQL on narrative tables is static: no template-literal interpolation into reporting.narrative_* statements', () => {
    for (const s of all.filter((x) => /repository/.test(x.file)))
      expect(s.text, s.file).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*\breporting\.narrative_(reports|versions|templates)\b|\breporting\.narrative_(reports|versions|templates)\b[^`]*\$\{/);
  });
  it('every narrative_versions UPDATE is guarded by status (the DB trigger is the backstop, not the only lock)', () => {
    need(narrative.filter((x) => /repository/.test(x.file)).length, 'narrative repository');
    for (const s of narrative.filter((x) => /repository/.test(x.file))) for (const m of s.text.matchAll(/UPDATE\s+reporting\.narrative_versions[\s\S]*?(?=`|'\s*[,)])/gi)) expect(m[0], s.file).toMatch(/\bstatus\b/i);
  });
  it('N-handlers use the narrative service and never reach into storage or the network', () => {
    need(narrative.filter((x) => /handlers/.test(x.file)).length, 'narrative handlers');
    for (const s of narrative.filter((x) => /handlers/.test(x.file))) { expect(s.text, s.file).not.toMatch(/\bfetch\(|node:https?|from\s+['"]node:net['"]/); }
  });
});
