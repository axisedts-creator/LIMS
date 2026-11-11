# Bridge agent Windows-only tests (02-TRD §16 job c7-go-windows, CR-C7-013).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

go test -tags windows ./internal/secrets/... ./internal/svc/... ./internal/update/...
exit $LASTEXITCODE
