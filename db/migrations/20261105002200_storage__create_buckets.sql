-- T0B-12: Storage buckets of 08 §4.8 (names verbatim, <owner-module>-<purpose>, exception `reports`; 08 R26), all private (REQ-SEC-034).
-- SP-4 outcome api-proxied (db/meta/decisions/SP-4.md): Storage is reached only through ctx.storage with the server credential, so this
-- file creates buckets only. No policy on storage.objects / realtime.*, no grant to end-user roles; `reporting-legacy` stays reserved (B4).
-- A bucket pre-created public (Storage service, earlier run) is flipped private, not skipped. Single role switch: lims_owner.
-- [CONV] lims_owner needs INSERT/UPDATE on storage.buckets in the pinned image: .orchestra/cr/T0B-12.md.
SET LOCAL ROLE lims_owner;

INSERT INTO storage.buckets (id, name, public) VALUES
  ('reports', 'reports', false),
  ('reporting-inputs', 'reporting-inputs', false),
  ('reporting-prints', 'reporting-prints', false),
  ('identity-assets', 'identity-assets', false),
  ('identity-exports', 'identity-exports', false),
  ('frontdesk-trf', 'frontdesk-trf', false),
  ('billing-exports', 'billing-exports', false),
  ('instruments-attachments', 'instruments-attachments', false),
  ('micro-imports', 'micro-imports', false),
  ('anatomic-images', 'anatomic-images', false),
  ('partners-slips', 'partners-slips', false)
ON CONFLICT (id) DO UPDATE SET public = false;
