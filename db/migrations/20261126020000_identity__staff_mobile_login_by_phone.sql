-- PHLEBO-UI-FULL-1 (founder decision 2026-11-26): the phlebotomist app signs in with phone number + password.
-- GoTrue knows users by email, so the mobile login first turns the phone into the account's email. This runs before any
-- claims exist (x-context identity_auth), so it is a DEFINER lookup. It answers ONLY when exactly one active staff user
-- has that phone; no match, an inactive user or two users with the same phone all return NULL, and the caller then fails
-- exactly like a wrong password (no enumeration). The email never leaves the API process.
SET LOCAL ROLE lims_owner;

CREATE POLICY users__select__owner_phone_login ON core.users FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'identity_staff_email_for_phone'
         AND phone_e164 IS NOT NULL AND phone_e164 = current_setting('app.pre_phone', true));

CREATE FUNCTION app.identity_staff_email_for_phone(p_phone_e164 text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email text; v_count integer;
BEGIN
  IF p_phone_e164 IS NULL OR p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' THEN RETURN NULL; END IF;
  PERFORM set_config('app.pre_phone', p_phone_e164, true);
  PERFORM set_config('app.maintenance', 'identity_staff_email_for_phone', true);
  SELECT count(*)::integer, min(u.email_normalized) INTO v_count, v_email
    FROM core.users u
   WHERE u.phone_e164 = p_phone_e164 AND u.is_active AND u.email_normalized IS NOT NULL;
  PERFORM set_config('app.maintenance', '', true);
  PERFORM set_config('app.pre_phone', '', true);
  RETURN CASE WHEN v_count = 1 THEN v_email ELSE NULL END;
END $$;
ALTER FUNCTION app.identity_staff_email_for_phone(text) OWNER TO lims_owner;
REVOKE ALL ON FUNCTION app.identity_staff_email_for_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.identity_staff_email_for_phone(text) TO lims_app;

-- lookups by phone at login
CREATE INDEX users__phone_e164__p_idx ON core.users (phone_e164) WHERE phone_e164 IS NOT NULL;
