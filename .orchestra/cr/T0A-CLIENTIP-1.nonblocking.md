Title: CR-C0-CLIENTIP-1: 02-TRD §6.4 / 08 A25 P-61 — X-Forwarded-For with a verified BFF key uses the leftmost entry (proxy appends, does not overwrite)
From chunk: C0 (lane C0-0A)   To owner: spec owner (02-TRD §6.4, 08-CR-REGISTER A25 P-61)
Type: bug (spec text)
Blocking? no (LD-296 already rules the behaviour; code shipped in T0A-CLIENTIP-1)
Problem: the spec text assumes a single-hop reverse proxy that OVERWRITES X-Forwarded-For, so the API accepts only one bare IP literal. On Render the hosting proxy APPENDS its peer (comma list), the API fell back to the TCP peer and identity.auth_events stored 127.0.0.1/32 (lead SELECT 2026-11-16 22:36 NPT).
Proposed change (exact text): "X-Forwarded-For is honoured only (a) with a verified X-Lims-Bff-Key: the LEFTMOST entry, when it is a bare IP literal (the web writes it; a hosting proxy may append), else the TCP peer; (b) from a TCP peer inside LIMS_CORE_TRUSTED_PROXY_CIDRS: a single bare IP literal only. Otherwise the TCP peer. The web BFF forwards the browser address (first x-forwarded-for entry, else x-real-ip, bare literal only) and the browser user agent (trimmed, max 512) on every API call."
Backward compatible? yes (single literal still accepted; no key -> unchanged).
Tenant/security impact: no RLS/PHI change. Spoofing still requires the BFF key; a junk leftmost falls back to the peer (no log forging).
Alternatives considered: rightmost-minus-N hop counting (depends on Render hop count, brittle); trusted CIDR for Render egress (not published/stable).
Tests that will prove it: services/api/src/core/auth/__tests__/client-ip.test.ts "LD-296" describe; post-deploy auth_events check by the lead.
