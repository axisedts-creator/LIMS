# infra/ — C1 Infrastructure & Operations

C1 owns only this directory (02-TRD §1). It covers hosts, the Supabase and LIMS runtime, the edge, backups, monitoring, CI/CD and runbooks.

## Run the checks

```sh
bash infra/tests/run.sh      # TAP output; exit 0 = green
```

`run.sh` runs these checks:

- gitleaks over `infra/` (AC-05.2)
- yamllint over `infra/`
- ansible-lint over `infra/ansible/`, once that directory exists
- the static tests in `infra/tests/static/`: secrets-schema lint, `.sops.yaml` rules, the ops-tools register and the skeleton

`verify.yml` and the infra CI (02-TRD §12.4) use the same script.

These tools must be on PATH: `bash`, `python3`, `gitleaks`, `yamllint` and `ansible-lint`. A missing tool fails the run. Exception (LD-17): without `CI=true` a missing ansible-lint prints `SKIP ansible-lint (CI only)`; CI always runs it.

## Secrets boundary (REQ-SEC-128)

- **No secret values in this repository.** Encrypted env files (`dev|staging|prod.enc.yaml`) live in the separate private repo **`lims-secrets`**. That repo is a bare repo on ops-1, reached over SSH on wg0 (02-TRD §8.2).
- `secrets/schema/<env>.secrets.schema.yaml` lists the secret ids, owners, consumers, format rules and rotation. It holds names only, never values. CI checks that the decrypted file has exactly these ids.
- `secrets/.sops.yaml` holds the age **public** recipients, one rule per env. The current recipients are placeholders until the key ceremony. Private keys are never stored here.
- Secrets are rendered to tmpfs on the target hosts (`/run/lims/secrets/...`) by the role `secrets_render` (02-TRD §8.3).

## Topology profiles (LD-45, LD-48)

- **`prod-lean` is the default prod inventory** (`ansible/inventories/prod-lean/`): `prod-1` (site A, groups data + app + ops) and `backup-1` (site B, different provider, group `backup`). No hot standby.
- `full` = `ansible/inventories/prod/`, the 4-host topology of 02-TRD §3.1. Staging: `staging-lean/` (one VM) or `staging/`.
- Scale triggers and details: `ansible/inventories/DECISION.md`.

## Layout and where to look

- `THIRD-PARTY-OPS.md`: every ops tool, with version, licence, host and network reach (CR-C1-007 conditions).
- `ci/`: CI/CD steps (02-TRD §12). These are stubs until their owning tasks fill them in.
- `ansible/`, `compose/`, `edge/`, `database/`, `monitoring/`, `logging/` and the other directories: see the tree in 02-TRD §1 and the tasks in 06-IMPLEMENTATION-PLAN.
- `runbooks/`: one runbook per alert family, plus DR and IR (04-UI-UX §4).
