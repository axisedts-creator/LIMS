-- T0B-CNTPOL-1 (LD-257, CR-C0-T0B-REVIEW-1-002, LD-232 item 3): narrow engagement.number_counters for non-staff actors.
-- (1) three RESTRICTIVE policies TO lims_app: user and system actors unchanged; a patient actor only on its own rate / booking keys
--     (booking_no:YY, otp_day:YYYYMMDD, linkfail:<uuid>:<10 digits>, checked against the real key builders); device and every other actor: nothing.
-- (2) a BEFORE UPDATE guard (pattern of C16 05-SCHEMA §4 engagement.guard_actor_columns): a patient actor can never lower last_value
--     (closes the OTP daily cap / link failure limit reset; founder answer in LD-257). Staff, system and the system purge DELETE unchanged.
-- Narrowing only: no DROP, REVOKE, GRANT, table, column or other policy change. Same text in db/policies/engagement.sql.
-- NOT RUN in the lane: this migration and db/tests/engagement/T0B-CNTPOL-1_number_counters.test.sql; founder runs db/tests/run-suites.sh before push-cloud.ps1.
SET LOCAL ROLE lims_owner;

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

-- LD-257: a patient actor can never lower a counter (OTP cap, link failure limit); equal or higher is fine.
CREATE FUNCTION engagement.guard_counter_decrease() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_actor text := app.current_actor_type();
BEGIN
  IF v_actor = 'patient' AND NEW.last_value < OLD.last_value THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row', DETAIL = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER number_counters__patient_no_decrease BEFORE UPDATE ON engagement.number_counters
  FOR EACH ROW EXECUTE FUNCTION engagement.guard_counter_decrease();
