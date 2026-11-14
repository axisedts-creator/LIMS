# T0D-DEP-02 impl (writer)
- New apps/web/src/core/session/bff-key.ts: readBffKey(env = process.env). File wins; env fallback only when LIMS_CORE_ENV ∈ {dev, ci, staging} exact (LD-174); otherwise 'LIMS_WEB_BFF_KEY_FILE is not set'.
- c2.ts: keeps cachedKey, calls readBffKey(); node:fs import removed. actions.ts: only the bffKey block + its node:fs import swapped for readBffKey (cache kept).
- [CONV] LIMS_WEB_BFF_KEY="" (defined but empty) in dev/ci/staging throws 'LIMS_WEB_BFF_KEY is empty', not 'not set'.
- [CONV] No 'server-only' import in bff-key.ts (c2.ts has none either; keeps vitest loadable). Importers are server files only.
- Ran: DEP-02 config 24/24 pass; C2.T12 config (t12 admin-auth) 120/120 pass. tsc: 250 pre-existing errors, none in touched files.
- Open: worktree had no node_modules; ran `pnpm install --frozen-lockfile --ignore-scripts` to run tests.
