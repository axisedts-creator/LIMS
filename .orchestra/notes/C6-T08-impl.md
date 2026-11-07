# C6-T08 impl (writer)
Files: tasks/assemble_report.ts (new), cron.ts (new: sweep_assembly + crontab), index.ts (wires both, assemble max 10 / sweep 5), tasks/process_input_file.ts (only `export` on checkReply + METRIC, reused for instrument PDFs).
Tests: reporting dir 9 files / 222 pass (incl. the 3 T08 files, 70 tests). Full worker run: unrelated xlsx/core failures (not reporting; consumer+deadletter pass in isolation).
[CONV] only family `laboratory` assembled (builder is lab-only); others/cancelled just clear needs_assembly. Nominated-signatory ids and regeneration reason have no source yet → unset.
[CONV] template config read from `signatories.{mode,max}` (templates.ts) OR flat `signatoryMode/maxSignatories` (test fixture). Render job key `render:<version_id>`, payload {tenant_id, report_id, report_version_id}.
[CONV] sanitised instrument PDFs stored content-addressed at reporting-inputs/<tenant>/instrument-pdfs/<sha>.pdf; AssetRef.id = sanitized sha. Sandbox reject/hash mismatch → attachment omitted + metric; transport error → throw.
Review fix: smart port wrapped in SAVEPOINT smart_summary (RELEASE on success, ROLLBACK TO on any throw) since worker ctx.db.tx has no savepoint; port gets ctx. Reporting dir now 224 pass.
Open: narrative images not attached (ponytail comment); no sandbox timeout (index.ts sandbox still unwired until C6-T12); smart happy path untested; worker has no package.json/tsconfig in this lane so only ad-hoc tsc on my 3 files (clean).
