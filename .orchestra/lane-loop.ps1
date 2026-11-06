<# Runs one lane forever: run the orchestrator, then wait 10 minutes and try again.
   Always calls the run.ps1 in the integration repo, so a fixed script is picked up on the next try. #>
param([string]$Chunk, [string]$Filter, [string]$WorkDir, [string]$Integration, [string]$StateDir = "C:\LIMS-state", [int]$EveryMinutes = 10, [switch]$NoPush)
$host.UI.RawUI.WindowTitle = "LIMS lane $(Split-Path -Leaf $WorkDir) ($Chunk $Filter)"
while ($true) {
  $p = @("-ExecutionPolicy","Bypass","-File","$Integration\.orchestra\run.ps1","-Chunk",$Chunk,"-Filter",$Filter,"-WorkDir",$WorkDir,"-Integration",$Integration,"-StateDir",$StateDir)
  if ($NoPush) { $p += "-NoPush" }
  & powershell @p
  Write-Host "$(Get-Date -Format s) lane pass finished (exit $LASTEXITCODE). Next try in $EveryMinutes min. Close this window to stop the lane."
  Start-Sleep -Seconds ($EveryMinutes * 60)
}
