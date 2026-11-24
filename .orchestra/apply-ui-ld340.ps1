# 2026-11-17 lead (LD-340): commit the UI pass the founder asked for (sidebar and registration layout, ElabAssist menu names and grouping, Dashboard landing, profile menu with Sign out).
# Edited in the main working tree by the lead (founder permission, 2026-11-17 20:27 and 20:37 NPT). NOT test-run yet: task T0D-ELABMENU-1 (lane C0-0D) verifies and fixes after this commit.
# Backups of the originals: C:\LIMS-state\backups\*.before-LD340-20261117.*
Set-Location C:\LIMS
$br = (git rev-parse --abbrev-ref HEAD).Trim()
if ($br -ne 'main') { Write-Host "STOP: C:\LIMS is on branch $br, not main. Nothing committed."; exit 1 }
git add -- 'apps/web/src/core/i18n/messages.ts'
git add -- 'apps/web/src/core/nav/elab-menu.ts'
git add -- 'apps/web/src/core/shell/AppShell.tsx'
git add -- 'apps/web/src/core/shell/Rail.tsx'
git add -- 'apps/web/src/core/shell/NavIcon.tsx'
git add -- 'apps/web/src/core/shell/ShellFrame.tsx'
git add -- 'apps/web/src/core/shell/UserMenu.tsx'
git add -- 'apps/web/src/core/shell/shell.css'
git add -- 'apps/web/src/app/(staff)/layout.tsx'
git add -- 'apps/web/src/app/page.tsx'
git add -- 'apps/web/src/features/frontdesk/components/frontdesk.css'
git add -- 'apps/web/src/features/frontdesk/__tests__/regscreen1.layout.test.ts'
git add -- 'apps/web/src/app/(staff)/catalog/tests/page.tsx'
git diff --cached --stat
git commit -m 'web: ElabAssist sidebar names and grouping, Dashboard landing, profile menu with Sign out, compact sidebar and one-screen registration (LD-340)' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj'
git log -1 --oneline
Write-Host "committed. Task T0D-ELABMENU-1 verifies it when lane C0-0D starts it."
