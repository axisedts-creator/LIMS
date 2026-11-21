-- T0C-MSGDESK-1 (LD-321, LD-325; founder 2026-11-17 09:18 NPT priority order; ElabAssist "Messages" and "Message To Laboratory").
-- Five NEW tenant tables, nothing else touched (additive):
--   engagement.broadcast_template (name, channel sms | whatsapp | email, subject (email only), body with placeholders from a closed list, is_active):
--     staff only; lims_app SELECT, INSERT, UPDATE (deactivate), no DELETE.
--   engagement.broadcast (template_id, audience_filter jsonb (closed schema in engagement.yaml), status draft | pending_approval | approved | sending | sent | cancelled,
--     recipient_count 0..5000, opted_out_count, requested_by, approved_by, approved_at): the second person rule lives in the table too
--     (approved_by <> requested_by; approved, sending and sent need an approver). Staff only; SELECT, INSERT, UPDATE, no DELETE.
--   engagement.broadcast_recipient (broadcast_id, party_kind laboratory | franchise | client | lab_user, party_id, channel_address, status queued | sent | failed | skipped,
--     skip_reason, outbox_id): one row per party per broadcast; outbox_id unique when set = one outbox row per recipient, so a retry never double sends.
--     channel_address holds the real address (needed to send); the API masks it on read. outbox_id points at the notification outbox row written through
--     NotificationPort (owned by reporting, so no cross-module FK). Staff only; SELECT, INSERT, UPDATE (status moves), no DELETE.
--   partners.partner_ticket (party_kind partner, party_id = partners.partners.id, subject, status new | replied | closed, last_message_at):
--     staff (user, system) read and write all tickets of the tenant; a partner actor reads, creates and updates only the tickets of its own partner
--     (party_id = app.current_partner_id()). SELECT, INSERT, UPDATE, no DELETE.
--   partners.partner_ticket_message (ticket_id, sender_kind partner | lab, body): append only (SELECT, INSERT; no UPDATE, no DELETE);
--     a partner actor reads and writes only messages of its own tickets and only with sender_kind partner; a staff user writes as lab.
-- Real sending needs a provider the founder has configured and approved (LD-321); this schema only records broadcasts and queues through the outbox.
-- No data rewrite: no UPDATE / INSERT / DELETE of rows, no existing table, column or policy is changed.
-- Idempotent: IF NOT EXISTS everywhere, each CREATE POLICY guarded by pg_policy, triggers CREATE OR REPLACE.
-- Cloud apply is a founder step (push-cloud), after 20261117230000 (or 20261117220000 when MISREPORTS adds none); not done by this task.
-- DOWN (manual, never automatic; drops the message history: founder decision, export first):
--   DROP TABLE IF EXISTS partners.partner_ticket_message, partners.partner_ticket, engagement.broadcast_recipient, engagement.broadcast, engagement.broadcast_template;
SET LOCAL ROLE lims_owner;

-- ---------- (1) engagement.broadcast_template ----------
CREATE TABLE IF NOT EXISTS engagement.broadcast_template (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  name        text        NOT NULL,
  channel     text        NOT NULL,
  subject     text,
  body        text        NOT NULL,
  is_active   boolean     NOT NULL DEFAULT true,
  version     integer     NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        NOT NULL,
  CONSTRAINT broadcast_template__pk PRIMARY KEY (id),
  CONSTRAINT broadcast_template__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT broadcast_template__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT broadcast_template__channel__ck CHECK (channel IN ('sms','whatsapp','email')),
  CONSTRAINT broadcast_template__name__ck CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT broadcast_template__subject__ck CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 150),
  CONSTRAINT broadcast_template__body__ck CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
  CONSTRAINT broadcast_template__version__ck CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS broadcast_template__tenant_id_is_active__idx ON engagement.broadcast_template (tenant_id, is_active, name);

