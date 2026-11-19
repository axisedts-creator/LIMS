-- T0B-MISREPORTS-2 / LD-408 (founder decision 2026-11-19 08:04 NPT, CR-C0-MISREPORTS2-001 item 1; A39-4): parent / sub party rule of the
-- two_level_commission report. An explicit party -> parent party link on the settings row (no derivation through the sales hierarchy):
--   partners.party_commercial_setting.parent_credit_party_id  uuid, nullable; NULL = standalone (level 1). Composite tenant FK to
--                                                            catalog.credit_parties (tenant_id, id), the identity the report already rates from.
--   partners.party_commercial_setting.credit_self_not_parent boolean NOT NULL DEFAULT false; true = the outlet keeps its own commission (level 1)
--                                                            although a parent link is on file; false + parent set = level 2, rolls up to the parent.
-- [CONV] a parent link only on credit_party rows and never to the party itself (CHECK).
-- Additive only, no data rewrite (constant DEFAULT is metadata only in PG17). Idempotent: IF NOT EXISTS, constraints guarded by pg_constraint.
-- Cloud apply is a founder step (push-cloud.ps1); not done by this task.
-- DOWN (manual): ALTER TABLE partners.party_commercial_setting DROP COLUMN IF EXISTS parent_credit_party_id, DROP COLUMN IF EXISTS credit_self_not_parent;
SET LOCAL ROLE lims_owner;

ALTER TABLE partners.party_commercial_setting
  ADD COLUMN IF NOT EXISTS parent_credit_party_id uuid,
  ADD COLUMN IF NOT EXISTS credit_self_not_parent boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'partners.party_commercial_setting'::regclass AND conname = 'party_commercial_setting__parent_credit_party__fk') THEN
    ALTER TABLE partners.party_commercial_setting ADD CONSTRAINT party_commercial_setting__parent_credit_party__fk
      FOREIGN KEY (tenant_id, parent_credit_party_id) REFERENCES catalog.credit_parties (tenant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'partners.party_commercial_setting'::regclass AND conname = 'party_commercial_setting__parent_credit_party__ck') THEN
    ALTER TABLE partners.party_commercial_setting ADD CONSTRAINT party_commercial_setting__parent_credit_party__ck
      CHECK (parent_credit_party_id IS NULL OR (party_kind = 'credit_party' AND parent_credit_party_id <> party_id));
  END IF;
END $$;
