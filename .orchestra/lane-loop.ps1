<# Runs one lane forever: run the orchestrator, then wait 2 minutes and try again.
   Always calls the run.ps1 in the integration repo, so a fixed script is picked up on the next try.
   -ExitWhenFinished : close when every task of this lane is done or blocked.
   -ExitWhenIdle     : close when nothing of this lane can run right now (waiting on other lanes); the queue starts the lane again when work is ready,
                       so an idle lane never holds one of the limited lane slots. #>
param([string]$Chunk, [string]$Filter, [string]$WorkDir, [string]$Integration, [string]$StateDir = "C:\LIMS-state", [int]$EveryMinutes = 2, [switch]$NoPush, [switch]$ExitWhenFinished, [switch]$ExitWhenIdle)
$host.UI.RawUI.WindowTitle = "LIMS lane $(Split-Path -Leaf $WorkDir) ($Chunk $Filter)"
$laneName = Split-Path -Leaf $WorkDir
while ($true) {
  $p = @("-ExecutionPolicy","Bypass","-File","$Integration\.orchestra\run.ps1","-Chunk",$Chunk,"-Filter",$Filter,"-WorkDir",$WorkDir,"-Integration",$Integration,"-StateDir",$StateDir)
  if ($NoPush) { $p += "-NoPush" }
  & powershell @p
  Write-Host "$(Get-Date -Format s) lane pass finished (exit $LASTEXITCODE). Next try in $EveryMinutes min. Close this window to stop the lane."
  if ($ExitWhenFinished -or $ExitWhenIdle) {
    $f = Join-Path $StateDir "tasks\$Chunk.json"
    if (Test-Path $f) {
      try {
        $j = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json; $t = @(); foreach ($x in $j) { $t += $x }   # flat list in Windows PowerShell 5.1 and 7
        $mine = @($t | Where-Object { $_.id -match $Filter -and $_.status -notin @('done','blocked') })
        if ($ExitWhenFinished -and $mine.Count -eq 0) { Write-Host "lane finished (all tasks done or blocked) - closing"; Start-Sleep 5; exit 0 }
        if ($ExitWhenIdle -and $mine.Count -gt 0) {
          # same pick rules as run.ps1: not owned by another lane once started, every dependency done
          $any = $false
          foreach ($c in $mine) {
            if ($c.lane -and $c.lane -ne $laneName -and $c.status -ne 'todo') { continue }
            $unmet = @(@($c.depends) | Where-Object { $_ } | Where-Object { $d = $_; @($t | Where-Object { $_.id -eq $d -and $_.status -ne 'done' }).Count -gt 0 })
            if ($unmet.Count -eq 0) { $any = $true; break }
          }
          if (-not $any) { Write-Host "$(Get-Date -Format s) nothing can run right now (waiting on other lanes) - closing; the queue restarts this lane when work is ready"; Start-Sleep 5; exit 0 }
        }
      } catch { }   # task file being rewritten: just try again next round
    }
  }
  Start-Sleep -Seconds ($EveryMinutes * 60)
}
