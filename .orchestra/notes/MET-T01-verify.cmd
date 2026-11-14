cd /d %~dp0..\..\apps\bridge-agent && go test -count=1 ./internal/drivers/ ./internal/mllp/ ./internal/simulator/ -run "Metis|SevenProfiles|TestEveryRegisteredCode|TestSessions"
