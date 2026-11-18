# Excel test import (catalog) — operations note

Task T0B-TESTIMPORT-1 (contract T0C-TESTIMPORT-1, LD-318 and its follow-up, LD-325, LD-335). Founder 2026-11-17 08:58 NPT: one Excel file with exactly the fields of the
forms, filled at once, converted to JSON on the server and stored, with no dirty data.

## Operations

| operationId | what it does |
|---|---|
| downloadCatalogImportTemplate | xlsx generated from the one field list (`services/api/src/modules/catalog/import/fields.ts`) that also drives the parser and validator |
| validateCatalogImport | dry run: parse + validate on the server, record a batch (`validated` or `rejected`); writes no catalog row |
| commitCatalogImport | one transaction, all rows or none, DRAFTS only; If-Match + `confirm: true` |
| listCatalogImports / getCatalogImport | batch history (never deleted), ETag = version |
| downloadCatalogImportErrors | the uploaded rows with an `Errors` column (plus Meta and Lists, so the fixed file validates again) |

All six need `catalog.test.manage`. None needs `catalog.reference_range.publish`.

## Draft only: the import never publishes

Imported tests, analytes (version 1 DRAFT, or a new DRAFT beside the published version in `update` mode), reference range sets and critical limit sets are created as
drafts through the existing catalog services. The import never publishes: the pathologist sign-off (publishAnalyteVersion / publishReferenceRangeSet, publish
permission) still decides what goes live, and imported tests become orderable only by the existing publish rules (LD-318 decision 2).

## Library choice and dependency audit

Audit run 2026-11-18 (`npm audit` over a throwaway lockfile with the candidates, nothing installed into the repo):

| candidate | version | advisories found |
|---|---|---|
| xlsx (SheetJS, npm) | 0.18.5 | HIGH: prototype pollution GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9; no fixed version on npm |
| exceljs | 4.4.0 | moderate via uuid < 11.1.1 (GHSA-w5hq-g745-h8pq); also pulls jszip, saxes, archiver, unzipper, tmp |
| read-excel-file | 9.3.17 | none reported (read only; still a zip + XML stack we do not control) |
| fast-xml-parser | 5.12.1 | none reported |
| yauzl | 3.4.0 | none reported |
| write-excel-file | 4.1.1 | none reported (already a pinned dependency of services/api, used by the analytics export XlsxWriter) |

Pick: **no spreadsheet, zip or XML dependency.** `services/api/src/modules/catalog/import/xlsx.ts` is a minimal reader and writer on `node:zlib`
(inflateRawSync / deflateRawSync / crc32) and a few anchored regular expressions. Reasons: the only full-featured option (xlsx) has open high advisories, exceljs carries a
moderate one and a large tree, and the import needs a small subset (inline / shared strings, numbers, booleans, data validation lists, sheet protection). Owning the reader
lets every safety check run before any byte is inflated. `services/api/package.json` is unchanged. The existing write-excel-file 4.1.1 stays pinned for the analytics
export; the import does not use it, so the reader and the writer of this feature (template, errors file) stay one small audited code path. Re-run the audit before ever adding a library here; any spreadsheet,
zip or XML dependency must be pinned to an exact version (static test).

## Limits and file safety (refused as problem+json, nothing recorded)

- At most **5 MB** (`catalog.import_too_large`, 413) and at most **5000** data rows per sheet (`catalog.import_too_large`, 413).
- xlsx only, by magic bytes and structure (never the name or mime type): csv, xls (OLE2), pdf, random bytes, a truncated file or a zip without a workbook part are
  `catalog.import_invalid_file` (422).
- Zip bomb: entry count (1000), per entry (40 MB) and total (120 MB) uncompressed size and the expansion ratio (200:1 above 1 MB) are checked on the central directory
  before inflating; every inflate is capped again because declared sizes can lie. ZIP64, encryption and unknown compression methods are refused.
- Macros (`vbaProject`, macro enabled content types), external links (`externalLinks` parts, `TargetMode="External"` relationships), embedded OLE objects and ActiveX
  are refused. Any `DOCTYPE` / `ENTITY` declaration is refused (no XXE, no billion laughs); only the five XML entities and numeric references are decoded.
- Any **formula** cell in a named sheet (hidden sheets included) refuses the file. Only the named sheets are read; other sheets are ignored.
- The Meta sheet carries the template version and a checksum of the layout; a wrong version, a wrong checksum, a renamed header or a missing sheet is
  `catalog.import_template_outdated` (422); no Meta sheet at all is `catalog.import_invalid_file`.

## Cell hygiene and validation (batch errors, all listed, at most 1000)

Cells are trimmed, normalized to Unicode NFC, stripped of control characters and capped (20000 characters; each field also has its contract length). Text cells that
start with `=`, `+`, `-` or `@` are rejected as `formula_injection` (spreadsheet formula injection); a rejected or oversized cell is blanked in the stored payload.
Error codes (sheet, Excel row, column, code, message): required_missing, cell_too_long, formula_injection, code_duplicate, code_exists, unknown_master, value_not_allowed,
not_a_number, not_a_boolean, value_out_of_range, orphan_row, unknown_member, panel_inconsistent, unknown_parameter_reference, formula_self_reference, formula_cycle,
formula_division_by_zero, formula_invalid, range_from_ge_to, range_overlap, normal_low_gt_high, critical_inside_normal, auto_approved_outside_normal,
default_range_duplicate, workbook_empty. The band, overlap and formula rules reuse the T0B-TESTMGMT-1 domain validators (rangeMatch, ranges.service, formulaGraph,
the shared formula parser). Gender `any` is kept as an any-sex band; critical limits 0 and 0 mean none.

## Commit errors

- `catalog.import_has_errors` (409): the batch was rejected; fix the file and validate again.
- `catalog.import_batch_expired` (409): older than 24 hours (also a database rule).
- `catalog.import_already_committed` (409): committed before; the same file and mode uploaded again returns that batch (idempotent per tenant, file hash and mode).
- `common.version_conflict` (409) / `common.precondition_required` (428): If-Match.
- `catalog.code_duplicate` (409): a code appeared in the catalog between validate and commit; nothing of the file is written.

## Known limits (open points)

- Instrument Code and Laboratory Code: instruments and branches live in other modules and no port exposes them to the catalog, so any value is refused as unknown_master
  until such a port exists; the dropdown lists are empty.
- Test categories must already exist (Category Name is checked against the masters, not created).
- `update` mode updates the test row in place (audited), adds new DRAFT analyte versions and draft range sets, and leaves existing panels unchanged.
