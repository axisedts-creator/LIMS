#!/usr/bin/env bash
# eicar_probe.sh <container> - AC-28.1 (T-22), 07-SEC REQ-SEC-084, 02-TRD s7.4 (08 A25 D-209).
# Deploy-time probe: from INSIDE <container> (api-a in the runbook) speak clamd's zINSTREAM protocol to clamd and check
#   PING -> PONG | clean stream -> `stream: OK` | EICAR -> `... FOUND` | a stream of CLAMD_LIMIT_MB + 1 MiB is REFUSED
#   (`INSTREAM size limit exceeded`, i.e. StreamMaxLength 20M is really applied).
# Needs `node` in <container> (the C0 api/worker images are Node). The EICAR string is assembled at run time so this file is not
# itself an antivirus hit.  Env: CLAMD_ADDR (default clamd:3310), CLAMD_LIMIT_MB (default 20).
# Output TAP (probe_lib.sh), fail closed: stopped container, missing node, unreachable clamd or a wrong answer = not ok.
# Exit 0 all as expected, 1 mismatch, 2 usage.  T-22 tester deliverable; needs the running stack (static harness: test_t22_clamav.py).
set -u
C=${1:-}
[ -n "$C" ] || { echo "usage: eicar_probe.sh <container>" >&2; exit 2; }
ADDR=${CLAMD_ADDR:-clamd:3310}
LIMIT=${CLAMD_LIMIT_MB:-20}
case "$ADDR" in *:*) HOST=${ADDR%:*}; PORT=${ADDR##*:} ;; *) echo "CLAMD_ADDR must be host:port" >&2; exit 2 ;; esac
case "$PORT$LIMIT" in *[!0-9]* | "") echo "CLAMD_ADDR port and CLAMD_LIMIT_MB must be numeric" >&2; exit 2 ;; esac
# shellcheck source=probe_lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/probe_lib.sh"
need_running "$C"
need_tool "$C" node

read -r -d '' JS <<'EOF'
const net = require('net');
const [, host, port, mode, mb] = process.argv;
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');
let out = Buffer.alloc(0), done = false;
const finish = (msg) => {
  if (done) return;
  done = true;
  console.log(msg || out.toString().replace(/\0/g, '').trim());
  process.exit(0);
};
const s = net.connect(Number(port), host);
s.setTimeout(60000, () => { console.log('TIMEOUT'); process.exit(3); });
s.on('data', (d) => { out = Buffer.concat([out, d]); if (out.includes(0)) finish(); });
s.on('close', () => finish());
s.on('error', (e) => finish(out.length ? '' : 'CONNECTION ' + e.code));
s.on('connect', () => {
  if (mode === 'ping') { s.write('zPING\0'); return; }
  s.write('zINSTREAM\0');
  const send = (b) => { const h = Buffer.alloc(4); h.writeUInt32BE(b.length); s.write(h); s.write(b); };
  if (mode === 'eicar') send(Buffer.from(EICAR));
  else if (mode === 'clean') send(Buffer.from('synthetic lims upload, nothing to see'));
  else {
    const total = Number(mb) * 1024 * 1024 + 1, chunk = Buffer.alloc(1024 * 1024);
    for (let sent = 0; sent < total; sent += chunk.length) send(chunk.subarray(0, Math.min(chunk.length, total - sent)));
  }
  s.write(Buffer.alloc(4));
});
EOF

ask() { docker exec "$C" node -e "$JS" "$HOST" "$PORT" "$1" "$LIMIT" 2>/dev/null; }

r=$(ask ping)
[ "$r" = PONG ] && tap ok "clamd answers PING from $C" || tap fail "clamd answers PING from $C (got: ${r:-nothing})"
r=$(ask clean)
[ "$r" = "stream: OK" ] && tap ok "clean stream scans OK" || tap fail "clean stream scans OK (got: ${r:-nothing})"
r=$(ask eicar)
case "$r" in *FOUND) tap ok "EICAR reports FOUND ($r)" ;; *) tap fail "EICAR reports FOUND (got: ${r:-nothing})" ;; esac
r=$(ask big)
case "$r" in
  *"size limit exceeded"* | "CONNECTION EPIPE" | "CONNECTION ECONNRESET") tap ok "stream above ${LIMIT}M is refused ($r)" ;;
  *) tap fail "stream above ${LIMIT}M is refused (got: ${r:-nothing})" ;;
esac
finish
