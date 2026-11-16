// T0B-CNTPOL-1 (C0, LD-257, CR-C0-T0B-REVIEW-1-002, LD-232 item 3): static checks of
//   db/migrations/20261116030000_engagement__narrow_number_counters_access.sql and db/policies/engagement.sql.
// engagement.number_counters gets three RESTRICTIVE policies TO lims_app (SELECT / INSERT / UPDATE, name number_counters__<cmd>__nonstaff_keys):
//   user + system actors unchanged; patient actor only on counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'; device and every other actor: nothing.
// plus one BEFORE UPDATE trigger function + trigger (pattern of engagement.guard_actor_columns): a patient actor cannot LOWER last_value (closes the OTP cap / link failure limit reset).
// The migration: leading `SET LOCAL ROLE lims_owner` (02-CONVENTIONS.md:717, db/tools/check-migrations.ts, T0B-MFAPOL-1 ruling), then exactly 3 CREATE POLICY, 1 CREATE FUNCTION, 1 CREATE TRIGGER; no DROP / REVOKE / GRANT.
// The key regexes are run against keys produced by the REAL builders (their source is extracted from services/ and evaluated), so a key the code really builds cannot be refused.
// NOT RUN in the lane: db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql (pgTAP) and the migration; the founder runs db/tests/run-suites.sh before push-cloud.ps1.
// Run: node --test tests/db/T0B-CNTPOL-1.static.test.mjs      (T0BCP1_ROOT=<dir> points the checks at another tree)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = process.env.T0BCP1_ROOT ? resolve(process.env.T0BCP1_ROOT) + '/' : repo;
const MIG = '20261116030000_engagement__narrow_number_counters_access.sql';
const TBL = 'engagement.number_counters';
const KEY_RE = '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$';
const ACT = '(SELECT app.current_actor_type())';
const PRED = `${ACT} IN ('user','system') OR (${ACT} = 'patient' AND counter_key ~ '${KEY_RE}')`;
const POLS = {   // name -> { cmd, using, check }
  number_counters__select__nonstaff_keys: { cmd: 'SELECT', using: PRED, check: '' },
  number_counters__insert__nonstaff_keys: { cmd: 'INSERT', using: '', check: PRED },
  number_counters__update__nonstaff_keys: { cmd: 'UPDATE', using: PRED, check: PRED },
};
const ANY_T = "tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) IN ('user','system','patient','device')";

