<# Starts every lane in its own window and its own git worktree, so lanes never touch the same files.
   Usage (from C:\LIMS):  powershell -ExecutionPolicy Bypass -File .orchestra\supervisor.ps1
   Edit the $Lanes table to add chunks when their wave opens (spec/program/01-CHUNK-MAP.md §1). #>
param([string]$Integration = "C:\LIMS", [string]$LanesRoot = "C:\LIMS-lanes", [string]$StateDir = "C:\LIMS-state", [switch]$NoPush)

# Lane name, chunk, task-id filter. C0's four workstreams own different paths (C0 02-TRD §1.1).
$Lanes = @(
  @{ name = "C0-0A"; chunk = "C0-foundation-contracts"; filter = '^(T0A-|SP-|T0-)' },
  @{ name = "C0-0B"; chunk = "C0-foundation-contracts"; filter = '^T0B-' },
  @{ name = "C0-0C"; chunk = "C0-foundation-contracts"; filter = '^T0C-' },
  @{ name = "C0-0D"; chunk = "C0-foundation-contracts"; filter = '^T0D-' },
  @{ name = "C1";    chunk = "C1-infrastructure-ops";   filter = '.*' }
  # Wave 1, add once C0 contracts are merged:  @{ name = "C2"; chunk = "C2-identity-admin"; filter = '.*' }, C3, C4, C5, C6
)

Set-Location $Integration
if ((git status --porcelain) ) { Write-Host "C:\LIMS has uncommitted changes. Commit them first (git add -A; git commit -m ...)."; exit 1 }
New-Item -ItemType Directory -Force -Path $LanesRoot, $StateDir | Out-Null
foreach ($l in $Lanes) {
  $wt = Join-Path $LanesRoot $l.name
  $br = "lane/$($l.name)"
  if (-not (Test-Path $wt)) {
    if (git branch --list $br) { git worktree add $wt $br } else { git worktree add $wt -b $br main }
  }
  $plist = @("-NoExit","-ExecutionPolicy","Bypass","-File","`"$Integration\.orchestra\lane-loop.ps1`"",
            "-Chunk",$l.chunk,"-Filter","`"$($l.filter)`"","-WorkDir","`"$wt`"","-Integration","`"$Integration`"","-StateDir","`"$StateDir`"")
  if ($NoPush) { $plist += "-NoPush" }
  Start-Process powershell -ArgumentList $plist
  Write-Host "started lane $($l.name) in $wt"
  Start-Sleep -Seconds 20   # stagger starts so only one lane runs the planner
}
Write-Host "All lanes started. Shared log: $StateDir\logs\<chunk>.log   Task list: $StateDir\tasks\<chunk>.json"
