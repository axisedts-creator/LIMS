// CI dry-run / job selector (02-TRD §15.1 "Runs" column). Reads trigger globs from the workflow itself
// (job-level `TRIGGER_PATHS: "<glob> <glob> ..."`; a job without it runs always), so there is no second copy.
// Usage:
//   node tools/lint/ci-plan.ts --files <changed-paths.txt> [--workflow .github/workflows/pr.yml] [--job <id>]
//     stdout: JSON array (sorted) of job ids a pull_request with those changes runs;
//             with --job: `run=true|false` (for $GITHUB_OUTPUT).
// Exit 0 ok, 2 bad usage / unreadable input / path escaping the repo (fail closed).
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
class Usage extends Error {}

export function globRe(g: string): RegExp {
  let re = '';
  for (let i = 0; i < g.length; ) {
    if (g.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; }
    else if (g.startsWith('**', i)) { re += '.*'; i += 2; }
    else if (g[i] === '*') { re += '[^/]*'; i++; }
    else if (g[i] === '?') { re += '[^/]'; i++; }
    else if (g[i] === '{') {
      const j = g.indexOf('}', i);
      if (j < 0) throw new Usage(`unclosed { in glob ${g}`);
      re += '(?:' + g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = j + 1;
    } else { re += g[i].replace(/[.+^$()|[\]\\]/g, '\\$&'); i++; }
  }
  return new RegExp('^' + re + '$');
}

// Text parse (no YAML dep): `jobs:` at col 0, job ids at 2-space indent, TRIGGER_PATHS anywhere in the job block.
export function jobTriggers(text: string): Map<string, string[] | null> {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  if (start < 0) throw new Usage('workflow has no top-level jobs:');
  const jobs = new Map<string, string[] | null>();
  let cur: string | null = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && !l.startsWith('#')) break;
    const m = /^  (?:"([\w-]+)"|'([\w-]+)'|([\w-]+)):\s*(#.*)?$/.exec(l);
    if (m) { cur = m[1] ?? m[2] ?? m[3]; jobs.set(cur, null); continue; }
    const t = /^\s+TRIGGER_PATHS:\s*(["']?)(.*)\1\s*$/.exec(l);
    if (cur && t) {
      const globs = t[2].split(/\s+/).filter(Boolean);
      if (!globs.length) throw new Usage(`empty TRIGGER_PATHS in job ${cur}`);
      jobs.set(cur, globs);
    }
  }
  if (!jobs.size) throw new Usage('workflow defines no jobs');
  return jobs;
}

export function normalize(p: string): string {
  const n = posix.normalize(p.trim().replace(/\\/g, '/')).replace(/^(\.\/)+/, '');
  if (n === '..' || n.startsWith('../') || n.startsWith('/')) throw new Usage(`path escapes the repo: ${p}`);
  return n;
}

export function plan(files: string[], jobs: Map<string, string[] | null>): string[] {
  const out: string[] = [];
  for (const [id, globs] of jobs) {
    if (globs === null) { out.push(id); continue; }
    const res = globs.map(globRe);
    if (files.some((f) => res.some((r) => r.test(f)))) out.push(id);
  }
  return out.sort();
}

function main(argv: string[]): number {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!['--files', '--workflow', '--job'].includes(k) || v === undefined) throw new Usage(`bad argument ${k}`);
    a[k] = v;
  }
  if (!a['--files']) throw new Usage('--files is required');
  let files: string[], wf: string;
  try {
    files = readFileSync(a['--files'], 'utf8').split(/\r?\n/).filter((l) => l.trim()).map(normalize);
    wf = readFileSync(a['--workflow'] ?? posix.join(ROOT.replace(/\\/g, '/'), '.github/workflows/pr.yml'), 'utf8');
  } catch (e) {
    if (e instanceof Usage) throw e;
    throw new Usage(`cannot read input: ${(e as Error).message}`);
  }
  const jobs = jobTriggers(wf);
  const planned = plan(files, jobs);
  if (a['--job']) {
    if (!jobs.has(a['--job'])) throw new Usage(`unknown job ${a['--job']}`);
    process.stdout.write(`run=${planned.includes(a['--job'])}\n`);
  } else process.stdout.write(JSON.stringify(planned) + '\n');
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`ci-plan: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
