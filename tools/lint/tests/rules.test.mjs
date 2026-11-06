// T0A-03: custom lint rules, positive (violation) + negative (clean) fixtures per rule.
// Run: node --test tools/lint/tests/rules.test.mjs
//
// Contract the implementation must follow (spec names the rules, not their API; this is a test-side choice):
//   tools/lint/rules/<rule-name>.ts  (plain TS, loadable by node type stripping, no deps) exports
//     export const name = '<rule-name>';
//     export function check(path: string, source: string): Array<{ rule: string; line: number; message: string }>;
//   `path` is repo-relative (forward or back slashes, optional leading `./`); [] = clean. 1-based `line`.
// Rules: 02-CONVENTIONS §1.3, 02-TRD §3.2/§6.8, 06 T0A-03, AC-0A-3.4, 07-SECURITY AB-21 (core.dead_letters only in services/api/src/core/**).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const load = async (rule) => {
  const file = join(root, 'tools/lint/rules', `${rule}.ts`);
  assert.ok(existsSync(file), `tools/lint/rules/${rule}.ts must exist`);
  return import(pathToFileURL(file).href);
};

const API = 'services/api/src';
const WEB = 'apps/web/src';
// [path, source, why]
const cases = {
  'no-cross-module-import': {
    bad: [
      [`${API}/modules/lab/service/a.ts`, "import { x } from '../../billing/index';", 'sibling module via ../../'],
      [`${API}/modules/lab/a.ts`, "import { x } from '../billing/index';", 'sibling module via ../'],
      [`${API}/modules/lab/a.ts`, "import type { T } from '../billing/types';", 'type-only import is still cross-module'],
      [`${API}/modules/lab/a.ts`, "export * from '../billing/x';", 're-export'],
      [`${API}/modules/lab/a.ts`, "export { y } from '../billing/x';", 'named re-export'],
      [`${API}/modules/lab/a.ts`, "const m = await import('../billing/x');", 'dynamic import'],
      [`${API}/modules/lab/a.ts`, "const m = require('../billing/x');", 'require'],
      [`${WEB}/features/lab/a.tsx`, "import { x } from '../billing/x';", 'web features folder'],
    ],
    good: [
      [`${API}/modules/lab/service/a.ts`, "import { y } from '../repo/y';", 'own module'],
      [`${API}/modules/lab/service/a.ts`, "import { y } from './b';", 'same dir'],
      [`${API}/modules/lab/service/a.ts`, "import { y } from '../../lab/z';", 'own module via explicit name'],
      [`${API}/modules/lab/service/a.ts`, "import { c } from '../../../core/x';", 'core is not a module folder'],
      [`${API}/modules/lab/service/a.ts`, "import Fastify from 'fastify';", 'package import'],
      [`${WEB}/features/lab/a.tsx`, "import { x } from '../../shared/x';", 'web shared folder'],
    ],
  },
  'no-foreign-schema-sql': {
    bad: [
      [`${API}/modules/identity/service/dl.ts`, 'const q = `select * from core.dead_letters`;', 'AB-21 / D-T12: identity service names core.dead_letters'],
      [`${API}/modules/identity/repository/dl.ts`, 'const q = `update core.dead_letters set state = $1`;', 'core.dead_letters excluded from identity/repository allowance'],
      [`${API}/modules/identity/repository/dl.ts`, "const q = 'delete from CORE.DEAD_LETTERS';", 'case-insensitive'],
      [`${API}/modules/identity/repository/dl.ts`, 'const q = `select 1 from "core"."dead_letters"`;', 'quoted identifiers'],
      [`${API}/modules/identity/sql/grant.sql`, 'GRANT SELECT ON core.dead_letters TO lims_app;', 'C2 SQL file granting on it'],
      [`${API}/modules/lab/repository/x.ts`, 'const q = `select * from core.tenants`;', 'other module naming core.'],
      [`${API}/modules/identity/service/x.ts`, 'const q = `select * from core.audit_log`;', 'identity outside repository/ naming core.'],
      [`services\\api\\src\\modules\\identity\\service\\dl.ts`, 'const q = `select * from core.dead_letters`;', 'backslash path (Windows) still caught'],
      [`./${API}/modules/identity/service/dl.ts`, 'const q = `select * from core.dead_letters`;', 'leading ./ still caught'],
    ],
    good: [
      [`${API}/core/deadletters/repo.ts`, 'const q = `select * from core.dead_letters where id = $1`;', 'core owns core.dead_letters'],
      [`${API}/core/x.ts`, 'const q = `select * from core.tenants`;', 'core owns core.*'],
      [`${API}/modules/identity/repository/m.ts`, 'const q = `select * from core.membership_branches where tenant_id = $1`;', 'CR-C2-002 allowlist'],
      [`${API}/modules/identity/service/dl.ts`, 'await ctx.core.deadLetters.list({ state: "dead" });', 'ctx.core.deadLetters API is the single write path (A8.6)'],
      [`${API}/modules/identity/repository/u.ts`, 'const q = `select * from identity.users`;', 'own schema'],
      [`${API}/modules/lab/repository/o.ts`, 'const q = `select * from lab.orders`;', 'own schema'],
    ],
  },
  'no-supabase-in-browser': {
    bad: [
      [`${WEB}/lib/a.ts`, "import { createClient } from '@supabase/supabase-js';", 'supabase-js in web'],
      [`${WEB}/lib/a.ts`, "import { createBrowserClient } from '@supabase/ssr';", 'ssr in web'],
      [`${WEB}/features/lab/a.tsx`, "import { createClient } from '@supabase/supabase-js';", 'tsx in web'],
      [`${WEB}/lib/a.ts`, "const s = await import('@supabase/supabase-js');", 'dynamic import'],
      [`${WEB}/lib/a.ts`, "const s = require('@supabase/ssr');", 'require'],
      [`${WEB}/lib/a.ts`, "import x from '@supabase/ssr/dist/main';", 'subpath'],
    ],
    good: [
      [`${API}/modules/identity/a.ts`, "import { createClient } from '@supabase/supabase-js';", 'server code may use it (BFF)'],
      [`${WEB}/lib/a.ts`, "import { z } from 'zod';", 'unrelated package'],
      [`${WEB}/lib/a.ts`, "import x from '@supabase-like/pkg';", 'lookalike scope'],
      [`${WEB}/lib/a.ts`, "// we never import @supabase/supabase-js here", 'comment'],
    ],
  },
  'no-bare-set': {
    bad: [
      [`${API}/core/db.ts`, "await c.query('SET app.tenant_id = $1', [t]);", 'bare SET'],
      [`${API}/core/db.ts`, "await c.query('set role lims_app');", 'lowercase'],
      [`${API}/core/db.ts`, 'await c.query(`SET SESSION app.user_id = 1`);', 'SET SESSION'],
      [`${API}/core/db.ts`, "await c.query('SET search_path TO app, public');", 'search_path'],
      [`${API}/core/db.ts`, "await c.query('select 1; SET role x');", 'SET after ;'],
      [`${API}/core/db.ts`, "await c.query('select set_config($1, $2, false)', [k, v]);", 'session-scoped set_config(…, false)'],
    ],
    good: [
      [`${API}/core/db.ts`, "await c.query('SET LOCAL app.tenant_id = $1', [t]);", 'SET LOCAL'],
      [`${API}/core/db.ts`, "await c.query('set local role lims_app');", 'lowercase SET LOCAL'],
      [`${API}/core/db.ts`, "await c.query('select set_config($1, $2, true)', [k, v]);", 'set_config(…, true)'],
      [`${API}/modules/lab/repository/u.ts`, 'const q = `update lab.orders set status = $1 where id = $2`;', 'UPDATE ... SET is not a bare SET statement'],
      [`${API}/modules/lab/repository/u.ts`, 'const q = `insert into t(a) values($1) on conflict (a) do update set b = excluded.b`;', 'ON CONFLICT DO UPDATE SET'],
      [`${API}/core/x.ts`, "const label = 'Reset the filter';", 'no SQL'],
    ],
  },
  'no-raw-bs-lib': {
    bad: [
      [`${WEB}/lib/d.ts`, "import { adToBs } from '@remotemerge/nepali-date-converter';", 'AC-0A-3.4 app code, converter'],
      [`${WEB}/lib/d.ts`, "import bs from 'bikram-sambat';", 'bikram-sambat'],
      [`apps/mobile/lib/d.dart`, "import 'package:nepali_utils/nepali_utils.dart';", 'Dart app code, nepali_utils'],
      [`${API}/modules/lab/d.ts`, "const x = require('bikram-sambat');", 'require'],
      [`${API}/modules/lab/d.ts`, "const x = await import('@remotemerge/nepali-date-converter');", 'dynamic import'],
      [`${API}/modules/lab/d.ts`, "import x from '@remotemerge/nepali-date-converter/dist/x';", 'subpath'],
      ['packages/shared-ts/src/money/m.ts', "import x from 'bikram-sambat';", 'shared-ts but not bsdate/'],
      ['packages/shared-ts/src/bsdate-extra/m.ts', "import x from 'bikram-sambat';", 'prefix lookalike of bsdate dir'],
      ['packages/shared-dart/lib/src/money/m.dart', "import 'package:nepali_utils/nepali_utils.dart';", 'shared-dart but not bsdate/'],
      ['packages\\shared-ts\\src\\money\\m.ts', "import x from 'bikram-sambat';", 'backslash path'],
    ],
    good: [
      ['packages/shared-ts/src/bsdate/impl.ts', "import { adToBs } from '@remotemerge/nepali-date-converter';", 'allowed wrapper (TS)'],
      ['packages/shared-ts/src/bsdate/sub/x.ts', "import { adToBs } from '@remotemerge/nepali-date-converter';", 'allowed subtree'],
      ['packages/shared-dart/lib/src/bsdate/impl.dart', "import 'package:nepali_utils/nepali_utils.dart';", 'allowed wrapper (Dart)'],
      [`${WEB}/lib/d.ts`, "import { adToBs } from '@lims/shared-ts/bsdate';", 'wrapper import is fine'],
      [`${WEB}/lib/d.ts`, "// uses nepali_utils via the wrapper", 'comment'],
      [`${WEB}/lib/d.ts`, "const lib = 'bikram-sambat';", 'plain string, not an import'],
    ],
  },
  'no-math-random': {
    bad: [
      [`${API}/core/t.ts`, 'const t = Math.random().toString(36);', 'token from Math.random'],
      [`${WEB}/lib/id.ts`, 'const id = Math.floor(Math.random() * 1e9);', 'id from Math.random'],
      [`${API}/core/t.ts`, "const r = Math['random']();", 'bracket access'],
      [`${API}/core/t.ts`, 'const r = Math.random ();', 'spacing'],
    ],
    good: [
      [`${API}/core/t.ts`, 'const b = crypto.getRandomValues(new Uint8Array(16));', 'CSPRNG'],
      [`${API}/core/t.ts`, 'const n = Math.floor(x / 2);', 'other Math'],
      [`${API}/core/t.ts`, '// never use Math.random() here', 'comment'],
      [`${API}/core/t.ts`, "const msg = 'Math.random is banned';", 'string literal'],
    ],
  },
  'no-new-date-in-domain': {
    bad: [
      [`${API}/modules/lab/domain/order.ts`, 'const now = new Date();', 'server domain'],
      [`${WEB}/features/lab/domain/order.ts`, 'const now = new Date();', 'web domain'],
      [`${API}/modules/lab/domain/order.ts`, 'const now = new Date( );', 'spacing'],
      [`${API}/modules/lab/domain/rules/r.ts`, 'return new Date ();', 'nested under domain/'],
    ],
    good: [
      [`${API}/modules/lab/domain/order.ts`, 'const now = clock.now();', 'injected clock'],
      [`${API}/modules/lab/service/order.ts`, 'const now = new Date();', 'outside domain/'],
      [`${API}/modules/lab/domainx/order.ts`, 'const now = new Date();', 'lookalike dir name'],
      [`${API}/modules/lab/domain/order.ts`, '// avoid new Date() here', 'comment'],
    ],
  },
  'no-dangerously-set-inner-html': {
    bad: [
      [`${WEB}/features/lab/a.tsx`, 'const A = () => <div dangerouslySetInnerHTML={{ __html: userHtml }} />;', 'variable input'],
      [`${WEB}/features/lab/a.tsx`, 'const A = () => <div dangerouslySetInnerHTML={{ __html: props.html }} />;', 'prop input'],
      [`${WEB}/features/lab/a.tsx`, 'const A = () => <div dangerouslySetInnerHTML={props.inner} />;', 'whole object non-constant'],
      [`${WEB}/features/lab/a.tsx`, 'const A = () => <div dangerouslySetInnerHTML={{ __html: `<b>${name}</b>` }} />;', 'template with interpolation'],
      [`${WEB}/features/lab/a.tsx`, "const A = () => <div dangerouslySetInnerHTML={{ __html: '<b>' + name }} />;", 'concatenation'],
    ],
    good: [
      [`${WEB}/features/lab/a.tsx`, "const A = () => <div dangerouslySetInnerHTML={{ __html: '<b>static</b>' }} />;", 'string-literal constant'],
      [`${WEB}/features/lab/a.tsx`, 'const A = () => <div dangerouslySetInnerHTML={{ __html: `<b>static</b>` }} />;', 'template without expressions'],
      [`${WEB}/features/lab/a.tsx`, 'const A = () => <div>{text}</div>;', 'no usage'],
      [`${WEB}/features/lab/a.tsx`, '// dangerouslySetInnerHTML={{ __html: x }} is banned', 'comment'],
    ],
  },
  'no-console': {
    bad: [
      [`${API}/core/a.ts`, "console.log('x');", 'log'],
      [`${API}/core/a.ts`, "console.error(err);", 'error'],
      [`${API}/core/a.ts`, "console.warn('x');", 'warn'],
      [`${API}/core/a.ts`, "console.info('x');", 'info'],
      [`${API}/core/a.ts`, "console.debug('x');", 'debug'],
      [`${WEB}/lib/a.tsx`, "console.log('x');", 'web'],
      [`${API}/core/a.ts`, "console['log']('x');", 'bracket access'],
    ],
    good: [
      [`${API}/core/a.ts`, "logger.info({ id }, 'x');", 'shared logger'],
      [`${API}/core/a.ts`, '// console.log is banned', 'comment'],
      [`${API}/core/a.ts`, "const s = 'console.log';", 'string literal'],
      [`${API}/core/a.ts`, 'const consoleWidth = 80;', 'identifier containing console'],
    ],
  },
};

