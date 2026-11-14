# C18 Legacy Data Migration — 04 UI/UX (operator CLI and runbook experience)

Status: DRAFT, 2026-11-06. C18 is a non-UI chunk: no web screen, no `@lims/ui` component, no `nav.manifest.ts`. The operator experience is the `lims-migrate` CLI on the migration host plus the runbooks. Staff see migrated data only in the owners' screens (C4 search, C5 history/trend, C6 legacy documents), specified by those owners under CR-C18-002/003/004.

## 1. Principles

1. **Safe by default.** Every command that changes run state shows what it will do first. `approve`, `load`, `void request`, `void approve`, `void`, `purge request-early`, `purge approve-early`, `purge`, `signoff` and `run abandon` always require the operator to type the `run_code` on a TTY; `--yes` is refused for them. Other state-changing commands (`crosswalk import`, `match decide`) ask for `y` and accept `--yes` [DECISION].
2. **No PHI on screen unless asked.** Names, phones, legacy codes, registration numbers and values are masked by default; `--reveal` unmasks for one command, requires a TTY, and is audited (`run_events.kind = 'patient_reveal'` / `'row_reveal'`).
3. **Plain text, machine-readable on request.** Default output = aligned text tables; `--json` = one JSON document on stdout (no PHI unless `--reveal`, which is refused together with `--json` so PHI never lands in a pipe/file) [DECISION].
4. **Deterministic exit codes** (C1 04-UI-UX §7 convention): `0` ok · `2` refused before any change (guard, validation of arguments, state) · `1` failed after changes started (resumable unless stated) · `3` completed with findings that block the next step (e.g. `validation_failed`, `dry_run_failed`, `verify_failed`) [CONV, extends C1's 0/1/2 with 3 for "ran fine, result negative"].
5. **Every message carries a code** `mig.<area>.<reason>` and, for refusals, the runbook anchor.
6. **English only** in v1 (02-CV §13); messages from a catalogue `tools/migration/src/cli/messages.en.ts` keyed `migration.cli.<key>` so Nepali can be added.
7. **No colour-only meaning**: status words are always printed (`OK`, `ERROR`, `WARN`, `BLOCKED`); colour (when stdout is a TTY and `NO_COLOR` unset) is decoration only (02-CV §14 spirit).

## 2. Invocation

```
lims-migrate <command> [subcommand] [options]
lims-migrate --help | <command> --help
lims-migrate --version          # prints tool version, canonical formats supported, git sha
```

Global options: `--json`, `--reveal`, `--quiet`, `--operator <platform_staff_id>` (required for state-changing commands; the C1 playbook `migration-run.yml` sets it from the SSH account mapping — the CLI cross-checks the Unix user against `LIMS_MIGRATION_OPERATOR_MAP` (02-TRD §14) and refuses a mismatch `mig.operator.mismatch`). The four-eyes commands (`approve`, `void approve`, `purge approve-early`) must be run from the second operator's **own** Unix account; there is no approver option on the first operator's command (08 A19 D-133).

`--tenant <code>` is required on every run-addressed command (08 A19 D-134). The code is resolved with C0's `app.core_resolve_tenant_code` before any tenant transaction; the run is then addressed by `run_id` (UUID) or `run_code` (`MR-<tenant_code>-<yyyymmdd>-<n>`) inside that tenant only. Commands that take no run (`package verify`, `transform`, `status --metrics`) do not need it; `transform` takes it only to write `manifest.tenant_code`. Below, `<run>` stands for `<run> --tenant <code>`.

## 3. Command reference

| Command | Purpose | Key options | Changes | Confirmation |
|---|---|---|---|---|
| `package verify <dir>` | US-01 | — | none | — |
| `transform --source <name> --in <dir> --out <dir> --tenant <code> --kind full\|delta [--source-timezone <iana>]` | run a `SourceTransformer`; `elabs` → `mig.source.not_implemented` (B4) | — | writes package | — |
| `run create --tenant <code> --source <name> --kind full\|delta [--parent <run>] [--rehearsal]` | US-02 | `--source` required (`^[a-z][a-z0-9_]{1,31}$`; must equal manifest `source_system` at `stage`) | runs row | — |
| `run show <run>` / `run list --tenant <code>` / `run abandon <run> --reason <code>` | inspect / abandon | — | abandon: state | typed |
| `stage <run> <dir>` | US-02 | — | staging rows | — (resumable) |
| `crosswalk export <run> --kind <k>` / `crosswalk import <run> --kind <k> <file>` | US-03; kinds: `centre`, `doctor`, `credit_party`, `credit_party_kind`, `analyte`, `unit`, `ordinal`, `sex`, `flag`, `result_status`, `document_kind` | `--dry` (import: validate only) | crosswalk | prints diff, typed `y` |
| `validate <run>` | US-04 | — | issues, statuses | — |
| `issues <run> [--rule <code>] [--entity <e>] [--limit N]` | list issues (row ids, rule, column; masked values with `--reveal`) | — | none | — |
| `match list <run> [--class <c>] [--status pending]` | US-05 | `--reveal` | none (reveal audited) | — |
| `match decide <run> (--pair <id> \| --class <c>) --action <a> [--target <patient_id>] --by <membership_id> --form-ref <text>` | US-05 | `--form-ref` required: reference of the paper sign-off form recording the lab lead's decision (D-133) | decisions | typed `y` showing count |
| `dryrun <run> [--sample N]` | US-06 | — | staging outcomes, report | — |
| `sample review <run>` / `sample confirm-ui <run> --pair <sample_id>` | US-06 / post-load UI check | `--reveal` implied, TTY required | verdicts | per item |
| `report <run> [--kind dry_run\|post_load\|void] [--json]` | show stored report (no PHI) | — | none | — |
| `approve <run>` | US-07 (second operator, own Unix account) | — | approval | typed `run_code` |
| `load <run>` | US-07 | `--max-rows-per-second N` (≤ config) | owner rows via ports | typed `run_code` |
| `verify-load <run>` | US-08 | — | report | — |
| `signoff <run> --lab-membership <id> --reference <text>` | US-10 | `--reference` required (signed paper form number) | sign-off | typed `run_code` + signatory display name read back |
| `void request <run> --reason <code>` | US-11, operator A | — | `run_events` `void_request` | typed `run_code` |
| `void approve <run>` | US-11, operator B from B's own Unix account (B ≠ A) | — | `signoffs` `void_approval` | typed `run_code` |
| `void <run>` | US-11; requires a `void_approval` for the latest request | — | owner voids | typed `run_code` |
| `purge request-early <run> --reason <code>` / `purge approve-early <run>` | US-12, early purge only: A requests, B (≠ A, own account) approves → `signoffs` `early_purge_approval` | — | run_events / signoffs | typed `run_code` |
| `purge <run>` | US-12; after `purge_not_before`, or with an `early_purge_approval` row | — | deletes staging rows + files | typed `run_code` |
| `masters build <run> --kind catalog_master\|price_list\|referrers\|credit_parties [--price-list-legacy-code <c> --price-list-id <uuid> --price-list-code <code>]` | US-13 | price-list options required for `price_list` (copied by the lab from C3's empty template) | writes xlsx | — |
| `finance list <run>` | US-15 | — | writes CSVs on host | — |
| `status [--tenant <code>] [--metrics]` | overview / metrics textfile; without `--tenant`, tenants are enumerated with `app.cron_tenant_ids()` (D-134) | — | metrics file | — |

Void reason codes [CONV] (`migration_void_reasons`): `verification_failed`, `wrong_mapping`, `transformer_defect`, `no_go_decision`, `wrong_tenant` (also triggers the incident note). Abandon reasons: `rehearsal_done`, `superseded_by_new_extract`, `package_defect`.

## 4. Output specifications (synthetic examples)

### 4.1 `package verify`
```
lims-migrate 0.1.0 · canonical v1 · host app-1
Package  /srv/lims/migration/tenant_a/inbox/2026-11-06   source=synthetic  tenant=tenant_a  kind=full
File                      Rows        SHA-256       Status
manifest.json             -           3f9a1c0e7b2d  OK
patients.csv              1,200       9c1d44a0e1f3  OK
visits.csv                3,950       a11b0c9d2e77  OK
results.csv               96,400      0e7f3c2b5a19  OK
documents.csv             3,900       77c2a9f0d1e4  OK
documents/ (3,900 files)  612.4 MiB   -             OK
OK  package verified (6 files, 0 errors)
```

### 4.2 Progress (stage, dryrun, load, verify)
One line refreshed every 5 s on a TTY; on non-TTY one line per 30 s:
```
[load MR-tenant_a-20261106-1] results  batch 312/482  62,400/96,400 rows  980 rows/s  ETA 00:00:35  rejected 0
```

### 4.3 Issues
```
Rule                          Sev    Entity    Rows   Example row (masked)
mig.ref.analyte_unmapped      ERROR  results   1,204  stg_results 01a1…c0de  legacy_analyte_code=H***
mig.domain.phone_invalid      WARN   patients     37  stg_patients 01a1…77aa  phone_raw=98******
mig.excluded.not_final        INFO   results     410  —
3 rules · 1 ERROR rule · run status: validation_failed (exit 3)
Next: crosswalk export MR-tenant_a-20261106-1 --kind analyte   (runbook cutover.md#unmapped-analytes)
```

### 4.4 Reconciliation summary (`report`)
```
Entity     Package  Excluded  Invalid  Merged  Create  Link  Already  Unchanged  Rejected  Invariant
patients     1,200         3        0      12   1,180     5        0          0         0  OK
results     96,400       410        0       0  95,990     -        0          0         0  OK
documents    3,900         0        0       0   3,900     -        0          0         0  OK
Financial (not loaded — treatment pending auditor B6/B7): patient_dues 40 rows / NPR 12,345.00 · invoice_refs 9,000
Samples: 50 drawn (seed 5b2e…), 50 pass, 0 fail
```
Amounts are printed in NPR with 2 decimals from integer paisa via `@lims/shared-ts/money` (02-CV §4.9).

### 4.5 Masking rules (`cli/output.ts`)

| Field | Masked form | Example (synthetic) |
|---|---|---|
| Person name | first 2 chars of each word + `*` × (len − 2), min 2 `*` | `Te** Pa***** 00**` |
| Phone | first 2 + `x` × (n − 4) + last 2 | `98xxxxxx42` (same as C4 `phone_masked`) |
| Legacy key / code / registration no | first char + `***` | `E***` |
| Birth date | year only | `1983-**-**` |
| Result value / free text | `«hidden»` | — |
| File path | staging row id | `stg_documents 01a1…9f20` |

`--reveal` prints the real values in a framed block headed `PHI — do not copy` and writes `run_events` with the staging row ids revealed (no values).

### 4.6 Duplicate review (`match list` + `match decide`)
```
Pair 01a1…0a01  class=strong   status=pending
             A (stg 01a1…1001)            B (stg 01a1…1002)
 name        Te** Pa***** 00**            Te** Pa***** 00**
 birth       1983-**-** (exact)           1983-**-** (exact)
 phone       98xxxxxx42                   98xxxxxx42
 sex         male                         male
 first seen  2021-03-04                   2023-09-11
 visits      14                           2
Decide: lims-migrate match decide MR-… --tenant tenant_a --pair 01a1…0a01 --action merge|keep_separate --by <lab membership id> --form-ref <form no>
```
`target_possible` pairs show the existing LIMS patient as B with `patient_code` (P2, masked) and last visit date.

### 4.7 Confirmation prompt
```
You are about to LOAD run MR-tenant_a-20261106-1 into tenant tenant_a (Synthetic Lab Alpha):
  patients 1,185 · results 95,990 · documents 3,900   approved by <platform staff display name> at 2026-11-06T13:10Z
This writes production records through owner ports. It can be voided until lab sign-off.
Type the run code to continue: _
```

## 5. Exit codes and messages (catalogue excerpt; full list in `messages.en.ts`)

| Code | Exit | Text |
|---|---|---|
| `mig.host.not_allowed` | 2 | "This host or directory is not an approved migration location." |
| `mig.db.login_refused` | 2 | "Database login refused — is the migration window open? (runbook cutover.md#window)" |
| `mig.package.checksum_mismatch` | 2 | "File {file} does not match its SHA-256." |
| `mig.package.format_unsupported` | 2 | "Canonical format {v} is not supported by this tool version." |
| `mig.package.tenant_mismatch` | 2 | "Package tenant does not match the run tenant." |
| `mig.package.changed_since_stage` | 2 | "Package files changed after staging. Create a new run." |
| `mig.run.invalid_transition` | 2 | "Run is {state}; {command} is not allowed now." |
| `mig.run.locked` | 2 | "Another process is working on this run." |
| `mig.run.not_approved` / `mig.run.not_approvable` | 2 | "Run must be dry-run-passed and approved by a second operator." |
| `mig.approval.same_operator` | 2 | "The approver must be a different operator." |
| `mig.void.not_approved` | 2 | "A second operator must run `void approve` for this request first." |
| `mig.match.form_ref_missing` | 2 | "Give the sign-off form reference of this decision (--form-ref)." |
| `mig.run.tenant_unknown` / `mig.run.tenant_not_active` | 2 | "Tenant code not found." / "Tenant is not active." |
| `mig.package.source_mismatch` | 2 | "Package source system does not match the run." |
| `mig.masters.price_list_id_missing` | 2 | "Give --price-list-id and --price-list-code from C3's empty template." |
| `mig.match.decisions_pending` | 3 | "{n} duplicate pairs need a decision." |
| `mig.signoff.blockers_open` / `mig.signoff.signatory_invalid` | 2 | "Sign-off blocked: {list}." / "Signatory must be an active tenant administrator of this lab." |
| `mig.void.after_signoff` | 2 | "Signed-off runs cannot be voided; use owner screens to correct data." |
| `mig.purge.too_early` / `mig.purge.child_open` | 2 | "Purge allowed from {date}." / "A delta run depends on this run." |
| `mig.source.not_implemented` | 2 | "Source '{name}' is not implemented. eLabs export format unknown (B4)." |
| `mig.runtime.permission_missing` | 1 | "Owner port refused the migration actor (permission {p}). Check CR-C18-007 deployment." |
| `mig.runtime.contract_violation` | 1 | "Owner port returned an unexpected outcome set; load stopped." |

## 6. Runbook experience

Runbooks live in `tools/migration/runbooks/` (owned) and are linked from C1's catalogue (CR-C18-006). Each step uses C1's entry template (C1 04-UI-UX §4.2): **When** · **Who** · **Command** · **Expected output** · **If not** (anchor). Files:

| Runbook | Content |
|---|---|
| `rehearsal.md` | §6.2 of 03-APP-FLOW as a checklist with timing capture table |
| `cutover.md` | preconditions checklist, historical load, freeze table F0–F6, go/no-go form, anchors for every refusal code (`#window`, `#unmapped-analytes`, `#stalled-load`, `#verify-mismatch`, `#pending-scan`) |
| `rollback.md` | levels R0–R3 (03-APP-FLOW §7) with exact commands |
| `purge.md` | purge procedure, early-purge approval, verification that files are gone |
| `incident.md` | wrong tenant / PHI exposure: stop, close window, preserve run_events, notify founder; links C1 IR runbook |

Operator manual `docs/manual/migration/`: `overview.md` (what is migrated and what is not — PRD §4), `canonical-format.md` (02-TRD §6 for transformer authors), `signoff-form.md` (lab sign-off form text below), `faq-for-labs.md` (plain-language answers: "Will my old invoices be in the new system?" → "No. Old invoices stay in eLabs; your auditor decides whether any reference copy is needed.").

### 6.1 Lab sign-off form (content of `signoff-form.md`)

Fields: lab name; tenant code; run codes (R1 full, R2 delta); data as of (F0); counts table copied from `report` (patients created/linked, results, documents, excluded by reason); list of accepted exclusions; duplicate-pair decisions count by class, with the lab lead's signature against the decisions (this form's reference is stored on every `match decide`, 08 A19 D-133); sample result (n pass / n); statement "Historical invoices and dues were **not** imported; they remain in eLabs" (until B6/B7 change it); statement that eLabs remains read-only from F0; signatory name, role, date; the LIMS provider operator and approver names; reference number (entered into `signoff --reference`). No patient data on the form.

## 7. Accessibility and ergonomics

- Works in an 80-column terminal; wide tables wrap to key/value blocks below 100 columns.
- No interactive full-screen TUI (keeps SSH/screen-share simple); prompts are line-based and accept `q` to abort without changes.
- Long commands are safe to run under `tmux`/`screen` (C1 host); progress lines do not require cursor control on non-TTY.
- All times shown in UTC and Asia/Kathmandu (`2026-11-06T13:10Z / 18:55 NPT`), A.D. only (02-CV §13: tool is not a statutory document).

## 8. Components

No `@lims/ui` / `lims_ui` components are used or needed. No CR to C0-0D for UI. Owners' screens that display legacy data (C4 search hint, C5 "Legacy (eLabs)" label in history/trend, C6 legacy documents list) use their own kit components; C18 asks only for the visible text marker "Legacy (<source display name>)" with text, not colour alone (02-CV §14) in CR-C18-003/004.
