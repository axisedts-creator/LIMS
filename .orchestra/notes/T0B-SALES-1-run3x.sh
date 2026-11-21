#!/usr/bin/env bash
# T0B-SALES-1: runs the verify three times, logs to notes/T0B-SALES-1-runN.log
cd "$(dirname "$0")/../.."
for i in 1 2 3; do
  bash tests/partners/T0B-SALES-1.pg.sh > ".orchestra/notes/T0B-SALES-1-run$i.log" 2>&1
  echo "run$i rc=$?"
  grep -E "Test Files|Tests " ".orchestra/notes/T0B-SALES-1-run$i.log" | tail -4
done