const RULES = Object.keys(cases);

for (const rule of RULES) {
  test(`${rule}: module exports name + check`, async () => {
    const m = await load(rule);
    assert.equal(m.name, rule);
    assert.equal(typeof m.check, 'function');
  });

  cases[rule].bad.forEach(([path, src, why], i) => {
    test(`${rule}: violation #${i + 1} (${why})`, async () => {
      const { check } = await load(rule);
      const v = check(path, src);
      assert.ok(Array.isArray(v) && v.length >= 1, `expected >=1 violation for ${path}: ${src}`);
      for (const x of v) {
        assert.equal(x.rule, rule);
        assert.ok(Number.isInteger(x.line) && x.line >= 1, 'line is 1-based integer');
        assert.ok(typeof x.message === 'string' && x.message.length > 0);
      }
    });
  });

  cases[rule].good.forEach(([path, src, why], i) => {
    test(`${rule}: clean #${i + 1} (${why})`, async () => {
      const { check } = await load(rule);
      assert.deepEqual(check(path, src), [], `expected no violations for ${path}: ${src}`);
    });
  });
}

// --- specific behaviours ---
test('no-console: reports the correct line and every offence', async () => {
  const { check } = await load('no-console');
  const v = check(`${API}/core/a.ts`, "const a = 1;\nconsole.log(a);\nconst b = 2;\nconsole.error(b);\n");
  assert.deepEqual(v.map((x) => x.line), [2, 4]);
});