-- ---------- (2) engagement.broadcast ----------
CREATE TABLE IF NOT EXISTS engagement.broadcast (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  template_id     uuid        NOT NULL,
  audience_filter jsonb       NOT NULL,
  status          text        NOT NULL DEFAULT 'draft',
  recipient_count integer     NOT NULL DEFAULT 0,
  opted_out_count integer     NOT NULL DEFAULT 0,
  requested_by    uuid        NOT NULL,
  approved_by     uuid,
  approved_at     timestamptz,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT broadcast__pk PRIMARY KEY (id),
  CONSTRAINT broadcast__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT broadcast__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT broadcast__template__fk FOREIGN KEY (tenant_id, template_id) REFERENCES engagement.broadcast_template (tenant_id, id),
  CONSTRAINT broadcast__status__ck CHECK (status IN ('draft','pending_approval','approved','sending','sent','cancelled')),
  CONSTRAINT broadcast__recipient_count__ck CHECK (recipient_count BETWEEN 0 AND 5000),
  CONSTRAINT broadcast__opted_out_count__ck CHECK (opted_out_count >= 0 AND opted_out_count <= 1000000),
  CONSTRAINT broadcast__audience_filter__ck CHECK (jsonb_typeof(audience_filter) = 'object'),
  CONSTRAINT broadcast__second_person__ck CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT broadcast__approved_has_approver__ck CHECK (status NOT IN ('approved','sending','sent') OR approved_by IS NOT NULL),
  CONSTRAINT broadcast__version__ck CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS broadcast__tenant_id_status_created_at__idx ON engagement.broadcast (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS broadcast__tenant_id_template_id__idx ON engagement.broadcast (tenant_id, template_id);

-- ---------- (3) engagement.broadcast_recipient ----------
CREATE TABLE IF NOT EXISTS engagement.broadcast_recipient (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  broadcast_id    uuid        NOT NULL,
  party_kind      text        NOT NULL,
  party_id        uuid        NOT NULL,
  channel_address text        NOT NULL,
  status          text        NOT NULL DEFAULT 'queued',
  skip_reason     text,
  outbox_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcast_recipient__pk PRIMARY KEY (id),
  CONSTRAINT broadcast_recipient__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT broadcast_recipient__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT broadcast_recipient__broadcast__fk FOREIGN KEY (tenant_id, broadcast_id) REFERENCES engagement.broadcast (tenant_id, id),
  CONSTRAINT broadcast_recipient__party__uq UNIQUE (tenant_id, broadcast_id, party_kind, party_id),
  CONSTRAINT broadcast_recipient__party_kind__ck CHECK (party_kind IN ('laboratory','franchise','client','lab_user')),
  CONSTRAINT broadcast_recipient__status__ck CHECK (status IN ('queued','sent','failed','skipped')),
  CONSTRAINT broadcast_recipient__skip_reason__ck CHECK (skip_reason IS NULL OR skip_reason IN ('opted_out','no_address')),
  CONSTRAINT broadcast_recipient__address__ck CHECK (char_length(channel_address) BETWEEN 1 AND 254)
);
CREATE UNIQUE INDEX IF NOT EXISTS broadcast_recipient__tenant_id_outbox_id__uq ON engagement.broadcast_recipient (tenant_id, outbox_id) WHERE outbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS broadcast_recipient__tenant_id_broadcast_id_status__idx ON engagement.broadcast_recipient (tenant_id, broadcast_id, status);

-- ---------- (4) RLS: the three broadcast tables are staff only (user, system); no partner, patient, portal or device policy ----------
ALTER TABLE engagement.broadcast_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.broadcast_template FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement.broadcast ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.broadcast FORCE ROW LEVEL SECURITY;
ALTER TABLE engagement.broadcast_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement.broadcast_recipient FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast_template'::regclass AND polname = 'broadcast_template__select__tenant') THEN
  CREATE POLICY broadcast_template__select__tenant ON engagement.broadcast_template FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast_template'::regclass AND polname = 'broadcast_template__insert__tenant') THEN
  CREATE POLICY broadcast_template__insert__tenant ON engagement.broadcast_template FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast_template'::regclass AND polname = 'broadcast_template__update__tenant') THEN
  CREATE POLICY broadcast_template__update__tenant ON engagement.broadcast_template FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast'::regclass AND polname = 'broadcast__select__tenant') THEN
  CREATE POLICY broadcast__select__tenant ON engagement.broadcast FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast'::regclass AND polname = 'broadcast__insert__tenant') THEN
  CREATE POLICY broadcast__insert__tenant ON engagement.broadcast FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast'::regclass AND polname = 'broadcast__update__tenant') THEN
  CREATE POLICY broadcast__update__tenant ON engagement.broadcast FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast_recipient'::regclass AND polname = 'broadcast_recipient__select__tenant') THEN
  CREATE POLICY broadcast_recipient__select__tenant ON engagement.broadcast_recipient FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast_recipient'::regclass AND polname = 'broadcast_recipient__insert__tenant') THEN
  CREATE POLICY broadcast_recipient__insert__tenant ON engagement.broadcast_recipient FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'engagement.broadcast_recipient'::regclass AND polname = 'broadcast_recipient__update__tenant') THEN
  CREATE POLICY broadcast_recipient__update__tenant ON engagement.broadcast_recipient FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON engagement.broadcast_template TO lims_app;
GRANT SELECT, INSERT, UPDATE ON engagement.broadcast TO lims_app;
GRANT SELECT, INSERT, UPDATE ON engagement.broadcast_recipient TO lims_app;
CREATE OR REPLACE TRIGGER broadcast_template__audit AFTER INSERT OR UPDATE OR DELETE ON engagement.broadcast_template FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
CREATE OR REPLACE TRIGGER broadcast__audit AFTER INSERT OR UPDATE OR DELETE ON engagement.broadcast FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();

-- ---------- (5) partners.partner_ticket ----------
CREATE TABLE IF NOT EXISTS partners.partner_ticket (
  id              uuid        NOT NULL,
  tenant_id       uuid        NOT NULL,
  party_kind      text        NOT NULL DEFAULT 'partner',
  party_id        uuid        NOT NULL,
  subject         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'new',
  last_message_at timestamptz,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid        NOT NULL,
  CONSTRAINT partner_ticket__pk PRIMARY KEY (id),
  CONSTRAINT partner_ticket__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partner_ticket__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT partner_ticket__partner__fk FOREIGN KEY (tenant_id, party_id) REFERENCES partners.partners (tenant_id, id),
  CONSTRAINT partner_ticket__party_kind__ck CHECK (party_kind IN ('partner')),
  CONSTRAINT partner_ticket__status__ck CHECK (status IN ('new','replied','closed')),
  CONSTRAINT partner_ticket__subject__ck CHECK (char_length(btrim(subject)) BETWEEN 1 AND 150),
  CONSTRAINT partner_ticket__version__ck CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS partner_ticket__tenant_id_party_id_status__idx ON partners.partner_ticket (tenant_id, party_kind, party_id, status);
CREATE INDEX IF NOT EXISTS partner_ticket__tenant_id_status_created_at__idx ON partners.partner_ticket (tenant_id, status, created_at DESC);

-- ---------- (6) partners.partner_ticket_message (append only) ----------
CREATE TABLE IF NOT EXISTS partners.partner_ticket_message (
  id          uuid        NOT NULL,
  tenant_id   uuid        NOT NULL,
  ticket_id   uuid        NOT NULL,
  sender_kind text        NOT NULL,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        NOT NULL,
  CONSTRAINT partner_ticket_message__pk PRIMARY KEY (id),
  CONSTRAINT partner_ticket_message__tenant_id_id__uq UNIQUE (tenant_id, id),
  CONSTRAINT partner_ticket_message__tenant__fk FOREIGN KEY (tenant_id) REFERENCES core.tenants (id),
  CONSTRAINT partner_ticket_message__ticket__fk FOREIGN KEY (tenant_id, ticket_id) REFERENCES partners.partner_ticket (tenant_id, id),
  CONSTRAINT partner_ticket_message__sender_kind__ck CHECK (sender_kind IN ('partner','lab')),
  CONSTRAINT partner_ticket_message__body__ck CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)
);
CREATE INDEX IF NOT EXISTS partner_ticket_message__tenant_id_ticket_id_created_at__idx ON partners.partner_ticket_message (tenant_id, ticket_id, created_at);

-- ---------- (7) RLS: staff see the tenant; a partner actor sees only its own partner's tickets and their messages ----------
ALTER TABLE partners.partner_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_ticket FORCE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_ticket_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners.partner_ticket_message FORCE ROW LEVEL SECURITY;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket'::regclass AND polname = 'partner_ticket__select__tenant') THEN
  CREATE POLICY partner_ticket__select__tenant ON partners.partner_ticket FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket'::regclass AND polname = 'partner_ticket__insert__tenant') THEN
  CREATE POLICY partner_ticket__insert__tenant ON partners.partner_ticket FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket'::regclass AND polname = 'partner_ticket__update__tenant') THEN
  CREATE POLICY partner_ticket__update__tenant ON partners.partner_ticket FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'))
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket'::regclass AND polname = 'partner_ticket__select__partner') THEN
  CREATE POLICY partner_ticket__select__partner ON partners.partner_ticket FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
           AND party_kind = 'partner' AND party_id = (SELECT app.current_partner_id()));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket'::regclass AND polname = 'partner_ticket__insert__partner') THEN
  CREATE POLICY partner_ticket__insert__partner ON partners.partner_ticket FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
                AND party_kind = 'partner' AND party_id = (SELECT app.current_partner_id()) AND status = 'new');
