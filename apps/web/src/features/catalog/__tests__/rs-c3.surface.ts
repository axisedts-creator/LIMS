// RS-C3 helper (tester-owned). Computes the "API surface" of the catalog feature so a restyle can be proven not to change it:
//   - sha256 of every file under features/catalog/server/** (api-client usage, field names, validation, permissions live there),
//   - the sorted route tree under app/(staff)/catalog/** (file paths of page/route files),
//   - per UI file: the set of symbols imported from the server layer (which actions / loaders a screen calls).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const web = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'); // apps/web
export const featureDir = join(web, 'src', 'features', 'catalog');
export const routeDir = join(web, 'src', 'app', '(staff)', 'catalog');

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    if (n === '__tests__' || n === 'node_modules') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const rel = (base: string, p: string) => relative(base, p).split('\\').join('/');
const norm = (t: string) => t.replace(/\r\n/g, '\n');

export function serverHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of walk(join(featureDir, 'server'))) out[rel(featureDir, f)] = createHash('sha256').update(norm(readFileSync(f, 'utf8'))).digest('hex');
  return out;
}

export function routes(): string[] {
  return walk(routeDir).filter((f) => /(?:page|route)\.tsx?$/.test(f)).map((f) => rel(routeDir, f));
}

/** `import { a, b as c } from '../server/x'` / `'@/features/catalog/server/x'` -> "x: a,b" (type-only specifiers dropped). */
export function serverImports(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const files = [...walk(featureDir).filter((f) => /\.tsx?$/.test(f) && !f.includes(`${join(featureDir, 'server')}`)), ...walk(routeDir).filter((f) => /\.tsx?$/.test(f))];
  for (const f of files) {
    const text = norm(readFileSync(f, 'utf8'));
    const found: string[] = [];
    for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+'((?:\.\.?\/|@\/features\/catalog\/)[^']*server[^']*)'/g)) {
      if (m[1]) continue;
      const mod = m[3]!.replace(/^.*server\//, '');
      for (const s of m[2]!.split(',')) {
        const name = s.trim().replace(/^type\s+.*/, '').split(/\s+as\s+/)[0]!.trim();
        if (name) found.push(`${mod}:${name}`);
      }
    }
    if (found.length) out[f.startsWith(routeDir) ? `app/${rel(routeDir, f)}` : rel(featureDir, f)] = [...new Set(found)].sort();
  }
  return out;
}