// ------------------------------------------------------------------------------------------------ helpers
const strip = (s) => s.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const ws = (s) => s.replace(/\s+/g, ' ').trim();
const norm = (s) => ws(s).replace(/\s*([(),=~])\s*/g, '$1').toLowerCase();
function unwrap(x) {   // "( a AND (b) )" -> "a AND (b)" only when the first "(" closes at the very end
  x = x.trim();
  if (x[0] !== '(' || x.at(-1) !== ')') return x;
  let d = 0;
  for (let i = 0; i < x.length - 1; i++) { d += x[i] === '(' ? 1 : x[i] === ')' ? -1 : 0; if (d === 0) return x; }
  return x.slice(1, -1).trim();
}
// statement splitter: ';' outside '...' strings and outside $tag$ ... $tag$ bodies
function splitStatements(sql) {
  const out = []; let cur = '', q = false, dq = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dq) { if (sql.startsWith(dq, i)) { cur += dq; i += dq.length - 1; dq = null; } else cur += c; continue; }
    if (q) { cur += c; if (c === "'") { if (sql[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; continue; }
    if (c === '$') { const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i)); if (m) { dq = m[0]; cur += dq; i += dq.length - 1; continue; } }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function clauses(rest) {
  const wi = rest.search(/\bWITH\s+CHECK\b/i);
  const u = /^\s*USING\b/i.test(rest) ? (wi < 0 ? rest : rest.slice(0, wi)).replace(/^\s*USING\s*/i, '') : '';
  const c = wi < 0 ? '' : rest.slice(wi).replace(/^\s*WITH\s+CHECK\s*/i, '');
  return { using: u ? norm(unwrap(u)) : '', check: c ? norm(unwrap(c)) : '' };
}
const parsePolicy = (s) => {
  const m = /^CREATE POLICY (\w+) ON ([\w.]+)(?: AS (PERMISSIVE|RESTRICTIVE))? FOR (\w+) TO ([\w, ]+?) (?=USING|WITH)([\s\S]*)$/i.exec(ws(s));
  return m ? { name: m[1], table: m[2].toLowerCase(), kind: (m[3] ?? 'PERMISSIVE').toUpperCase(), cmd: m[4].toUpperCase(), roles: m[5], ...clauses(m[6]) } : null;
};
const parseFn = (s) => {   // CREATE FUNCTION engagement.<n>() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$ body $$
  const m = /^CREATE FUNCTION (engagement\.\w+)\(\) RETURNS trigger ([\s\S]*?) AS (\$[A-Za-z_]*\$)([\s\S]*)\3$/i.exec(ws(s));
  return m ? { name: m[1].toLowerCase(), head: m[2], body: m[4].trim() } : null;
};
const parseTrg = (s) => /^CREATE TRIGGER (\w+) BEFORE UPDATE ON ([\w.]+) FOR EACH ROW EXECUTE FUNCTION ([\w.]+)\(\)$/i.exec(ws(s));

// returns the list of defects of a migration text (empty = fine)
function migrationDefects(text) {
  const bad = [];
  const sts = splitStatements(strip(text)).map(ws);
  if (sts.length && /^SET LOCAL ROLE lims_owner$/i.test(sts[0])) sts.shift(); else bad.push('first statement must be SET LOCAL ROLE lims_owner');
  const pol = sts.filter((s) => /^CREATE POLICY\b/i.test(s)), fn = sts.filter((s) => /^CREATE FUNCTION\b/i.test(s)), tg = sts.filter((s) => /^CREATE TRIGGER\b/i.test(s));
  if (sts.length !== 5 || pol.length !== 3 || fn.length !== 1 || tg.length !== 1) bad.push(`expected exactly 3 CREATE POLICY + 1 CREATE FUNCTION + 1 CREATE TRIGGER after the role switch, found ${sts.length} statements (${pol.length}/${fn.length}/${tg.length})`);
  const seen = new Set();
  for (const s of pol) {
    const p = parsePolicy(s);
    if (!p) { bad.push(`unparsable CREATE POLICY: ${s.slice(0, 100)}`); continue; }
    const w = POLS[p.name];
    if (!w) { bad.push(`unexpected policy ${p.name}`); continue; }
    seen.add(p.name);
    if (p.table !== TBL) bad.push(`${p.name}: table ${p.table}`);
    if (p.kind !== 'RESTRICTIVE') bad.push(`${p.name}: must be AS RESTRICTIVE`);
    if (p.cmd !== w.cmd) bad.push(`${p.name}: FOR ${p.cmd}`);
    if (p.roles !== 'lims_app') bad.push(`${p.name}: TO ${p.roles}`);
    if (p.using !== norm(w.using)) bad.push(`${p.name} USING: ${p.using || '(none)'}`);
    if (p.check !== norm(w.check)) bad.push(`${p.name} WITH CHECK: ${p.check || '(none)'}`);
  }
  for (const n of Object.keys(POLS)) if (!seen.has(n)) bad.push(`missing policy ${n}`);
  let f = null;
  if (fn.length === 1) {
    f = parseFn(fn[0]);
    if (!f) bad.push(`CREATE FUNCTION is not 'engagement.<name>() RETURNS trigger ... AS $$ ... $$': ${fn[0].slice(0, 100)}`);
    else {
      if (!/\bLANGUAGE plpgsql\b/i.test(f.head)) bad.push('function: LANGUAGE plpgsql');
      if (!/\bSET search_path = ''/i.test(f.head)) bad.push("function: SET search_path = ''");
      if (/\bSECURITY DEFINER\b/i.test(f.head)) bad.push('function: must not be SECURITY DEFINER (a plain guard like guard_actor_columns)');
      const b = ws(f.body).toLowerCase().replace(/\s*(<=|>=|<|>|=|\(|\)|,)\s*/g, '$1');
      if (!/app\.current_actor_type\(\)/.test(b)) bad.push('function: reads app.current_actor_type() (schema-qualified, search_path is empty)');
      if (!/'patient'/.test(b)) bad.push("function: applies to the 'patient' actor");
      if (/'(user|system|device)'/.test(b)) bad.push('function: must not name user / system / device (staff, system and the system purge stay unchanged)');
      if (!/new\.last_value<old\.last_value|old\.last_value>new\.last_value/.test(b)) bad.push('function: raises on NEW.last_value < OLD.last_value (strictly lower)');
      if (/new\.last_value(<=|>|>=)old\.last_value|old\.last_value(<|<=|>=)new\.last_value/.test(b)) bad.push('function: wrong comparison');
      if (!/\braise exception\b/.test(b)) bad.push('function: RAISE EXCEPTION');
      if (!/\breturn new\b/.test(b)) bad.push('function: RETURN NEW');
      if (/\b(delete|insert|update|truncate)\b\s+(from|into)?\s*\w/.test(b)) bad.push('function: must not write any table');
    }
  }
  if (tg.length === 1) {
    const t = parseTrg(tg[0]);
    if (!t) bad.push(`CREATE TRIGGER is not 'BEFORE UPDATE ON .. FOR EACH ROW EXECUTE FUNCTION fn()': ${tg[0].slice(0, 100)}`);
    else {
      if (!/^number_counters__[a-z0-9_]+$/.test(t[1])) bad.push(`trigger name <table>__<purpose>: ${t[1]}`);
      if (t[2].toLowerCase() !== TBL) bad.push(`trigger table ${t[2]}`);
      if (f && t[3].toLowerCase() !== f.name) bad.push(`trigger executes ${t[3]}, function is ${f.name}`);
    }
  }
  return bad;
}

const migPath = root + 'db/migrations/' + MIG;
const migFiles = () => readdirSync(root + 'db/migrations').filter((f) => f.endsWith('.sql')).sort();
const rd = (p) => readFileSync(root + p, 'utf8');
const polText = () => strip(rd('db/policies/engagement.sql'));
const sts = (t) => splitStatements(strip(t)).map(ws);
const createPolicies = (t) => sts(t).filter((s) => /^CREATE POLICY /i.test(s)).map((s) => { const p = parsePolicy(s); assert.ok(p, `parsable policy: ${s.slice(0, 100)}`); return p; });
const keyOf = (p) => `${p.name}@${p.table}`;

// ------------------------------------------------------------------------------------------------ the checker itself rejects wrong migrations (mutants of the expected text)
const FN_BODY = `
DECLARE v_actor text := app.current_actor_type();
BEGIN
  IF v_actor = 'patient' AND NEW.last_value < OLD.last_value THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END`;
const fnSql = (body = FN_BODY, head = "LANGUAGE plpgsql SET search_path = ''") => `CREATE FUNCTION engagement.guard_counter_decrease() RETURNS trigger\n${head} AS $$${body}\n$$;\n`;
const polSql = (name, cmd, using, check, kind = ' AS RESTRICTIVE', role = 'lims_app') =>
  `CREATE POLICY ${name} ON ${TBL}${kind} FOR ${cmd} TO ${role}${using ? `\n  USING (${using})` : ''}${check ? `\n  WITH CHECK (${check})` : ''};\n`;
const pols = (p = PRED) => polSql('number_counters__select__nonstaff_keys', 'SELECT', p, '') + polSql('number_counters__insert__nonstaff_keys', 'INSERT', '', p) + polSql('number_counters__update__nonstaff_keys', 'UPDATE', p, p);
const TRG = `CREATE TRIGGER number_counters__patient_no_decrease BEFORE UPDATE ON ${TBL}\n  FOR EACH ROW EXECUTE FUNCTION engagement.guard_counter_decrease();\n`;
const GOOD = `-- LD-257\nSET LOCAL ROLE lims_owner;\n${pols()}${fnSql()}${TRG}`;
test('checker self-test: the expected text passes, every mutant is rejected', () => {
  assert.deepEqual(migrationDefects(GOOD), [], 'expected text must pass');
  const rep = (a, b) => { assert.ok(GOOD.includes(a), `mutant anchor missing: ${a}`); return GOOD.replace(a, b); };
  const repAll = (a, b) => { assert.ok(GOOD.includes(a), `mutant anchor missing: ${a}`); return GOOD.split(a).join(b); };
  const mutants = {
    'missing SET LOCAL ROLE': rep('SET LOCAL ROLE lims_owner;\n', ''),
    'role switch not first': rep('SET LOCAL ROLE lims_owner;\n', '') + 'SET LOCAL ROLE lims_owner;\n',
    'second role switch': GOOD + 'RESET ROLE;\n',
    'other role': rep('lims_owner', 'lims_app'),
    'PERMISSIVE (no AS RESTRICTIVE)': repAll(' AS RESTRICTIVE', ''),
    'AS PERMISSIVE': repAll(' AS RESTRICTIVE', ' AS PERMISSIVE'),
    'TO public instead of lims_app': repAll('TO lims_app', 'TO public'),
    'TO lims_app, lims_worker': repAll('TO lims_app', 'TO lims_app, lims_worker'),
    'device allowed': repAll("IN ('user','system')", "IN ('user','system','device')"),
    'patient dropped from key rule (any patient key)': repAll(`${ACT} = 'patient' AND counter_key ~ '${KEY_RE}'`, `${ACT} = 'patient'`),
    'patient allowed on card_no': repAll('(booking_no:', '(card_no:|booking_no:'),
    'booking_no loses the yy anchor': repAll('booking_no:[0-9]{2}|', 'booking_no:|'),
    'regex unanchored at the start': repAll("'^(booking_no", "'(booking_no"),
    'regex unanchored at the end': repAll(")$'", ')\''),
    'otp_day digits 6': repAll('otp_day:[0-9]{8}', 'otp_day:[0-9]{6}'),
    'linkfail hour digits 8': repAll(':[0-9]{10}', ':[0-9]{8}'),
    'linkfail uuid class without hyphen': repAll('[0-9a-f-]{36}', '[0-9a-f]{36}'),
    'key class extended (card_no via otp_day|card_no)': repAll('otp_day:[0-9]{8}', '(otp_day|card_no):[0-9]{8}'),
    'regex match operator ~* (case-insensitive)': repAll("counter_key ~ '", "counter_key ~* '"),
    'LIKE instead of regex': repAll(`counter_key ~ '${KEY_RE}'`, "counter_key LIKE 'otp_day:%'"),
    'user dropped': repAll("IN ('user','system')", "IN ('system')"),
    'system dropped': repAll("IN ('user','system')", "IN ('user')"),
    'OR true in the select policy': rep(`USING (${PRED})`, `USING (${PRED} OR true)`),
    'actor call not wrapped in (SELECT ...)': repAll(ACT, 'app.current_actor_type()'),
    'update without WITH CHECK': rep(`\n  WITH CHECK (${PRED});\nCREATE FUNCTION`, ';\nCREATE FUNCTION'),
    'select policy gets a WITH CHECK': rep(`USING (${PRED});\nCREATE POLICY number_counters__insert`, `USING (${PRED}) WITH CHECK (${PRED});\nCREATE POLICY number_counters__insert`),
    'policy FOR ALL': rep('number_counters__select__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR SELECT', 'number_counters__select__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR ALL'),
    'wrong table': rep('ON engagement.number_counters AS RESTRICTIVE FOR SELECT', 'ON engagement.settings AS RESTRICTIVE FOR SELECT'),
    'policy renamed': rep('number_counters__select__nonstaff_keys', 'number_counters__select__keys'),
    'DELETE policy added': GOOD + polSql('number_counters__delete__nonstaff_keys', 'DELETE', PRED, ''),
    'missing update policy': rep(pols().split('CREATE POLICY').slice(-1)[0], '').replace(/CREATE POLICY $/, ''),
    'extra DROP POLICY': GOOD + `DROP POLICY number_counters__update__tenant ON ${TBL};\n`,
    'extra ALTER POLICY': GOOD + `ALTER POLICY number_counters__update__tenant ON ${TBL} USING (true);\n`,
    'extra REVOKE': GOOD + `REVOKE UPDATE ON ${TBL} FROM lims_app;\n`,
    'extra GRANT': GOOD + `GRANT SELECT ON ${TBL} TO lims_app;\n`,
    'extra ALTER TABLE': GOOD + `ALTER TABLE ${TBL} ADD COLUMN x int;\n`,
    'extra DROP TRIGGER': GOOD + 'DROP TRIGGER x ON engagement.slot_occupancy;\n',
    'guard not for patient (user)': rep("v_actor = 'patient'", "v_actor = 'user'"),
    'guard for patient AND user': rep("v_actor = 'patient'", "v_actor IN ('patient','user')"),
    'guard names system': rep("v_actor = 'patient'", "v_actor IN ('patient','system')"),
    'guard compares <= (blocks an equal write)': rep('NEW.last_value < OLD.last_value', 'NEW.last_value <= OLD.last_value'),
    'guard compares > (blocks increments)': rep('NEW.last_value < OLD.last_value', 'NEW.last_value > OLD.last_value'),
    'guard compares OLD < NEW': rep('NEW.last_value < OLD.last_value', 'OLD.last_value < NEW.last_value'),
    'guard without RAISE': rep('RAISE EXCEPTION USING ERRCODE = \'P0001\', MESSAGE = \'immutable_row\', DETAIL = TG_TABLE_SCHEMA || \'.\' || TG_TABLE_NAME;', 'NULL;'),
    'guard without RETURN NEW': rep('RETURN NEW;', 'RETURN NULL;'),
    'guard SECURITY DEFINER': rep("LANGUAGE plpgsql SET search_path = ''", "LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''"),
    'guard without search_path': rep("LANGUAGE plpgsql SET search_path = ''", 'LANGUAGE plpgsql'),
    'guard function in schema app': rep('CREATE FUNCTION engagement.guard_counter_decrease', 'CREATE FUNCTION app.guard_counter_decrease'),
    'guard actor unqualified current_actor_type()': rep('v_actor text := app.current_actor_type()', 'v_actor text := current_actor_type()'),
    'guard writes a table': rep('RETURN NEW;', 'DELETE FROM engagement.number_counters WHERE true; RETURN NEW;'),
    'trigger AFTER UPDATE': rep('BEFORE UPDATE ON', 'AFTER UPDATE ON'),
    'trigger BEFORE INSERT OR UPDATE': rep('BEFORE UPDATE ON', 'BEFORE INSERT OR UPDATE ON'),
    'trigger BEFORE DELETE': rep('BEFORE UPDATE ON', 'BEFORE DELETE ON'),
    'trigger FOR EACH STATEMENT': rep('FOR EACH ROW', 'FOR EACH STATEMENT'),
    'trigger on another table': rep(`BEFORE UPDATE ON ${TBL}`, 'BEFORE UPDATE ON engagement.settings'),
    'trigger runs another function': rep('EXECUTE FUNCTION engagement.guard_counter_decrease()', 'EXECUTE FUNCTION engagement.guard_actor_columns()'),
    'trigger name outside <table>__<purpose>': rep('number_counters__patient_no_decrease', 'trg_patient_no_decrease'),
    'no trigger': rep(TRG, ''),
    'no function': rep(fnSql(), ''),
    'two triggers': GOOD + TRG.replace('patient_no_decrease', 'patient_no_decrease2'),
    'empty migration': '-- nothing\n',
  };
  for (const [what, text] of Object.entries(mutants)) assert.notDeepEqual(migrationDefects(text), [], `mutant not rejected: ${what}`);
});
test('checker self-test: the $$ body is not split at its semicolons, and a string with ; is one statement', () => {
  assert.equal(splitStatements(strip(GOOD)).length, 6);
  assert.deepEqual(splitStatements("SELECT 'a;b'; SELECT $x$ c;d $x$;"), ["SELECT 'a;b'", 'SELECT $x$ c;d $x$']);
});

// ------------------------------------------------------------------------------------------------ the migration
test('migration file exists, sorts after every migration with a lower timestamp (incl. 20261116020000), has a unique timestamp and a <ts>_engagement__<name>.sql name', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing (T0B-CNTPOL-1 writer creates it)`);
  const others = migFiles().filter((f) => f !== MIG), ts = (f) => f.slice(0, 14);
  assert.ok(others.length > 0);
  for (const f of others.filter((x) => ts(x) < ts(MIG))) assert.ok(MIG > f, `${MIG} must sort after ${f}`);
  assert.ok(others.some((f) => f.startsWith('20261116020000_')), 'the T0B-PEVPOL-1 migration (20261116020000) precedes it');
  assert.deepEqual(others.filter((x) => ts(x) === ts(MIG)), [], 'no other migration shares the 14-digit timestamp');
  assert.match(MIG, /^\d{14}_engagement__[a-z0-9_]+\.sql$/);
});
test('migration: leading SET LOCAL ROLE lims_owner, then exactly the 3 RESTRICTIVE nonstaff_keys policies, 1 BEFORE UPDATE guard function and 1 trigger (text as in the CR Proposal); nothing else', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  assert.deepEqual(migrationDefects(rd('db/migrations/' + MIG)), []);
});
test('migration: no DROP, REVOKE, GRANT, ALTER, TABLE or column change, no other policy or trigger, exactly one role switch', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const t = strip(rd('db/migrations/' + MIG));
  assert.doesNotMatch(t, /\b(DROP|REVOKE|GRANT|ALTER|TRUNCATE|CREATE\s+TABLE|CREATE\s+INDEX|CREATE\s+SCHEMA|RESET)\b/i);
  assert.equal([...t.matchAll(/\bCREATE\s+POLICY\b/gi)].length, 3);
  assert.equal([...t.matchAll(/\bCREATE\s+TRIGGER\b/gi)].length, 1);
  assert.equal([...t.matchAll(/\bCREATE\s+FUNCTION\b/gi)].length, 1);
  assert.equal([...t.matchAll(/\bSET\s+(LOCAL\s+)?ROLE\b/gi)].length, 1, 'exactly one role switch');
  assert.doesNotMatch(t, /\bSECURITY\s+DEFINER\b/i);
});
test('migration: the policy text of the three policies is character-for-character the Proposal of CR T0B-REVIEW-1.2 (user, system unchanged; patient only on the three key classes; no device)', () => {
  const cr = rd('.orchestra/cr/T0B-REVIEW-1.2.nonblocking.md');
  const crPols = createPolicies(cr.slice(cr.indexOf('```sql') + 6, cr.indexOf('```', cr.indexOf('```sql') + 6)).replace(/^\s*--.*$/gm, ''));
  assert.deepEqual(crPols.map((p) => p.name).sort(), Object.keys(POLS).sort(), 'the CR Proposal names the same three policies');
  const mine = createPolicies(rd('db/migrations/' + MIG).replace(/\$\$[\s\S]*?\$\$/g, '$$$$'));
  for (const p of crPols) { const m = mine.find((x) => x.name === p.name); assert.ok(m, p.name); assert.deepEqual([m.kind, m.cmd, m.roles, m.using, m.check], [p.kind, p.cmd, p.roles, p.using, p.check], p.name); }
});

