-- C16 T-PERF1 — specimen-status consumer load (pgbench custom script), 02-TRD §12 row "Event consumers" + §7 consumer algorithm.
-- Models `lab.specimen.status_changed.v1` applied to engagement.patient_order_specimens: 2.5/s at 10x (N = 10 labs), 0.25/s at 1x.
-- BUDGET: consumer p95 <= 30 ms (pgbench -P/--report-latencies; read the 95th percentile of the per-statement latency report).
-- LD-184: tester-owned (test-folder file). Synthetic data only: ids come from seed.mjs (same id scheme), no names/phones/codes.
-- Stale-event guard (08 A19 D-106): the upsert only overwrites when the incoming status_seq is HIGHER than the stored one,
--   so a replayed/out-of-order event is a no-op, never a regression.
-- Run (Linux/staging DB, as table owner; parent patient_orders rows come from the seed load):
--   pgbench -n -f consumer.pgbench.sql -D tenants=10 -D orders=1000 -R 2.5 -T 300 -c 4 -j 2 --report-latencies <db>   (10x)
--   pgbench -n -f consumer.pgbench.sql -D tenants=1  -D orders=100  -R 0.25 -T 300 -c 1 --report-latencies <db>        (1x)
\set t random(1, :tenants)
\set o random(1, :orders)
\set ord random(1, 3)
\set seq random(1, 6)
INSERT INTO engagement.patient_order_specimens
  (tenant_id, specimen_id, order_id, patient_id, specimen_type_code, status, status_seq, ordinal, created_by, updated_by)
VALUES (
  ('00000000-0000-4000-8000-' || lpad(:t::text, 12, '0'))::uuid,
  ('00000003-0000-4000-8000-' || lpad((:o * 3 + :ord)::text, 12, '0'))::uuid,
  ('00000002-0000-4000-8000-' || lpad(:o::text, 12, '0'))::uuid,
  ('00000001-0000-4000-8000-' || lpad(:o::text, 12, '0'))::uuid,
  'SYNTH', (ARRAY['collected','received','in_process','resulted','verified','reported'])[:seq], :seq, :ord,
  '00000000-0000-4000-8000-00000000f001'::uuid, '00000000-0000-4000-8000-00000000f001'::uuid)
ON CONFLICT (tenant_id, specimen_id) DO UPDATE
  SET status = EXCLUDED.status, status_seq = EXCLUDED.status_seq, updated_at = now(), updated_by = EXCLUDED.updated_by
  WHERE engagement.patient_order_specimens.status_seq < EXCLUDED.status_seq;
