# Secrets runbook (`secrets`)

Owner C1. Rotation per secret id (02-TRD s8.5, 03-APP-FLOW s10, REQ-SEC-128). Ids and consumers: `infra/secrets/schema/<env>.secrets.schema.yaml`. Host names follow the active profile (`lean` or `full`, LD-45): "the data host" runs Postgres, "the app host" runs the LIMS containers; in `lean` both are the same VM.
Rules: one secret id per run. Never paste a value into a chat, ticket, shell history, `docker inspect` output or this repo. Values live only in the encrypted file of the env (`sops`) and, rendered, on tmpfs under `/run/lims/`. Every rotation leaves an `ops_audit` line (who, what, when; never the value). Do not rotate while a deploy, a restore drill or a patch run is in progress.

## Rotation
Defaults [CONV]: DB passwords 180 d, API and HMAC keys 365 d, on any suspected exposure immediately (see Suspected exposure).
Automated: `ansible-playbook -i inventories/<env>/hosts.yml playbooks/rotate-secret.yml -e secret_id=<id> -e secrets_render_enc_file=<path to <env>.enc.yaml> -e rotate_probe_base=<api base URL> -e '{"rotate_compose_env": {...}}'` (compose env = the dict the last deploy used: image digests, `APP_WG_IP`, `COMPOSE_PROFILES`).
| Secret id | How |
|---|---|
| `lims_api_password`, `lims_worker_password` | the playbook (DB passwords) |
| `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_KEYS`, `JWT_JWKS`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `lims_core_jwt_key` | by hand: JWT signing keys |
| `core_storage_service_key` | by hand: Storage signing key |
| `bff_key_staff_web`, `bff_key_partner`, `bff_key_portal` | by hand: BFF keys |
| `payments_kek` | by hand: Payments KEK |
| `pgbackrest_repo1_cipher_pass`, `pgbackrest_repo2_cipher_pass` | by hand: pgBackRest cipher pass |
| `wireguard_private_keys` | by hand: WireGuard keys |
| `luks_keyfiles` | by hand: LUKS keys |
The playbook refuses every other id before it changes anything and prints the anchor of this file to use.

## DB passwords
Ids: `lims_api_password` (role `lims_api`, consumers api-a, api-b), `lims_worker_password` (role `lims_worker`, consumers worker-a, plus worker-b only in `full`). Interval 180 d.
**Check first:** staging or dev first if this is the first run of a new release; no deploy running; `docker ps` shows api and worker healthy; the database answers (`db.md`).
**Run:** `rotate-secret.yml -e secret_id=lims_api_password ...` (see Rotation). The playbook does, in this order: ops_audit note; starts the synthetic load (`infra/tests/internal/rotation_load.py`, 300 s, `/v1/core/health/ready`); generates 48 random characters; `ALTER ROLE ... PASSWORD` (SQL on stdin, logging of the failing statement switched off); stores the value with `sops --set` and commits the encrypted file; renders the secrets to tmpfs; rolling restart: api-a is recreated and healthy before api-b is touched (one `up -d --no-deps --force-recreate --wait` per consumer; a plain `up -d` does nothing because only the secret file changed); waits for the load; ops_audit end note.
**Pass criterion (AC-19.2):** the load reports zero failed requests (exit 0, `"failed": 0`) over the 300 s. Any failed request fails the play.
**If it fails:** the rescue puts the old password back on the role, in the encrypted file, re-renders and recreates the consumers, writes an ops_audit note and exits non-zero. Read the note: `old value restored` means you are back where you started; `RESTORE FAILED` means the role may hold a password nobody has: set it by hand from the old value in the previous commit of the encrypted file, then render and recreate. Then file the cause.
**Known risk:** the old password stops working at `ALTER ROLE`; open pooled connections keep working, a NEW connection from a not-yet-recreated api before its restart can fail. Staging runs show whether the window is visible; if it is, ask for a lead ruling (dual-role switch) instead of retrying in prod.
**Close-out:** ops log line with id, env, load result; update `Last tested` under Dry run in staging.