// ------------------------------------------------------------------------------------------------ db/policies/engagement.sql
test('db/policies/engagement.sql: the same three policies, the same guard function and trigger text as the migration (normalised), each exactly once', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const mig = sts(rd('db/migrations/' + MIG)), pol = sts(rd('db/policies/engagement.sql'));
  const only = (list, re) => list.filter((s) => re.test(s)).map(norm);
  for (const re of [/^CREATE POLICY number_counters__\w+__nonstaff_keys\b/i, /^CREATE FUNCTION\b/i, /^CREATE TRIGGER number_counters__/i]) {
    const a = only(mig, re), b = only(pol, re);
    assert.ok(a.length >= 1, `migration has ${re}`);
    if (re.source.startsWith('^CREATE FUNCTION')) { assert.ok(b.length === 1 && mig.filter((s) => re.test(s)).length === 1, 'one guard function'); assert.deepEqual(b, a, 'function text equal'); continue; }
    assert.deepEqual([...b].sort(), [...a].sort(), `policy file carries the migration text for ${re}`);
  }
  const p = createPolicies(polText()).filter((x) => /__nonstaff_keys$/.test(x.name));
  assert.deepEqual(p.map((x) => x.name).sort(), Object.keys(POLS).sort());
});
test('db/policies/engagement.sql: the guard function and trigger are not in the schema migration (history) and the parsed text passes the same checks', () => {
  const body = sts(rd('db/policies/engagement.sql')).filter((s) => /^(CREATE POLICY number_counters__\w+__nonstaff_keys|CREATE FUNCTION|CREATE TRIGGER number_counters__)/i.test(s));
  const defects = migrationDefects('SET LOCAL ROLE lims_owner;\n' + body.map((s) => s + ';').join('\n'));
  assert.deepEqual(defects, [], 'the policy file text of the new objects passes the migration checker');
});
test('db/policies/engagement.sql: number_counters__{select,insert,update}__tenant (ANY_T) and __delete__tenant, settings and cs_* policies are untouched (equal to the schema migration text); no other new policy', () => {
  const schemaMig = migFiles().find((f) => /_engagement__create_engagement_schema\.sql$/.test(f));
  assert.ok(schemaMig, 'schema migration found');
  const old = new Map(createPolicies(rd('db/migrations/' + schemaMig)).map((p) => [keyOf(p), JSON.stringify([p.kind, p.cmd, p.roles, p.using, p.check])]));
  const now = createPolicies(polText()).filter((p) => p.table.startsWith('engagement.'));
  const added = now.filter((p) => !old.has(keyOf(p))).map((p) => p.name).sort();
  assert.deepEqual(added, Object.keys(POLS).sort(), 'the only new policies are the three nonstaff_keys policies');
  for (const p of now.filter((x) => old.has(keyOf(x)))) assert.equal(JSON.stringify([p.kind, p.cmd, p.roles, p.using, p.check]), old.get(keyOf(p)), `${p.name} unchanged`);
  const byName = Object.fromEntries(now.map((p) => [p.name, p]));
  for (const c of ['select', 'insert', 'update']) { const p = byName[`number_counters__${c}__tenant`]; assert.ok(p, c); assert.equal(p.kind, 'PERMISSIVE'); assert.equal(c === 'insert' ? p.check : p.using, norm(ANY_T)); }
  assert.ok(byName.number_counters__delete__tenant, 'purge DELETE policy stays');
  for (const n of ['settings__select__tenant', 'cs_booking_cancel_reasons__select__tenant', 'cs_reminder_reasons__select__tenant', 'cs_enquiry_categories__select__tenant']) { assert.ok(byName[n], n); assert.equal(byName[n].kind, 'PERMISSIVE'); assert.equal(byName[n].using, norm(ANY_T), `${n} stays ANY_T`); }
  assert.equal(now.filter((p) => p.kind === 'RESTRICTIVE').length, 3, 'no RESTRICTIVE policy but the three new ones in engagement');
  assert.deepEqual(now.filter((p) => /^(settings|cs_)/.test(p.name) && p.kind === 'RESTRICTIVE'), [], 'settings / cs_* get no restrictive policy');
});
test('the migrations before this one are not edited: no earlier migration mentions the new policy, function or trigger names', () => {
  for (const f of migFiles().filter((x) => x !== MIG)) assert.doesNotMatch(rd('db/migrations/' + f), /__nonstaff_keys/, f);
});

