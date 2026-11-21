// RS-C5 helper (tester-owned): regenerates rs-c5.baseline.json = sha256 of every features/lab/server/*.ts(x) file (LF-normalised) + the list of
// (staff)/lab page.tsx routes. The restyle may not change either (LD-140: no change to API calls, fields, validation, permissions or routes).
// Run from the repo root only when the lead rules a deliberate change:  node apps/web/src/features/lab/__tests__/rs-c5.make-baseline.cjs
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const walk = (dir, fn) => {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    if (fs.statSync(f).isDirectory()) walk(f, fn);
    else fn(f, n);
  }
};
const key = (f) => f.split(path.sep).join('/');
const server = {};
const routes = [];
walk('apps/web/src/features/lab/server', (f, n) => {
  if (/\.tsx?$/.test(n)) server[key(f)] = crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
});
walk('apps/web/src/app/(staff)/lab', (f, n) => {
  if (n === 'page.tsx') routes.push(key(f));
});
fs.writeFileSync('apps/web/src/features/lab/__tests__/rs-c5.baseline.json', JSON.stringify({ server, routes: routes.sort() }, null, 1) + '\n');
console.log(Object.keys(server).length, 'server files,', routes.length, 'routes');
