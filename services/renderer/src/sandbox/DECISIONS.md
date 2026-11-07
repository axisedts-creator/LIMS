# PDF sandbox decisions — C6-T12 (02-TRD §5.2)

- Pinned: qpdf **12.4.2** (apt/source build in `Dockerfile.sandbox`), `@cantoo/pdf-lib` **2.11.1** (exact, `services/renderer/package.json`).
- **qpdf is invoked with an argument array (`execFile`), never through a shell.** File names are fixed (`in.pdf`, `out.pdf`,
  `part<N>.pdf`) inside a per-job directory under the `tmpfs` work dir, removed before the response is sent.
- qpdf exit codes (manual "Exit Status"): 0 ok, 2 error, 3 warnings. Anything other than 0 is a rejection (a repaired file is not trusted).
- Per-process timeout 30 s, per-call 60 s [CONV]; a killed qpdf → `timeout`.

## Options per sanitise step

> The option names below are written from the qpdf CLI reference as known to the writer; they were **not** re-read against the
> 12.4.2 manual on this host (no browser pass, qpdf not installed). Verify with `qpdf --help=all` in the image before release (open point).

| Step | Options | Outcome |
|---|---|---|
| 1 magic-byte check | none (done in the service: bytes 0–4 must be `%PDF-` at offset 0) | `not_pdf` |
| 3 encrypted | `--is-encrypted` (exit 0 = encrypted); fallback: `/Encrypt` in the bytes when step 2 fails | `encrypted` |
| 2 structural check | `--check` (exit ≠ 0, including 3 = warnings/recovered, is rejected) | `malformed` |
| 5 page count / pages ≤ 200 | `--show-npages` | `too_many_pages` |
| 4 rewrite whole file + linearise | `--linearize --object-streams=disable --stream-data=preserve in out` | `malformed` on failure |

Order of execution: 1, 3, 2, 5, 4 (encryption is tested before the structural check because a file with an unusable `/Encrypt`
dictionary fails `--check`). qpdf rewrites only the live objects, so superseded incremental revisions are dropped.
`--object-streams=disable` keeps a classic xref table (the test text extractor does not read object streams);
`--stream-data=preserve` leaves stream data as-is (no recompression, no decode).

After step 4 the output is parsed with `@cantoo/pdf-lib` and rejected (`malformed`) when any object uses a name in the deny
list: `/JavaScript /JS /Launch /EmbeddedFile /EmbeddedFiles /EF /RichMedia /OpenAction /URI /GoToR /GoToE /SubmitForm
/ImportData /Rendition /Movie /Sound` (07-SECURITY A12). Links (`/URI`) are rejected, not stripped, and never followed.
`main` parts in `assemble` (our own Chromium output) skip this scan; steps 1–5 still apply to every part.

## Assemble

`qpdf --empty --object-streams=disable --stream-data=preserve --pages <part files in order> -- merged.pdf`, then
`@cantoo/pdf-lib` stamps every page (Helvetica, ASCII only): `page_label_format` with `{n}`/`{m}` at the bottom right,
`NOT RELEASED` at the bottom left when `markers.not_released`. Saved with `useObjectStreams: false`. `markers.plain`
is accepted and has no effect (spec gives it no sandbox meaning).
