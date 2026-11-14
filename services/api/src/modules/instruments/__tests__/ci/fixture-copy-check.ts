// C7 API-T07 — CI check: byte-for-byte compare of two fixture trees (shared canonical-JSON / config fixtures). 02-TRD §16, CR-C7-013.
// Written by the TESTER role under LD-56 (2026-11-07). No newline/BOM normalisation. Missing dir or two empty trees = problem (fail closed).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CheckResult { ok: boolean; problems: string[] }

function files(dir: string, label: string, problems: string[]): Map<string, string> | undefined {
  try { if (!statSync(dir).isDirectory()) throw new Error('not a directory'); } catch { problems.push(`${label}: directory missing or unreadable`); return undefined; }
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string): void => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (e.isFile()) out.set(r, join(abs, e.name));
    }
  };
  walk(dir, '');
  return out;
}

export function checkFixtureCopies(dirA: string, dirB: string): CheckResult {
  const problems: string[] = [];
  const a = files(dirA, 'A', problems);
  const b = files(dirB, 'B', problems);
  if (a && b) {
    if (a.size === 0 && b.size === 0) problems.push('both fixture directories are empty (nothing compared)');
    for (const [rel, pa] of a) {
      const pb = b.get(rel);
      if (pb === undefined) problems.push(`${rel}: only in A`);
      else if (!readFileSync(pa).equals(readFileSync(pb))) problems.push(`${rel}: bytes differ`);
    }
    for (const rel of b.keys()) if (!a.has(rel)) problems.push(`${rel}: only in B`);
  }
  return { ok: problems.length === 0, problems };
}

function main(): void {
  const [a, b] = process.argv.slice(2);
  if (!a || !b) { console.error('usage: fixture-copy-check <dirA> <dirB>'); process.exit(2); }
  const r = checkFixtureCopies(a, b);
  for (const p of r.problems) console.error(p);
  console.log(r.ok ? 'fixture-copy-check: ok' : `fixture-copy-check: ${r.problems.length} problem(s)`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
