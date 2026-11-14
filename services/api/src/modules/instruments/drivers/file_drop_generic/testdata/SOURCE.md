# file_drop_generic golden cases

All cases are **synthetic generic** (02-TRD §15.2). The `.raw` file is a tiny invented PDF-like placeholder, not a real report.
Agent metadata (barcode `E2600000042`, attachment code `HISTO-IMG`) arrives through `options` [CONV].

| Case | Covers |
|---|---|
| attachment-pdf | exactly one `attachment` record; barcode + analyte code from metadata; bytes never decoded |
