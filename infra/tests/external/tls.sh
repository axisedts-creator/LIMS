#!/usr/bin/env bash
# AC-02.1 / AC-02.2 (02-TRD s6.2, 04 I5) against the live public origins.
#   LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API [LIMS_ORIGIN_PARTNER]  host names (required)
#   LIMS_EDGE_ADDR   optional IP to connect to (SNI stays the origin name)
# Runs testssl.sh (report, saved under $LIMS_TLS_REPORT_DIR or /tmp) and asserts the
# numbers with openssl s_client. Exit 0 only when every origin passes.
set -euo pipefail

origins=()
for v in LIMS_ORIGIN_STAFF_WEB LIMS_ORIGIN_PORTAL LIMS_ORIGIN_API LIMS_ORIGIN_PARTNER; do
  [ -n "${!v:-}" ] && origins+=("${!v}")
done
[ "${#origins[@]}" -ge 3 ] || { echo "tls.sh: set LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_PORTAL, LIMS_ORIGIN_API" >&2; exit 2; }
TESTSSL="${TESTSSL:-$(command -v testssl.sh || command -v testssl || true)}"
[ -n "$TESTSSL" ] || { echo "tls.sh: testssl.sh not found (set TESTSSL)" >&2; exit 2; }
command -v openssl >/dev/null || { echo "tls.sh: openssl not found" >&2; exit 2; }

# TLS 1.2: exactly these may be accepted (TLSRef intermediate). With an ECDSA
# certificate only the ECDHE-ECDSA three can negotiate; the RSA three stay configured.
SIX="ECDHE-ECDSA-AES128-GCM-SHA256 ECDHE-RSA-AES128-GCM-SHA256 ECDHE-ECDSA-AES256-GCM-SHA384 ECDHE-RSA-AES256-GCM-SHA384 ECDHE-ECDSA-CHACHA20-POLY1305 ECDHE-RSA-CHACHA20-POLY1305"
ECDSA3="ECDHE-ECDSA-AES128-GCM-SHA256 ECDHE-ECDSA-AES256-GCM-SHA384 ECDHE-ECDSA-CHACHA20-POLY1305"
SUITES13="TLS_AES_128_GCM_SHA256 TLS_AES_256_GCM_SHA384 TLS_CHACHA20_POLY1305_SHA256"
MAX_DAYS=90
fail=0
bad() { echo "FAIL $1: $2"; fail=1; }

hs() {  # hs HOST ARGS... -> 0 when the handshake succeeds
  local h="$1"; shift
  echo | timeout 10 openssl s_client -connect "${LIMS_EDGE_ADDR:-$h}:443" -servername "$h" "$@" >/dev/null 2>&1
}

for h in "${origins[@]}"; do
  report="${LIMS_TLS_REPORT_DIR:-/tmp}/testssl-$h.json"
  "$TESTSSL" --quiet --color 0 --protocols --each-cipher --jsonfile "$report" --ip "${LIMS_EDGE_ADDR:-one}" "$h:443" >/dev/null 2>&1 \
    || bad "$h" "testssl.sh did not complete (report $report)"

  for p in -tls1 -tls1_1; do hs "$h" "$p" && bad "$h" "protocol ${p#-} offered"; done
  hs "$h" -tls1_2 -no_tls1_3 || bad "$h" "TLS 1.2 not offered"
  hs "$h" -tls1_3 || bad "$h" "TLS 1.3 not offered"

  accepted=""
  for c in $(openssl ciphers 'ALL:COMPLEMENTOFALL' | tr ':' ' '); do
    hs "$h" -tls1_2 -no_tls1_3 -cipher "$c" && accepted="$accepted $c"
  done
  for c in $accepted; do case " $SIX " in *" $c "*) ;; *) bad "$h" "TLS 1.2 suite $c accepted";; esac; done
  for c in $ECDSA3; do case " $accepted " in *" $c "*) ;; *) bad "$h" "TLS 1.2 suite $c refused";; esac; done

  for s in $SUITES13; do hs "$h" -tls1_3 -ciphersuites "$s" || bad "$h" "TLS 1.3 suite $s refused"; done
  for s in TLS_AES_128_CCM_SHA256 TLS_AES_128_CCM_8_SHA256; do hs "$h" -tls1_3 -ciphersuites "$s" && bad "$h" "TLS 1.3 suite $s accepted"; done

  # AC-02.2: leaf is ECDSA P-256 (secp256r1 / prime256v1) and valid <= 90 days.
  cert="$(echo | timeout 10 openssl s_client -connect "${LIMS_EDGE_ADDR:-$h}:443" -servername "$h" 2>/dev/null | openssl x509 2>/dev/null || true)"
  [ -n "$cert" ] || { bad "$h" "no certificate"; continue; }
  text="$(printf '%s\n' "$cert" | openssl x509 -noout -text)"
  printf '%s' "$text" | grep -q "id-ecPublicKey" || bad "$h" "leaf key is not ECDSA"
  printf '%s' "$text" | grep -Eq "prime256v1|P-256" || bad "$h" "leaf curve is not P-256"
  start="$(printf '%s\n' "$cert" | openssl x509 -noout -startdate | cut -d= -f2)"
  end="$(printf '%s\n' "$cert" | openssl x509 -noout -enddate | cut -d= -f2)"
  days=$(( ($(date -d "$end" +%s) - $(date -d "$start" +%s)) / 86400 ))
  [ "$days" -le "$MAX_DAYS" ] || bad "$h" "validity $days days > $MAX_DAYS"
  [ "$fail" -eq 0 ] && echo "ok   $h"
done
exit "$fail"
