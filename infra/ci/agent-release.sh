#!/usr/bin/env bash
# infra/ci/agent-release.sh [--dry-run] <version> - C7 bridge-agent release on ops-1 (02-TRD s7.11, CR-C7-012).
# Runs ONLY on the ops host (role agent_release; unit lims-agent-release.service). Steps, in order:
#   1 Authenticode-sign agent.exe inside bridge-agent-<version>-windows-amd64.zip (client certificate)
#   2 Ed25519-sign the raw SHA-256 bytes of the signed package (release key; stored base64url)
#   3 copy the signed zip into /srv/lims/agent-releases (rsync over wg0 to app-1 when APP_TARGET is set)
#   4 write the instruments.g_agent_releases seed (INSERT only: a published version is immutable)
#   5 deploy.yml applies the seed as lims_migrator through the one-shot `migrate` container (02-TRD s7.9)
# The release signing key and the Authenticode certificate are read here and nowhere else (AC-19.3, AC-31.2):
# only the signed zip + seed SQL leave this host; each read is noted in ops_audit (ids only, never content).
# Env (defaults below): LIMS_AGENT_RELEASE_ARTIFACT, _OUT, _SECRETS_DIR, _KEY_ID (required, <= 32 chars),
#   _APP_TARGET (optional rsync destination, `full` profile), _AUTHENTICODE_BIN (installed by the role).
# LD-45: no host name is pinned; lean runs ops and app roles on one host, so APP_TARGET is simply unset there.
set -euo pipefail
umask 077

KEY_ID_SECRET=instruments_release_signing_key
CERT_ID_SECRET=instruments_authenticode_cert
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$' # g_agent_releases__version__ck (C7 05-SCHEMA s2.18)
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

die() { echo "agent-release: $*" >&2; exit 1; }
usage() { echo "usage: agent-release.sh [--dry-run] <version>   (version = MAJOR.MINOR.PATCH)" >&2; exit 2; }

