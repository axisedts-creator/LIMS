#!/usr/bin/env bash
# Developer shortcut (NOT the verify): only the regapi2 folder + the probes folder of src/modules/frontdesk against a throwaway PG17.
set -euo pipefail
export REGAPI2_SUITE="${REGAPI2_SUITE:-src/modules/frontdesk/__tests__/regapi2}"
bash tests/frontdesk/T0B-REGAPI-2.pg.sh
