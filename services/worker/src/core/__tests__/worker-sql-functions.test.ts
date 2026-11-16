// T0B-ASYNC-1 done_when (5), catalog half: the pgTAP file db/tests/identity/T0B-ASYNC-1_worker_grants.test.sql lists every app.* function the worker
// SQL calls and asserts lims_worker may execute it. This test keeps that list equal to the worker sources, so a new call cannot dodge the grant check.
// Static: needs no database. Calls in comments are ignored. Dynamic SQL built from a variable is invisible (documented limit).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const WORKER_SRC = join(ROOT, 'services', 'worker', 'src');
const PGTAP = join(ROOT, 'db', 'tests', 'identity', 'T0B-ASYNC-1_worker_grants.test.sql');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e) && !/\.(test|spec|fakes?)\.ts$/.test(e)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1').replace(/^\s*--[^\n]*/gm, '');

// Files scanned: the worker sources AND the api files they import directly (e.g. a repository the worker task calls), plus
// definerTask(<task>, '<fn>') whose SQL is `SELECT app.${fn}()` (identity tasks/shared.ts).
// api files that hold SQL a worker task runs (a worker task imports the repository). Explicit, not "everything the worker imports": that would
// pull in api-only definers (mfa.repo, link.service) the worker never executes. Add a file here when a new worker task imports an api repository.
// T0B-ASYNC-2: the homecollection tasks run api repositories whose SQL calls app.current_actor_id() through shared.repo.ts (lims_worker inherits lims_app's EXECUTE).
const HC = 'services/api/src/modules/homecollection/';
const API_FILES_RUN_BY_WORKER = [
  `${HC}repository/housekeeping.repo.ts`, `${HC}repository/shared.repo.ts`, `${HC}repository/visits.repo.ts`, `${HC}repository/handovers.repo.ts`,
  `${HC}repository/visitFlags.repo.ts`, `${HC}repository/visitSpecimens.repo.ts`, `${HC}repository/routes.repo.ts`,
  `${HC}route.service.ts`, `${HC}specimen.service.ts`,
];
function scanned(): string[] {
  return [...walk(WORKER_SRC), ...API_FILES_RUN_BY_WORKER.map((f) => join(ROOT, f))];
}

function calledFunctions(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (fn: string, f: string) => out.set(fn, [...(out.get(fn) ?? []), f.slice(ROOT.length + 1).replace(/\\/g, '/')]);
  for (const f of scanned()) {
    const s = stripComments(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/\bapp\.([a-z_][a-z0-9_]*)\s*\(/g)) add(m[1]!, f);
    for (const m of s.matchAll(/\bdefinerTask\(\s*[A-Za-z_]+\s*,\s*'([a-z_][a-z0-9_]*)'/g)) add(m[1]!, f);
  }
  return out;
}

describe('worker SQL -> app.* functions -> pgTAP grant catalog', () => {
  const called = calledFunctions();
  const sql = readFileSync(PGTAP, 'utf8');
  const listed = new Set([...(/CREATE TEMP TABLE worker_app_fns\(fn\) AS VALUES([\s\S]*?);/.exec(sql)?.[1] ?? '').matchAll(/\('([a-z_0-9]+)'\)/g)].map((m) => m[1]!));

  it('the scan finds the calls we know the worker makes (positive control)', () => {
    for (const fn of ['enqueue_job', 'identity_login_context', 'cron_tenant_ids', 'queue_depth']) expect([...called.keys()], fn).toContain(fn);
  });

  it('every app.* function called by worker SQL is in the pgTAP catalog list', () => {
    const missing = [...called].filter(([fn]) => !listed.has(fn)).map(([fn, files]) => `${fn} (${files[0]})`);
    expect(missing, `add to worker_app_fns in ${PGTAP}: ${missing.join(', ')}`).toEqual([]);
  });

  it('the pgTAP list names no function the worker does not call (no stale rows)', () => {
    expect([...listed].filter((fn) => !called.has(fn))).toEqual([]);
  });

  it('the pgTAP file asserts the grant for lims_worker and that PUBLIC and lims_app still lack it', () => {
    expect(sql).toMatch(/has_function_privilege\('lims_worker', 'app\.identity_login_context\(uuid\)', 'EXECUTE'\)/);
    expect(sql).toMatch(/NOT has_function_privilege\('lims_app'/);
    expect(sql).toMatch(/a\.grantee = 0/);
  });
});