END IF; END $do$;
-- a partner reply moves its own ticket back to new and stamps last_message_at; a partner never closes a ticket
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket'::regclass AND polname = 'partner_ticket__update__partner') THEN
  CREATE POLICY partner_ticket__update__partner ON partners.partner_ticket FOR UPDATE TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
           AND party_kind = 'partner' AND party_id = (SELECT app.current_partner_id()) AND status <> 'closed')
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
                AND party_kind = 'partner' AND party_id = (SELECT app.current_partner_id()) AND status = 'new');
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket_message'::regclass AND polname = 'partner_ticket_message__select__tenant') THEN
  CREATE POLICY partner_ticket_message__select__tenant ON partners.partner_ticket_message FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()) AND (SELECT app.current_actor_type()) IN ('user','system'));
END IF; END $do$;
-- a staff user writes as the lab; the system actor may also replay a queued partner reply
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket_message'::regclass AND polname = 'partner_ticket_message__insert__tenant') THEN
  CREATE POLICY partner_ticket_message__insert__tenant ON partners.partner_ticket_message FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())
                AND ((SELECT app.current_actor_type()) = 'system' OR ((SELECT app.current_actor_type()) = 'user' AND sender_kind = 'lab')));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket_message'::regclass AND polname = 'partner_ticket_message__select__partner') THEN
  CREATE POLICY partner_ticket_message__select__partner ON partners.partner_ticket_message FOR SELECT TO lims_app
    USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner'
           AND EXISTS (SELECT 1 FROM partners.partner_ticket t WHERE t.tenant_id = partner_ticket_message.tenant_id AND t.id = partner_ticket_message.ticket_id
                         AND t.party_kind = 'partner' AND t.party_id = (SELECT app.current_partner_id())));
END IF; END $do$;
DO $do$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'partners.partner_ticket_message'::regclass AND polname = 'partner_ticket_message__insert__partner') THEN
  CREATE POLICY partner_ticket_message__insert__partner ON partners.partner_ticket_message FOR INSERT TO lims_app
    WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'partner' AND sender_kind = 'partner'
                AND EXISTS (SELECT 1 FROM partners.partner_ticket t WHERE t.tenant_id = partner_ticket_message.tenant_id AND t.id = partner_ticket_message.ticket_id
                              AND t.party_kind = 'partner' AND t.party_id = (SELECT app.current_partner_id())));
END IF; END $do$;
GRANT SELECT, INSERT, UPDATE ON partners.partner_ticket TO lims_app;
GRANT SELECT, INSERT ON partners.partner_ticket_message TO lims_app;
CREATE OR REPLACE TRIGGER partner_ticket__audit AFTER INSERT OR UPDATE OR DELETE ON partners.partner_ticket FOR EACH ROW EXECUTE FUNCTION app.tg_row_audit();
