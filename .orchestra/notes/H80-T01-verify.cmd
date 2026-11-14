cd /d "%~dp0..\..\apps\bridge-agent" && go test -count=1 ./internal/drivers/ ./internal/mllp/ ./internal/simulator/ -run "H80E|TestCodesAreExactlyTheSixProfiles|TestEveryRegisteredCode"