// ------------------------------------------------------------------------------------------------ the key patterns against the REAL key builders
const SRC = (p) => rd(p).replace(/\r\n?/g, '\n');
const svc = 'services/api/src/modules/engagement/';
const tsFn = (src, re, ret) => { const m = re.exec(src); assert.ok(m, `source of ${ret} not found: ${re}`); return new Function(`${stripTypeScriptTypes(m[0])}\nreturn ${ret};`)(); };
let _bd, _yy;   // the REAL functions, extracted from the source and evaluated lazily
const businessDay = (...a) => (_bd ??= tsFn(SRC(svc + 'service/auth.service.ts'), /function businessDay\([\s\S]*?\n}\n/, 'businessDay'))(...a);
const localYY = (...a) => (_yy ??= tsFn(SRC(svc + 'service/booking.service.ts'), /const localYY = [^\n]*\n/, 'localYY'))(...a);
const tpl = (src, prefix) => { const ms = [...src.matchAll(new RegExp('`(' + prefix + ':[^`]*)`', 'g'))]; assert.equal(ms.length, 1, `exactly one template literal "${prefix}:..." in the source, found ${ms.length}`); return ms[0][1]; };
const run = (t, names, vals) => new Function(...names, 'return `' + t + '`;')(...vals);
const TZ = ['Asia/Kathmandu', 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'Europe/London'];
const INSTANTS = ['2026-11-16T07:26:00.000Z', '2026-12-31T23:59:59.999Z', '2027-01-01T00:00:00.000Z', '2026-12-31T18:15:00.000Z', '2026-02-28T23:59:59.999Z', '2028-02-29T12:00:00.000Z', '2026-03-08T10:00:00.000Z', '2026-01-01T00:00:00.000Z', '2099-12-31T23:59:59.999Z'];
const UUIDS = ['01950c16-0000-7000-8000-000000000301', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '00000000-0000-0000-0000-000000000000', '0190c600-1234-7abc-9def-0123456789ab'];
const realKeys = () => {
  const k = { otp_day: [], linkfail: [], booking_no: [], card_no: [] };
  const tOtp = tpl(SRC(svc + 'service/auth.service.ts'), 'otp_day'), tLink = tpl(SRC(svc + 'service/link.service.ts'), 'linkfail'),
    tBook = tpl(SRC(svc + 'repository/booking.repo.ts'), 'booking_no'), tCard = tpl(SRC(svc + 'repository/membership.repo.ts'), 'card_no');
  for (const tz of TZ) for (const i of INSTANTS) {
    k.otp_day.push(run(tOtp, ['day'], [businessDay(i, tz)]));
    k.booking_no.push(run(tBook, ['a'], [{ yy: localYY(i, tz) }]));
    k.card_no.push(run(tCard, ['a'], [{ yy: i.slice(2, 4) }]));   // membership.service.ts:149: today.slice(2, 4)
  }
  for (const id of UUIDS) for (const i of INSTANTS) { k.linkfail.push(run(tLink, ['acct', 'now'], [{ id }, new Date(i).toISOString()])); k.linkfail.push(run(tLink, ['acct', 'now'], [{ id }, new Date(Date.parse(i) + 3_599_999).toISOString()])); }
  return k;
};
const keyRe = () => { const m = /counter_key ~ '([^']+)'/.exec(rd('db/migrations/' + MIG)); assert.ok(m, 'regex literal in the migration'); return new RegExp(m[1]); };
test('real key builders: the source templates are the ones this migration was written against (otp_day:${day.key}, linkfail:${acct.id}:<yyyymmddhh>, booking_no:${yy}, card_no:${yy})', () => {
  assert.equal(tpl(SRC(svc + 'service/auth.service.ts'), 'otp_day'), 'otp_day:${day.key}');
  assert.match(tpl(SRC(svc + 'service/link.service.ts'), 'linkfail'), /^linkfail:\$\{acct\['id'\]\}:\$\{now\.slice\(0, 13\)\.replace\(\/\\D\/g, ''\)\}$/);
  assert.equal(tpl(SRC(svc + 'repository/booking.repo.ts'), 'booking_no'), 'booking_no:${a.yy}');
  assert.equal(tpl(SRC(svc + 'repository/membership.repo.ts'), 'card_no'), 'card_no:${a.yy}');
});
test('real key builders (no migration needed): the CR regex accepts every otp_day / linkfail / booking_no key the code builds and refuses card_no', () => {
  const re = new RegExp(KEY_RE), k = realKeys();
  for (const cls of ['otp_day', 'linkfail', 'booking_no']) for (const key of k[cls]) assert.match(key, re, `a key the code really builds is refused: ${key}`);
  for (const key of k.card_no) assert.doesNotMatch(key, re, key);
});
test('real key builders: every key the patient flows build (otp_day, linkfail, booking_no; many time zones, year / day / hour boundaries, uuid shapes) matches the migration regex; the regex equals KEY_RE; the whole table CHECK still accepts them', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const re = keyRe(), k = realKeys();
  assert.equal(re.source, KEY_RE, 'the migration uses the regex of the CR Proposal (equal to the real key format)');
  const check = new RegExp(/number_counters__key__ck CHECK \(counter_key ~ '([^']+)'\)/.exec(rd('db/migrations/20261115160000_engagement__create_engagement_schema.sql'))[1]);
  for (const cls of ['otp_day', 'linkfail', 'booking_no']) {
    assert.ok(k[cls].length >= 20, cls);
    for (const key of k[cls]) { assert.match(key, re, `a key the code really builds is refused: ${key}`); assert.match(key, check, `table CHECK: ${key}`); }
  }
  assert.ok(k.otp_day.every((x) => /^otp_day:\d{8}$/.test(x)) && k.booking_no.every((x) => /^booking_no:\d{2}$/.test(x)) && k.linkfail.every((x) => /^linkfail:[0-9a-f-]{36}:\d{10}$/.test(x)), 'builders produce the documented shapes');
});
test('real key builders: card_no (staff-issued membership numbers) is NOT matched for a patient; neither are look-alikes (wrong length, case, prefix / suffix junk, newline)', () => {
  assert.ok(existsSync(migPath), `db/migrations/${MIG} missing`);
  const re = keyRe(), k = realKeys();
  for (const key of k.card_no) { assert.doesNotMatch(key, re, `card_no must be refused for a patient: ${key}`); assert.match(key, /^card_no:\d{2}$/); }
  for (const key of ['card_no:26', 'booking_no:2', 'booking_no:262', 'booking_no:26\n', 'booking_no:2a', 'xbooking_no:26', 'booking_no:26x', 'BOOKING_NO:26', 'otp_day:2026111', 'otp_day:202611160', 'otp_day:2026-11-16', 'otp_day:20261116\n', 'linkfail:01950c16-0000-7000-8000-000000000301:202611160', 'linkfail:01950c16-0000-7000-8000-000000000301:20261116070',
    'linkfail:01950C16-0000-7000-8000-000000000301:2026111607', 'linkfail:01950c16-0000-7000-8000-000000000301', 'linkfail::2026111607', 'rate:otp', '', 'booking_no:26|card_no:26', 'x\nbooking_no:26', 'booking_no:26\notp_day:20261116']) assert.doesNotMatch(key, re, `must be refused: ${JSON.stringify(key)}`);
});
test('real key builders: the engagement code (api + worker, non-test) builds number_counters keys of exactly these four classes; a new class would need a new test row here', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === '__tests__' ? [] : walk(p)) : /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : []; });
  const files = [...walk(root + 'services/api/src/modules/engagement'), ...walk(root + 'services/worker/src/jobs/engagement')];
  const writers = files.filter((f) => /\b(INSERT\s+INTO|UPDATE)\s+engagement\.number_counters\b/i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(writers.map((f) => f.slice(root.length).replace(/\\/g, '/')).sort(), [svc + 'repository/booking.repo.ts', svc + 'repository/linkCodes.repo.ts', svc + 'repository/membership.repo.ts', svc + 'repository/otp.repo.ts'].sort(), 'files that write number_counters');
  const classes = new Set();
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/`(\w+):\$\{/g)) if (/^(booking_no|card_no|otp_day|linkfail)$/.test(m[1])) classes.add(m[1]);
  assert.deepEqual([...classes].sort(), ['booking_no', 'card_no', 'linkfail', 'otp_day']);
  assert.equal(readFileSync(root + svc + 'repository/membership.repo.ts', 'utf8').includes('card_no:'), true, 'card_no is the staff-only key (membership.service.ts issues the card)');
});

// ------------------------------------------------------------------------------------------------ the pgTAP file and the notes (reviewed by reading only; here: they exist and cover the done_when list)
test('pgTAP file db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql covers device, patient card_no, patient own keys, lowering, staff / system unchanged, purge DELETE, settings and cs_* untouched', () => {
  const f = 'db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql';
  assert.ok(existsSync(root + f), 'pgTAP file missing');
  const t = rd(f);
  for (const k of ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)']) assert.ok(t.includes(`'${k} `), `assertion ${k}`);
  assert.match(t, /number_counters__select__nonstaff_keys/); assert.match(t, /number_counters__insert__nonstaff_keys/); assert.match(t, /number_counters__update__nonstaff_keys/);
  assert.match(t, /RESTRICTIVE/); assert.match(t, /E42501/); assert.match(t, /card_no:26/); assert.match(t, /otp_day:/); assert.match(t, /linkfail:/); assert.match(t, /booking_no:/);
  assert.match(t, /'device'/); assert.match(t, /'patient'/); assert.match(t, /'user'/); assert.match(t, /'system'/);
  assert.match(t, /last_value = 0/); assert.match(t, /settings__select__tenant/); assert.match(t, /cs_booking_cancel_reasons__select__tenant/); assert.match(t, /expires_at < now\(\)/);
  assert.match(t, /NOT RUN in the lane/); assert.match(t, /run-suites\.sh/); assert.match(t, /push-cloud\.ps1/);
});
test('notes: T0B-CNTPOL-1-tests.md says pgTAP and migration were NOT run, names run-suites.sh before push-cloud.ps1, test 462, the key-builder check and the open rename gap; verify.cmd is one line', () => {
  const n = '.orchestra/notes/T0B-CNTPOL-1-tests.md', v = '.orchestra/notes/T0B-CNTPOL-1-verify.cmd';
  assert.ok(existsSync(root + n) && existsSync(root + v), 'notes missing');
  const t = rd(n);
  assert.match(t, /NOT run/i); assert.match(t, /run-suites\.sh/); assert.match(t, /push-cloud\.ps1/); assert.match(t, /\b462\b/); assert.match(t, /real key builders|key builders/i); assert.match(t, /counter_key/);
  assert.equal(rd(v).split(/\r?\n/).filter((l) => l.trim()).length, 1, 'verify.cmd is exactly one line');
});
