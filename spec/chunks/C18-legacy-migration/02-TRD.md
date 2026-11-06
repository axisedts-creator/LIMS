# C18 Legacy Data Migration — 02 TRD

Status: DRAFT, 2026-11-06. Read with `01-PRD.md`. Labels as in `program/00-README.md`. Everything about the **eLabs** side is **BLOCKED B4** and deliberately absent.

## 1. Owned paths

| Path | Content |
|---|---|
| `tools/migration/**` | the `lims-migrate` CLI package (`@lims/migration-tool` [CONV, 02-CV §2.1 naming]), its tests, runbooks, synthetic generator |
| `docs/manual/migration/**` | operator manual + lab sign-off form template (01 §3 `docs/manual/<module>/`) |
| schema `migration_staging` | **specification only** (05-SCHEMA); C0-0B writes the DDL (01 §0) |

Not owned (never edited): `db/`, `contracts/`, `packages/*`, any `core/`, `services/api/src/modules/*`, `services/worker/src/jobs/*`, `infra/`. Everything needed there is a CR (§19).

## 2. Stack and libraries

| Item | Value | Source |
|---|---|---|
| Runtime | Node.js 26.x LTS, exact patch pinned by C0 (`.nvmrc`, image digest) | 02-CV §1.1 |
| Language | TypeScript, C0's `tsconfig.base.json` + §1.2 flags | 02-CV §1.2 |
| DB driver | `pg` (node-postgres), version pinned by C0 | C0 02-TRD §2.2 |
| Port types, generated error codes | `@lims/contracts` | 02-CV §2.1 |
| Logger, UUIDv7, money, B.S. dates, errors, crypto | `@lims/shared-ts` (`logger`, `uuidv7`, `money`, `bsdate`, `errors`, `crypto`) | 02-CV §1.1, §4.10, §9 |
| Tool runtime (port registry + tenant transactions as a system actor) | `@lims/worker` core export requested in **CR-C18-005** | 02-CV §8.2 (X7) |
| Port fakes | `@lims/fakes` | 02-CV §8.3 |
| Synthetic data | `@lims/test-fixtures` (generators) | 02-CV §11.2 |
| xlsx writing (master workbooks for C3) | `write-excel-file` **4.1.1** (MIT), same pin as C3 — C3 02-TRD §2.2 (registry evidence there). C18 adds it to its own `package.json` with the identical exact version | C3 02-TRD §2.2 |
| CLI argument parsing | Node built-in `node:util` `parseArgs` — no dependency [DECISION] | Node core |
| CSV parsing / writing | in-house, RFC 4180 subset (§6.3), streaming, ≈200 lines in `src/canonical/csv.ts` — no dependency [DECISION: small, fully specified grammar; avoids an unvetted parser handling PHI] | — |
| Hashing | `node:crypto` SHA-256 | — |
| Test runner | Vitest, pinned by C0 | C0 02-TRD §2.2 |

No new foreign service (04 §11). No network access other than PostgreSQL on the WireGuard overlay (§4.3).

## 3. Internal architecture

### 3.1 Layers

```
cli/            argument parsing, prompts, output formatting, exit codes  (no SQL, no business rules)
commands/       one file per command; orchestrates services; writes run_events
domain/         pure: canonical row types, validation rules, normalisation, match classifier, digests, state machine
canonical/      package reader/verifier, CSV parser, manifest schema (ajv via @lims/shared-ts validation helper)
staging/        repository for migration_staging only (parameterised SQL, tenant filter explicit — REQ-SEC-024)
load/           batch planner, port adapters (calls ctx.ports.Legacy*ImportPort), resumable loader, verifier
report/         reconciliation computations, report JSON writer, sample selector
masters/        canonical masters → C3 workbook builders (write-excel-file)
sources/        SourceTransformer interface; synthetic/ (tests); elabs/ (BLOCKED B4 — absent)
runtime/        boots CR-C18-005 tool runtime; host guard; config
```

