-- T0B-05: <m>.event_inbox in the 16 schemas of 05-SCHEMA §3.9 (no catalog, 08 A31.4), each = the §10 template (table, brin index,
-- ENABLE + FORCE RLS, __tenant SELECT/INSERT, purge owner policies gated on app.maintenance = 'purge_event_inboxes', SELECT/INSERT grant).
SET LOCAL ROLE lims_owner;

-- ---------------------------------------------------------------- identity
CREATE TABLE identity.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON identity.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE identity.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE identity.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON identity.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON identity.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON identity.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON identity.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON identity.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- frontdesk
CREATE TABLE frontdesk.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON frontdesk.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE frontdesk.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE frontdesk.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON frontdesk.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON frontdesk.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON frontdesk.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON frontdesk.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON frontdesk.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- billing
CREATE TABLE billing.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON billing.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE billing.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE billing.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON billing.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON billing.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON billing.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON billing.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON billing.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- lab
CREATE TABLE lab.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON lab.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE lab.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE lab.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON lab.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON lab.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON lab.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON lab.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON lab.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- instruments
CREATE TABLE instruments.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON instruments.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE instruments.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE instruments.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON instruments.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON instruments.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON instruments.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON instruments.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON instruments.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- reporting
CREATE TABLE reporting.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON reporting.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE reporting.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE reporting.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON reporting.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON reporting.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON reporting.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON reporting.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON reporting.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- analytics
CREATE TABLE analytics.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON analytics.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE analytics.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE analytics.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON analytics.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON analytics.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON analytics.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON analytics.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON analytics.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- quality
CREATE TABLE quality.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON quality.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE quality.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE quality.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON quality.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON quality.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON quality.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON quality.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON quality.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- micro
CREATE TABLE micro.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON micro.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE micro.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE micro.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON micro.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON micro.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON micro.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON micro.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON micro.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- anatomic
CREATE TABLE anatomic.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON anatomic.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE anatomic.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE anatomic.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON anatomic.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON anatomic.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON anatomic.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON anatomic.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON anatomic.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- inventory
CREATE TABLE inventory.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON inventory.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE inventory.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE inventory.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON inventory.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON inventory.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON inventory.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON inventory.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON inventory.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- partners
CREATE TABLE partners.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON partners.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE partners.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE partners.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON partners.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON partners.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON partners.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON partners.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON partners.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- smartreport
CREATE TABLE smartreport.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON smartreport.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE smartreport.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE smartreport.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON smartreport.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON smartreport.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON smartreport.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON smartreport.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON smartreport.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- payments
CREATE TABLE payments.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON payments.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE payments.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE payments.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON payments.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON payments.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON payments.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON payments.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON payments.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- engagement
CREATE TABLE engagement.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON engagement.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE engagement.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE engagement.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON engagement.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON engagement.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON engagement.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON engagement.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON engagement.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');

-- ---------------------------------------------------------------- homecollection
CREATE TABLE homecollection.event_inbox (
  tenant_id uuid NOT NULL, event_id uuid NOT NULL, event_type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
  CONSTRAINT event_inbox__pk PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT event_inbox__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id)
);
CREATE INDEX event_inbox__received_at__brin ON homecollection.event_inbox USING brin (received_at);  -- EXCEPTION: retention
ALTER TABLE homecollection.event_inbox ENABLE ROW LEVEL SECURITY;  ALTER TABLE homecollection.event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY event_inbox__select__tenant ON homecollection.event_inbox FOR SELECT TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
CREATE POLICY event_inbox__insert__tenant ON homecollection.event_inbox FOR INSERT TO lims_app
  WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()));
GRANT SELECT, INSERT ON homecollection.event_inbox TO lims_app;
CREATE POLICY event_inbox__select__owner_only ON homecollection.event_inbox FOR SELECT TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
CREATE POLICY event_inbox__delete__owner_only ON homecollection.event_inbox FOR DELETE TO lims_owner
  USING (current_setting('app.maintenance', true) = 'purge_event_inboxes' AND received_at < now() - interval '90 days');
