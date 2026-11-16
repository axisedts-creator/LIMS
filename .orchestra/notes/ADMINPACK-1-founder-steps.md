# ADMINPACK-1 founder steps (LD-254)

A pack change does NOT reach an existing tenant by itself. Changing `role-packs.data.yaml` only changes what a NEW tenant gets, or what the next apply gives.

After the deploy, run this against staging (a data step; the lanes do not run it):

    pnpm --filter @lims/api identity:apply-role-pack --tenant <tenant uuid> --pack elabcorp_default

(use `--pack elabassist_standard` for an ELabAssist tenant). The command is safe to re-run. Then make sure the administrator user is assigned the pack role (`corp_admin` or `std_admin`); the user keeps its old permissions until it holds the updated role and signs in again.

Heads-up: `services/api/package.json` has no `identity:apply-role-pack` script today (only `identity:bootstrap-platform-admin`). The CLI file exists: `services/api/src/modules/identity/cli/apply-role-pack.ts`. If the script name is missing at deploy time, the writer or lead must add the one-line script first.

What the administrator sees after this: all 13 tenant groups. Still hidden on purpose (decision, bench, money, platform): Verification, Approval, QC capture, Breakpoint sets, Report library, Report wording, Inventory bench, Engagement queue, and the platform group.
