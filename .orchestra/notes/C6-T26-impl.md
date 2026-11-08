# C6-T26 impl
- Files: services/api/src/modules/reporting/delivery/adapters/email.smtp-relay.ts (only file). API: `smtpRelayTransport`, creds {host,port,from,security?,username?,password?,timeoutMs?,ca?}.
- Review 1: nodemailer not in services/api|worker package.json, so wrote .orchestra/cr/C6-T26.md (To C0-0D: add nodemailer 10.3.1, apply CR-C6-019). Task PENDING-CR; package.json untouched.
- Interim: hand-rolled node:net/tls client kept so tests run; rewrite on nodemailer (createTransport secure/requireTLS/ignoreTLS, text-only sendMail, map err.responseCode/err.code) once the CR lands.
- Review 2: wrong "no SMTP library needed" comment replaced with CR-C6-019 + T0-03-dependencies.md:54 citation.
- Review 3: `ca` (PEM dev/test trust anchor) validated and passed to tls.connect for STARTTLS and implicit TLS; untrusted cert = non-retryable tls_failed.
- [CONV] Errors = TransportError(failureCode only); 4xx/network/timeout retryable, 5xx/auth/config non-retryable; default starttls, fail closed; 'none' loopback only.
- Checked: email-smtp.test.ts 34/34; tsc no errors in this file. Open: CR-C6-T26 (nodemailer); eslint does not cover this path.
