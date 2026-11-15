Title: CR-C0-T0B-REVIEW-1-002: engagement tenant policies without is_staff_or_system (LD-232 item 3; policy_shape test 462)
From chunk: C0 (lane C0-0B, T0B-REVIEW-1)            To owner: C0-0B (lead; founder yes needed, policy change)
Type: security (narrowing)
Blocking? no (LD-232: report only; no migration, policy, grant, test or code was changed)

## Intent
- C16 05-SCHEMA §5.1 predicate ANY_T = `tenant_id = T AND K IN ('user','system','patient','device')` (no `G`); STAFF = `tenant_id = T AND G AND K IN ('user','system')`; SYS = `… G AND K = 'system'`.
- C16 05-SCHEMA §5.2 policy matrix: `settings` S ANY_T, I/U STAFF; `number_counters` S/I/U ANY_T, D SYS + `expires_at IS NOT NULL AND expires_at < now()` (P-18(c)); `cs_*` (cs_booking_cancel_reasons, cs_reminder_reasons, cs_enquiry_categories) S ANY_T, I/U STAFF (08 A31.2).
- C16 05-SCHEMA §1: `number_counters` holds booking_no, card_no and durable rate counters (otp_day, linkfail); key CHECK `number_counters__key__ck`.
- C0 05-SCHEMA §10 schema test 24 (08 A17 P-16, A23.3): every `__tenant` policy carries `is_staff_or_system`. The C16 spec deliberately deviates with ANY_T. So the ANY_T reads are intended; the open question (LD-232) is whether non-staff writes to number_counters are wider than needed.

## Current behaviour
- db/policies/engagement.sql (= migration 20261115160000 §5) transcribes §5.2 verbatim: `settings__select__tenant`, `number_counters__select__tenant`, `number_counters__insert__tenant`, `number_counters__update__tenant`, `cs_booking_cancel_reasons__select__tenant`, `cs_reminder_reasons__select__tenant`, `cs_enquiry_categories__select__tenant` use ANY_T without `is_staff_or_system`; test 462 of db/tests/policy/T0B-08_policy_shape.test.sql flags them.
- Effect: any patient actor (signed-in or pre-auth) and any device actor of the tenant can read the tenant's engagement settings and cs_* lookups (intended: the patient app and queue display need them), and can INSERT / UPDATE any number_counters row, including `card_no:<yy>` (staff-issued membership numbers) and its own `otp_day:` / `linkfail:` rate rows, e.g. `UPDATE … SET last_value = 0` resets the OTP daily cap or the link-redeem failure limit. Device actors have no counter use at all.

## Callers
- Patient / pre-auth counter writes: services/api/src/modules/engagement/repository/otp.repo.ts:28 (`otp_day:` key built at services/api/src/modules/engagement/service/auth.service.ts:129), services/api/src/modules/engagement/repository/linkCodes.repo.ts:108 (`linkfail:` key at services/api/src/modules/engagement/service/link.service.ts:290), services/api/src/modules/engagement/repository/booking.repo.ts:90 (`booking_no:` key, line 89; patient self-booking, C16 02-TRD step 5).
- Staff-only counter write: services/api/src/modules/engagement/repository/membership.repo.ts:52 (`card_no:` key, line 51; staff issues the card, services/api/src/modules/engagement/service/membership.service.ts:152).
- System purge: services/worker/src/jobs/engagement/tasks/purge.ts:25.
- Non-staff settings reads: services/api/src/modules/engagement/service/selfreg.service.ts:69, services/api/src/modules/engagement/repository/mybooking.repo.ts:27, services/api/src/modules/engagement/repository/linkCodes.repo.ts:15, services/api/src/modules/engagement/service/payment.service.ts:52; device read: services/api/src/modules/engagement/repository/display.repo.ts:62.
- Policies: db/policies/engagement.sql:5, db/policies/engagement.sql:448, db/policies/engagement.sql:450, db/policies/engagement.sql:452, db/policies/engagement.sql:487, db/policies/engagement.sql:494, db/policies/engagement.sql:501. Shape check: db/tests/policy/T0B-08_policy_shape.test.sql:89.

## Proposal
settings and cs_* SELECT: no change (spec ANY_T; real patient and device callers). number_counters: add RESTRICTIVE policies so device actors cannot use counters and patient actors touch only the three keys they need (staff and system unchanged). Additive migration plus the same text in db/policies/engagement.sql:
```sql
-- LD-232 item 3 (CR-C0-T0B-REVIEW-1-002): non-staff actors only on their own rate / booking keys; no device access
CREATE POLICY number_counters__select__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR SELECT TO lims_app
  USING ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'));
CREATE POLICY number_counters__insert__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'));
CREATE POLICY number_counters__update__nonstaff_keys ON engagement.number_counters AS RESTRICTIVE FOR UPDATE TO lims_app
  USING ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'))
  WITH CHECK ((SELECT app.current_actor_type()) IN ('user','system')
         OR ((SELECT app.current_actor_type()) = 'patient' AND counter_key ~ '^(booking_no:[0-9]{2}|otp_day:[0-9]{8}|linkfail:[0-9a-f-]{36}:[0-9]{10})$'));
```
Open for the founder (not policy text, so not proposed here): a patient can still lower its own `otp_day` / `linkfail` value; closing that needs a BEFORE UPDATE guard (`NEW.last_value >= OLD.last_value` for non-staff), like C16 05-SCHEMA §4 `engagement.guard_actor_columns`. Test 462: the lead decides whether ANY_T tables get a documented exemption in the shape test (C16 §5.1 deviation); this CR does not change the assertion.

## Tests
- db/tests/engagement (new suite or C16 policy suite): must assert device claims → `SELECT 1 FROM engagement.number_counters` returns 0 rows and INSERT / UPDATE → 42501 / n=0; patient claims → INSERT / UPDATE of `card_no:26` → 42501 / n=0; patient claims → `otp_day:` / `linkfail:` / `booking_no:` upsert still n=1; staff and system unchanged; purge DELETE by system unchanged.
- db/tests/policy/T0B-08_policy_shape.test.sql: the three new policies are RESTRICTIVE, `TO lims_app`, named `<table>__<cmd>__<scope>`.
- Existing patient flows stay green: OTP request cap, link-code redeem failure limit, self-booking number.
