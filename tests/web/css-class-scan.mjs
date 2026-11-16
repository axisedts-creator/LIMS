// WEB-CSS-RATCHET-1 (LD-241): static scan helpers for the lims- CSS class ratchet.
// Used: lims- tokens inside a className attribute/property of apps/web, apps/portal, apps/partner, packages/ui.
// Defined: `.lims-*` selectors in a .css / .module.css (or an inline <style> block in a component) of the same app or of packages/ui.
// ponytail: regex scan, not an AST. Dynamic names (`lims-x-${v}`) are skipped; classes built
// elsewhere and passed as className={var} are not seen. Upgrade to an AST scan if that bites.
import fs from 'node:fs';
import path from 'node:path';

export const APPS = ['apps/web', 'apps/portal', 'apps/partner', 'packages/ui'];
export const SHARED = 'packages/ui';

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.turbo', 'coverage', '__tests__', '__mocks__']);
const CODE = /\.(tsx|ts|jsx|js|mjs)$/;
const SKIP_CODE = /\.(test|spec)\.[a-z]+$|\.d\.ts$/;
const TOKEN = /(?<![A-Za-z0-9_-])lims-[A-Za-z0-9_-]+/g;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else out.push(path.join(dir, e.name));
  }
  return out;
}

function classNameExpressions(src) {
  const out = [];
  const re = /\bclassName\s*[=:]\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const i = re.lastIndex;
    const c = src[i];
    let end = -1;
    if (c === '"' || c === "'" || c === '`') end = src.indexOf(c, i + 1);
    else if (c === '{') {
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end > i) out.push(src.slice(i, end + 1));
  }
  return out;
}

export function usedClasses(src) {
  const found = new Set();
  for (const expr of classNameExpressions(src))
    for (const t of expr.match(TOKEN) ?? []) if (!t.endsWith('-')) found.add(t); // trailing '-' = dynamic prefix
  return found;
}

export function definedClasses(css) {
  const found = new Set();
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.(lims-[A-Za-z0-9_-]+)/g)) found.add(m[1]);
  return found;
}

function collect(root, app) {
  const files = walk(path.join(root, app));
  const used = new Map(); // class -> [repo-relative files]
  const defined = new Set();
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (f.endsWith('.css')) {
      for (const c of definedClasses(fs.readFileSync(f, 'utf8'))) defined.add(c);
    } else if (CODE.test(f) && !SKIP_CODE.test(f)) {
      const src = fs.readFileSync(f, 'utf8');
      for (const c of usedClasses(src)) used.set(c, [...(used.get(c) ?? []), rel]);
      // an inline <style> block in a component (React 19 style href/precedence) is a stylesheet too
      if (src.includes('<style')) for (const c of definedClasses(src)) defined.add(c);
    }
  }
  return { used, defined };
}

/** Per app: used classes, files per class, and violations (used but defined neither in the app nor in packages/ui). */
export function scan(root, apps = APPS) {
  const shared = collect(root, SHARED).defined;
  const result = {};
  for (const app of apps) {
    const { used, defined } = collect(root, app);
    const all = app === SHARED ? defined : new Set([...defined, ...shared]);
    result[app] = {
      used: [...used.keys()].sort(),
      files: Object.fromEntries(used),
      violations: [...used.keys()].filter((c) => !all.has(c)).sort(),
    };
  }
  return result;
}

/** Ratchet: `added` = undefined and not baselined; `stale` = baselined but no longer a violation. */
export function ratchet(scanResult, baselineApps) {
  const out = {};
  for (const [app, r] of Object.entries(scanResult)) {
    const base = new Set(baselineApps[app] ?? []);
    out[app] = {
      added: r.violations.filter((c) => !base.has(c)),
      stale: [...base].filter((c) => !r.violations.includes(c)).sort(),
    };
  }
  return out;
}