dry=0
if [[ ${1:-} == --dry-run ]]; then dry=1; shift; fi
[[ $# -eq 1 ]] || usage
version=$1
[[ $version =~ $VERSION_RE && $version != *[[:space:]]* ]] || die "invalid version (want MAJOR.MINOR.PATCH): refused"

zip_name="bridge-agent-${version}-windows-amd64.zip"
artifact=${LIMS_AGENT_RELEASE_ARTIFACT:-/srv/lims/agent-build/$zip_name}
out=${LIMS_AGENT_RELEASE_OUT:-/srv/lims/agent-releases}
secrets_dir=${LIMS_AGENT_RELEASE_SECRETS_DIR:-/run/lims/secrets/release}
app_target=${LIMS_AGENT_RELEASE_APP_TARGET:-}

[[ -f $artifact ]] || die "artefact not found: $artifact (CI build, C7 02-TRD s5.11)"

if ((dry)); then
  cat <<EOF
dry run: $zip_name (no secret read, nothing written)
  1. authenticode: sign agent.exe in the package with the client certificate ($CERT_ID_SECRET)
  2. ed25519: sign the raw SHA-256 bytes of the signed package with the release key ($KEY_ID_SECRET), base64url
  3. copy the signed zip into $out (agent-releases mount source${app_target:+; rsync to the app host over wg0})
  4. write the instruments.g_agent_releases seed (INSERT only) next to the zip
  5. deploy.yml applies the seed as lims_migrator through the one-shot migrate container
EOF
  exit 0
fi

# ---- preflight: fail closed before anything is written
missing=()
for sid in "$KEY_ID_SECRET" "$CERT_ID_SECRET"; do
  [[ -s $secrets_dir/$sid ]] || missing+=("$sid")
done
((${#missing[@]} == 0)) || die "missing secret(s): ${missing[*]} (in $secrets_dir)"
key_id=${LIMS_AGENT_RELEASE_KEY_ID:-}
[[ $key_id =~ ^[A-Za-z0-9._-]{1,32}$ ]] || die "LIMS_AGENT_RELEASE_KEY_ID required (1-32 chars of A-Za-z0-9._-)"
sign_bin=${LIMS_AGENT_RELEASE_AUTHENTICODE_BIN:-}
[[ -x $sign_bin ]] || die "Authenticode tool not installed (role agent_release pin; CR .orchestra/cr/C1.T-34.md)"
final="$out/$zip_name"
seed="$out/$version.seed.sql"
if [[ -e $final || -e $seed ]]; then die "release $version already exists in $out: a published version is immutable"; fi
for t in unzip zip openssl base64 sha256sum; do command -v "$t" >/dev/null || die "$t not installed"; done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# ---- audit: key and certificate are read now (ids only; 02-TRD s8.4)
"$SELF_DIR/ops-note.sh" "agent-release $version read instruments_release_signing_key and instruments_authenticode_cert on this host" >/dev/null

# ---- 1 Authenticode
authenticode_sign() { # <exe in> <exe out> <cert file>
  # Tool CLI and certificate format are not fixed by the spec: blocked on CR .orchestra/cr/C1.T-34.md.
  die "Authenticode signing invocation pending (CR .orchestra/cr/C1.T-34.md)"
}
mkdir "$work/pkg"
unzip -q "$artifact" -d "$work/pkg"
[[ -f $work/pkg/agent.exe ]] || die "agent.exe missing in the package"
authenticode_sign "$work/pkg/agent.exe" "$work/agent.signed.exe" "$secrets_dir/$CERT_ID_SECRET"
mv "$work/agent.signed.exe" "$work/pkg/agent.exe"
publisher=$(openssl x509 -in "$secrets_dir/$CERT_ID_SECRET" -noout -subject -nameopt multiline 2>/dev/null |
  sed -n 's/^ *commonName *= *//p' | head -n1)
[[ -n $publisher && ${#publisher} -le 200 && $publisher != *"'"* ]] || die "certificate subject CN unusable"
(cd "$work/pkg" && zip -q -X -r "$work/$zip_name" .)

# ---- 2 Ed25519 over the raw SHA-256 bytes of the package
digest_hex=$(sha256sum "$work/$zip_name" | cut -d' ' -f1)
openssl dgst -sha256 -binary "$work/$zip_name" >"$work/digest.bin"
openssl pkeyutl -sign -rawin -inkey "$secrets_dir/$KEY_ID_SECRET" -in "$work/digest.bin" -out "$work/sig.bin" ||
  die "Ed25519 signing failed"
signature=$(base64 -w0 <"$work/sig.bin" | tr '+/' '-_' | tr -d '=')
size=$(wc -c <"$work/$zip_name" | tr -d ' ')

# ---- 4 seed (INSERT only; ON CONFLICT DO NOTHING keeps a re-run harmless, never DO UPDATE)
cat >"$work/$version.seed.sql" <<SQL
INSERT INTO instruments.g_agent_releases
  (id, version, channel, package_file_name, package_sha256, package_size, signature, key_id,
   authenticode_publisher, released_at, is_active, created_at)
VALUES
  (gen_random_uuid(), '$version', 'stable', '$zip_name', '$digest_hex', $size, '$signature', '$key_id',
   '$publisher', now(), true, now())
ON CONFLICT (version) DO NOTHING;
SQL

# ---- 3 copy (no key or certificate ever travels: only the zip and the seed)
if [[ -n $app_target ]]; then
  rsync -a --ignore-existing "$work/$zip_name" "$work/$version.seed.sql" "$app_target"
fi
install -d -m 0755 "$out"
install -m 0644 "$work/$zip_name" "$final"
install -m 0644 "$work/$version.seed.sql" "$seed"
"$SELF_DIR/ops-note.sh" "agent-release $version published sha256=$digest_hex key_id=$key_id" >/dev/null
echo "agent-release: $zip_name signed and staged; deploy.yml applies the g_agent_releases seed via migrate"
