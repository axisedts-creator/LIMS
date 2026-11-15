#!/usr/bin/env node
// SEC-AUTHZ-1 (LD-235, audit 2026-11-15 check 3.3): static, read-only classifier of every operationId in contracts/openapi/*.yaml.
// Prints ONE deterministic JSON document { total, counts, operations } to stdout and writes nothing.
// Binding: C0 02-TRD 6.2 / 7.2, 07-SECURITY AB-5. The classifier reads text only; it never runs a handler.
//
// Class order of decision (first hit wins):
//   1. x-permission platform.*                      -> platform   (IdentityPort.assertRole rejects platform.*, IdentityPort.impl.ts:229)
//   2. security bffSession (identity session flow)  -> identity-session-flow
//   3. security paymentCallbackToken / path-token callback -> scheme-callback-token
//   4. security deviceToken / queueDisplayToken     -> scheme-device;  portalSession -> scheme-portal;  patientPreAuth -> scheme-patient-pre-auth
//   5. x-public (no scheme)                         -> public
//   6. bearerJwt operations: follow handler -> service calls statically for IdentityPort.assertRole(...):
//        no handler definition found                -> stub
//        permission asserted equals x-permission    -> guarded-exact
//        permission asserted differs                -> guarded-other (permission = the asserted code, sorted, joined by ",")
//        no assertRole reachable                    -> unguarded
//        assertRole reachable, permission not a literal/const we can resolve -> inconclusive (with reason)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTRACTS = path.join(ROOT, 'contracts', 'openapi');
const MODULES = path.join(ROOT, 'services', 'api', 'src', 'modules');

export const CLASSES = [
  'public', 'identity-session-flow', 'scheme-callback-token', 'scheme-device', 'scheme-portal', 'scheme-patient-pre-auth',
  'platform', 'guarded-exact', 'guarded-other', 'unguarded', 'stub', 'inconclusive',
];

// LD-235 / verifier A: the identity session flow (6 operations without an x-permission). The other identity_auth public
// operations (password recovery, email token, setup, partner / patient / mobile pre-auth) stay class public or a scheme class.
const SESSION_FLOW = new Set(['loginStaff', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession']);

// ---------- contracts ----------
function readContracts() {
  const ops = {};
  for (const f of readdirSync(CONTRACTS).filter((n) => n.endsWith('.yaml') && !n.startsWith('_')).sort()) {
    const L = readFileSync(path.join(CONTRACTS, f), 'utf8').split(/\r?\n/);
    let cur = null;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      let m = l.match(/^ {6}operationId:\s*(\S+)\s*$/);
      if (m) { cur = { module: f.replace(/\.yaml$/, ''), permission: null, isPublic: false, publicNote: '', schemes: [] }; ops[m[1]] = cur; continue; }
      if (!cur) continue;
      if ((m = l.match(/^ {6}x-permission:\s*(\S+)\s*$/))) cur.permission = m[1];
      if ((m = l.match(/^ {6}x-public:\s*(.*)$/))) { cur.isPublic = true; cur.publicNote = m[1].replace(/^["']|["']$/g, ''); }
      if (/^ {6}security:/.test(l)) {
        if (/\[\s*\]/.test(l)) continue;
        let j = i + 1;
        while (j < L.length && /^ {8}- /.test(L[j])) { const s = L[j].match(/^ {8}- \{?\s*(\w+)/); if (s) cur.schemes.push(s[1]); j++; }
      }
    }
  }
  return ops;
}

// ---------- tiny TS lexer: mask comments and string contents so braces can be matched ----------
function mask(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let lastSig = '';
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; blank(i, j); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; lastSig = c; continue;
    }
    if (c === '`') {
      let j = i + 1, depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '}') depth--;
        j++;
      }
      blank(i + 1, j); i = j + 1; lastSig = '`'; continue;
    }
    if (c === '/' && '(,=:[!&|?{};'.includes(lastSig || ';')) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; lastSig = '/'; continue; }
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join('');
}

// match the closer of the opener at index i in masked text
function closer(m, i) {
  const open = m[i];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < m.length; j++) {
    if (m[j] === open) depth++;
    else if (m[j] === close && --depth === 0) return j;
  }
  return m.length - 1;
}

