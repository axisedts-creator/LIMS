# C6-T26 impl
- Files: services/api/src/modules/reporting/delivery/adapters/email.smtp-relay.ts (new; only file).
- Protocol-level SMTP client on node:net/tls; no dependency, so CR-C6-019 SMTP pin not needed. API as tests assume: `smtpRelayTransport`, creds {host,port,from,security?,username?,password?,timeoutMs?}.
- Message: single-part text/plain, base64 body, RFC 2047 subject, Message-ID from deliveryId (returned as providerMessageId). No other content path.
- [CONV] Errors = TransportError(failureCode only): 4xx/network/timeout retryable; 5xx, bad creds/address/channel non-retryable. Codes: provider_temporary, provider_rejected, invalid_destination, auth_failed, tls_unavailable, tls_failed, timeout, network_error, invalid_config, invalid_message, unsupported_channel.
- [CONV] security default `starttls` (fail closed, no downgrade); `none` allowed only for loopback host (extra guard beyond tests).
- Checked: email-smtp.test.ts 31/31; tsc clean for this file; reporting suite 1821/1822, the 1 failure = random 10s hook timeouts under load, those files pass alone (195/195).
- Open: STARTTLS/TLS handshake path untested (sink cannot upgrade); eslint ignores this path (no config match).
