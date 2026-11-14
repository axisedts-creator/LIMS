// CI job `deps` (02-TRD §15.1 gates 12/13): licence allowlist (CV §15.2), banned list (CV §15.3) and the
// `pnpm audit --audit-level critical` triage file check. Run after `pnpm install --frozen-lockfile`.
// Usage: node tools/lint/check-deps.ts --triage <deps-triage.json> [--audit <pnpm-audit.json>] [--root <dir>]
// Triage file [CONV]: { "advisories": [{ "id", "reason", "until": "YYYY-MM-DD" }],
//                       "licenceReviews": [{ "name", "licence", "approval" }] }  (approval = C0 + founder record)
// Exit 0 clean, 1 findings, 2 bad usage / unreadable or malformed input (fail closed).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

class Usage extends Error {}

// CV §15.2 Allowed; LD-15 (2026-11-07) adds PostgreSQL and BlueOak-1.0.0.
const ALLOWED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib',
  'Unicode-DFS-2016', 'Unicode-3.0', 'OFL-1.1', 'PostgreSQL', 'BlueOak-1.0.0']);
// CV §15.3 (npm / pub package names). bikram-sambat may only be a test oracle -> banned in `dependencies` only.
const BANNED_ANY = [/^pdf-lib$/, /^bullmq$/, /^bull$/, /^bee-queue$/, /^@powersync\//, /^powersync$/,
  /^electric-sql$/, /^@electric-sql\//, /^sqlcipher_flutter_libs$/];
const BANNED_RUNTIME = [/^bikram-sambat$/];
const BANNED_IN_WEB = [/^@supabase\/supabase-js$/, /^@supabase\/ssr$/]; // staff web browser bundle (04 S4; REQ-SEC-068)

function readJson(f: string): any {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new Usage(`cannot read ${f}: ${(e as Error).message}`); }
}

// SPDX expression is allowed when some OR-alternative has only allowed ids.
export function licenceOk(expr: string): boolean {
  return expr.replace(/[()]/g, ' ').split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

function installed(root: string): { name: string; licence: string }[] {
  const dir = join(root, 'node_modules', '.pnpm');
  if (!existsSync(dir)) throw new Usage('node_modules/.pnpm missing: run pnpm install --frozen-lockfile first');
  const out: { name: string; licence: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const m = /^((?:@[^+]+\+)?[^@]+)@/.exec(entry);
    if (!m) continue;
    const name = m[1].replace('+', '/');
    const f = join(dir, entry, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(f)) continue;
    const j = readJson(f);
    const licence = typeof j.license === 'string' ? j.license : j.license?.type ?? (j.licenses ?? []).map((x: any) => x.type).join(' OR ');
    out.push({ name, licence: licence ?? '' });
  }
  if (!out.length) throw new Usage('no installed packages found (never pass vacuously)');
  return out;
}

function workspaceManifests(root: string): { file: string; deps: string[] }[] {
  const out: { file: string; deps: string[] }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = d ? `${d}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name === 'package.json') out.push({ file: rel, deps: Object.keys(readJson(join(root, rel)).dependencies ?? {}) });
    }
  };
  walk('');
  return out;
}

function pubPackages(root: string): string[] {
  const f = join(root, 'pubspec.lock');
  if (!existsSync(f)) return [];
  return [...readFileSync(f, 'utf8').matchAll(/^ {2}([a-z0-9_]+):\s*$/gm)].map((m) => m[1]);
}

function main(argv: string[]): number {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--triage', '--audit', '--root'].includes(argv[i]) || argv[i + 1] === undefined) throw new Usage(`bad argument ${argv[i]}`);
    a[argv[i]] = argv[i + 1];
  }
  if (!a['--triage']) throw new Usage('need --triage');
  const root = a['--root'] ?? '.';
  const triage = readJson(a['--triage']);
  if (!Array.isArray(triage.advisories) || !Array.isArray(triage.licenceReviews)) throw new Usage('triage needs advisories[] and licenceReviews[]');
  const errs: string[] = [];

  // licence allowlist (CV §15.2); review-required / unknown ids need a recorded C0 + founder approval
  const reviewed = new Set(triage.licenceReviews.filter((r: any) => r?.name && r?.approval).map((r: any) => r.name));
  for (const p of installed(root)) {
    if (p.name.startsWith('@pnpm/')) continue; // pnpm's own platform binaries: tooling, not shipped code
    if (!licenceOk(p.licence) && !reviewed.has(p.name)) errs.push(`licence: ${p.name} "${p.licence || 'none'}" not in CV §15.2 allowlist (needs C0 + founder review)`);
    if (BANNED_ANY.some((r) => r.test(p.name))) errs.push(`banned: ${p.name} (CV §15.3)`);
  }
  // banned list (CV §15.3)
  for (const m of workspaceManifests(root)) {
    for (const d of m.deps) {
      if (BANNED_RUNTIME.some((r) => r.test(d))) errs.push(`banned: ${d} in ${m.file} dependencies (test oracle only, CV §15.3)`);
      if (m.file.startsWith('apps/web/') && BANNED_IN_WEB.some((r) => r.test(d))) errs.push(`banned: ${d} in ${m.file} (staff web uses the BFF, CV §15.3)`);
    }
  }
  for (const d of pubPackages(root)) if (BANNED_ANY.some((r) => r.test(d))) errs.push(`banned: ${d} in pubspec.lock (CV §15.3)`);

  // pnpm audit triage: every critical advisory must be triaged with an unexpired `until`
  if (a['--audit']) {
    const audit = readJson(a['--audit']);
    if (!audit || typeof audit.advisories !== 'object' || audit.advisories === null) throw new Usage('audit JSON has no advisories object (audit failed?)');
    const today = new Date().toISOString().slice(0, 10);
    const ok = new Set(triage.advisories.filter((t: any) => t?.id && t?.reason && /^\d{4}-\d{2}-\d{2}$/.test(t?.until ?? '') && t.until >= today).map((t: any) => String(t.id)));
    for (const adv of Object.values<any>(audit.advisories)) {
      if (adv?.severity !== 'critical') continue;
      const ids = [String(adv.id), adv.github_advisory_id].filter(Boolean);
      if (!ids.some((i) => ok.has(i))) errs.push(`audit: critical ${ids.join('/')} in ${adv.module_name} not in triage file (or expired)`);
    }
  }

  for (const e of errs) console.error(`deps: ${e}`);
  return errs.length ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`deps: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
}