test('no-foreign-schema-sql: AB-21 message names core.dead_letters / ctx.core.deadLetters', async () => {
  const { check } = await load('no-foreign-schema-sql');
  const [v] = check(`${API}/modules/identity/service/dl.ts`, 'const q = `select * from core.dead_letters`;');
  assert.ok(v, 'violation expected');
  assert.match(v.message, /dead_letters/);
});

test('no-foreign-schema-sql: one clean line + one offending line in the same file → only the offender, right line', async () => {
  const { check } = await load('no-foreign-schema-sql');
  const src = 'const a = `select 1 from identity.users`;\nconst b = `select * from core.dead_letters`;\n';
  const v = check(`${API}/modules/identity/repository/x.ts`, src);
  assert.deepEqual(v.map((x) => x.line), [2]);
});

test('no-raw-bs-lib: AC-0A-3.4 message names the library and the wrapper', async () => {
  const { check } = await load('no-raw-bs-lib');
  const [v] = check(`${WEB}/lib/d.ts`, "import { adToBs } from '@remotemerge/nepali-date-converter';");
  assert.ok(v, 'violation expected');
  assert.match(v.message, /nepali-date-converter/);
  assert.match(v.message, /bsdate/);
});

test('no-supabase-in-browser: server file same import is clean while web file is not (path decides)', async () => {
  const { check } = await load('no-supabase-in-browser');
  const src = "import { createClient } from '@supabase/supabase-js';";
  assert.deepEqual(check(`${API}/core/a.ts`, src), []);
  assert.equal(check(`${WEB}/lib/a.ts`, src).length, 1);
});

test('rules never throw on empty or non-code input', async () => {
  for (const rule of RULES) {
    const { check } = await load(rule);
    assert.deepEqual(check(`${API}/core/a.ts`, ''), []);
    assert.doesNotThrow(() => check(`${API}/core/a.ts`, '\u0000�{{{ ((( `unterminated'));
  }
});
