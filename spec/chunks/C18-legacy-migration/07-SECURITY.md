# C18 Legacy Data Migration — 07 SECURITY

Status: DRAFT, 2026-11-06. A migration moves a lab's whole patient history at once: health data is sensitive under the Privacy Act (s.27(2)), staff are personally liable (s.12(4), s.29 — 04 L17), and all PHI must stay in Nepal (04 S1). Requirement IDs are cited, not copied (04 precedence rule 4).

## 1. Applicable requirements

| REQ | How it applies to C18 | Where implemented / tested |
|---|---|---|
| REQ-SEC-004 | per-column PHI classification of staging and proposed owner tables | 05-SCHEMA §6, Appendix B; `db/meta/tables.yaml` (CR-C18-001) |
| REQ-SEC-005, 006 | migrated patients get a `legacy_import` consent row with all channel flags false; no message is ever sent by a migration (owners publish no events, call no NotificationPort) | CR-C18-002; PRD AC-07.5 test |
| REQ-SEC-007 | tooling, files and DB on Nepal servers only; no foreign service; transfer via WireGuard/SFTP or age-encrypted media | 02-TRD §4.3; CR-C18-006; CI grep: no network modules in `src/**` |
| REQ-SEC-010 | threat model (§3) + security sign-off before first real run | DoD §4 |
| REQ-SEC-011, 012, 014, 015, 016 | every staging table ENABLE + FORCE RLS, per-command policies naming `lims_migration` (PROPOSED EXCEPTION, 08 A19 D-136) with the `(SELECT app.is_staff_or_system())` guard (08 A17 P-16), default deny for UPDATE/DELETE on append-only tables | 05-SCHEMA §5; probes §6 |
| REQ-SEC-013, 067 | tenant comes only from `--tenant <code>`, resolved by C0's `app.core_resolve_tenant_code` (active tenants only; 08 A19 D-134) and fixed on the run row, set into claims by the C0 tool runtime; never from package content (manifest tenant is only compared, AC-02.5) | 02-TRD §4.2; AC-02.5 |
| REQ-SEC-019–021 | C18 adds no SECURITY DEFINER function; it is granted EXECUTE on two existing C0 DEFINERs (`app.core_resolve_tenant_code`, `app.cron_tenant_ids`) when CR-C18-001 is accepted after B4 (D-134); the runs lifecycle guard is SECURITY INVOKER with `search_path = ''` | 05-SCHEMA §2, §4 |
| REQ-SEC-023, 024, 026, 027 | `tenant_id` leading every index; explicit `tenant_id = $1` in every staging query; composite FKs; no default | 05-SCHEMA; lint of `src/staging/**` |
| REQ-SEC-028 | ids UUIDv7; run handle `run_code` is not secret and never used as a credential | 05-SCHEMA |
| REQ-SEC-029, 030 | no `service_role`/secret key anywhere in C18; runtime asserts `current_user = 'lims_migration'` | CR-C18-005; test |
| REQ-SEC-039, 131 | dedicated `lims_migration` login: NOBYPASSRLS, owns nothing, NOLOGIN outside windows; `lims_api`/`lims_worker` have no staging access | 05-SCHEMA §2, §12 |
| REQ-SEC-040, 041, 042 | cross-tenant probes on every staging table and on every new owner port; synthetic tenants only in tests; negative policy tests | §6 |
| REQ-SEC-044 | crosswalk targets, `link` targets and sign-off memberships of another tenant are rejected (fuzzed with tenant_b ids) | §6 T-07, T-08 |
| REQ-SEC-045, 133 | the migration actor legitimately touches "unusually many patient records"; an alert fires if the migration actor writes **outside** an open window (role login enabled) or if `lims_migration` logs in while no window is approved | CR-C18-006 (C1 alert on `pg_stat_activity` / auth log) |
| REQ-SEC-055 (analogue) | two-person rule for load, void and early purge: the second operator runs a separate command (`approve`, `void approve`, `purge approve-early`) from their **own** Unix account, mapped through `LIMS_MIGRATION_OPERATOR_MAP`, and must differ from the requester; each writes a `signoffs` row (08 A19 D-133). Lab-lead match decisions and sign-off rest on the signed paper form, whose reference is stored on every decision and on the sign-off (design choice §4 item 7) | 03-APP-FLOW G2, T19, T21, §3.13–3.14; AC-07.1, AC-11.1, AC-11.4, AC-12.2 |
| REQ-SEC-062, 063 | operators are the LIMS provider platform staff (separate identity, MFA per C2) with C1 `ops_admin` host accounts; host access via WireGuard + SSH keys (C1) | C1; `LIMS_MIGRATION_OPERATOR_MAP` cross-check |
| REQ-SEC-080, 082 | strict CSV/manifest validation (unknown columns rejected, lengths, patterns); all SQL parameterised (`unnest` arrays), no string-built SQL | 02-TRD §6.3, §7; lint |
| REQ-SEC-083, 084, 087 | legacy PDFs treated as untrusted: size cap 15 MB, magic bytes, sha256, malware scan + qpdf sanitise in C6's sandboxed pipeline before any staff view (04 R7) | CR-C18-004; AC-08.2 |
| REQ-SEC-085 | legacy PDFs served only by C6 as attachments with `nosniff`, `no-store` | CR-C18-004 |
| REQ-SEC-095 | CLI error messages: codes + safe text, no SQL, no PHI | 04-UI-UX §5 |
| REQ-SEC-096, 097 | command audit in append-only `run_events`; owner tables audited by C0 triggers with actor = migration system actor and `request_id` = batch id; reveals logged | 05-SCHEMA §4; AC-05.7, AC-17.3 |
| REQ-SEC-098 | logs carry only UUIDs/counts/codes (§5) | log-scan test |
| REQ-SEC-125 | dedicated LUKS volume for packages, PDFs and run files | CR-C18-006 |
| REQ-SEC-126, 127 | staging rows enter encrypted WAL/backups like other production data; purge does not remove backup copies (documented) | 05-SCHEMA §9 |
| REQ-SEC-128 | `LIMS_MIGRATION_DATABASE_URL` from SOPS, rendered to tmpfs per window, password rotated on window open | CR-C18-006 |
| REQ-SEC-129, 130 | exact-pinned deps (one new: `write-excel-file` 4.1.1, same as C3); container image pinned by digest, non-root, read-only root FS except the run volume, trivy scan | 02-TRD §18; T13 |
| REQ-SEC-132 | container egress only to `data-1:5432` on wg0; no internet | CR-C18-006 |
| REQ-SEC-134 | incident runbook (wrong tenant, PHI exposure) linked to C1 IR | 04-UI-UX §6 `incident.md` |
| REQ-SEC-136 | real migration data **only** in production; rehearsals run on the production host and never load (03-APP-FLOW §6.2); tests use synthetic packages only | runbook; CI fixture scan |
| REQ-SEC-139 | staging purge after sign-off + 30 days; minimisation: only final results, no in-flight work, no staff accounts, no audit logs | AC-12.x; PRD §4.2 |
| REQ-SEC-140 | window close removes the temporary WireGuard peer and SFTP chroot; operators offboarded per C1 | CR-C18-006 |
| REQ-SEC-141 | the eLabs vendor (if it performs the export) is added to the vendor/channel risk register with "data touched: full lab history, in Nepal at the lab site" | founder action (T00 note) |

