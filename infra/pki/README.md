# Internal CA (ops network TLS)

02-TRD s8.2 / s3.3. One internal CA per environment issues the TLS certificates of
the ops-1 services reached over wg0: **ops nginx** (`<ops-1 wg IP>:443`) and the
**registry** (`<ops-1 wg IP>:5000`). Nothing public uses it.

| Item | Where | Lifetime |
|---|---|---|
| CA private key (secret id `internal_ca_key`) | secret store only: `lims-secrets/<env>.enc.yaml` (SOPS + age); on ops-1 only on tmpfs (`/run/lims/pki/ca.key`) while signing, removed right after | 5 years [CONV] |
| CA certificate (public) | ops-1 `/srv/lims/pki/ca.crt`; copied to hosts that pull from the registry | 5 years |
| Leaf key + certificate | ops-1 `/srv/lims/pki/<ops-nginx|registry>/{key,cert}.pem` (LUKS data volume) | 1 year, re-issued when < 30 days left |

No key, certificate or CSR is ever committed to this repository.

## Bootstrap (once per environment, on ops-1)
Run in an empty directory on tmpfs; the key goes straight into SOPS and is never
written to persistent disk:

```sh
cd "$(mktemp -d -p /run/lims)" && umask 077
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:secp384r1 -out ca.key
sops <env>.enc.yaml     # paste ca.key as the block-scalar value of internal_ca_key
shred -u ca.key
```

Then run `site.yml` (play "Monitoring core"): role `internal_ca` writes the key to
tmpfs, creates the self-signed CA certificate (`/srv/lims/pki/ca.crt`, 1825 days)
if missing, issues the ops nginx and registry leaf certificates (365 days,
`subjectAltName = IP:<ops-1 wg IP>`, EC prime256v1) and deletes the key from tmpfs
in an `always` step. Every automated decrypt writes an `ops_audit` line (s8.4).

## Rotation
- Leaf certificates: automatic on every `site.yml` run when < 30 days remain.
  Re-issued leaf names land in the fact `internal_ca_reissued`; role `monitoring`
  restarts `ops-nginx` when it is listed. The registry consumer (T-23) must do the
  same for `registry`, else it keeps serving the old certificate until it expires.
- CA (5 years, or on suspected exposure): generate a new key as above, replace
  `internal_ca_key` in the secret store, delete `/srv/lims/pki/ca.crt` and the leaf
  `cert.pem` files, re-run `site.yml`, redistribute `ca.crt` to registry clients.
  Record it with `infra/ci/ops-note.sh "rotated internal CA"`.
