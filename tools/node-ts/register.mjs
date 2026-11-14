// tools/node-ts/register.mjs (T0D-DEP-01, LD-179 (1)): the one resolver hook that lets Node run the TypeScript sources as-is.
// Usage: node --import <path to this file> src/main.ts
//
// Why: the sources import './x.js' (the TypeScript convention for ES modules) while only x.ts exists on disk. Node's built-in
// type stripping runs x.ts, but Node maps no .js specifier to .ts, so it fails with ERR_MODULE_NOT_FOUND. vitest and tsc do the
// mapping, which is why no test caught it before.
//
// This is not a transpiler: it rewrites no code. It only changes WHICH file a relative import resolves to, and only when
//   - the specifier is relative (./ or ../) and ends in .js,
//   - the importing module is a file: URL ending in .ts,
//   - the .js file does NOT exist and the .ts file DOES exist.
// In every other case it calls nextResolve unchanged, so a genuinely missing module still fails with ERR_MODULE_NOT_FOUND.
// Dependency-free: node:module and node:fs only; no eval, no network, no file reads (existsSync only), no environment.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js') &&
      typeof parent === 'string' &&
      parent.startsWith('file:') &&
      parent.endsWith('.ts')
    ) {
      const jsUrl = new URL(specifier, parent);
      const tsUrl = new URL(jsUrl.href.slice(0, -'.js'.length) + '.ts');
      if (!existsSync(jsUrl) && existsSync(tsUrl)) return nextResolve(tsUrl.href, context);
    }
    return nextResolve(specifier, context);
  },
});
