# C6-T26 tests (email SMTP-relay, link-only; AC-08.5)
- Files: services/api/src/modules/reporting/__tests__/email-smtp.test.ts + email-smtp.helpers.ts (in-process node:net dev SMTP sink; no dependency).
- Run: `.orchestra/notes/C6-T26-verify.cmd` (= `pnpm --dir services/api exec vitest run src/modules/reporting/__tests__/email-smtp.test.ts`).
- Fail now: `delivery/adapters/email.smtp-relay.ts` missing (import error / static readFileSync ENOENT).
- ASSUMED API (not pinned by spec; writer matches or raises CR): `export const smtpRelayTransport: Transport` (providerKind `email_smtp_relay`); creds `{host, port, from, security:'none'|'starttls'|'tls' (default starttls), username?, password?, timeoutMs?}`.
- Covers: one RCPT/link text/plain, no attachment (runtime + static), unicode, dot-stuffing, line length, AUTH, TLS fail-closed default, 4xx/timeout/refused retryable, 5xx/535 non-retryable, no leak in errors, header/command injection, wrong channel, no env/console in source.
- Not covered: real TLS/STARTTLS handshake (sink cannot upgrade); SMTP client library is pending-cr CR-C6-019 (none installed, so adapter must be protocol-level on node:net/tls or the pin must land first).
