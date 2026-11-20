-- PLATFORM-DDL-1 (LD-223, founder-approved 2026-11-15 19:49 NPT; audit-realstack-20261115 RS-04): the C2 05-SCHEMA s5.3 __platform policies that
-- 20261105001300 lacked (it held only __tenant / owner_only policies for these tables). Predicate verbatim from the s5.3 heading:
-- TO lims_app USING ((SELECT app.is_platform_actor())); WITH CHECK on INSERT and UPDATE. Names <table>__<command>__platform.
-- s5.3 rows: platform_staff S/I/U, platform_events S/I, auth_events S (no INSERT), feature_flags S/U, support_sessions S/I/U,
-- ird_annex_records S/I/U, ird_annex_events S/I (no UPDATE), ird_annex_documents S/I/U (UPDATE of scan_state only: the existing
-- column grant and trigger, P-19). The tenant_settings / sessions / mfa_factors / invitations / core.tenants rows already exist.
-- Additive only: no existing policy, grant, function, trigger or table changes; the grants of 20261105001300 already cover every command.
-- Copied 1:1 into db/policies/identity.sql (AC-0B-2.3). NOT RUN in the lane: db/tests/identity/PLATFORM-DDL-1_policies.test.sql.
SET LOCAL ROLE lims_owner;

CREATE POLICY platform_staff__select__platform ON identity.platform_staff FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY platform_staff__insert__platform ON identity.platform_staff FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY platform_staff__update__platform ON identity.platform_staff FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY platform_events__select__platform ON identity.platform_events FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY platform_events__insert__platform ON identity.platform_events FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY auth_events__select__platform ON identity.auth_events FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY feature_flags__select__platform ON identity.feature_flags FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY feature_flags__update__platform ON identity.feature_flags FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY support_sessions__select__platform ON identity.support_sessions FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY support_sessions__insert__platform ON identity.support_sessions FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY support_sessions__update__platform ON identity.support_sessions FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_records__select__platform ON identity.ird_annex_records FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_records__insert__platform ON identity.ird_annex_records FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_records__update__platform ON identity.ird_annex_records FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_events__select__platform ON identity.ird_annex_events FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_events__insert__platform ON identity.ird_annex_events FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_documents__select__platform ON identity.ird_annex_documents FOR SELECT TO lims_app
  USING ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_documents__insert__platform ON identity.ird_annex_documents FOR INSERT TO lims_app
  WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY ird_annex_documents__update__platform ON identity.ird_annex_documents FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
