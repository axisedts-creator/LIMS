// T0B-STALE-1 (C0, LD-257, LD-263): static checks that three pgTAP files carry the post-migration expectations. pgTAP itself is NOT run in the lane.
//  1 db/tests/grants/T0B-08_grants.test.sql         provider_events UPDATE grant is EXPECTED (20261116020000: narrowed by policy, grant kept)
//  2 db/tests/engagement/T0B-13.C16_schema.test.sql  trigger list + number_counters__patient_no_decrease, function list + guard_counter_decrease (20261116030000)
//  3 db/tests/engagement/T-SEC1_table_probes.test.sql tenant-bound check allows the 3 RESTRICTIVE number_counters__(select|insert|update)__nonstaff_keys policies
// Every changed line carries a comment naming the migration and LD-257. No check deleted. Run: node --test tests/db/T0B-STALE-1.static.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(repo + p, 'utf8').replace(/\r\n?/g, '\n');
// ponytail: strips '--' even inside string literals; none of the checked statements has one
const code = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const stmts = (s) => code(s).split(';');
const commented = (s, re, mig) => s.split('\n').some((l) => /--/.test(l) && re.test(l) && l.includes('LD-257') && l.includes(mig));

const G = 'db/tests/grants/T0B-08_grants.test.sql';
const C = 'db/tests/engagement/T0B-13.C16_schema.test.sql';
const S = 'db/tests/engagement/T-SEC1_table_probes.test.sql';
const M_PE = '20261116020000';
const M_NC = '20261116030000';

test('T0B-08_grants: provider_events UPDATE grant is expected, other append-only tables still have none', () => {
  const t = read(G);
  const upd = stmts(t).filter((s) => /has_table_privilege/.test(s) && /'UPDATE'/.test(s));
  const generic = upd.find((s) => /has no UPDATE on/.test(s));
  assert.ok(generic, 'the generic "has no UPDATE on" check stays (not deleted)');
  assert.match(generic, /provider_events/, 'the generic no-UPDATE check must exclude reporting.provider_events (checks 764/765/766)');
  const grant = upd.filter((s) => s !== generic && /provider_events/.test(s));
  assert.ok(grant.length, 'a separate UPDATE check must name reporting.provider_events');
  assert.ok(grant.some((s) => /is\(\s*has_table_privilege\([^;]*'UPDATE'\s*\)\s*,\s*true/i.test(s) || /\bok\(\s*has_table_privilege\([^;]*'UPDATE'\s*\)/i.test(s)),
    'provider_events UPDATE must be asserted TRUE (grant kept; narrowing is by policy)');
  assert.ok(commented(t, /provider_events/, M_PE), 'a comment names provider_events, LD-257 and ' + M_PE);
});

test('T0B-13.C16_schema: trigger list has number_counters__patient_no_decrease (8 triggers)', () => {
  const t = read(C);
  const stmt = stmts(t).find((s) => /ARRAY\['account_patient_links__mutable_columns'/.test(s));
  assert.ok(stmt, 'trigger-list check exists');
  const names = [...stmt.matchAll(/'([a-z_]+__[a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, ['account_patient_links__mutable_columns', 'account_patient_links__patient_guard', 'bookings__mutable_columns', 'number_counters__patient_no_decrease', 'queue_displays__device_guard', 'queue_tokens__mutable_columns', 'settings__consent_version', 'slot_occupancy__patient_guard']);
  assert.match(stmt, /exactly the 8 /, 'description says 8 triggers');
  assert.ok(commented(t, /number_counters__patient_no_decrease|8 (spec )?triggers/, M_NC), 'a comment names the trigger, LD-257 and ' + M_NC);
});

test('T0B-13.C16_schema: function list has guard_counter_decrease', () => {
  const t = read(C);
  const stmt = stmts(t).find((s) => /ARRAY\['guard_actor_columns'/.test(s) && /pg_proc/.test(s) && /array_agg/.test(s));
  assert.ok(stmt, 'function-list check exists');
  assert.match(stmt, /ARRAY\['guard_actor_columns','guard_counter_decrease','guard_patient_link_update','purge_payment_requests','purge_queue','settings_consent_version_guard'\]/);
  assert.ok(commented(t, /guard_counter_decrease/, M_NC), 'a comment names guard_counter_decrease, LD-257 and ' + M_NC);
});

test('T-SEC1_table_probes check 14: RESTRICTIVE number_counters policies are allowed in the tenant-bound check', () => {
  const t = read(S);
  const stmt = stmts(t).find((s) => /every lims_app policy on a tenant table is tenant-bound/.test(s));
  assert.ok(stmt, 'tenant-bound check exists (not deleted)');
  assert.match(stmt, /current_tenant_id\|engagement_account_id\|engagement_patient_ids/, 'original predicate regex kept');
  for (const c of ['select', 'insert', 'update']) assert.ok(stmt.includes('number_counters__' + c + '__nonstaff_keys'), 'policy ' + c + ' is named in the check');
  assert.ok(commented(t, /number_counters|RESTRICTIVE/, M_NC), 'a comment names the policies, LD-257 and ' + M_NC);
});
