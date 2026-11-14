APPROVE
Round 2 (diff 6da59635..befd4a9e). Task remains PENDING-CR on .orchestra/cr/C6-T26.md (C0-0D: add nodemailer 10.3.1 per CR-C6-019 / T0-03-dependencies.md:54); package.json untouched, as review 1 item 1 directed.
1. Item 1: done. nodemailer is absent from services/api and services/worker package.json, so a CR was written using the template. The interim hand-rolled client is clearly labelled at email.smtp-relay.ts:3-4, and the nodemailer rewrite is deferred until the CR lands.
2. Item 2: done. The invented comment is gone; the file now cites CR-C6-019 and T0-03-dependencies.md:54.
3. Item 3: done. `ca` is validated (line 33) and passed to tls.connect for STARTTLS (line 116) and implicit TLS (line 142). Tests 105/114/121 cover STARTTLS with AUTH after the upgrade, implicit TLS, and an untrusted cert giving non-retryable tls_failed with nothing sent.
Non-blocking, for the nodemailer rewrite: email.smtp-relay.ts:88 regex /CERT|TLS|SSL/ does not match UNABLE_TO_VERIFY_LEAF_SIGNATURE, so that cert failure is classified as a retryable network_error.
Checked OK: providerKind `email_smtp_relay` verbatim; failureCode-only errors (no PHI or relay text); no attachment path; no env access, logging or secrets; CRLF injection refused; owned paths only; no DB/RLS/permission surface.
Ran: `pnpm --dir services/api exec vitest run src/modules/reporting/__tests__/email-smtp.test.ts` → 34/34 pass; tsc shows no errors in the smtp files.