## JWT signing keys
Ids: `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, `JWT_KEYS`, `JWT_JWKS`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `lims_core_jwt_key`. By hand; the C2/C0 owners sign off the order (02-TRD s8.5 item 3).
**Method: dual keys with an overlap, then remove.** Tokens already issued must keep verifying while new ones are signed with the new key.
1. Generate the new key material with the pinned upstream scripts (`add-new-auth-keys.sh` for the key set; the pinned snapshot is in `infra/compose/supabase/upstream/utils`). Keep the old key in the set: the verifier must accept both keys.
2. Put old + new into the encrypted file (`sops`), render (`site.yml` or the `secrets_render` role), recreate the auth and gateway services, then api-a and api-b one at a time (`up -d --no-deps --force-recreate --wait`). Signing now uses the new key; both keys verify.
3. Overlap: wait at least the longest token lifetime set by C2 (refresh tokens and sessions included). Check the auth error rate stays flat.
4. Remove the old key from the set, render, recreate again in the same rolling order.
5. `lims_core_jwt_key` (the core API's own key, C0): same overlap pattern, following the C0 runbook for its key id list.
**Escalate when:** users are logged out in bulk or the verifier rejects valid tokens after step 2: put the old key back as the signing key (step 2 reversed) and call the C2 owner.
**Close-out:** ops log line with each step and time; record the dry run below.

## Storage signing key
Id: `core_storage_service_key`. By hand. Rotating it invalidates all existing signed Storage URLs (REQ-SEC-035, 04 A14); no browser holds one (downloads stream through the API, 03-APP-FLOW s1), so only internal callers are affected: the C0 core storage adapter in api-a, api-b, worker-a (and worker-b in `full`).
1. Do it outside a report-generation peak; check `runtime.md` queue depth is low.
2. Which upstream key it carries (`SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`) is fixed by C0 SP-1 / T-05 (UNVERIFIED): rotate that upstream key with the JWT signing keys procedure first, then set the same value in `core_storage_service_key` in the encrypted file.
3. Render, then recreate api-a, api-b, worker-a (worker-b in `full`) one at a time with `up -d --no-deps --force-recreate --wait`.
4. Check: upload and download one synthetic file in staging (or a synthetic report in prod) and confirm the scanner and the report PDF flow still work.
**If it fails:** put the old value back in the encrypted file, render, recreate again; signed URLs created in between are lost either way.

## BFF keys
Ids: `bff_key_staff_web`, `bff_key_partner`, `bff_key_portal` (365 d). By hand with an overlap: the API reads every key listed in `LIMS_CORE_BFF_KEY_FILES`, so old + new are both accepted.
1. Add the new key as an extra file for the API (both old and new listed) and render; recreate api-a, then api-b.
2. Switch the matching web container (web, portal or partner) to the new key; render; recreate it.
3. After the overlap (one session lifetime), drop the old key from `LIMS_CORE_BFF_KEY_FILES`; render; recreate api-a, then api-b.
**Close-out:** ops log line; the C7 config-signing key follows the C7 runbook (overlap by key id), not this section.

## Payments KEK
Id: `payments_kek` (read-only mount in api and worker). Procedure (02-TRD s7.12, CR-C15-008): add the new KEK next to the old one; render and recreate consumers one at a time; set the new KEK active in the payments settings; run `payments.rewrap_credentials` and wait until it reports every credential rewrapped; only then remove the old KEK from the encrypted file, render and recreate again. Never remove the old KEK before the rewrap has finished: stored credentials become unreadable.

Each environment (dev, staging, prod) has its own distinct KEK; never copy a KEK from one environment to another. The KEK stays in the encrypted secrets file and the read-only mount only: it never enters the database, a backup of the database or a log (D-118).
**If the rewrap fails:** leave both KEKs in place, keep the old one active, and call the payments owner.

## pgBackRest cipher pass
Ids: `pgbackrest_repo1_cipher_pass`, `pgbackrest_repo2_cipher_pass`. The cipher pass of an existing repository cannot be changed. Rotation means a new repo (a new stanza or a new repository path) with the new pass and a new full backup; the old repo stays, with its old pass kept in the encrypted file, until its retention ends.
1. Generate the new pass; add it under a new id or path in the encrypted file; configure the new repo (`backup.md`).
2. Take a new full backup to the new repo and run `pgbackrest check` and `verify`.
3. Run a restore drill from the new repo (`drill.md`) before treating it as the recovery source.
4. Keep the old repo and its pass until retention ends; then delete both. Never delete the old pass earlier: old backups become unreadable.
Never weaken encryption, WAL archiving to site B, or the restore drill to save time (LD-45).

## WireGuard keys
Id: `wireguard_private_keys` (per host). Generate a new key pair on the host (the private key never leaves it), put the public key in `wg_peers` of `inventories/<env>/group_vars/all.yml`, run `site.yml` to update every peer, then check the tunnel (`wg show`, a Prometheus target up on the far side). Do one host at a time and keep a console or provider access open: a wrong key cuts the management path.

## LUKS keys
Id: `luks_keyfiles`. Add the new key BEFORE removing the old one so there is never a moment without a working key: `cryptsetup luksAddKey <device> <new keyfile>`, then test that the volume opens with the new keyfile (`cryptsetup open --test-passphrase --key-file <new keyfile> <device>`), update the encrypted file, and only then `cryptsetup luksRemoveKey <device> <old keyfile>`. Keep the LUKS header backup current (`host.md`). Unlock after reboot: `host.md`.

## Offboarding
When a person with access leaves, within 1 business day (REQ-SEC-140): remove the WireGuard peer, the Linux account, the Grafana user and the basic-auth entry (all through `site.yml`), and rotate every secret the person could decrypt (the schema lists consumers; the sops recipients list shows who could decrypt). Remove their key from the sops recipients and re-encrypt the file. Record each step in ops_audit.

## Suspected exposure
Rotate the exposed id immediately, do not wait for the next interval. Steps: 1. Tell the founder and open an incident (`incident-response.md`). 2. Rotate with the matching section above; for a database password use the playbook at once, even in peak hours (a failed rotation rolls back). 3. Treat anything derived from it as exposed too (the JWT family signs sessions; a Storage key signs downloads). 4. Search the logs for use of the old value (`security.md`). 5. Record the time of exposure, the time of rotation and the cause.

## Dry run in staging
Each manual procedure is rehearsed in staging before it is used in prod, and the DB password playbook is run in staging after any change to it. Record the result here; keep no values.
| Procedure | Date | Result |
|---|---|---|
| DB password (`lims_api_password`, AC-19.2 load) | not run | Last tested: never |
| JWT signing keys (dual-key overlap) | not run | Last tested: never |
| Storage signing key | not run | Last tested: never |
Staging dry runs are done by the operator on the staging environment; this table is filled in then. Until it is filled in, the JWT and Storage procedures are documented but unproven.