## 2. Assets and entry points

| Asset | PHI | Entry points |
|---|---|---|
| Raw eLabs export | P3 | lab site → inbox (SFTP over temporary WireGuard peer, or age-encrypted media) |
| Canonical package (CSVs, PDFs) | P3 | transformer output on the host volume |
| `lims-migrate` process | handles P3 in memory | SSH session of an operator on the migration host |
| `lims_migration` credentials | key to staging + owner writes as `lims_app` | SOPS secret, tmpfs file, window playbook |
| `migration_staging` tables | P3 | `lims_migration` connections only |
| Owner legacy tables + `reporting-legacy` bucket (08 R26) | P3 | owner ports (write); owner HTTP read endpoints (staff) |
| Reports, run ledger | P0/P1 | CLI `report`/`status` |
| Operator terminal output | P3 when `--reveal` | screen, scrollback, screen-share with the lab lead |
| Crosswalk / finance / sample files on the host | P2/P3 | host volume |
| Master workbooks for C3 | P0 + doctors' contact data (P2) | the only C18 output that leaves the host (to the lab's staff PC for upload in C3) |

## 3. Threat model (STRIDE)

| Asset / entry | S (spoofing) | T (tampering) | R (repudiation) | I (information disclosure) | D (denial of service) | E (elevation of privilege) |
|---|---|---|---|---|---|---|
| Inbox transfer | attacker uploads a fake package → WireGuard peer bound to the lab's machine key, SFTP chroot per tenant; manifest `extract_id` recorded | package altered in transit/at rest → SHA256SUMS + manifest hashes; `package.changed_since_stage` | who delivered which package → run_files hashes + run_events | sniffing → WireGuard / age encryption; no plaintext on laptops | huge package fills the volume → C1 volume quota; file/row caps (02-TRD §6.3.9) | SFTP account escapes chroot → SFTP-only, no shell (C1) |
| Canonical package parsing | — | malicious CSV (formula injection, control chars, path traversal in `file_path`, oversized cells) → strict grammar, path regex + no `..`, length caps; every text cell of exported CSVs and workbooks passes `@lims/shared-ts/spreadsheet.neutraliseFormula` (08 A13 P-9; no local copy) | — | parsing errors echo cell content → issue messages never include PHI cell values (AC-04.7) | pathological CSV (quoted field never closed) → row size cap 64 KiB → `mig.file.row_too_large` | — |
| CLI process / operator | someone runs the CLI as another operator → `--operator` cross-checked against Unix user map; approver ≠ operator | edits staging rows directly in psql → `lims_migration` creds only via the tool container; no interactive psql role [C1]; `source_row_sha256` re-checked at dry run | operator denies a load or void → run_events + signoffs (append-only; approver row written from the approver's own account) + owner audit triggers; lab lead denies a decision → the signed paper form, whose reference is on every `match_pairs` decision and the `lab_signoff` row | `--reveal` output copied → TTY-only, framed warning, audited; `--json` + `--reveal` refused | runaway load → rate caps, one writer per tenant | operator loads into the wrong tenant → run tenant fixed at `run create`, typed `run_code` confirmation shows tenant name, manifest tenant check |
| `lims_migration` credentials | stolen password used later → NOLOGIN outside windows; password rotated per window; C1 alert on login outside window | — | — | creds give lims_app power → disabled except during windows | — | role has no BYPASSRLS, owns nothing; cannot `SET ROLE` |
| Staging tables | — | other services modify staging → no grants for lims_app/api/worker | — | API/worker reads staging → no USAGE (01 §3); probes | staging bloats DB → purge, alert `MigrationStagingNotPurged` | — |
| Owner ports | non-migration code calls a Legacy port → permissions with `roles: []`, only the migration system actor holds them | replayed batch with altered rows → `legacy_batch_conflict` on hash mismatch | — | ports return PHI → outcomes carry ids and codes only | huge batch → 200-row limit | migration actor used for non-legacy writes → its permission set contains only the three import codes |
| Legacy PDFs | — | malicious PDF → scan + qpdf sanitise in sandbox before any view (04 R7) | — | cross-tenant download → RLS + 404 probes | PDF bombs → C6 sandbox limits | PDF exploit in renderer → legacy PDFs never pass through the Chromium pool (04 R7) |
| Reports / ledger | — | — | — | report contains PHI → JSON schema with key denylist (AC-06.4) | — | — |
| Master workbooks | — | — | — | patient data in a workbook → generated only from `stg_masters` (no patient tables) — unit test asserts no patient columns | — | — |

## 4. Design choices the security reviewer must confirm

Items 1–3 and 8–9 are **PROPOSED EXCEPTION — needs 08 acceptance after B4** (08 A19 D-136): they are not accepted now and are decided together with CR-C18-001 once B4 lifts.

1. **Row-audit exclusion** for `stg_*`, `match_pairs`, `issues`, `samples` (05-SCHEMA §1.5) — PROPOSED EXCEPTION — trade-off: audit_log would retain staging PHI ≥ 5 years; command-level audit + hashes replace it.
2. **Policies to `lims_migration`, not `lims_app`** (05-SCHEMA §1.2) — PROPOSED EXCEPTION — deviation from 02-CV §5.8 to satisfy 01 §3 (the P-16 guard is kept).
3. **`lims_migration` is a member of `lims_app`** (`GRANT lims_app TO lims_migration`) — PROPOSED EXCEPTION — needed to run owner code in-process; during a window it gives the tool process DML on every owner table with system claims (`has_all_centres()` = true); contained by NOLOGIN outside windows, rotation, alerting, the permission set of the migration system actor and the CI grep against other-schema SQL. The reviewer must confirm this versus a narrower role.
4. **Masked review over SSH/screen share** with the lab lead instead of a web screen — the lab lead sees PHI of their own lab only on the operator's screen; no copy leaves the host.
5. **Rehearsals never load** (no non-production target for real data) — accepted cost: the first real load is the historical load R1, which remains voidable until sign-off.
6. **Legacy rows are voided, not deleted** — PHI of a wrongly loaded run stays in owner tables (hidden) unless the founder-approved purge CR candidate (06 §5) is implemented; incident R3 requires it.
7. **Lab-lead decisions rest on the paper sign-off form** (08 A19 D-133) — the lab lead does not authenticate to the CLI; the operator records the lead's membership id (checked as an active `tenant_admin` via `ctx.core.membership`) and the form reference on every `match decide` and on `signoff`. Repudiation is answered by the signed form kept by the lab. A web review screen where the lead acts under their own login stays a 06 §5 candidate.
8. **Class E staging without `expires_at`** (05-SCHEMA §1.6) — PROPOSED EXCEPTION — expiry per run, purge bound to `runs.purge_not_before`.
9. **Class "C-legacy"** for the owner legacy tables (05-SCHEMA §1.7) — PROPOSED EXCEPTION.

## 5. PHI handling and logging rules

| Rule | Detail |
|---|---|
| Logs | `@lims/shared-ts/logger` only; allowed: run_id, batch_id, staging row UUIDs, tenant_id, counts, durations, rule/error codes, file **canonical names** (`results.csv`). Forbidden: names, phones, emails, addresses, DOB, legacy keys/codes, registration numbers, result values, titles, `documents/` paths. Legacy invoice numbers are not logged either (02-CV §9.2 would allow `invoice_no`, but C18 keeps them only in the host-side finance list) |
| Terminal | masked by default (04-UI-UX §4.5); `--reveal` audited |
| Files | only under `LIMS_MIGRATION_ROOT/<tenant>/<run>/` on the LUKS volume; mode 0600/0700; host guard refuses other paths; no `/tmp` use for PHI (temporary files under the run dir) |
| Network | DB only; no HTTP client code in `src/**` (CI grep for `fetch(`, `node:http`, `node:https`, `undici`) |
| Laptops | never hold the package, PDFs, crosswalk CSVs with doctor contacts, finance lists or terminal logs; the only file allowed off-host is the C3 master workbook (no patient data) |
| Screen sharing | only through a the LIMS provider-controlled session with the lab lead physically present or on a the LIMS provider-managed call; recording disabled [DECISION] |
| AI tools | no package content, staging output or terminal output pasted into AI tools (00 §7.5; REQ-SEC-136); applies to the eLabs sample too — T14 uses a synthetic re-creation of its structure |
| Retention | staging purge (AC-12.x); host dir shredded; WAL/backups rotate per C1 |

## 6. Required security tests

| ID | Test | Layer |
|---|---|---|
| S-01 | Cross-tenant probe on every staging table: claims tenant A → 0 rows of B; insert with B fails; update/delete of B affect 0 | db/tests (C0) + `__tests__/probes` |
| S-02 | `lims_api`, `lims_worker`, `lims_analytics`, `anon`, `authenticated` have no USAGE on `migration_staging` and no privilege on any staging table | db/tests |
| S-03 | `lims_migration`: not BYPASSRLS, not superuser, owns nothing, cannot `SET ROLE lims_owner` | db/tests |
| S-04 | DELETE on staging rows of a non-purgeable run affects 0 rows; append-only tables refuse UPDATE/DELETE | db/tests |
| S-05 | Each Legacy port contract suite includes: other tenant's patient/analyte/centre ids → `rejected` (not found), no write in tenant B (DB check as owner) | owner contract tests |
| S-06 | Legacy port called by an actor without the permission (staff user with `tenant_admin`, system actor of another module) → `auth.forbidden` | owner contract tests |
| S-07 | `crosswalk import` with a tenant_b centre/analyte id → `mig.crosswalk.target_unknown`, nothing applied | integration |
| S-08 | `match decide --target <tenant_b patient id>` → refused; `match decide` without `--form-ref` → `mig.match.form_ref_missing`; `signoff --lab-membership <tenant_b membership>` → `mig.signoff.signatory_invalid` | integration |
| S-09 | Package manifest `tenant_code = tenant_b` staged into a tenant_a run → `mig.package.tenant_mismatch` | integration |
| S-10 | Full synthetic run log scan: none of the planted names/phones/keys/codes/values/paths appear | security (DoD §1.8) |
| S-11 | Report JSON schema rejects any string field outside the allowed keys; planted PHI in staging never appears in `reports.body` | unit + integration |
| S-12 | Issue messages never contain PHI cell values | unit (AC-04.7) |
| S-13 | Host guard: wrong host / missing volume marker / path outside root → exit 2 before reading | unit |
| S-14 | `--reveal` without TTY refused; with TTY writes `run_events` with row ids only; `--json --reveal` refused | unit/integration |
| S-15 | Operator mismatch (`--operator` ≠ Unix user map) → `mig.operator.mismatch`; approver = creator → `mig.approval.same_operator`; `void approve` / `purge approve-early` by the requester → `mig.approval.same_operator`; `void` without `void_approval` → `mig.void.not_approved`; early `purge` without `early_purge_approval` → `mig.purge.too_early` (and the DELETE policy deletes 0 rows) | unit/integration |
| S-16 | CSV formula injection: crosswalk/finance exports prefix risky leading characters; path traversal `../x.pdf` rejected | unit |
| S-17 | Non-PDF bytes renamed `.pdf` → `mig.doc.not_pdf`; sha256 mismatch → `mig.doc.sha256_mismatch`; owner also rejects (defence in depth) | unit + contract |
| S-18 | No event published and no NotificationPort call during a full load (event spy) | integration/e2e |
| S-19 | CI greps: no SQL referencing schemas other than `migration_staging` in `src/**`; no `billing` token; no HTTP modules; no `console.*`; no `Math.random` | CI |
| S-20 | Runtime refuses to start with a fake Legacy port when `NODE_ENV=production`; refuses if `current_user ≠ lims_migration` | integration |
| S-21 | Downloaded legacy PDF by tenant_b user → 404; by user without `reporting.legacy_document.read` → 403; quarantined document not downloadable | C6 probes (CR-C18-004) |
| S-22 | Search by legacy code from a tenant_b session never returns tenant_a patients | C4 probes (CR-C18-002) |
| S-23 | P-16 guard: partner, portal and patient claims of tenant A read 0 rows of every staging table (05-SCHEMA §12 test 9) | db/tests |

## 7. Abuse cases

| # | Abuse | Control |
|---|---|---|
| AB-1 | An insider copies the package to a USB stick or laptop "to work offline" | policy + host-only volume; no copy tooling in the CLI; C1 host audit; training note citing Privacy Act personal liability (04 L17) |
| AB-2 | An operator loads a test/fake package into a real tenant | synthetic packages carry `source_system = synthetic`; production runtime refuses `synthetic` unless `run create --rehearsal`, and rehearsals cannot load (CHECK `runs__rehearsal_no_load__ck`) |
| AB-3 | Someone "fixes" a wrong result after sign-off by re-running a delta with a higher legacy version | allowed only through a new run with its own dry run, approval and sign-off; every version stays visible to the owner (superseded rows kept) |
| AB-4 | eLabs invoices imported to "keep history complete" | no code path (S-19), DO-NOT-FILE CR, sign-off form statement (06 R-6) |
| AB-5 | Replay of an old package as a newer delta to roll values back | lower `legacy_version_no` → `stale_version`; same version different content → conflict/report; `extract_id` and `data_as_of` must be newer than the parent's (`mig.package.not_newer_than_parent`, added to rule set) |
| AB-6 | Duplicate merge used to hide a patient's results under another identity | merges need a named lab decision-maker per pair and the reference of the signed paper form (D-133); samples include merged groups; void before sign-off (two-operator `void request` / `void approve`) |
| AB-7 | `lims_migration` password reused to query PHI outside a window | NOLOGIN; rotation per window; alert on login outside window |

## 8. Secrets used

| Secret | Store | Lifetime |
|---|---|---|
| `lims_migration` DB password (`LIMS_MIGRATION_DATABASE_URL`) | SOPS (prod key held per C1 §8), rendered to tmpfs in the container | per migration window; rotated on open |
| age identity for inbound encrypted media | migration volume only (private key never on laptops) | project duration; destroyed with the volume |
| WireGuard peer key for the lab's export machine | generated on the lab machine; public key in C1 inventory | removed at window close |
| SFTP account | C1, key-based, chroot | removed at window close |

No API keys, no JWTs, no `service_role`, no gateway or messaging credentials are used by C18.
