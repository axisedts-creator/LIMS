-- T0B-SESSRANGE-1: LD-304 ruling on CR-C0-LOGIN-1 (04-consolidated-decisions A8, REQ-SEC-073).
-- identity.tenant_settings session ranges: idle 15..30 minutes, absolute 1..12 hours (same as the session checks; those are NOT changed).
-- A database built from 20261105001300 already has both checks, so this is a no-op there; it repairs a database that lacks them.
-- Clamp out-of-range rows first (only those rows), then re-add both checks. Idempotent. Cloud apply is a founder step (push-cloud.ps1).
-- cr-approved-breaking: CR-C0-LOGIN-1 ruled by LD-304 (DROP CONSTRAINT IF EXISTS is the idempotent re-add of the same two checks, same ranges).
-- OPEN (see .orchestra/notes/T0B-SESSRANGE-1-dispute.md): under FORCE RLS lims_owner has no UPDATE policy on this table, so the clamp sees no rows.
SET LOCAL ROLE lims_owner;

UPDATE identity.tenant_settings
   SET idle_timeout_minutes   = LEAST(GREATEST(idle_timeout_minutes, 15), 30),
       absolute_session_hours = LEAST(GREATEST(absolute_session_hours, 1), 12)
 WHERE idle_timeout_minutes NOT BETWEEN 15 AND 30
    OR absolute_session_hours NOT BETWEEN 1 AND 12;

ALTER TABLE identity.tenant_settings
  DROP CONSTRAINT IF EXISTS tenant_settings__idle__ck,
  DROP CONSTRAINT IF EXISTS tenant_settings__absolute__ck,
  ADD CONSTRAINT tenant_settings__idle__ck CHECK (idle_timeout_minutes BETWEEN 15 AND 30),
  ADD CONSTRAINT tenant_settings__absolute__ck CHECK (absolute_session_hours BETWEEN 1 AND 12);
