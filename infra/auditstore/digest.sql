-- infra/auditstore/digest.sql (05-SCHEMA s3.4, REQ-SEC-097, 07-SEC AB-8). Nightly 02:30 Asia/Kathmandu [CONV], run as
-- audit_digest (SELECT on the replicated tables; SELECT + INSERT on daily_digests/ops_audit; no UPDATE/DELETE), via
-- psql -X -q -At -v ON_ERROR_STOP=1 -v env=<dev|staging|prod> (role auditstore, lims-auditstore-digest.sh).
-- 1. For business_date D = yesterday (NPT), plus any missed night in D-6 .. D, and each (tenant_id, source_table) with rows that day:
--      rows_sha256  = sha256(convert_to(string_agg(<row as jsonb text>, E'\n' ORDER BY occurred_at, id), 'UTF8'))
--      chain_digest = sha256(coalesce(prev_digest, '\x'::bytea) || rows_sha256 || convert_to(row_count::text, 'UTF8'))
--    prev_digest = chain_digest of the newest earlier day of the same chain (NULL on the first day). A day already
--    digested is never rewritten (ON CONFLICT DO NOTHING): a re-run the same night is a no-op.
-- 2. Re-verifies the last 7 days (D-6 .. D): a stored digest that no longer matches the rows (or its own chain formula)
--    is a mismatch, recorded in auditstore_meta.ops_audit (action digest_mismatch) - never silently recomputed. A
--    backfill is recorded in ops_audit with its reference by the operator BEFORE any digest is recomputed (break-glass).
-- 3. Last output line = total digest_mismatch rows in ops_audit (append-only => monotonic) for the
--    lims_ops_audit_digest_mismatch_total counter.
-- Row text: to_jsonb(row)::text with TimeZone UTC, so the digest never depends on the session time zone.

\set ON_ERROR_STOP 1
\if :{?env}
\else
\set env dev
\endif
SET TIME ZONE 'UTC';
SELECT ((now() AT TIME ZONE 'Asia/Kathmandu')::date - 1) AS digest_day \gset

BEGIN;

CREATE TEMP TABLE digest_now ON COMMIT DROP AS
WITH bounds AS (
  SELECT ((:'digest_day'::date + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu') AS hi,
         ((:'digest_day'::date + 1)::timestamp AT TIME ZONE 'Asia/Kathmandu') - interval '7 days' AS lo
), r AS (
  SELECT 'audit.audit_log'::text AS source_table, t.tenant_id, t.occurred_at, t.id, to_jsonb(t)::text AS j
    FROM audit.audit_log t, bounds b WHERE t.occurred_at >= b.lo AND t.occurred_at < b.hi
  UNION ALL
  SELECT 'audit.access_log', t.tenant_id, t.occurred_at, t.id, to_jsonb(t)::text
    FROM audit.access_log t, bounds b WHERE t.occurred_at >= b.lo AND t.occurred_at < b.hi
  UNION ALL
  SELECT 'billing.activity_log', t.tenant_id, t.occurred_at, t.id, to_jsonb(t)::text
    FROM billing.activity_log t, bounds b WHERE t.occurred_at >= b.lo AND t.occurred_at < b.hi
)
SELECT tenant_id, source_table, (occurred_at AT TIME ZONE 'Asia/Kathmandu')::date AS business_date,
       count(*) AS row_count,
       sha256(convert_to(string_agg(j, E'\n' ORDER BY occurred_at, id), 'UTF8')) AS rows_sha256
  FROM r
 GROUP BY tenant_id, source_table, (occurred_at AT TIME ZONE 'Asia/Kathmandu')::date;

-- 1. links for yesterday AND every missed night in D-6 .. D (review T-15 item 3, REQ-SEC-097: a missed run must not
--    leave a silent hole in the chain). Per chain, only days newer than its latest stored day; one day at a time in
--    ascending order so the LATERAL prev_digest lookup sees the link inserted for the previous day.
DO $digest$
DECLARE
  day date;
BEGIN
  FOR day IN SELECT DISTINCT business_date FROM digest_now ORDER BY 1 LOOP
    INSERT INTO auditstore_meta.daily_digests (tenant_id, source_table, business_date, row_count, rows_sha256, prev_digest, chain_digest)
    SELECT n.tenant_id, n.source_table, n.business_date, n.row_count, n.rows_sha256, p.prev_digest,
           sha256(coalesce(prev_digest, '\x'::bytea) || n.rows_sha256 || convert_to(row_count::text, 'UTF8'))
      FROM digest_now n
      LEFT JOIN LATERAL (
            SELECT d.chain_digest AS prev_digest
              FROM auditstore_meta.daily_digests d
             WHERE d.tenant_id = n.tenant_id AND d.source_table = n.source_table AND d.business_date < n.business_date
             ORDER BY d.business_date DESC
             LIMIT 1) p ON true
     WHERE n.business_date = day
       AND NOT EXISTS (SELECT 1 FROM auditstore_meta.daily_digests l
                        WHERE l.tenant_id = n.tenant_id AND l.source_table = n.source_table
                          AND l.business_date >= n.business_date)
    ON CONFLICT (tenant_id, source_table, business_date) DO NOTHING;
  END LOOP;
END
$digest$;

-- 2. re-verify the last 7 days; every mismatch is recorded (07-SEC AB-8)
INSERT INTO auditstore_meta.ops_audit (id, occurred_at, operator, env, action, detail)
SELECT gen_random_uuid(), now(), 'audit_digest', :'env', 'digest_mismatch',
       jsonb_build_object('tenant_id', d.tenant_id, 'source_table', d.source_table, 'business_date', d.business_date,
                          'stored_row_count', d.row_count, 'current_row_count', coalesce(n.row_count, 0))
  FROM auditstore_meta.daily_digests d
  LEFT JOIN digest_now n USING (tenant_id, source_table, business_date)
 WHERE d.business_date >= :'digest_day'::date - 6 AND d.business_date <= :'digest_day'::date
   AND (n.rows_sha256 IS DISTINCT FROM d.rows_sha256
        OR n.row_count IS DISTINCT FROM d.row_count
        OR d.chain_digest <> sha256(coalesce(d.prev_digest, '\x'::bytea) || d.rows_sha256
                                    || convert_to(d.row_count::text, 'UTF8')));

COMMIT;

-- 3. counter value (last line)
SELECT count(*) FROM auditstore_meta.ops_audit WHERE action = 'digest_mismatch';
