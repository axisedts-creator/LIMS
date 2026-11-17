#!/usr/bin/env bash
# oncall_sudo.sh: 07-SEC "privilege escalation: ops_oncall cannot run non-allowlisted sudo / decrypt prod secrets" (quarterly).
# Run as root on the host under test. Reads the ops_oncall sudo allowlist with `sudo -l -U`, then proves as that user (via
# `sudo -n -u`, never a password) that nothing broader than the allowlist works and that prod secrets cannot be decrypted.
# Env: ONCALL_USER (default ops_oncall), ONCALL_SOPS_FILE (optional: an encrypted prod file to try to decrypt).
# TAP; exit 0 ok, 1 failed, 2 usage (not root, user missing, sudo missing).
set -u
U=${ONCALL_USER:-ops_oncall}
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
command -v sudo >/dev/null || { echo "sudo missing" >&2; exit 2; }
id "$U" >/dev/null 2>&1 || { echo "user $U does not exist" >&2; exit 2; }
n=0; rc=0
tap() { n=$((n + 1)); if [ "$1" = ok ]; then echo "ok $n - $2"; else echo "not ok $n - $2"; rc=1; fi; }

list=$(sudo -l -U "$U" 2>/dev/null)
if [ -n "$list" ]; then tap ok "sudo -l -U $U readable"; else tap fail "sudo -l -U $U readable"; fi
# no blanket grant: `(ALL) ALL`, `NOPASSWD: ALL`, or a shell / editor / interpreter
if printf '%s\n' "$list" | grep -Eq '(\)|:)[[:space:]]*ALL[[:space:]]*$|/(ba|da|z)?sh([[:space:]]|,|$)|/(vi|vim|nano|python3?|perl)([[:space:]]|,|$)'; then
  tap fail "allowlist of $U contains ALL or a shell/editor/interpreter"
else
  tap ok "allowlist of $U has no blanket grant"
fi

# non-allowlisted commands must be refused (policy query `sudo -l -U`: never executes the command; LD-116)
for c in "/bin/bash -c true" "/usr/bin/id" "/bin/cat /etc/shadow" "/usr/bin/systemctl edit sshd"; do
  # shellcheck disable=SC2086
  if sudo -l -U "$U" $c >/dev/null 2>&1; then tap fail "$U may run '$c' through sudo"; else tap ok "$U cannot sudo '$c'"; fi
done

# prod secrets: the decrypt units are root-only and the oncall user holds no key
if sudo -l -U "$U" /usr/bin/systemctl start lims-prod-decrypt@v0.0.0.service >/dev/null 2>&1; then
  tap fail "$U may start lims-prod-decrypt@ (prod secrets decrypt)"
else
  tap ok "$U cannot start lims-prod-decrypt@"
fi
if sudo -n -u "$U" sh -c 'command -v sops >/dev/null && [ -n "${SOPS_AGE_KEY_FILE:-}" ]' >/dev/null 2>&1; then
  tap fail "$U has a sops key in its environment"
else
  tap ok "$U has no sops key in its environment"
fi
if [ -n "${ONCALL_SOPS_FILE:-}" ]; then
  if sudo -n -u "$U" sops -d "$ONCALL_SOPS_FILE" >/dev/null 2>&1; then tap fail "$U decrypted $ONCALL_SOPS_FILE"; else tap ok "$U cannot decrypt $ONCALL_SOPS_FILE"; fi
fi
echo "1..$n"
exit "$rc"
