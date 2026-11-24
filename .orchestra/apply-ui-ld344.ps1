# 2026-11-17 lead (LD-344): founder review of the live site at 22:20 NPT. Shared UI polish, edited in the main working tree by the lead.
# Sidebar 14.5rem with names on one line and no group counts, shorter top search, web letters 10 percent smaller, one title style, no bold table headers.
# Backups of every original: C:\LIMS-state\backups\*.before-LD344-20261117b.bak
Set-Location C:\LIMS
$br = (git rev-parse --abbrev-ref HEAD).Trim()
if ($br -ne 'main') { Write-Host "STOP: C:\LIMS is on branch $br, not main. Nothing committed."; exit 1 }
# the queue merges lanes with git: wait until it lets go of the index
for ($i = 0; $i -lt 45 -and (Test-Path 'C:\LIMS\.git\index.lock'); $i++) { Start-Sleep -Seconds 2 }
# 2026-11-17 lead: a zero byte index.lock older than 15 minutes with no git.exe running is stale (it blocked every merge into main from 22:56 NPT). Move it aside, never delete it (same as the earlier index.lock.stale-* files).
$lk = Get-Item 'C:\LIMS\.git\index.lock' -ErrorAction SilentlyContinue
if ($lk -and $lk.Length -eq 0 -and $lk.LastWriteTime -lt (Get-Date).AddMinutes(-15) -and -not (Get-Process git -ErrorAction SilentlyContinue)) { Rename-Item $lk.FullName ('index.lock.stale-' + (Get-Date -Format 'yyyyMMddHHmm')); Write-Host 'stale index.lock moved aside' }
git add -- 'apps/web/src/core/shell/shell.css'
git add -- 'apps/web/src/core/shell/Rail.tsx'
git add -- 'apps/web/src/core/shell/GlobalSearch.tsx'
git add -- 'apps/web/src/core/shell/ShellFrame.tsx'
git add -- 'apps/web/src/core/i18n/messages.ts'
git add -- 'packages/ui/src/components/kit.css'
git add -- 'apps/web/src/features/frontdesk/components/frontdesk.css'
git add -- 'apps/web/src/core/shell/__tests__/m2.source.test.ts'
git add -- 'apps/web/src/core/shell/__tests__/r04.source.test.ts'
git add -- 'apps/web/src/core/shell/__tests__/r04.shell.test.tsx'
git add -- 'apps/web/src/core/shell/__tests__/m4.source.test.ts'
git diff --cached --stat
git commit -m 'web: sidebar and top search tidy, letters 10 percent smaller, one title style, lighter weights (LD-344, founder review 22:20 NPT)' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' -m 'Claude-Session: https://claude.ai/code/session_01UjY635U7Jui4KiEdLCq4Rj'
git log -1 --oneline
Write-Host ""
Write-Host "committed. Now the shell and kit tests (about 2 minutes). A red line below does not undo the commit; paste it to the lead."
$log = 'C:\LIMS-state\logs\ui-ld344-tests.log'
"" | Set-Content $log
pnpm --dir apps/web run build:nav *>> $log
pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.m2.config.ts *>> $log
pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.elabmenu.config.ts *>> $log
pnpm --dir apps/web exec vitest run --config src/core/shell/__tests__/vitest.density.config.ts *>> $log
pnpm --dir packages/ui exec vitest run *>> $log
Select-String -Path $log -Pattern 'Test Files|Tests |FAIL|AssertionError' | Select-Object -First 30 | ForEach-Object { $_.Line }
Write-Host "full log: $log"
