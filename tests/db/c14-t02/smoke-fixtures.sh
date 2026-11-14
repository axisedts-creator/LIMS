#!/usr/bin/env bash
# Debug hook for run.sh:  LIMS_C14T02_CMD="bash tests/db/c14-t02/smoke-fixtures.sh" bash tests/db/c14-t02/run.sh
# Applies fixtures.sql to the migrated database and prints row counts (proves the fixture is valid against the real DDL). Uses SUPER_PW / NAME / DB exported by run.sh.
set -euo pipefail
PSQL() { docker exec -i -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
PSQL -q -f - < tests/db/c14-t02/fixtures.sql
PSQL -c "SELECT (SELECT count(*) FROM smartreport.library_versions) lib, (SELECT count(*) FROM smartreport.template_blocks) blocks, (SELECT count(*) FROM smartreport.rules) rules,
  (SELECT count(*) FROM smartreport.analyte_groups) maps, (SELECT count(*) FROM smartreport.group_settings) groups, (SELECT count(*) FROM smartreport.wording_deny_terms) deny,
  (SELECT count(*) FROM smartreport.summaries) summaries, (SELECT count(*) FROM smartreport.summary_report_bindings) bindings, (SELECT count(*) FROM smartreport.summary_reviews) sreviews,
  (SELECT count(*) FROM smartreport.library_reviews) lreviews, (SELECT count(*) FROM smartreport.llm_runs) runs"
