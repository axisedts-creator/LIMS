# One-off: release tasks blocked by the v4 bugs fixed in v4.1. Run once from C:\LIMS after copying kit v4.1.
$f = "C:\LIMS-state\tasks\C0-foundation-contracts.json"; $g = "C:\LIMS-state\tasks\C1-infrastructure-ops.json"
Remove-Item -Force "C:\LIMS-state\locks\lane-C0-0A.lock" -ErrorAction SilentlyContinue
function SetS($file, $map) { $t = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($k in $map.Keys) { $x = $t | Where-Object { $_.id -eq $k }; if ($x) { $x | Add-Member -Force status $map[$k]; $x | Add-Member -Force reviewRounds 0 } }
  $t | ConvertTo-Json -Depth 6 | Set-Content $file -Encoding UTF8 }
SetS $f @{ "SP-1"="changes"; "T0C-03"="changes"; "SP-2"="implemented"; "SP-3"="implemented"; "SP-5"="implemented" }
SetS $g @{ "T-01"="todo" }
Write-Host "released SP-1, T0C-03, SP-2, SP-3, SP-5, C1 T-01; removed stale C0-0A lock"
