# C6-T26 tests (email SMTP-relay, link-only; AC-08.5)
- Files: services/api/src/modules/reporting/__tests__/email-smtp.test.ts + email-smtp.helpers.ts (in-process dev SMTP sink on node:net/tls; no dependency; self-signed cert built in memory per run, nothing committed).
- Run: `.orchestra/notes/C6-T26-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/reporting/__tests__/email-smtp.test.ts`).
- ASSUMED API: `export const smtpRelayTransport: Transport` (providerKind `email_smtp_relay`); creds `{host, port, from, security:'none'|'starttls'|'tls' (default starttls), username?, password?, timeoutMs?, ca?}`; `ca` = PEM dev/test trust anchor passed through to TLS options.
- Covers: one RCPT/link text/plain, no attachment (runtime + static), unicode, dot-stuffing, AUTH, TLS fail-closed default, 4xx/timeout/refused retryable, 5xx/535 non-retryable, no leak in errors, injection, wrong channel, no env/console in source.
- Review round (item 3) adds: real STARTTLS upgrade (AUTH only after upgrade), implicit TLS, untrusted cert (no `ca`) => non-retryable `tls_failed`, nothing sent.
- Now: 32/34 pass vs the hand-rolled adapter; the 2 positive TLS tests fail (adapter ignores `ca`). Review items 1-2 (nodemailer 10.3.1 / CR) are impl-side, untouched here.