// index of the body '{' after a parameter list ending at p: skips type-literal braces of a return type (preceded by < : | & , = or ( )
function bodyStart(m, p) {
  let i = p + 1, prev = ')';
  for (; i < m.length; i++) {
    const c = m[i];
    if (c === ';' || (c === '=' && m[i + 1] === '>') ) return -1; // overload signature or arrow
    if (c === '{') { if (!'<:|&,=('.includes(prev)) return i; i = closer(m, i); prev = '}'; continue; }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

// end of a statement/expression starting at i: first depth-0 ';' or ',' (when commaEnds) or closer of an enclosing bracket
function exprEnd(m, i, commaEnds) {
  let depth = 0;
  for (let j = i; j < m.length; j++) {
    const c = m[j];
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) { if (depth === 0) return j; depth--; }
    else if (depth === 0 && (c === ';' || (commaEnds && c === ','))) return j;
    else if (depth === 0 && c === '\n' && !commaEnds && /^(export|const|let|var|function|async function|class|type|interface|import)\b/.test(m.slice(j + 1, j + 20))) return j;
  }
  return m.length;
}

// ---------- module code index ----------
function listTs(dir, acc = []) {
  for (const n of readdirSync(dir).sort()) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') listTs(p, acc); }
    else if (n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'new', 'typeof', 'void', 'delete', 'super', 'import', 'else', 'do', 'throw']);

function indexFile(file) {
  const text = readFileSync(file, 'utf8');
  const m = mask(text);
  const defs = new Map(); // name -> [bodyText]
  const add = (name, a, b) => { if (!defs.has(name)) defs.set(name, []); defs.get(name).push(text.slice(a, b)); };
  let r;
  const fn = /\bfunction\s*\*?\s*(\w+)\s*(?:<[^>(]*>)?\s*\(/g;
  while ((r = fn.exec(m))) { const p = closer(m, r.index + r[0].length - 1); const b = bodyStart(m, p); if (b >= 0) add(r[1], r.index, closer(m, b) + 1); }
  const vr = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=;]*?)?=(?!=)/g;
  while ((r = vr.exec(m))) add(r[1], r.index, exprEnd(m, r.index + r[0].length, false));
  const me = /(?:^|[\n{};,])\s*(?:(?:public|private|protected|static|async|readonly)\s+)*(\w+)\s*(?:<[^>(]*>)?\s*\(/g;
  while ((r = me.exec(m))) {
    if (KEYWORDS.has(r[1])) continue;
    const o = r.index + r[0].length - 1;
    const p = closer(m, o);
    const b = bodyStart(m, p);
    if (b >= 0) add(r[1], r.index, closer(m, b) + 1);
  }
  const pr = /(?:^|[\n{,])\s*(\w+)\s*:\s*(?=\S)/g;
  while ((r = pr.exec(m))) { if (!KEYWORDS.has(r[1])) add(r[1], r.index, exprEnd(m, r.index + r[0].length, true)); }
  // imports: name -> resolved file (relative specifiers only)
  const imports = new Map();
  const im = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;
  while ((r = im.exec(text))) {
    if (!r[2].startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), r[2].replace(/\.js$/, ''));
    const target = [base + '.ts', path.join(base, 'index.ts')].find((p) => existsSync(p));
    if (!target) continue;
    for (const part of r[1].split(',')) { const nm = part.trim().split(/\s+as\s+/).pop(); if (nm) imports.set(nm, target); }
  }
  // namespace imports: import * as s from './x.js'  -> s.member() resolves to member defs of that file
  const ns = new Map();
  const nm = /\bimport\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s*'(\.[^']+)'/g;
  while ((r = nm.exec(text))) {
    const base = path.resolve(path.dirname(file), r[2].replace(/\.js$/, ''));
    const target = [base + '.ts', path.join(base, 'index.ts')].find((p) => existsSync(p));
    if (target) ns.set(r[1], target);
  }
  return { file, text, defs, imports, ns };
}

const moduleCache = new Map();
export function loadModule(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  const dir = path.join(MODULES, name);
  const files = existsSync(dir) ? listTs(dir).map(indexFile) : [];
  const byFile = new Map(files.map((f) => [f.file, f]));
  // string constants for permission resolution: NAME = 'a.b.c' and OBJ = { key: 'a.b.c' }
  const consts = new Map();
  for (const f of files) {
    let r;
    const c1 = /\b(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(['"])([a-z][\w.]*)\2/g;
    while ((r = c1.exec(f.text))) consts.set(r[1], r[3]);
    // OBJ = { key: 'a.b.c', ... } (also Object.freeze({...}) and `as const`): stored as "OBJ.key"
    const mk = mask(f.text);
    const c2 = /\b(?:const|let)\s+(\w+)\s*(?::[^=]*)?=\s*(?:Object\.freeze\(\s*)?\{/g;
    while ((r = c2.exec(mk))) {
      const open = r.index + r[0].length - 1;
      const body = f.text.slice(open, closer(mk, open) + 1);
      for (const kv of body.matchAll(/\b(\w+)\s*:\s*(['"])([a-z][\w.]*)\2/g)) consts.set(`${r[1]}.${kv[1]}`, kv[3]);
    }
  }
  const mod = { name, files, byFile, consts };
  moduleCache.set(name, mod);
  return mod;
}

// Permissions in a body. Many handlers assert through a helper (assertRole(ctx, { permission }) with the code passed in), so the
// call-site argument is not parsed. Instead: if assertRole is reachable, every KNOWN permission code (a code that appears as an
// x-permission in some contract) found as a string literal or a string constant in the reachable bodies is taken as asserted.
// This over-approximates (a code used for another purpose in the same closure counts); the snapshot records it as evidence only.
let KNOWN = new Set();
function scanAssert(body, mod, acc) {
  if (/\bassertRole\b/.test(body)) acc.hasAssert = true;
  for (const r of body.matchAll(/(['"`])([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\1/g)) if (KNOWN.has(r[2])) acc.perms.add(r[2]);
  for (const r of body.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\b/g)) { const v = mod.consts.get(r[1]); if (v && KNOWN.has(v)) acc.perms.add(v); }
}

function identifiers(body) {
  const out = new Set();
  for (const r of body.matchAll(/\b([A-Za-z_]\w*)\b/g)) out.add(r[1]);
  return out;
}

// walk from a def body through same-file and imported-file defs
export function walk(mod, startFile, startBody) {
  const acc = { hasAssert: false, perms: new Set(), unresolved: new Set() };
  const seen = new Set();
  const queue = [{ file: startFile, body: startBody, depth: 0 }];
  while (queue.length) {
    const { file, body, depth } = queue.shift();
    scanAssert(body, mod, acc);
    if (depth >= 6) continue;
    const f = mod.byFile.get(file);
    if (!f) continue;
    const follow = (target, id) => {
      if (!target || !target.defs.has(id)) return;
      const key = `${target.file}#${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      for (const b of target.defs.get(id)) queue.push({ file: target.file, body: b, depth: depth + 1 });
    };
    for (const id of identifiers(body)) {
      if (f.defs.has(id)) follow(f, id);
      else if (f.imports.has(id)) follow(mod.byFile.get(f.imports.get(id)), id);
    }
    // member calls: alias.member() through a namespace import, and obj.member() where a file this file imports defines member
    const imported = new Set([...f.imports.values(), ...f.ns.values()]);
    for (const r of body.matchAll(/\b(\w+)\s*\??\.\s*(\w+)\s*\(/g)) {
      if (f.ns.has(r[1])) follow(mod.byFile.get(f.ns.get(r[1])), r[2]);
      else if (!f.defs.has(r[2]) && !f.imports.has(r[2])) for (const t of imported) follow(mod.byFile.get(t), r[2]);
    }
  }
  return acc;
}

// find the definition(s) of a handler for operationId within a module
export function findHandler(mod, opId) {
  const idx = mod.files.find((f) => /handlers[\\/]index\.ts$/.test(f.file));
  const pref = idx?.imports.get(opId);
  const hits = [];
  for (const f of mod.files) {
    if (!f.defs.has(opId)) continue;
    for (const b of f.defs.get(opId)) hits.push({ file: f.file, body: b });
  }
  // a handler of the same name that handlers/index.ts imports wins over unregistered variants
  const chosen = pref ? hits.filter((h) => h.file === pref) : hits;
  return (chosen.length ? chosen : hits).filter((h) => !/handlers[\\/]index\.ts$/.test(h.file) || /=>|\bfunction\b/.test(h.body));
}

// ---------- classify ----------
function classify(id, c) {
  const e = { class: '', x_permission: c.permission };
  const sch = new Set(c.schemes);
  if (c.permission?.startsWith('platform.')) {
    e.class = 'platform';
    e.reason = 'platform.* is rejected by IdentityPort.assertRole (IdentityPort.impl.ts:229); needs its own guard in the central stage';
  } else if (SESSION_FLOW.has(id)) {
    e.class = 'identity-session-flow'; e.reason = 'identity login and session flow (x-context identity_auth); the session token authenticates, no staff permission';
  } else if (sch.has('paymentCallbackToken') || (c.isPublic && /path token/i.test(c.publicNote))) {
    e.class = 'scheme-callback-token'; e.reason = 'authenticated by a callback or path token, not a session';
  } else if (sch.has('deviceToken') || sch.has('queueDisplayToken')) {
    e.class = 'scheme-device'; e.reason = `scheme ${[...sch].join('+')}`;
  } else if (sch.has('portalSession')) {
    e.class = 'scheme-portal'; e.reason = 'scheme portalSession';
  } else if (sch.has('patientPreAuth')) {
    e.class = 'scheme-patient-pre-auth'; e.reason = 'scheme patientPreAuth';
  } else if (c.isPublic) {
    e.class = 'public'; e.reason = `x-public: ${c.publicNote || 'declared public'}`;
  } else if (c.module === 'core') {
    e.class = 'inconclusive'; e.reason = 'core operation without x-public or x-permission; no handler module to scan';
  } else {
    const mod = loadModule(c.module);
    const hs = findHandler(mod, id);
    if (hs.length === 0) { e.class = 'stub'; e.reason = 'no handler definition found; registered through the module stub (common.internal or 501)'; return e; }
    const acc = { hasAssert: false, perms: new Set(), unresolved: new Set() };
    for (const h of hs) {
      const a = walk(mod, h.file, h.body);
      a.perms.forEach((p) => acc.perms.add(p));
      a.unresolved.forEach((u) => acc.unresolved.add(u));
      acc.hasAssert ||= a.hasAssert;
    }
    const perms = acc.hasAssert ? [...acc.perms].sort() : [];
    if (perms.includes(c.permission)) { e.class = 'guarded-exact'; e.permission = c.permission; }
    else if (perms.length) { e.class = 'guarded-other'; e.permission = perms.join(','); e.reason = `asserts ${perms.join(',')} but x-permission is ${c.permission}`; }
    else if (acc.hasAssert) { e.class = 'inconclusive'; e.reason = 'assertRole is reachable but no permission code is a literal or a same-module constant (code comes from an imported table, a destructured array or a helper argument); a handler-level read is needed to name it'; }
    else { e.class = 'unguarded'; e.reason = 'no IdentityPort.assertRole reachable from the handler through same-module calls'; }
  }
  return e;
}

function stable(v, ind = '') {
  if (Array.isArray(v)) return `[${v.map((x) => stable(x, ind)).join(',')}]`;
  if (v && typeof v === 'object') {
    const ks = Object.keys(v).sort();
    if (!ks.length) return '{}';
    return `{\n${ks.map((k) => `${ind}  ${JSON.stringify(k)}: ${stable(v[k], ind + '  ')}`).join(',\n')}\n${ind}}`;
  }
  return JSON.stringify(v);
}

export function run() {
  const contracts = readContracts();
  KNOWN = new Set(Object.values(contracts).map((c) => c.permission).filter(Boolean));
  const operations = {};
  const counts = Object.fromEntries(CLASSES.map((k) => [k, 0]));
  for (const id of Object.keys(contracts).sort()) {
    const e = classify(id, contracts[id]);
    operations[id] = e;
    counts[e.class]++;
  }
  return { total: Object.keys(operations).length, counts, operations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(stable(run()) + '\n');
}