Layer rules (02-CV §2.2 spirit): `domain/` imports no IO; `staging/` is the only folder with SQL and references only `migration_staging.*` (CI grep: any other schema-qualified name in `tools/migration/src/**` fails, except `core.*` reads through the runtime's `ctx.core`); `load/` never builds SQL; no file imports another module's code (`services/api/src/modules/**`).

### 3.2 File skeleton

```
tools/migration/
├── package.json                    # name @lims/migration-tool; bin { "lims-migrate": "dist/cli/main.js" }
├── tsconfig.json                   # extends ../../tsconfig.base.json
├── src/
│   ├── cli/main.ts                 # parseArgs → command dispatch → exit code
│   ├── cli/output.ts               # tables, masking, progress lines (04-UI-UX)
│   ├── cli/prompt.ts               # typed confirmations ("type the run code")
│   ├── commands/{package-verify,run-create,stage,crosswalk-export,crosswalk-import,validate,issues,
│   │            match-list,match-decide,dryrun,report,sample,approve,load,verify-load,signoff,
│   │            void,purge,masters-build,finance-list,status,transform}.ts
│   ├── domain/
│   │   ├── run.state.ts            # run state machine (03-APP-FLOW §2)
│   │   ├── canonical.types.ts      # row types per canonical file (§6.4)
│   │   ├── rules/*.rule.ts         # one file per validation rule family (§8)
│   │   ├── normalise.ts            # name (NFC, case fold, single space), phone (+977 rule), sex map
│   │   ├── match.ts                # candidate classifier (§9)
│   │   ├── digest.ts               # row/batch digests (§10.3)
│   │   └── sample.ts               # seeded stratified sampler (PRNG from @lims/shared-ts/crypto seed derivation)
│   ├── canonical/{manifest.schema.json, manifest.ts, reader.ts, csv.ts, verify.ts}
│   ├── staging/{db.ts, runs.repo.ts, files.repo.ts, rows.repo.ts, crosswalk.repo.ts, issues.repo.ts,
│   │            match.repo.ts, batches.repo.ts, reports.repo.ts, events.repo.ts, purge.repo.ts}
│   ├── load/{planner.ts, patients.adapter.ts, results.adapter.ts, documents.adapter.ts, loader.ts, verifier.ts, voider.ts}
│   ├── report/{reconcile.ts, checksums.ts, report.schema.json, render.ts}
│   ├── masters/{catalog-master.ts, price-list.ts, referrers.ts, credit-parties.ts}
│   ├── sources/{transformer.ts, synthetic/generator.ts}      # elabs/ added only after B4
│   └── runtime/{boot.ts, host-guard.ts, config.ts, metrics-textfile.ts}
├── runbooks/{cutover.md, rehearsal.md, rollback.md, purge.md, incident.md}   # operator copies; C1 links them
└── __tests__/{unit, integration, contract, probes, e2e}/
```

## 4. Runtime and channels

### 4.1 Why C18 has no HTTP API

01 §3 gives C18 only `tools/migration` and a schema "never exposed to API roles". C18 therefore implements **no endpoint, no port and no event**. It is a client of owner ports.

### 4.2 Tool runtime (CR-C18-005)

`runtime/boot.ts` calls the C0 export requested in CR-C18-005:

```ts
// requested from C0-0D (services/worker core), consumed by tools/migration
import { createToolRuntime } from '@lims/worker/tool-runtime';

export interface ToolRuntime {
  /** Opens a transaction with claims { sub: <system actor of `actorModule`>, tenant_id, actor_type: 'system' }
   *  (no extra claim: `tool_run_id` is not a registered `extraClaims` key, 03-IC §13; the batch id goes into
   *  app.request_id via opts.requestId) via the same set_config path as the worker (02-CV §5.10), builds RequestContext with
   *  ctx.ports (same registry as API/worker — 02-CV §8.2) and ctx.core. Commits unless fn throws or
   *  opts.rollback is true (used for dry runs). */
  tx<T>(tenantId: Uuidv7, fn: (ctx: RequestContext & { core: CoreRepository }) => Promise<T>, opts?: { rollback?: boolean; requestId?: Uuidv7 }): Promise<T>;
  close(): Promise<void>;
}
export function createToolRuntime(opts: {
  actorModule: 'migration';                  // row in db/meta/system-actors.yaml (CR-C18-001)
  databaseUrl: string;                       // lims_migration login (CR-C18-001), direct connection
  systemPermissions: readonly PermissionCode[];  // checked by IdentityPort.assertRole for actor_type 'system'
  clientLabel: string;                       // written to app.user_agent ('lims-migrate/<version>')
}): Promise<ToolRuntime>;
```

`systemPermissions` = `['frontdesk.patient.import_legacy', 'lab.legacy_result.import', 'reporting.legacy_document.import']` (CR-C18-002/003/004/007). Production boot of the runtime fails if any of the three Legacy ports resolves to a fake (02-CV §8.2).

Staging SQL runs through the **same** `ctx.tx` so a batch's owner write and the staging status update commit atomically (§11.3). The `lims_migration` role is proposed as a member of `lims_app` (owner tables via owner code under RLS) — **PROPOSED EXCEPTION — needs 08 acceptance after B4** (08 A19 D-136; 05-SCHEMA §1.2, 07 §4 item 3) — and is the only role with grants on `migration_staging` (05-SCHEMA §2).

**Tenant resolution (08 A19 D-134).** Every run-addressed command requires `--tenant <code>`. Before any tenant transaction the tool resolves the code with C0's pre-tenant DEFINER `app.core_resolve_tenant_code(p_code) RETURNS TABLE (tenant_id uuid, status text)` (08 A19 D-121) and requires `status = 'active'` (else exit 2 `mig.run.tenant_unknown` / `mig.run.tenant_not_active`); `runtime.tx(tenantId, …)` then opens with that id, and a `run_id`/`run_code` given on the command line is looked up only inside that tenant (RLS). `status --metrics` enumerates tenants with the existing A13 P-6 DEFINER `app.cron_tenant_ids()` and opens one read transaction per tenant. Both need `EXECUTE … TO lims_migration`, requested in CR-C18-001 for when it is accepted after B4. No new C0 capability is requested.

### 4.3 Where it runs

| Aspect | Rule | Source |
|---|---|---|
| Host | C1's `app-1` (or a dedicated VM of the same class), container `lims-migrate` started by a C1 playbook; never on a laptop, never in dev/staging with real data | 04 S1; REQ-SEC-136; CR-C18-006 |
| DB connection | direct to `data-1:5432` over `wg0` as `lims_migration` (not through PgBouncer: long transactions in dry runs, 04 S8 "workers and migrations on direct connections") | C1 02-TRD network table; 04 S8 |
| Files | `/srv/lims/migration/<tenant_code>/<run_code>/` on a dedicated LUKS volume (REQ-SEC-125); marker file `/srv/lims/migration/.lims-migration-volume` written by C1 provisioning; host guard (§14) refuses to run elsewhere | CR-C18-006 |
| Inbound package transfer | (a) preferred: SFTP-only chroot `/srv/lims/migration/inbox/<tenant_code>/` reachable only over a temporary WireGuard peer for the lab's export machine, removed after cut-over; (b) fallback: package archive encrypted with `age` to the migration recipient public key **on the lab's machine**, carried on removable media, copied to the inbox, decrypted only on the migration host; media wiped by the lab afterwards. In both cases no the LIMS provider laptop holds the plaintext | C1 §8 (age 1.3.2 already in C1 stack); CR-C18-006 |
| Login role | `lims_migration` is `NOLOGIN` outside an approved migration window; C1 runbook toggles `LOGIN` and rotates the password per window | CR-C18-001, CR-C18-006 |

## 5. Interfaces consumed

### 5.1 New owner ports (requested; signatures to be transcribed by C0-0C into `contracts/ports/`)

Common types (`contracts/ports/legacy-common.ts`, CR-C18-005):

```ts
import type { RequestContext, Uuidv7, IsoUtc, IsoDate, DecimalString, Code, Sex, FieldError } from './common';

export type LegacySourceSystem = string;      // ^[a-z][a-z0-9_]{1,31}$ — 'elabs', 'synthetic'
export interface LegacyBatchHeader {
  readonly runId: Uuidv7;                     // migration_staging.runs.id (plain uuid, no FK in owner tables)
  readonly batchId: Uuidv7;                   // idempotency key of the whole call
  readonly sourceSystem: LegacySourceSystem;
  readonly dryRun: boolean;                   // true → full validation + inserts allowed, but NO non-transactional side effect
                                              // (storage write, external call); the caller rolls the transaction back
  readonly contentSha256: string;             // hex64 over the batch's rowSha256 list (§10.3)
}
export type LegacyRowOutcome =
  | { readonly rowRef: Uuidv7; readonly outcome: 'created'; readonly targetId: Uuidv7; readonly targetCode?: string }
  | { readonly rowRef: Uuidv7; readonly outcome: 'linked'; readonly targetId: Uuidv7 }
  | { readonly rowRef: Uuidv7; readonly outcome: 'superseded_previous'; readonly targetId: Uuidv7; readonly previousTargetId: Uuidv7 }
  | { readonly rowRef: Uuidv7; readonly outcome: 'already_imported'; readonly targetId: Uuidv7; readonly changedFields?: readonly string[] }
  | { readonly rowRef: Uuidv7; readonly outcome: 'rejected'; readonly reasonCode: Code; readonly fieldErrors?: readonly FieldError[];
      readonly candidatePatientIds?: readonly Uuidv7[] };   // only with reasonCode = 'duplicate_candidates' (LegacyPatientImportPort, §9.1)
export interface LegacyBatchResult { readonly batchId: Uuidv7; readonly replayed: boolean; readonly outcomes: readonly LegacyRowOutcome[] }
export interface LegacyBatchSummary {
  readonly batchId: Uuidv7; readonly runId: Uuidv7; readonly status: 'committed' | 'voided' | 'partially_voided';
  readonly rowCount: number;                  // number of port rows of the batch whose outcome was created, linked or superseded_previous
                                              // (one patient row counts once, whatever its number of legacyRefs)
  readonly digestSha256: string;              // hex64 over the stored rows' rowSha256 (§10.3)
  readonly committedAt: IsoUtc; readonly voidedAt?: IsoUtc;
}
export interface LegacyVoidResult {
  readonly batchId: Uuidv7; readonly voided: number;
  readonly notVoidable: readonly { readonly targetId: Uuidv7; readonly reasonCode: Code }[];  // e.g. 'in_use'
}
```

Rules every Legacy port implementation follows (contract-tested, §17):
1. Runs inside `ctx.tx`; first statement-level action is `IdentityPort.assertRole(ctx, { permission })`.
2. `rows.length` 1–200 (`common.validation_failed` otherwise).
3. Idempotent on `batchId`: same `batchId` + same `contentSha256` → return the stored outcomes with `replayed: true`; same `batchId` + different hash → throw `<module>.legacy_batch_conflict`.
4. Row-level idempotency on the legacy key (per port below) → `already_imported`.
5. Publishes **no** event of 03-IC §3 and calls no `NotificationPort` method.
6. A row-level problem never throws; it returns `rejected` with a code from the owner's coded set `legacy_import_reasons` (`x-coded-set`, 02-CV §5.5).
7. `voidBatch` is used only before the run's lab sign-off. C18 enforces that through its run state machine; owners do not see C18's run state, so they add an independent guard: void is refused with `<module>.legacy_void_window_closed` when `ctx.now() > committedAt + LIMS_<M>_LEGACY_VOID_WINDOW_DAYS` (default 60 [CONV]).

**`LegacyPatientImportPort`** (owner C4, module `frontdesk`; CR-C18-002):

```ts
export interface LegacyPatientRow {
  readonly rowRef: Uuidv7; readonly rowSha256: string;
  readonly legacyRefs: readonly { readonly legacyPatientKey: string; readonly legacyPatientCode?: string }[]; // 1–10; >1 = merged by decision/source
  readonly decision: { readonly kind: 'create_new' } | { readonly kind: 'link'; readonly patientId: Uuidv7 };
  readonly reviewedDuplicates?: boolean;            // true = a human decided keep_separate / create_new for this row's candidates (§9.1)
  readonly fullName: string;                        // 1–200 (C4 patients__name__ck)
  readonly sex: Sex;
  readonly birthOn?: IsoDate; readonly isBirthOnEstimated: boolean;
  readonly phoneE164?: string; readonly email?: string; readonly addressText?: string;
  readonly registeredCentreId: Uuidv7;
  readonly lastVisitAt?: IsoUtc;
}
export interface LegacyPatientImportPortV1 {
  /** @throws frontdesk.legacy_batch_conflict, auth.forbidden */
  importPatients(ctx: RequestContext, input: LegacyBatchHeader & { readonly rows: readonly LegacyPatientRow[] }): Promise<LegacyBatchResult>;
  getBatchSummary(ctx: RequestContext, input: { readonly batchId: Uuidv7 }): Promise<LegacyBatchSummary>;
  /** Deactivates patients created by the batch that have no non-legacy order and voids the batch's legacy refs.
   *  @throws frontdesk.legacy_void_window_closed */
  voidBatch(ctx: RequestContext, input: { readonly batchId: Uuidv7; readonly reasonCode: Code }): Promise<LegacyVoidResult>;
}
```
Semantics: `create_new` creates a `frontdesk.patients` row (new `patient_code` from C4's counter; C4's normalisation), one `patient_legacy_refs` row per legacy ref, and one `patient_consents` row `source = 'legacy_import'` with every flag false (PRD D-9). `link` adds legacy refs to an existing patient (must exist in tenant, not anonymised → else `rejected link_target_not_found`). C4's own dedupe predicate still runs: a `create_new` row with candidates and `reviewedDuplicates: true` is created with `duplicate_override_reason_code = 'legacy_import_reviewed'` (the human decision was made in C18, §9); without the flag it is `rejected duplicate_candidates` with `candidatePatientIds`. Legacy key already present → `already_imported` with `changedFields` = names of demographic fields whose normalised value differs (not applied — DECISION D-10 below).

**`LegacyResultImportPort`** (owner C5, module `lab`; CR-C18-003):

```ts
export interface LegacyResultRow {
  readonly rowRef: Uuidv7; readonly rowSha256: string;
  readonly legacyResultKey: string;  readonly legacyVersionNo: number;   // ≥ 1
  readonly patientId: Uuidv7;                                             // target id from the patient step
  readonly centreId: Uuidv7;
  readonly analyteId: Uuidv7; readonly testId?: Uuidv7;                   // from the analyte crosswalk
  readonly legacyTestCode: string; readonly legacyAnalyteCode: string; readonly legacyDisplayName: string;  // ≤64/≤64/≤200
  readonly resultType: 'numeric' | 'text' | 'ordinal';
  readonly valueNumeric?: DecimalString; readonly valueText?: string; readonly ordinalCode?: Code;
  readonly unitCode?: Code; readonly unitRaw?: string; readonly unitFactorApplied?: DecimalString;
  readonly refLow?: DecimalString; readonly refHigh?: DecimalString; readonly refText?: string;   // valueNumeric, refLow, refHigh are all in unitCode units
                                                                          // (staging value_numeric_target / ref_low_target / ref_high_target)
  readonly flag?: 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A'; readonly flagRaw?: string;
  readonly commentText?: string; readonly methodText?: string; readonly specimenTypeRaw?: string;
  readonly collectedAt?: IsoUtc; readonly reportedAt: IsoUtc;            // reportedAt orders history/trend
  readonly legacyVisitKey?: string; readonly legacyRegistrationNo?: string;
}
export interface LegacyResultImportPortV1 {
  /** @throws lab.legacy_batch_conflict, auth.forbidden */
  importResults(ctx: RequestContext, input: LegacyBatchHeader & { readonly rows: readonly LegacyResultRow[] }): Promise<LegacyBatchResult>;
  getBatchSummary(ctx: RequestContext, input: { readonly batchId: Uuidv7 }): Promise<LegacyBatchSummary>;
  /** @throws lab.legacy_void_window_closed */
  voidBatch(ctx: RequestContext, input: { readonly batchId: Uuidv7; readonly reasonCode: Code }): Promise<LegacyVoidResult>;
}
```
Semantics: idempotent on `(source_system, legacy_result_key, legacy_version_no)`. A higher `legacyVersionNo` for a known key creates a new row and marks the previous one superseded (`superseded_previous`). A lower one → `rejected stale_version`. `patientId` must exist; `analyteId` must exist in the tenant catalog (via `CatalogPort.getTest`/analyte lookup — C5's choice). No delta, critical or range evaluation is run (values are historical).

**`LegacyDocumentImportPort`** (owner C6, module `reporting`; CR-C18-004):

```ts
export interface LegacyDocumentInput {
  readonly rowRef: Uuidv7; readonly rowSha256: string;
  readonly legacyDocumentKey: string;
  readonly patientId: Uuidv7; readonly centreId: Uuidv7;
  readonly documentKind: 'lab_report' | 'radiology_report' | 'outsourced_report' | 'other_report';
  readonly documentDate: IsoDate; readonly title?: string;               // title ≤ 200, e.g. panel names as printed (P3)
  readonly legacyVisitKey?: string; readonly legacyRegistrationNo?: string;
  readonly mimeType: 'application/pdf';
  readonly sizeBytes: number;                                            // ≤ 15,728,640 (02-CV §10.2)
  readonly sha256: string;                                               // of the bytes
  readonly bytesBase64: string;                                          // in-process only; plain serialisable (02-CV §8.1)
}
export interface LegacyDocumentImportPortV1 {
  /** One document per call (≤ 15 MB). Bytes go to C6's quarantine path, then C6's existing scan → sanitise pipeline
   *  (04 R7; REQ-SEC-083/084/087). dryRun: validates metadata, magic bytes and sha256 only; writes nothing to storage.
   *  @throws reporting.legacy_batch_conflict, auth.forbidden */
  importDocument(ctx: RequestContext, input: LegacyBatchHeader & { readonly document: LegacyDocumentInput }): Promise<LegacyBatchResult>;
  getBatchSummary(ctx: RequestContext, input: { readonly batchId: Uuidv7 }): Promise<LegacyBatchSummary & {
    readonly states: { readonly pendingScan: number; readonly ready: number; readonly quarantined: number; readonly rejected: number } }>;
  /** @throws reporting.legacy_void_window_closed */
  voidBatch(ctx: RequestContext, input: { readonly batchId: Uuidv7; readonly reasonCode: Code }): Promise<LegacyVoidResult>;
}
```
For documents a "batch" is one document (`batchId` per document) [DECISION: keeps calls ≤ 15 MB and failures isolated].

### 5.2 Existing ports used

| Port.method | Why | Notes |
|---|---|---|
| `CatalogPort.getTest` | validate that crosswalk targets exist and read analyte `resultType`, `unitCode`, `decimals` | 03-IC §4.2; read-only. C18 is **not yet** in the 03-IC §4.2 consumer list; under 08 A19 P-46 this call needs an additive consumer CR to C3 (fake and contract suite updated), filed with CR-C18-005 when it is accepted after B4 |
| `IdentityPort.getTenantSettings({keys:['timezone','retentionYears']})` | default `source_timezone` suggestion; report text | 03-IC §4.6 |
| `app.core_resolve_tenant_code` / `app.cron_tenant_ids` (C0 DEFINERs, 08 A19 D-121, A13 P-6) | resolve `--tenant <code>` before the tenant transaction; enumerate tenants for `status --metrics` | EXECUTE += `lims_migration` when CR-C18-001 is accepted after B4 (D-134) |
| `ctx.core` (C0 core repository, C0 02-TRD §6.8) | `centres` / `centre` (crosswalk centre targets: active, in tenant); `membership({membershipId})` (roleCodes, isActive, lockedAt — match-decision and sign-off signatory check) | 01 §5 R1 exception; no other `ctx.core` method is used |

### 5.3 Endpoints, events, jobs

| Kind | Implemented | Consumed |
|---|---|---|
| HTTP endpoints | none | none (C18 is not an HTTP client; it uses ports in-process) |
| Events | none produced | none consumed; owners MUST NOT emit events for legacy imports (§5.1 rule 5) |
| Graphile Worker tasks / cron | none | indirectly: C6's scan/sanitise jobs for documents (owner-internal) |

### 5.4 Source transformer interface (the BLOCKED slot)

```ts
// tools/migration/src/sources/transformer.ts
export interface SourceTransformer {
  readonly sourceSystem: LegacySourceSystem;               // 'synthetic' now; 'elabs' after B4
  /** Reads the raw extract at `inputDir` (format defined by the source) and writes a canonical package (§6)
   *  to `outputDir`. Must be deterministic: same input bytes ⇒ byte-identical package. Must not open network
   *  connections or a DB connection. Returns counts for the manifest. */
  transform(inputDir: string, outputDir: string, opts: { tenantCode: string; extractKind: 'full' | 'delta'; sourceTimezone?: string }): Promise<TransformSummary>;
}
export interface TransformSummary { readonly files: readonly { name: string; rows: number }[]; readonly warnings: readonly { code: string; count: number }[] }
```
`sources/elabs/` does not exist until B4 is answered. `lims-migrate transform --source elabs` exits 2 (`mig.source.not_implemented`, PRD AC-16.1). Questions the eLabs sample must answer are listed in 06-IMPLEMENTATION-PLAN §6.

## 6. Canonical intermediate format v1 (DECISION)

### 6.1 Package layout

```
<package>/
├── manifest.json
├── patients.csv
├── visits.csv
├── results.csv
├── documents.csv
├── documents/<relative path>.pdf           # paths as listed in documents.csv
├── masters/{tests.csv, analytes.csv, reference_ranges.csv, panels.csv, panel_members.csv,
│            doctors.csv, centres.csv, credit_parties.csv, price_lists.csv, price_list_items.csv}   # all optional
├── financial/{patient_dues.csv, credit_party_balances.csv, invoice_refs.csv}                        # all optional
└── SHA256SUMS                               # "<hex64>  <relative path>" per file except itself (GNU coreutils format)
```

Required files: `manifest.json`, `patients.csv`, `SHA256SUMS`. Every other file is optional; absent = zero rows.

### 6.2 `manifest.json`

```json
{
  "format": "lims-legacy-canonical",
  "format_version": "1",
  "source_system": "synthetic",
  "source_version": "unknown",
  "tenant_code": "tenant_a",
  "extract_kind": "full",
  "parent_extract_id": null,
  "extract_id": "01a1a98a-ac40-7000-8000-00000000e001",
  "extracted_at": "2026-11-06T03:00:00.000Z",
  "data_as_of": "2026-11-06T02:45:00.000Z",
  "source_timezone": "Asia/Kathmandu",
  "transformer": { "name": "synthetic", "version": "1.0.0" },
  "files": [ { "path": "patients.csv", "rows": 1200, "sha256": "…hex64…" } ]
}
```
JSON Schema in `src/canonical/manifest.schema.json` (`additionalProperties: false`). `parent_extract_id` is the only field allowed to be `null` (this file is not an API payload; 02-CV §4.2 "no null on the wire" is about HTTP/events) [DECISION]. `source_timezone` is an IANA name used **only** for timestamps without offset (§6.3 rule 5); absent → such timestamps are errors.

### 6.3 CSV rules

1. UTF-8 without BOM (a BOM is rejected: `mig.file.bom_present`), Unicode NFC (non-NFC input is normalised and counted as warning `mig.file.nfc_normalised`).
2. RFC 4180 subset: comma separator, CRLF or LF line ends, `"` quoting with `""` escape, quoted fields may contain newlines; header row required; column names lower snake case, unique, order free; unknown columns → error `mig.file.unknown_column` (strict, mirroring REQ-SEC-080).
3. Empty cell = absent value. There is no "NULL" literal.
4. Dates: A.D. `YYYY-MM-DD`. If the source stores B.S., the **transformer** converts with `@lims/shared-ts/bsdate` (04 D13 range 1975–2099 B.S.); out of range → transformer error, never guessed.
5. Timestamps: RFC 3339 with offset (`2026-01-02T10:00:00+05:45`) or `Z`; a timestamp without offset is accepted only when `manifest.source_timezone` is set, and is converted to UTC by the stager (PRD AC-04.4). Stored UTC (02-CV §4.8).
6. Decimals: `^-?[0-9]{1,12}(\.[0-9]{1,6})?$` (= `DecimalString`, 03-IC §2.1). No thousands separators, no exponent.
7. Money: integer paisa `^-?[0-9]{1,15}$` in `*_paisa` columns (02-CV §4.9).
8. Booleans: `true` / `false`.
9. Max cell length 4,000 characters unless the column says less; max row 64 KiB; max file 2 GiB [CONV]; max 50,000,000 rows per file [CONV].
10. Every row carries a stable `legacy_*_key` (1–128 chars, `^[^\x00-\x1F]+$`) that is the source system's primary key or a deterministic composite built by the transformer. Keys are opaque to C18 and treated as **P2** (lab-linked identifiers, 03-IC §1).

### 6.4 File columns

Legend: **R** required · O optional · PHI class per 03-IC §1. Target column = where the value ends up (via the owner port).

**`patients.csv`** (one row per legacy patient record)

| Column | R/O | Type / rule | PHI | Target |
|---|---|---|---|---|
| legacy_patient_key | R | key (§6.3.10) | P2 | `frontdesk.patient_legacy_refs.legacy_patient_key` |
| legacy_patient_code | O | ≤ 40, printable | P2 | `patient_legacy_refs.legacy_patient_code` (searchable alias, PRD AC-14.1) |
| full_name | R | 1–200 | P2 | `frontdesk.patients.full_name` |
| sex_raw | R | ≤ 20; mapped by crosswalk `sex` | P2 | `patients.sex` ∈ male/female/other/unknown |
| birth_on | O | date | P2 | `patients.birth_on` |
| birth_on_is_estimated | O | boolean, default false | P2 | `patients.is_birth_on_estimated` |
| age_years_at_reference | O | integer 0–150; used only if `birth_on` absent, with `age_reference_on` | P2 | estimated `birth_on` = reference date − years, estimated = true |
| age_reference_on | O | date (required with `age_years_at_reference`) | P2 | — |
| phone_raw | O | ≤ 30 | P2 | `patients.phone_e164` after §9.2 normalisation |
| email | O | ≤ 254 | P2 | `patients.email` |
| address_text | O | ≤ 300 | P2 | `patients.address_text` |
| centre_legacy_code | O | ≤ 40; crosswalk `centre`; absent → crosswalk default entry `centre:__patient_default__` (must be mapped explicitly) | P0 | `patients.registered_centre_id` |
| first_seen_at | O | timestamp | P1 | survivor choice (§9.4) |
| last_visit_at | O | timestamp | P1 | `patients.last_visit_at` |
| merged_into_legacy_key | O | key of the survivor if the source system recorded a merge (B4: unknown whether eLabs has this) | P2 | §9.1 M1 |
| is_deleted_in_source | O | boolean; true → excluded `mig.excluded.deleted_in_source` | P0 | — |

**`visits.csv`** (one row per legacy registration/visit; used for linkage and reporting, not loaded as orders)

| Column | R/O | Type | PHI | Use |
|---|---|---|---|---|
| legacy_visit_key | R | key | P2 | results/documents linkage |
| legacy_patient_key | R | key | P2 | ref check |
| legacy_registration_no | O | ≤ 40 | P2 | copied to legacy results/documents (display only) |
| visit_at | R | timestamp | P1 | report strata, reconciliation |
| centre_legacy_code | O | crosswalk `centre` | P0 | `centre_id` of results/documents of the visit |
| referrer_legacy_code | O | crosswalk `doctor` | P0 | reported only (no target column in v1) |
| credit_party_legacy_code | O | crosswalk `credit_party` | P0 | reported only |
| visit_type_raw | O | ≤ 20 | P0 | reported only |

**`results.csv`** (one row per legacy result value version)

| Column | R/O | Type | PHI | Target (`lab.legacy_results`, CR-C18-003) |
|---|---|---|---|---|
| legacy_result_key | R | key | P2 | legacy_result_key |
| legacy_version_no | O | integer ≥ 1, default 1 | P0 | legacy_version_no |
| legacy_visit_key | O | key | P2 | legacy_visit_key (+ `centre_id` via the visit) |
| legacy_patient_key | R | key | P2 | → `patient_id` via loaded patient |
| legacy_test_code | R | ≤ 64 | P3 (with patient) | legacy_test_code |
| legacy_analyte_code | R | ≤ 64 | P3 | legacy_analyte_code; crosswalk `analyte` → analyte_id, test_id |
| analyte_display_name | R | ≤ 200 | P3 | legacy_display_name |
| result_status_raw | R | ≤ 20; crosswalk `result_status` → `final` / `amended_final` / `preliminary` / `cancelled` / `other` | P0 | only `final`, `amended_final` load (PRD D-4) |
| value_raw | O | ≤ 2,000 | P3 | kept in staging for review only |
| value_numeric | O | DecimalString | P3 | value_numeric |
| value_text | O | ≤ 2,000 | P3 | value_text |
| ordinal_raw | O | ≤ 20; crosswalk `ordinal` per analyte → ordinal code | P3 | ordinal_code |
| unit_raw | O | ≤ 40; crosswalk `unit` | P3 | unit_code, unit_raw, unit_factor_applied |
| ref_low / ref_high | O | DecimalString | P3 | ref_low / ref_high, converted × `unit_factor` like the value (staging `ref_low_target` / `ref_high_target`) |
| ref_text | O | ≤ 200 | P3 | ref_text |
| flag_raw | O | ≤ 20; crosswalk `flag` → N/L/H/LL/HH/A | P3 | flag, flag_raw |
| comment_text | O | ≤ 1,000 | P3 | comment_text |
| method_text | O | ≤ 200 | P3 | method_text |
| specimen_type_raw | O | ≤ 60 | P3 | specimen_type_raw |
| collected_at | O | timestamp | P1 | collected_at |
| reported_at | R | timestamp | P1 | reported_at |

Exactly one of `value_numeric`, `value_text`, `ordinal_raw` is required per row, consistent with the target analyte's `resultType` (numeric → `value_numeric`; text/coded/narrative → `value_text`; ordinal → `ordinal_raw`). Attachment-type legacy results are not supported (PDFs go through `documents.csv`).

**`documents.csv`**

| Column | R/O | Type | PHI | Target (`reporting.legacy_documents`, CR-C18-004) |
|---|---|---|---|---|
| legacy_document_key | R | key | P2 | legacy_document_key |
| legacy_patient_key | R | key | P2 | patient_id |
| legacy_visit_key | O | key | P2 | legacy_visit_key, centre via visit |
| centre_legacy_code | O | used when no visit | P0 | centre_id |
| document_kind_raw | R | crosswalk `document_kind` → lab_report / radiology_report / outsourced_report / other_report | P0 | document_kind |
| document_date | R | date | P1 | document_date |
| title | O | ≤ 200 | P3 | title |
| file_path | R | relative path under `documents/`, `^[A-Za-z0-9._/-]{1,240}$`, no `..`, no leading `/` | P2 (path may encode ids) | — |
| sha256 | R | hex64 of the file | P0 | sha256 |
| size_bytes | R | 1–15,728,640 | P0 | size_bytes |

**`masters/*.csv`** — `tests.csv`, `analytes.csv`, `reference_ranges.csv`, `panels.csv`, `panel_members.csv` and `doctors.csv` mirror the C3 workbook sheets of C3 02-TRD §8.2 (same lower-snake keys), plus `legacy_code` on each entity. `centres.csv`: `legacy_code, name, address_text, phone_raw` (input to the operator's manual entry in C2 and to the `centre` crosswalk). The following do **not** mirror C3 one-to-one; the builders map them:
- `credit_parties.csv`: `legacy_code, name, kind_raw, pan, contact_phone_raw, contact_email, billing_address, allows_credit` (O, boolean). Builder `--kind credit_parties` → C3 sheet `CreditParties` (CR-C18-008, ACCEPTED): `party_code` = `legacy_code` if it matches `^[A-Z0-9_\-]{1,20}$`, else blank (C3 auto-codes it) and listed in the `credit_party` crosswalk file; `name` ≤ 160; `kind` = crosswalk `credit_party_kind` of `kind_raw` (`hospital|company|clinic|partner_lab|insurer|other`; unmapped → `mig.ref.credit_party_kind_unmapped`, row not written); `allows_credit` = `Y` unless the cell is `false` [CONV: C3's default]; `pan` ≤ 20; `contact_phone_e164` = §9.2 phone normalisation of `contact_phone_raw`, kept only if it matches `^\+[1-9][0-9]{7,14}$` (08 A13 P-11), else blank + warning `mig.domain.phone_invalid`; `contact_email` ≤ 254; `billing_address` ≤ 500 (PRD AC-13.4).
- `price_lists.csv`: `legacy_code, name, owner_kind_raw (default|doctor|credit_party|centre), owner_legacy_code`; `price_list_items.csv`: `price_list_legacy_code, orderable_legacy_code, unit_price_paisa`. Builder `--kind price_list --price-list-legacy-code <c> --price-list-id <uuid> --price-list-code <code>`: C18 cannot read C3's price-list ids (no C3 read for them, catalog SQL banned), so the lab copies `price_list_id` and `price_list_code` from C3's empty template of the target list (C3 #96) and the operator passes them; `_meta.base_version_no = 0` (C3: "0 for an empty template"); `_meta.tenant_catalog_revision` is written blank [CONV: C18 has no revision source; C3 to confirm a blank value is accepted — handed off]; sheet `Prices` gets `orderable_code` = the `code` that `masters/tests.csv` or `panels.csv` gives for the row whose `legacy_code` = `orderable_legacy_code` [CONV; no match → row refused, `mig.ref.orderable_unknown`; C3 still validates the code against the tenant catalog] and `unit_price_npr` = `unit_price_paisa` converted with `@lims/shared-ts/money` (2 decimals) (PRD AC-13.5).
- Every text cell written to a workbook or exported CSV passes `@lims/shared-ts/spreadsheet.neutraliseFormula`; writer `write-excel-file` 4.1.1 (08 A13 P-9). C18 keeps no local copy.

**`financial/*.csv`** (BLOCKED B6/B7 for any load; staged and reported only)
- `patient_dues.csv`: `legacy_due_key` R, `legacy_patient_key` R, `legacy_invoice_no` O ≤ 40, `invoice_date` O, `amount_due_paisa` R ≥ 0, `as_of` R timestamp.
- `credit_party_balances.csv`: `legacy_balance_key` R, `credit_party_legacy_code` R, `balance_paisa` R, `as_of` R.
- `invoice_refs.csv`: `legacy_invoice_key` R, `legacy_invoice_no` R ≤ 40, `invoice_date` R, `fiscal_year_bs` O `^[0-9]{4}/[0-9]{2}$`, `legacy_patient_key` O, `credit_party_legacy_code` O, `gross_paisa` R, `net_paisa` R, `status_raw` R ≤ 20, `document_file_path` O.

### 6.5 Versioning

`format_version` "1" is fixed by this document. Because unknown columns are errors (§6.3.2), **any** column change, even an added optional column, bumps `format_version`. The CLI accepts only the versions listed in `LIMS_MIGRATION_SUPPORTED_FORMATS` (default `1`).

## 7. Staging mechanics

1. `stage` opens one runtime transaction per **chunk of 1,000 rows** [CONV] (multi-row `INSERT … SELECT * FROM unnest($1::text[], …)`, parameterised — REQ-SEC-082) and records progress in `run_files.rows_staged`; commit per chunk keeps transactions short (C0 `lims_worker` idle-in-transaction guard analogue).
2. Each staged row stores the raw canonical cells as typed columns (05-SCHEMA §3), `row_no` (1-based, header = 0) and `source_row_sha256` = SHA-256 of the canonical CSV record bytes after NFC normalisation (used for delta comparison, §11.6). This is **not** the `rowSha256` sent to owners: that digest of the port row (§10.3) is stored separately in `stg_patients/stg_results/stg_documents.port_row_sha256`, written at batch planning, so `verify-load` compares against a stored value.
3. Files are staged in this order: masters → patients → visits → results → documents (metadata only; PDF bytes stay on the host volume until load) → financial.
4. The PDF files are hashed during staging; mismatch with `documents.csv.sha256` → row error `mig.doc.sha256_mismatch`.
5. Resumability: a file whose `run_files.state = 'staged'` and sha256 matches is skipped; a file `staging` restarts from `rows_staged + 1` (rows are inserted in file order with `row_no`, unique `(tenant_id, run_id, row_no)` per table blocks double insert).

## 8. Validation rules

Executed by `validate` as set-based SQL inside `staging/` plus row-wise TS rules in `domain/rules/` (for normalisation). Each issue: `(rule_code, severity ∈ error|warning|info, entity, staging_row_id, column_key, message)` — **message never contains a PHI cell value** (PRD AC-04.7).

| Rule code | Sev | Applies to | Check |
|---|---|---|---|
| `mig.file.header_mismatch` | error | all files | every required column present |
| `mig.file.unknown_column` | error | all files | no column outside §6.4 for that file (§6.3.2) |
| `mig.file.row_too_large` | error | all files | record ≤ 64 KiB (§6.3.9) |
| `mig.file.encoding_invalid` / `mig.file.bom_present` | error | all | §6.3.1 |
| `mig.row.required_missing` | error | all | R columns non-empty |
| `mig.row.too_long` | error | all | max lengths in §6.4 |
| `mig.dup.legacy_key` | error | patients, visits, results (key+version), documents, financial | key unique within run |
| `mig.dup.legacy_key_prior_run` | info | patients, results, documents | key already loaded by a **prior run** — a run of this run's ancestor chain via `parent_run_id` in status `verified` or `signed_off`, or any `signed_off` run of the tenant → will be `already_imported`/`unchanged` |
| `mig.ref.patient_unknown` | error | visits, results, documents, dues | `legacy_patient_key` in this run or in a prior run (same definition) |
| `mig.ref.visit_unknown` | error | results, documents | given `legacy_visit_key` exists |
| `mig.ref.centre_unmapped` | error | patients, visits, results (via visit), documents | crosswalk `centre` has a target for the code |
| `mig.ref.analyte_unmapped` | error | results | crosswalk `analyte` target |
| `mig.ref.orderable_unknown` | error | `masters/price_list_items.csv` | `orderable_legacy_code` has a row in `masters/tests.csv` or `panels.csv` (§6.4 price-list builder) |
| `mig.ref.unit_unmapped` | error | results with `unit_raw` | crosswalk `unit` target |
| `mig.ref.result_type_mismatch` | error | results | value column used matches the target analyte's `resultType` (CatalogPort) |
| `mig.ref.ordinal_unmapped` / `mig.ref.flag_unmapped` / `mig.ref.sex_unmapped` / `mig.ref.status_unmapped` / `mig.ref.document_kind_unmapped` / `mig.ref.credit_party_kind_unmapped` | error | as named (the last: `masters/credit_parties.csv`) | crosswalk entry exists |
| `mig.domain.decimal_invalid` | error | numeric columns | §6.3.6 |
| `mig.domain.decimals_exceed_analyte` | warning | results | more decimals than the analyte's display `decimals` (kept as given) |
| `mig.domain.date_invalid` / `mig.domain.timestamp_no_offset` | error | dates/timestamps | §6.3.4–5 |
| `mig.domain.birth_on_future` / `mig.domain.age_out_of_range` | error | patients | birth_on ≤ data_as_of; age 0–150 |
| `mig.domain.phone_invalid` | warning | patients | after §9.2 not `^\+[1-9][0-9]{7,14}$` (C4 `patients__phone__ck`) → phone dropped, counted |
| `mig.domain.email_invalid` | warning | patients | not matching a basic `local@domain` shape → dropped |
| `mig.domain.reported_before_collected` | warning | results | reported_at < collected_at |
| `mig.domain.reported_after_as_of` | error | results, documents | reported_at > manifest `data_as_of` + 1 day |
| `mig.domain.money_invalid` | error | financial | §6.3.7, ≥ 0 where stated |
| `mig.doc.file_missing` / `mig.doc.sha256_mismatch` / `mig.doc.size_mismatch` / `mig.doc.not_pdf` | error | documents | file exists, hash, size, magic bytes `%PDF-` |
| `mig.excluded.not_final` | info | results | status mapped to preliminary/cancelled/other → `excluded` |
| `mig.excluded.deleted_in_source` | info | patients (+ their results/documents cascade as `mig.excluded.patient_excluded`) | |
| `mig.package.not_newer_than_parent` | error | run (delta) | manifest `data_as_of` ≤ parent run's `data_as_of`, or `extract_id` equal to the parent's |
| `mig.package.synthetic_in_production` | error | run | `source_system = synthetic` while `NODE_ENV=production` and the run is not a rehearsal |
| `mig.match.decisions_pending` | error | run | any `pending` candidate pair (§9) |
| `mig.match.merge_cycle` | error | patients | merge pointers/decisions form a cycle |

Run outcome: `validated` iff zero `error` issues on rows not `excluded` and zero run-level errors (PRD AC-04.6).

## 9. Patient matching and dedup (conservative)

### 9.1 Classes

| Class | Rule | Action |
|---|---|---|
| M0 identity | same `legacy_patient_key` (in this run or a prior run: ancestor chain via `parent_run_id` in `verified`/`signed_off`, or any `signed_off` run of the tenant — §8) | same patient — idempotent (`already_imported`); results/documents of that key resolve `patient_id` from the prior run's `stg_patients.target_patient_id` |
| M1 source merge | row has `merged_into_legacy_key` pointing at another row | both keys become legacy refs of the survivor's target patient; no human decision needed (the source system already decided). Chains are followed; cycles → `mig.match.merge_cycle` |
| `strong` | normalised name equal **and** exact `birth_on` equal with both `birth_on_is_estimated = false` **and** normalised phone equal (both present) | candidate pair, `pending`; human decision `merge` / `keep_separate` |
| `possible` | normalised name equal **and** (birth year differs by ≤ 1 **or** normalised phone equal) — and not `strong` | candidate pair, `pending`; human decision |
| `target_possible` | legacy row vs existing `frontdesk.patients` row of the tenant matching C4's dedupe predicate (normalised name equal, birth year ±1, same phone when given — C4 03-APP-FLOW registration step 1) | candidate pair, `pending`; decision `link` / `create_new`. Detected by the dry run (mechanics below); a real load sends `create_new` only for rows whose dry run found no candidates or whose pair was decided |
| (none) | name-only equality, phone-only equality, or birth-date-only equality | **never** a candidate (lead rule "never auto-merge on name only"; phones are shared by families — 06-GLOSSARY "Patient") |

`target_possible` mechanics (no C18 read of `frontdesk.*`): the C4 port in dry-run mode returns, for a `create_new` row whose C4 dedupe predicate finds candidates and that carries no `reviewedDuplicates: true` flag, `rejected` with `reasonCode = 'duplicate_candidates'` and `candidatePatientIds` = candidate patient ids (UUIDs only, P1; a dedicated field of the `rejected` variant, never packed into `FieldError.message`). C18 stores them as `target_possible` pairs; after the decision C18 resends with `decision: {kind:'link', patientId}` or `create_new` + `reviewedDuplicates: true`. (Field `reviewedDuplicates?: boolean` is part of `LegacyPatientRow` in CR-C18-002.)

`reviewedDuplicates` rule: rows whose every candidate pair (`strong`/`possible`) was decided `keep_separate`, and rows decided `create_new` (`target_possible`), are sent with `reviewedDuplicates: true`; this lets two legacy patients the lab lead kept apart both load, although C4's dedupe would find the first when the second is inserted. A `duplicate_candidates` outcome whose candidate ids are all patients created in the same dry-run transaction or by the same run is **not** stored as `target_possible` (those ids are placeholders that vanish on rollback, or the run's own rows): if the pair between them is decided it is a contract violation (03-APP-FLOW E17, exit 1 `mig.runtime.contract_violation`); if undecided the row is reported and the run fails validation via `mig.match.decisions_pending`.

### 9.2 Normalisation (copied rule, owner remains authoritative)

- Name: Unicode NFC → case fold → collapse whitespace to single spaces → trim (same rule as C4 `domain/patient.ts`, C4 02-TRD §3). C4's port re-normalises; C18's copy is only for candidate detection. A drift test (contract suite case) compares both on a shared fixture list.
- Phone: strip spaces, `-`, `(`, `)`; a 10-digit number starting with `9` → prefix `+977` (C4 DECISION, Nepali numbering plan UNVERIFIED — C4 02-TRD `NewPatient`); a value starting with `+` kept; anything else → dropped with `mig.domain.phone_invalid`.
- Sex: crosswalk `sex` (e.g. `M`→male); no default.

### 9.3 Decisions

`match decide` records `decision`, `decided_by_membership_id` (the lab lead, validated as an active, unlocked `tenant_admin` membership of the tenant via `ctx.core.membership`), `lab_form_reference` (required, ≤ 120: the reference of the paper sign-off form on which the lab lead recorded the decisions — the lead does not authenticate to the CLI, 08 A19 D-133), `operator_platform_staff_id`, `decided_at`, optional `note_code`. Bulk decisions by class are allowed (PRD AC-05.5) and recorded per pair. Any later crosswalk import or decision change resets the run to `staged` (03-APP-FLOW §2 guard G4).

### 9.4 Merge resolution

A `merge` decision or M1 pointer builds groups (union-find over pairs). Survivor = the row with the earliest `first_seen_at`; a NULL `first_seen_at` sorts after any value; ties (including all-NULL) → lowest `legacy_patient_key` in byte order. The survivor's demographics are sent; all group keys/codes are sent as `legacyRefs` (≤ 10 per patient; more → error `mig.match.group_too_large`, decide manually).

### 9.5 DECISION D-10 — no overwrite after load

Once a legacy key is loaded, later extracts never overwrite demographics in the LIMS (front desk edits become authoritative). Differences are reported as `changed_fields` for manual follow-up by the lab.

## 10. Reconciliation and verification

### 10.1 Report JSON (`report/report.schema.json`, stored in `migration_staging.reports.body`)

```json
{ "report_kind": "dry_run", "run_id": "…", "generated_at": "2026-11-06T05:00:00.000Z", "format_version": "1",
  "entities": { "patients": { "in_package": 1200, "staged": 1200, "excluded": {"mig.excluded.deleted_in_source": 3},
                              "invalid": 0, "merged_into_group": 12, "would_create": 1180, "would_link": 5,
                              "already_imported": 0, "unchanged": 0, "owner_rejected": {} },
                "results":  { "...": "same keys" },
                "documents": { "...": "same keys", "bytes_total": 52428800, "sha256_of_sorted_sha256": "…" } },
  "checksums": { "results_by_analyte": [ { "analyte_id": "…", "count": 340, "sum_value_numeric_target": "4521.300000" } ] },
  "strata": [ { "first_visit_year": 2024, "patients": 400, "results": 9000 } ],
  "financial": { "patient_dues": { "rows": 40, "total_paisa": 1234500 }, "invoice_refs": { "rows": 9000, "by_fiscal_year_bs": { "2081/82": 5000 } },
                 "note": "Not loaded — treatment pending auditor (B6/B7)" },
  "samples": { "seed": "…hex…", "size": 50, "pass": 50, "fail": 0 },
  "invariant_ok": true }
```
No names, phones, codes, legacy keys or values appear (AC-06.4; schema denies string properties outside the listed keys; ids are UUIDs).

### 10.2 Invariant (per entity)

`in_package = excluded + invalid + merged_into_group + would_create + would_link + already_imported + unchanged + owner_rejected` (dry run) and the same with `created/linked/superseded_previous` after load. `invariant_ok = false` blocks approval and sign-off.

### 10.3 Digests

- `rowSha256` sent to owners = SHA-256 over the UTF-8 bytes of the **canonical JSON** of the port row object without `rowRef` and `rowSha256` (keys sorted lexicographically, no whitespace, absent fields omitted, numbers as JSON numbers, strings as given) [DECISION; implemented in `domain/digest.ts`, golden-tested; owners store it verbatim, they do not recompute]. C18 stores it in `stg_*.port_row_sha256` at batch planning. It is distinct from the staging `source_row_sha256` (§7.2).
- Batch `contentSha256` = SHA-256 of the batch's `rowSha256` values sorted ascending, joined with `\n`.
- Owner `digestSha256` (summary) = same formula over the stored rows of the batch (excluding voided). `verify-load` compares with the same formula over the staging `port_row_sha256` of rows whose outcome was `created`/`linked`/`superseded_previous`, and compares `rowCount` with the number of those rows (one per port row).

### 10.4 Sample checks

`sample` draws N patients (default 50 [CONV], `--sample`), stratified proportionally by first-visit year, using a seeded PRNG (seed = 32 random bytes stored in the report). For each, the terminal shows legacy rows (staging) beside the port row objects that were/will be sent, and after load the operator opens the same patients in the staff web (C4/C5/C6 screens) with the lab lead. Verdict per sample recorded; any `fail` blocks approval/sign-off until its cause is fixed and the sample re-run with a new seed.

## 11. Load mechanics

### 11.1 Order

1. Patients (groups resolved, §9.4) → each staged patient row gets `target_patient_id`.
2. Results (need `patient_id`; sorted by `legacy_result_key`, then `legacy_version_no` ascending so supersede order is correct; a key's versions never split across concurrent batches — planner groups by key).
3. Documents (one call each).
Financial rows: never loaded (BLOCKED B6/B7).

### 11.2 Batching and concurrency

- Batch size 200 rows (patients, results) [CONV = 02-CV §4.1 bulk max]; documents 1.
- Batches are planned up front (`batches` rows with `seq`, `entity`, `content_sha256`, `status = 'planned'`) so resume is deterministic.
- Concurrency `LIMS_MIGRATION_CONCURRENCY` default 2, max 8 [CONV]; rate cap §15.

### 11.3 One batch = one transaction

```ts
await runtime.tx(tenantId, async (ctx) => {
  const res = await ctx.ports.LegacyResultImportPort.importResults(ctx, { runId, batchId, sourceSystem, dryRun, contentSha256, rows });
  await stagingRows.applyOutcomes(ctx, runId, res.outcomes);            // migration_staging only
  await batches.markCommitted(ctx, batchId, countOutcomes(res.outcomes));
}, { rollback: dryRun });
```
In a dry run the outcomes are kept in memory and, after the rollback, written to `stg_<entity>.dry_run_outcome` / `dry_run_reason_code` in a **separate** small transaction (so they survive); dry-run batches are not persisted in `batches` (03-APP-FLOW §3.7) [DECISION]. In a dry run the `batches.markCommitted` call is skipped (no `batches` row exists).

### 11.4 Failure handling

| Failure | Behaviour |
|---|---|
| Port throws `common.validation_failed` / `<m>.legacy_batch_conflict` | stop load, exit 1, `batches.status = 'failed'`, run `load_failed` |
| DB connection loss / timeout | retry the same batch up to 5 times with backoff 1 s, 5 s, 30 s, 2 min, 5 min [CONV]; idempotency makes retries safe |
| Some rows `rejected` in a real load (should not happen after a clean dry run) | batch commits the accepted rows; rejected rows recorded; run ends `loaded` with `owner_rejected > 0` → verification fails until the lab accepts the exclusion or the cause is fixed and a delta run re-sends them |
| Process killed | run stays `loading`; `load` resumes from the first non-`committed` batch (PRD AC-07.3) |

### 11.5 Void

Reverse order (documents → results → patients), one `voidBatch` per committed batch, each in its own transaction with the staging update; `notVoidable` entries recorded; run `voided` or `voided_partial`.

### 11.6 Delta runs

A delta run has `parent_run_id` (the parent is `verified` or `signed_off`, 03-APP-FLOW T1). Rows whose `(legacy key, source_row_sha256)` equals the value staged by a prior run (§8 definition) are `unchanged` and not sent (PRD AC-09.3); results and documents of patients loaded by a prior run take `patient_id` from that run's `stg_patients.target_patient_id` (PRD AC-09.4). Rows with a known key but different hash are sent: owners return `already_imported` + `changed_fields` (patients) or `superseded_previous` (results with a higher version) or `already_imported` (documents with same key and sha256; a different sha256 for a known document key → `rejected changed_document`, reviewed manually).

## 12. State machine

Run states and guards are in 03-APP-FLOW §2 (`domain/run.state.ts` is the single implementation; every command checks it).

## 13. Background jobs

None. All work is operator-initiated. The only scheduled item is C1's metrics/alert timer that runs `lims-migrate status --metrics` (CR-C18-006); it enumerates tenants with `app.cron_tenant_ids()` (§4.2, D-134), opens one read-only transaction per tenant, writes no `run_events` row (PRD AC-17.3) and needs no operator.

## 14. Configuration (env `LIMS_MIGRATION_*`, global per host; no tenant settings)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `LIMS_MIGRATION_DATABASE_URL` | secret (SOPS → tmpfs file, C1 §8) | — | `lims_migration` login, direct `data-1` |
| `LIMS_MIGRATION_ROOT` | path | `/srv/lims/migration` | run directories; must contain the volume marker |
| `LIMS_MIGRATION_ALLOWED_HOSTS` | csv | — (required) | host names where the CLI may run (host guard) |
| `LIMS_MIGRATION_OPERATOR_MAP` | path | — (required) | path to a root-owned file (mode 0400) mapping `unix_user → platform_staff_id`, one `user:uuid` per line [CONV format], written by the C1 playbook (CR-C18-006). The CLI refuses `--operator` values that do not match the invoking Unix user (`mig.operator.mismatch`), and the four-eyes commands (`approve`, `void approve`, `purge approve-early`) compare mapped ids (04-UI-UX §2, 07 S-15) |
| `LIMS_MIGRATION_SUPPORTED_FORMATS` | csv | `1` | canonical versions |
| `LIMS_MIGRATION_STAGE_CHUNK_ROWS` | int 100–10,000 | 1,000 [CONV] | rows per staging insert tx |
| `LIMS_MIGRATION_BATCH_ROWS` | int 1–200 | 200 [CONV] | rows per port call |
| `LIMS_MIGRATION_CONCURRENCY` | int 1–8 | 2 [CONV] | parallel batches |
| `LIMS_MIGRATION_MAX_ROWS_PER_SECOND_DAY` | int | 200 [CONV] | cap 06:00–20:00 Asia/Kathmandu (§15) |
| `LIMS_MIGRATION_MAX_ROWS_PER_SECOND_NIGHT` | int | 1,000 [CONV] | cap 20:00–06:00 |
| `LIMS_MIGRATION_SAMPLE_SIZE` | int 10–500 | 50 [CONV] | default `--sample` |
| `LIMS_MIGRATION_PURGE_AFTER_DAYS` | int 7–90 | 30 [CONV] | purge allowed after sign-off + N days |
| `LIMS_MIGRATION_PENDING_SCAN_MAX_MINUTES` | int | 60 [CONV] | verify fails for documents still `pending_scan` |
| `LIMS_MIGRATION_METRICS_TEXTFILE` | path | (unset = off) | Prometheus textfile output (CR-C18-006) |

Owner-side settings proposed in CRs: `LIMS_FRONTDESK_LEGACY_VOID_WINDOW_DAYS`, `LIMS_LAB_LEGACY_VOID_WINDOW_DAYS`, `LIMS_REPORTING_LEGACY_VOID_WINDOW_DAYS` (default 60 [CONV]); C5 lab setting `legacy_in_delta` (bool, default false) and `legacy_in_history` (bool, proposed default **false**, matching the binding `getAnalyteHistory.includeLegacy` default; the lab turns it on after cut-over — 08 A19 D-135).

## 15. Performance targets (derived from 04 §14; all volumes ASSUMPTION until B4 gives real counts)

Volume per **year of history** for one lab at the 04 §14 upper bounds:
- visits ≤ 500 patients/day × 365 = **182,500**;
- result rows 15,000–25,000/day × 365 = **5.48 M – 9.13 M**;
- report PDFs 500–700/day × 365 = **182,500 – 255,500**; at 150 KB/PDF (UNVERIFIED, 04 §14) ≈ **27–38 GB**.

| Stage | Target [CONV] | Arithmetic |
|---|---|---|
| Stage (CSV → staging) | ≥ 5,000 rows/s | 9.13 M rows ÷ 5,000 ≈ 30 min per history year |
| Validate | ≤ 15 min per 10 M result rows | set-based SQL with the 05-SCHEMA indexes |
| Load results (night) | 1,000 rows/s = 5 batch tx/s × 200 | 9.13 M ÷ 1,000 ≈ 2.5 h per history year; a 10 h night (20:00–06:00) loads ≈ 36 M rows ≈ 4 years |
| Load results (day) | ≤ 200 rows/s = 1 batch tx/s | keeps added write load at ≤ 1 tx/s against 04 §14's ≲50 writes/s normal and 250 writes/s headroom target for N = 10 |
| Load patients | ≥ 500 rows/s | ≤ 182,500 ÷ 500 ≈ 6 min per year |
| Documents | ≥ 5 documents/s into C6 quarantine; scan/sanitise throughput is C6/C1's (UNVERIFIED) | 255,500 ÷ 5 ≈ 14 h per year → documents are loaded in nightly slices **before** cut-over; only the delta's documents fall in the freeze window |
| Delta load in freeze window | ≤ 30 min for one day of delta | ≤ 500 patients + ≤ 25,000 results + ≤ 700 PDFs: 25,000 ÷ 1,000 = 25 s + 700 ÷ 5 = 140 s + validation/dry run/verify ≈ 20 min |
| Staging disk | ≈ 4 GB per history year in DB (ASSUMPTION ≈ 400 B/result row × 9.13 M) + PDFs on the host volume (27–38 GB) | C1 sizes the migration volume (CR-C18-006) |

## 16. Observability

Logs: `@lims/shared-ts/logger`, `service = "migration-tool"`, fields of 02-CV §9.1 plus `run_id`, `batch_id`, `command`. No PHI (02-CV §9.2): never a name, phone, legacy key/code, registration no, value, file path under `documents/` (paths may embed ids) — paths are logged as staging row UUIDs.

Metrics (Prometheus textfile, written at the end of each command and every 30 s during long commands — CR-C18-006):

| Metric | Type | Labels |
|---|---|---|
| `lims_migration_rows_total` | counter | `tenant_id`, `entity`, `stage` (staged/validated/dry_run/loaded/voided), `outcome` |
| `lims_migration_batch_duration_seconds` | histogram | `entity` |
| `lims_migration_run_state` | gauge (1 for the current state) | `tenant_id`, `run_kind`, `state` |
| `lims_migration_last_progress_timestamp_seconds` | gauge | `tenant_id` |
| `lims_migration_signed_off_unpurged_runs` | gauge | — (sum over the tenants enumerated by `app.cron_tenant_ids()`, §13) |

Alerts proposed to C1 (CR-C18-006, format of C1 04-UI-UX §6):

```yaml
- alert: MigrationLoadStalled
  owner: C18
  expr: (lims_migration_run_state{state="loading"} == 1) and (time() - lims_migration_last_progress_timestamp_seconds > 1800)
  for: 5m
  severity: warn
  notify_tenant: false
  summary: "Migration load for tenant {{ $labels.tenant_id }} made no progress for 30 min"
  runbook: tools/migration/runbooks/cutover.md#stalled-load
- alert: MigrationStagingNotPurged
  owner: C18
  expr: lims_migration_signed_off_unpurged_runs > 0
  for: 24h
  severity: warn
  notify_tenant: false
  summary: "Signed-off migration staging data still present"
  runbook: tools/migration/runbooks/purge.md
```

Audit: every command → `migration_staging.run_events` (A). Owner tables record actor = migration system actor and `app.request_id` = batch id through C0's audit trigger (04 D11).

## 17. Test strategy

| Layer | What | Fakes / real |
|---|---|---|
| Unit | CSV parser (RFC 4180 cases, CRLF/LF, quotes, newlines in quotes, BOM, invalid UTF-8), manifest schema, every rule in §8 (positive + negative), normalisation, match classifier (each class + "name only never"), union-find + cycle, digests (golden vectors), run state machine (every allowed + representative forbidden transition, 02-CV §11.4), sampler determinism | none |
| Integration | stage → validate → match → dryrun → load → verify → void → purge on PG 17 compose with `tenant_a`/`tenant_b`; synthetic packages of 1×, and 10× (≈ 100 k results) | Legacy ports: C0 fakes first, owners' real implementations once merged |
| Contract | `packages/fakes/contract-tests/Legacy{Patient,Result,Document}ImportPort.contract.ts` (cases in CR-C18-002..004) run against fakes (C0) and real owners; C18 runs them against fakes in its CI too | — |
| Probes | `migration_staging` RLS: claims tenant A see 0 rows of B; insert with B id fails; update/delete of B rows affect 0; `lims_api` and `lims_worker` have **no** privilege on any staging table (`has_table_privilege` = false) | C0 db/tests (CR-C18-001) + C18 `__tests__/probes` |
| Security | log scan of a full synthetic run (planted PHI), report JSON denylist, host guard, `--reveal` audit, CI grep: no `billing.` / other-schema SQL in `src/**`, no `fetch(`/`http` imports in `src/**` | — |
| E2E (nightly, after owners merge) | full rehearsal on the compose stack: synthetic package of 2 years → load → C5 history API returns legacy points → C4 search by legacy code → C6 legacy document list → void → purge | real owners |

Synthetic generator (`sources/synthetic/generator.ts`, built on `@lims/test-fixtures`): deterministic packages with planted edge cases (duplicate keys, strong/possible pairs, name-only twins, merge chains, unmapped codes, preliminary results, non-PDF bytes, wrong sha256, timestamps without offset, B.S.-converted dates at range edges). Names visibly fake ("Test Patient 0042"), phones from the generator (02-CV §11.2).

## 18. Dependencies table (02-CV §15.1)

| Name | Exact version | Licence | Purpose | Maintenance evidence | Alternatives |
|---|---|---|---|---|---|
| `write-excel-file` | 4.1.1 | MIT | C3 master workbooks | as recorded by C3 02-TRD §2.2 (registry, fetched 2026-11-05: published 2026-06-08) | none — must match C3's writer to avoid format drift |
| (workspace) `@lims/shared-ts`, `@lims/contracts`, `@lims/fakes`, `@lims/test-fixtures`, `@lims/worker` (tool-runtime export) | workspace | — | — | — | — |
| `pg` | C0 pin | MIT | DB | C0 | — |

## 19. Change requests raised

> Status per `program/08-CR-REGISTER.md` (2026-11-06). CR texts below are kept as history.

| CR | Status |
|---|---|
| CR-C18-001 | DEFERRED in 08 — B4: contract design accepted in principle; no DDL before B4 lifts (founder timing). |
| CR-C18-002 | DEFERRED in 08 — B4. |
| CR-C18-003 | DEFERRED in 08 — B4. `getAnalyteHistory.includeLegacy` already reserved. |
| CR-C18-004 | DEFERRED in 08 — B4. Bucket name reserved `reporting-legacy` (R26). |
| CR-C18-005 | DEFERRED in 08 — B4. |
| CR-C18-006 | DEFERRED in 08 — B4. |
| CR-C18-007 | DEFERRED in 08 — B4. |
| CR-C18-008 | ACCEPTED in 08 |
| CR-C18-009 | DEFERRED in 08 — B6/B7 auditor (F-07). |
| CR-C18-010 | ACCEPTED in 08 |
| Review fix pass 2026-11-06 | review/C18-legacy-migration.md + 08 Addendum A19 (plus A13 and A17 rules that apply to C18) applied — design text only; no DDL, ports or tool code authorised (08 F-06) |

**08 Addenda applied (08 A25 P-60: one row per addendum A1–A29; final check 2026-11-06)**

| Addendum | Status for C18 |
|---|---|
| A1 | not applicable |
| A2 | not applicable |
| A3 | not applicable |
| A4 | not applicable |
| A5 | not applicable |
| A6 | not applicable |
| A7 | not applicable |
| A8 | not applicable |
| A9 | not applicable |
| A10 | not applicable |
| A11 | not applicable |
| A12 | not applicable |
| A13 | applied 2026-11-06 — P-6, P-9, P-11, P-12, D-1, D-2, D-3, D-4, D-5, D-6, D-7, D-8, D-9, D-10 (PRD, TRD, AF, SCH, SEC) |
| A14 | not applicable |
| A15 | not applicable |
| A16 | applied 2026-11-06 — A16.1 (SCH) |
| A17 | applied 2026-11-06 — P-16, P-18 (TRD, SCH, SEC) |
| A18 | not applicable |
| A19 | applied 2026-11-06 — P-46, D-121, D-132, D-133, D-134, D-135, D-136 (PRD, TRD, AF, UI, SCH, PLAN, SEC) |
| A20 | not applicable |
| A21 | not applicable |
| A22 | not applicable |
| A23 | not applicable |
| A24 | not applicable |
| A25 | not applicable |
| A26 | not applicable |
| A27 | not applicable |
| A28 | not applicable |
| A29 | not applicable |


All CRs are **non-blocking for other chunks**; they block C18 tasks only (06-IMPLEMENTATION-PLAN). They are already registered in 08 §3 (no filing needed, 06 T00); owners implement when B4 is lifted (founder decides timing). Designed as if accepted, marked [CR]. The CR texts below were updated in the review fix pass to the 08 A19 decisions (bucket `reporting-legacy`, D-133…D-136).

```
Title: CR-C18-001: migration_staging DDL, role lims_migration, system actor 'migration'
From chunk: C18            To owner: C0-0B
Type: schema               Blocking? yes — C18 T03+ (staging)
Problem: C0 05-SCHEMA §2 creates schema migration_staging with "none (C18 defines its own loader role by CR)". C18 needs its tables and a login role
 that can write staging and run owner port code under RLS (PRD US-02..US-12).
Proposed change (exact): 05-SCHEMA.md of C18 §2 (role + grants), §4 (DDL), §5 (RLS). Summary:
  CREATE ROLE lims_migration LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; ALTER ROLE lims_migration NOLOGIN (enabled per window by C1 runbook);
  GRANT lims_app TO lims_migration WITH INHERIT TRUE, SET FALSE;   -- PROPOSED EXCEPTION — needs 08 acceptance after B4 (08 A19 D-136)
  GRANT USAGE ON SCHEMA migration_staging TO lims_migration;
  GRANT EXECUTE ON FUNCTION app.core_resolve_tenant_code(text) TO lims_migration;   -- 08 A19 D-121/D-134 (existing C0 DEFINER)
  GRANT EXECUTE ON FUNCTION app.cron_tenant_ids() TO lims_migration;                -- 08 A13 P-6/A19 D-134 (existing C0 DEFINER)
  tables of C18 05-SCHEMA §4 owned by lims_owner, policies TO lims_migration only (PROPOSED EXCEPTION, D-136) with the P-16 staff/system guard;
  lims_app gets nothing on migration_staging; the other proposed exceptions of C18 05-SCHEMA §1 (no row audit on stg_*/match_pairs/issues/samples,
  class E without expires_at, class C-legacy) are accepted or refused together with this CR after B4 (D-136);
  db/meta/system-actors.yaml: add module 'migration' with a fixed UUIDv7; core.g_system_actors seed row;
  db/meta/tables.yaml entries with class, phi_class per column, retention; migration file prefix migration_staging__ (last in the DAG, C0 02-TRD §4.2).
Backward compatible? yes (additive)
Tenant/security impact: new login role with lims_app membership (REQ-SEC-039/131: NOBYPASSRLS, no ownership); staging tables FORCE RLS (REQ-SEC-011/012);
 role disabled outside windows. Probes: §17. PHI: P2/P3 staging columns (05-SCHEMA §6).
Alternatives considered: running loads as lims_worker (rejected: would let the always-on worker read staging PHI; no window control).
Tests that will prove it: C18 05-SCHEMA §8 test list.
```

```
Title: CR-C18-002: LegacyPatientImportPort + frontdesk.patient_legacy_refs + legacy consent source + search by legacy code
From chunk: C18            To owner: C4 (frontdesk) + C0-0C (port type, permissions, errors) + C0-0B (DDL)
Type: port + schema + api  Blocking? yes — C18 T09
Problem: PRD US-07, US-14 (AC-14.1): migrated patients must be created by C4's own code (01 §5 R2) and found by old lab code (00 A2).
Proposed change (exact):
  Port: contracts/ports/LegacyPatientImportPort.ts = C18 02-TRD §5.1 (incl. LegacyPatientRow.reviewedDuplicates, §9.1).
  Port owner registry (C0 PORT_OWNERS): LegacyPatientImportPort → frontdesk; consumers: migration (tool runtime) only.
  DDL: frontdesk.patient_legacy_refs and frontdesk.legacy_import_batches as in C18 05-SCHEMA Appendix B.1;
       frontdesk.patient_consents.source CHECK adds 'legacy_import'.
  Behaviour: consent row source 'legacy_import' with consent_text_version = 'legacy_import', captured_at = load time (ctx.now()),
       processing = false, share_with_referrer = false, every channel flag false; C4 registration treats a patient whose latest consent source is
       'legacy_import' as "consent recapture required" (existing frontdesk.consent_required path; registration UI asks for consent as for a new patient).
  Dedupe: a row with reviewedDuplicates: true is created despite C4 dedupe candidates (duplicate_override_reason_code 'legacy_import_reviewed');
       without it, candidates → rejected duplicate_candidates with LegacyRowOutcome.candidatePatientIds (C18 02-TRD §5.1, §9.1).
  Search: POST /v1/frontdesk/patients/search also matches patient_legacy_refs.legacy_patient_code (exact, case-insensitive, ≥3 chars),
       result marked "matched on legacy code".
  Permissions (contracts/permissions.yaml): { code: frontdesk.patient.import_legacy, privileged: false, roles: [] }  # migration system actor only
  Errors: frontdesk.legacy_batch_conflict (409), frontdesk.legacy_void_window_closed (409).
  Coded set frontdesk legacy_import_reasons: invalid_field, link_target_not_found, duplicate_candidates, anonymised_target, already_voided.
  Coded set duplicate_override_reasons adds 'legacy_import_reviewed'.
  Contract tests (packages/fakes/contract-tests/LegacyPatientImportPort.contract.ts): (1) create_new → created + patient_code; (2) same batchId+hash
       → replayed; (3) same batchId other hash → conflict; (4) known legacy key → already_imported + changedFields; (5) link to other tenant's id → rejected
       link_target_not_found; (6) dry run leaves no rows after rollback and writes no storage; (7) >200 rows → validation_failed; (8) no event published,
       no NotificationPort call; (9) voidBatch deactivates unused patients, reports in_use for patients with a non-legacy order; (10) void after window → error;
       (11) create_new with dedupe candidates and no reviewedDuplicates → rejected duplicate_candidates with candidatePatientIds; (12) system actor without the
       permission → auth.forbidden; (13) consent row source legacy_import with all flags false, consent_text_version 'legacy_import', captured_at set;
       (14) two rows of one batch matching each other by C4's dedupe predicate, both reviewedDuplicates: true → both created.
Backward compatible? yes (new port, new tables, new CHECK value, search extension additive)
Tenant/security impact: new P2 columns (legacy codes); search over legacy codes is access-logged like other searches; no new public surface.
Alternatives considered: HTTP bulk endpoint (rejected: needs a human token for hours-long loads; support sessions have no centre scope — C2 02-TRD §6).
```

```
Title: CR-C18-003: LegacyResultImportPort + lab.legacy_results + history/trend inclusion
From chunk: C18            To owner: C5 (lab) + C0-0C + C0-0B
Type: port + schema + api  Blocking? yes — C18 T10
Problem: PRD US-14 AC-14.2/14.3: previous results and trend from day one (00 C2, C7) without creating orders/specimens/results for past visits (PRD D-1).
Proposed change (exact):
  Port: contracts/ports/LegacyResultImportPort.ts = C18 02-TRD §5.1. Owner registry: lab; consumer: migration.
  DDL: lab.legacy_results, lab.legacy_import_batches — C18 05-SCHEMA Appendix B.2 (class C-legacy: content immutable; lifecycle columns
       superseded_at, superseded_by_id, voided_at, voided_by, void_reason_code, void_batch_id).
  Read paths (reserved contract, 03-IC §4.5 / 08 §4.14; 08 A19 D-135): LabPort.getAnalyteHistory with includeLegacy: true (port default false)
       also returns rows of lab.legacy_results (not voided, not superseded) for the same patient_id + analyte_id as AnalyteHistoryPoint
       { source: 'legacy', resultId = lab.legacy_results.id, approvedAt = reported_at, valueNumeric, unitCode, flag }. The C5 HTTP routes
       getResultHistory (#25) and getAnalyteTrend (#26) pass includeLegacy = lab setting legacy_in_history. Delta evaluation (C5 delta.ts)
       ignores legacy rows unless legacy_in_delta = true (default false).
  Lab settings (lab.lab_settings): legacy_in_history boolean NOT NULL DEFAULT false (the lab turns it on after cut-over),
       legacy_in_delta boolean NOT NULL DEFAULT false.
  Permissions: { code: lab.legacy_result.import, privileged: false, roles: [] }  # migration system actor only
  Errors: lab.legacy_batch_conflict (409), lab.legacy_void_window_closed (409). Coded set legacy_import_reasons: invalid_field, patient_not_found,
       analyte_not_found, result_type_mismatch, stale_version, already_voided.
  Contract tests: (1) created; (2) replay; (3) conflict; (4) same key+version → already_imported; (5) higher version → superseded_previous and the old
       row superseded; (6) lower version → rejected stale_version; (7) other tenant's patient id → rejected patient_not_found; (8) no event, no critical
       evaluation; (9) history API returns legacy rows labelled; (10) delta ignores legacy by default; (11) voidBatch hides rows from history; (12) dry run
       leaves nothing.
Backward compatible? yes (`includeLegacy` and point `source` are already reserved in 03-IC §4.5)
Tenant/security impact: new P3 table, centre-scoped (centre_id + RLS TC template); no new public surface; history views already access-logged.
Alternatives considered: inserting into lab.results/result_versions (rejected: needs order_test/specimen/approval rows and membership ids that do not exist).
```

```
Title: CR-C18-004: LegacyDocumentImportPort + reporting.legacy_documents + bucket reporting-legacy + staff list/download
From chunk: C18            To owner: C6 (reporting) + C0-0C + C0-0B + C0-0A (ctx.storage bucket)
Type: port + schema + api  Blocking? yes — C18 T11
Problem: PRD IS-8, AC-14.4: staff must open old report PDFs (00 §3 item 11) — untrusted files (04 R7).
Proposed change (exact):
  Port: contracts/ports/LegacyDocumentImportPort.ts = C18 02-TRD §5.1. Owner registry: reporting; consumer: migration.
  DDL: reporting.legacy_documents, reporting.legacy_import_batches — C18 05-SCHEMA Appendix B.3.
  Storage: private bucket 'reporting-legacy' (name reserved, 08 R26 / §4.8), paths {tenant_id}/quarantine/{yyyy}/{mm}/{document_id}.bin and
       {tenant_id}/legacy/{yyyy}/{mm}/{document_id}.pdf ({yyyy}/{mm} of created_at UTC); same scan → qpdf-sanitise pipeline as input_files
       (04 R7; REQ-SEC-083/084/087); write-once.
  Orphan sweep: the storage put is not transactional, so a rolled-back or retried importDocument can leave a quarantine object without a row.
       C6 adds job reporting.sweep_legacy_orphans (daily [CONV], per_tenant per 08 A13 P-6): delete reporting-legacy/{tenant_id}/quarantine/**
       objects older than 24 h [CONV] that have no reporting.legacy_documents row (E-class quarantine objects, 08 A13 P-12(a)).
  HTTP (contracts/openapi/reporting.yaml):
     GET  /v1/reporting/patients/{patient_id}/legacy-documents  op listLegacyDocuments  x-permission reporting.legacy_document.read
          → {data:[{id, document_kind, document_date, title?, legacy_registration_no?, page_count?, state, created_at}], page}; only state ready listed
            unless caller holds reporting.template.manage (sees quarantined/rejected for triage) [CONV]
     GET  /v1/reporting/legacy-documents/{legacy_document_id}/pdf  op downloadLegacyDocumentPdf  x-permission reporting.legacy_document.read
          → 200 application/pdf, Content-Disposition attachment, Cache-Control no-store, nosniff; access_log 'legacy_document.download';
            rate tier general; 404 common.not_found for other tenant/centre or not ready.
  Permissions: { code: reporting.legacy_document.import, privileged: false, roles: [] }  # migration system actor only
               { code: reporting.legacy_document.read, privileged: false, roles: [front_desk, centre_staff, lab_technologist, pathologist] }
  Errors: reporting.legacy_batch_conflict (409), reporting.legacy_void_window_closed (409). Coded set legacy_import_reasons: invalid_field,
       patient_not_found, not_pdf, too_large, sha256_mismatch, changed_document, already_voided.
  Not delivered to portal/WhatsApp/patient app; no QR token (PRD D-6).
  Contract tests: (1) accepted → pending_scan, summary states; (2) replay; (3) conflict; (4) same key + sha → already_imported; same key other sha →
       rejected changed_document; (5) non-PDF magic → rejected not_pdf; (6) > 15 MB → rejected too_large; (7) dry run writes no storage object;
       (8) scan hit → quarantined, never downloadable; (9) download by tenant_b → 404; (10) void hides from list and download;
       (11) object written, transaction rolled back → removed by reporting.sweep_legacy_orphans.
Backward compatible? yes
Tenant/security impact: new P3 objects; first path segment tenant_id (04 D15 pattern); D3 Storage claims UNVERIFIED → server-side ctx.storage only.
```

```
Title: CR-C18-005: Tool runtime for tools/* (port registry + tenant transaction as a system actor) + legacy-common port types
From chunk: C18            To owner: C0-0D (services/worker core) + C0-0C (contracts/ports/legacy-common.ts)
Type: shared-lib / port    Blocking? yes — C18 T02
Problem: C18 must call owner ports in-process (01 §5: ports are the synchronous channel) but owns no API/worker module (01 §3).
Proposed change (exact): export createToolRuntime() from @lims/worker/tool-runtime with the signature in C18 02-TRD §4.2: same claims/set_config
  path as worker jobs (02-CV §5.10, §6), same port registry and fake/real resolution and production no-fake check (02-CV §8.2), opts.rollback for
  dry runs, systemPermissions validated against contracts/permissions.yaml (never platform.*), actorModule must exist in system-actors.yaml.
  Claims carry no extra key (no tool_run_id; 03-IC §13 extraClaims are not extended). contracts/ports/legacy-common.ts with the types of C18 02-TRD §5.1.
  Tenant resolution (08 A19 D-134): no new C0 capability. The tool resolves --tenant <code> with the existing app.core_resolve_tenant_code
  (D-121) and enumerates tenants for status --metrics with app.cron_tenant_ids() (A13 P-6); the EXECUTE grants are in CR-C18-001. Reads use
  ctx.core.centres / centre / membership (C0 02-TRD §6.8).
Backward compatible? yes
Tenant/security impact: a second process type acting as a system actor; it requires the lims_migration login (CR-C18-001), so it cannot run with
 lims_api/lims_worker credentials by accident (runtime asserts current_user = 'lims_migration').
Tests: runtime opens tx with correct claims; rollback option leaves no rows; fake ports refused in production mode; unknown permission refused.
```

```
Title: CR-C18-006: Migration host provisioning, transfer path, secrets, role window, metrics textfile, alerts
From chunk: C18            To owner: C1
Type: infra                Blocking? yes — C18 T13 (rehearsal), not for build
Proposed change (exact):
  - LUKS-backed volume on app-1 mounted /srv/lims/migration (size per C18 02-TRD §15: ≥ 2 × PDFs of the history years + 20 %), owner uid of the
    lims-migrate container, mode 0700, marker file .lims-migration-volume; excluded from any sync to ops-1; included in no backup (staging is
    re-creatable from the package; the package itself is kept until sign-off on this volume only).
  - Container image lims-migrate (built from tools/migration, pinned by digest) run via playbook migration-run.yml (interactive, ops_admin only).
  - SOPS secret migration.database_url (prod only when a window is approved); playbook migration-window.yml -e action=open|close toggles
    ALTER ROLE lims_migration LOGIN/NOLOGIN and rotates the password on open.
  - Inbox: SFTP-only chroot /srv/lims/migration/inbox/<tenant_code>/ via a temporary WireGuard peer (wg_peers entry with expiry note) — removed on
    close of the cut-over window; age recipient key for the migration volume (private key on the volume only).
  - node_exporter textfile directory + collector for LIMS_MIGRATION_METRICS_TEXTFILE; systemd timer every 5 min: lims-migrate status --metrics.
  - Alerts MigrationLoadStalled, MigrationStagingNotPurged (C18 02-TRD §16), plus a C1-owned alert when role lims_migration
    has an active session or a successful login while no migration window is recorded as open (REQ-SEC-045/133).
  - Network: lims-migrate container → data-1:5432 over wg0 only; no egress to the internet (Squid not configured for it).
Tenant/security impact: REQ-SEC-125 (LUKS), 128 (secrets), 132 (segmentation), 136 (prod only).
```

```
Title: CR-C18-007: IdentityPort handling for the 'migration' system actor
From chunk: C18            To owner: C2
Type: port semantics       Blocking? yes — C18 T09
Problem: assertRole for actor_type 'system' uses the module manifest's systemPermissions (03-IC §4.6). The migration actor is declared by the tool runtime,
 not by a module manifest.
Proposed change: IdentityPort.assertRole resolves systemPermissions for actor 'migration' from the tool-runtime registration (C0 system-actors registry,
 CR-C18-005); access_log entries for owner reads made during verification carry actor 'migration'. No human role gets the three *.import_legacy / *.import codes.
Backward compatible? yes
```

```
Title: CR-C18-008: Catalog import kind 'credit_parties' — ACCEPTED in 08 §3; now in C3 02-TRD §8.2 (sheet CreditParties)
From chunk: C18            To owner: C3
Type: api                  Blocking? no. C18 produces this workbook with `masters build --kind credit_parties` (PRD AC-13.4)
Problem: catalog.imports.kind allows price_list, catalog_master, referrers (C3 05-SCHEMA); credit parties (00 E2/E6) cannot be bulk-loaded.
Proposed change: kind 'credit_parties', sheet CreditParties (party_code, name, kind, allows_credit, pan, contact_phone_e164, contact_email, billing_address),
 upsert by party_code, permission catalog.price_list.manage.
```

```
Title: CR-C18-009 (DRAFT — DO NOT FILE until B6/B7 are answered): legacy invoice reference documents and opening balances
From chunk: C18            To owner: C4 (billing) + auditor review
Type: schema + api
Problem: PRD US-15. Historical invoices issued by eLabs may need to be viewable; dues and credit-party balances may need opening entries.
Constraints (04 L5–L8): never insert into billing.invoices/credit_notes/ledger_entries; never allocate or advance billing.fiscal_counters; never sync to CBMS;
 any reference document must be visibly marked as issued by the previous software and must itself be immutable (VAT Act s.29(1)(g2) applies to our software).
Options for the auditor: (A) no import — lab keeps eLabs read-only for invoice look-ups [current default]; (B) read-only "legacy invoice reference" table outside
 the billing sequence with PDF copies; (C) opening-balance records per credit party at cut-over date. Questions: does a mid-FY switch require continuing the
 eLabs number series or a new series (B6 series granularity); how are the two softwares' sales registers combined for that FY.
```

```
Title: CR-C18-010: Align B4 default wording (04 §13 vs 07-BLOCKERS) and 01 §2 C18 row
From chunk: C18            To owner: doc owner (founder)
Type: docs                 Blocking? no
Problem: 04 §13 B4 default = "No migration design"; 07-BLOCKERS B4 = "No migration build; only C18's requirements doc and target mapping"; the lead asked
 for the full pipeline design. C18 follows 04 for building (no build) and the lead's request for documents.
Proposed change: 04 §13 B4 default → "No migration build; C18 documents specify canonical format, staging, mapping, validation and cut-over (design only)".
```
