-- HC-T16 test-DB stand-ins, applied by tests/homecollection/HC-T16.pg.sh as superuser AFTER 05-SCHEMA §4.2 is installed (only when C0's migration lacks them).
-- (1) §4.2 function ownership + owner privileges: the function must be owned by lims_owner (the owner policies are TO lims_owner) and FORCE RLS must be on.
-- (2) C0's homecollection.visits__transition_guard is not in the P-1 stand-in: this is the part the retention path needs (05-SCHEMA §4 comment lines "address/window/note columns may change only while OLD.status IN
--     ('unassigned','assigned') - EXCEPT the retention anonymisation when current_user = 'lims_owner' AND app.maintenance = ..."; raised as P0001 'immutable_row').
-- Synthetic test fixture only; the real migration (C0 P-1) replaces it, and the same HC-T16 tests then run against the real objects.
DO $$
BEGIN
  IF to_regprocedure('app.homecollection_anonymise_retired_visits(timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION app.homecollection_anonymise_retired_visits(timestamptz) OWNER TO lims_owner;
  END IF;
END $$;
GRANT USAGE ON SCHEMA homecollection TO lims_owner;
GRANT SELECT, UPDATE ON homecollection.visits, homecollection.handover_items TO lims_owner;
ALTER TABLE homecollection.visits FORCE ROW LEVEL SECURITY;
ALTER TABLE homecollection.handover_items FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'homecollection.visits'::regclass AND tgname = 'visits__transition_guard') THEN
    CREATE FUNCTION homecollection.visits__transition_guard_t16() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $f$
    BEGIN
      IF OLD.status IN ('completed','failed','cancelled') THEN
        IF (NEW.address_text, NEW.landmark, NEW.latitude, NEW.longitude, NEW.note_for_phlebotomist, NEW.status_reason_text, NEW.window_start, NEW.window_end)
           IS DISTINCT FROM (OLD.address_text, OLD.landmark, OLD.latitude, OLD.longitude, OLD.note_for_phlebotomist, OLD.status_reason_text, OLD.window_start, OLD.window_end) THEN
          IF NOT (current_user = 'lims_owner'
                  AND current_setting('app.maintenance', true) = 'homecollection_anonymise_retired_visits'
                  AND NEW.window_start IS NOT DISTINCT FROM OLD.window_start AND NEW.window_end IS NOT DISTINCT FROM OLD.window_end
                  AND NEW.address_text IS NULL AND NEW.landmark IS NULL AND NEW.latitude IS NULL AND NEW.longitude IS NULL
                  AND NEW.note_for_phlebotomist IS NULL AND NEW.status_reason_text IS NULL) THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'immutable_row';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $f$;
    CREATE TRIGGER visits__transition_guard BEFORE UPDATE ON homecollection.visits FOR EACH ROW EXECUTE FUNCTION homecollection.visits__transition_guard_t16();
  END IF;
END $$;
