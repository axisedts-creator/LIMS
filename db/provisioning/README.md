# db/provisioning

Steps that run against services other than Postgres. SQL migrations never touch the Storage-owned schema `storage` (LD-54, CR-C0-T0B-12 option b).

## create-storage-buckets.mjs (T0B-12, REQ-SEC-034)

Ensures the 11 buckets of 08 §4.8 exist and are private, through the Storage service HTTP API with the server credential (08 R12b).
`reporting-legacy` is reserved and never created. Idempotent: missing bucket is created private, public bucket is flipped private.

- Credential: file path in `LIMS_CORE_STORAGE_KEY_FILE` (secret `core_storage_service_key`, C1 02-TRD §8.2). Never pass the value on the command line or log it.
- Base URL: `LIMS_CORE_STORAGE_URL` = internal Storage API base incl. `/storage/v1` prefix, no default (LD-55, CR-C0-T0B-12-b).
  Contract: `db/meta/decisions/SP-4.md` "Provisioning contract (LD-55)". Unit-tested against a stub server only; never run against a real stack yet.
- Output: one `<bucket> created|ok|flipped` line per bucket; any failure prints one line and exits 1.

## First-deploy smoke test (not run by CI or by task T0B-12)

Run once on the first deploy of a stack, after `db/bootstrap` and all migrations are applied:

1. `node db/provisioning/create-storage-buckets.mjs` with `LIMS_CORE_STORAGE_URL` and `LIMS_CORE_STORAGE_KEY_FILE` set (exit 0 expected; this confirms the LD-55 routes live).
2. Run it again: it must send no create request (idempotent).
3. `bash db/tests/run-suites.sh db/tests/storage/T0B-12_storage.test.sql` as superuser: bucket set, all private, no end-user policies on
   `storage.*`, and the authenticated/anon cross-tenant probes.
