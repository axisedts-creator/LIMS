-- T0B-10.C2: __platform policies on core.tenants, verbatim from C2 05-SCHEMA §10.2 ("C0 writes them in its migrations"; §5.3).
-- Not yet in C0 05-SCHEMA §10: .orchestra/cr/T0B-10.C2.md. core.dead_letters __platform policies already exist
-- (20261105000900_core__create_event_log.sql; C0 05-SCHEMA §10 wins).
SET LOCAL ROLE lims_owner;

CREATE POLICY tenants__select__platform ON core.tenants FOR SELECT TO lims_app USING ((SELECT app.is_platform_actor()));
CREATE POLICY tenants__insert__platform ON core.tenants FOR INSERT TO lims_app WITH CHECK ((SELECT app.is_platform_actor()));
CREATE POLICY tenants__update__platform ON core.tenants FOR UPDATE TO lims_app
  USING ((SELECT app.is_platform_actor())) WITH CHECK ((SELECT app.is_platform_actor()));
