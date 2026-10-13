#!/usr/bin/env bash
# Build the demo from the exported CSVs: no synthetic-data generation, no
# taxonomy bootstrap. About 2 minutes, two tiny model calls (the preflight).
#
# Usage, from anywhere:
#   demo/setup_from_export.sh [connection_name]
#
# Uses your default Snowflake CLI connection if no name is given. Runs as the
# connection's role (SYSADMIN is the expected one). Run demo/admin_setup.sql as
# ACCOUNTADMIN once first in a new account.
#
# Rerunnable: it rebuilds the pipeline objects and reloads the data, which
# clears every run, eval and promotion made since.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONN=()
if [[ $# -ge 1 && -n "$1" ]]; then CONN=(-c "$1"); fi

# Every statement after the database exists runs on the demo warehouse, so
# the build does not depend on the connection's default warehouse.
WH=(--warehouse PAN_DEMO_WH)

step() { printf '\n=== %s ===\n' "$1"; }

command -v snow >/dev/null || { echo "Snowflake CLI (snow) not found on PATH"; exit 1; }

step "1/5 Database and warehouse"
snow sql "${CONN[@]}" -q "
CREATE DATABASE IF NOT EXISTS PAN_DEMO_DB;
CREATE WAREHOUSE IF NOT EXISTS PAN_DEMO_WH
  WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;
SELECT CURRENT_ROLE() AS role, CURRENT_USER() AS user_name;"

step "2/5 Preflight (models, grants)"
PREFLIGHT="$(snow sql "${CONN[@]}" "${WH[@]}" -f demo/preflight.sql)"
echo "$PREFLIGHT" | sed -n '/^+/,$p'
if echo "$PREFLIGHT" | grep -q '| FAIL '; then
  echo
  echo "Preflight failed. Fix the FAIL rows above (see demo/admin_setup.sql), then rerun."
  exit 1
fi

step "3/5 Pipeline objects (sql/00, 02-06; 01 is skipped)"
for f in sql/00_setup.sql sql/02_taxonomy.sql sql/03_pipeline.sql \
         sql/04_evaluation.sql sql/05_revision_loop.sql sql/06_app_support.sql; do
  echo "--- $f"
  snow sql "${CONN[@]}" "${WH[@]}" -f "$f" > /dev/null
done

step "4/5 Upload demo/data/*.csv"
# Same stage DDL as section 1 of import_demo_data.sql (it must exist before PUT).
snow sql "${CONN[@]}" "${WH[@]}" -q "
CREATE SCHEMA IF NOT EXISTS PAN_DEMO_DB.SYNTHETIC_DATA;
CREATE STAGE IF NOT EXISTS PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');
PUT 'file://$ROOT/demo/data/*.csv' @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE
  AUTO_COMPRESS = FALSE OVERWRITE = TRUE;" | sed -n '/PUT/,$p'

step "5/5 Load (demo/import_demo_data.sql)"
snow sql "${CONN[@]}" "${WH[@]}" -f demo/import_demo_data.sql | tail -n 12

cat <<'EOF'

Done. Expected in the last table: 1260 notes, 1000 encounters, 163, 200,
v001, 78 subthemes, 281 gold labels, champion haiku_enum_v1 on v001,
2 configs, 0 classifications, 0 evals, 1000 test-scenario rows.

Start the web app:
  cd webapp && npm install && npm run dev
then open http://localhost:3000 (see webapp/README.md for the demo script).
EOF
