// RS-C7 helper (tester-owned): regenerates rs-c7.baseline.json from the pre-restyle tree:
//   server  = sha256 of every features/instruments/server/*.ts(x) (LF-normalised)  -> the api-client (actions, BFF fetchers, DTO types)
//   routes  = every file under app/(staff)/instruments that is a page.tsx / route.ts
//   pageImports = per route file, the names it imports from features/instruments/server/* (which data calls the page makes)
//   permissions = every `instruments.<x>.<y>` permission literal in features/instruments/components
// The restyle may not change any of it (LD-140: no change to API calls, fields, validation, permissions or routes).
// Run from the repo root only when the lead rules a deliberate change:  node apps/web/src/features/instruments/__tests__/rs-c7.make-baseline.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const walk = (dir, fn) => {
  for (const n of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, n);
    if (fs.statSync(f).isDirectory()) walk(f, fn);
    else fn(f, n);
  }
};
const key = (f) => f.split(path.sep).join('/');
const server = {};
const routes = [];
const pageImports = {};
const permissions = new Set();
walk('apps/web/src/features/instruments/server', (f, n) => {
  if (/\.tsx?$/.test(n)) server[key(f)] = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
});
const forms = {};
walk('apps/web/src/features/instruments/forms', (f, n) => {
  if (/\.tsx?$/.test(n)) forms[key(f)] = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
});
walk('apps/web/src/app/(staff)/instruments', (f, n) => {
  if (n !== 'page.tsx' && n !== 'route.ts') return;
  routes.push(key(f));
  const src = fs.readFileSync(f, 'utf8');
  const names = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(@\/features\/instruments\/server\/[^']+)'/g))
    for (const n2 of m[1].split(',')) if (n2.trim()) names.push(`${n2.trim()}@${m[2]}`);
  pageImports[key(f)] = names.sort();
});
walk('apps/web/src/features/instruments/components', (f) => {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/'(instruments\.[a-z_]+\.[a-z_]+)'/g)) permissions.add(m[1]);
});
fs.writeFileSync(
  'apps/web/src/features/instruments/__tests__/rs-c7.baseline.json',
  JSON.stringify({ server, forms, routes: routes.sort(), pageImports, permissions: [...permissions].sort() }, null, 1) + '\n',
);
console.log(Object.keys(server).length, 'server files,', routes.length, 'routes,', permissions.size, 'permissions');
