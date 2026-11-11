# Runbook: catalog alerts

The alerts are registered by C1 (platform). This page tells the operator what to do.

## Import stuck
An import has stayed in uploaded, scanning, validating or committing for too long.
1. Check worker queue `catalog.import_*` for the import id.
2. Check dead letters for failed tasks of that import.
3. Re-enqueue the task. Re-enqueue is safe: tasks are idempotent.

## Import quarantined
The security scan flagged an uploaded file.
1. Follow the security incident procedure.
2. The file remains in `catalog.files` until purge, for forensics. Do not download it on a staff PC.
3. Tell the uploader to send a clean `.xlsx` file without macros.

## No price spike
Orders are being priced with no price found.
1. Run the health report (catalog home, Needs attention).
2. The usual cause is a newly published price list without fall-through. Switch Falls through on, or add the missing items and publish a new version.
3. Check the result in the price simulator.
