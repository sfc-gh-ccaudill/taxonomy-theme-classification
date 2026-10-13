"""Setup helpers for the PAN Lines demo, used by demo/setup_notebook.ipynb.

Everything here runs the repository's own files rather than copies of them:
SQL files are uploaded to a stage and run with EXECUTE IMMEDIATE FROM, and the
bootstrap makes the same procedure calls the README lists, so the notebook and
a by-hand build from a terminal execute the same statements. Works in a Snowsight Workspace notebook (files are
read from the workspace by path) and on a local kernel with a CLI connection.

Object names match the rest of the repo: database PAN_DEMO_DB, warehouse
PAN_DEMO_WH. The web app is deployed into its own schema, PAN_DEMO_DB.APP, so
PIPELINE stays exactly what the SQL files create.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import time
from pathlib import Path

import yaml

DATABASE = "PAN_DEMO_DB"
WAREHOUSE = "PAN_DEMO_WH"
SETUP_STAGE = f"{DATABASE}.PUBLIC.SETUP_FILES"  # SQL files, run from here
PIPELINE = f"{DATABASE}.PIPELINE"

APP_SCHEMA = f"{DATABASE}.APP"
APP_NAME = "PAN_THEME_PIPELINE"
APP_CODE_STAGE = f"{APP_SCHEMA}.{APP_NAME}_CODE"
APP_REPO = f"{APP_SCHEMA}.{APP_NAME}_REPO"
APP_SERVICE = f"{APP_SCHEMA}.{APP_NAME}"

PIPELINE_FILES = [
    "sql/00_setup.sql",
    "sql/02_taxonomy.sql",
    "sql/03_pipeline.sql",
    "sql/04_evaluation.sql",
    "sql/05_revision_loop.sql",
    "sql/06_app_support.sql",
]
# Runs after the pipeline: its TEST_SCENARIO_SCORECARD view reads tables that
# 02-04 create.
DATA_FILE = "sql/01_synthetic_data.sql"

# The first production config, as the README bootstraps it.
SERVICE_LINE = "READMISSIONS"
LABELER_MODEL = "openai-gpt-5.2"  # drafts the taxonomy and labels the gold set
CHAMPION = "haiku_enum_v1"
TEMPLATE = "default_rubric"

# Service settings the notebook passes through from webapp/app.yml. Anything
# else there that changes the service (secrets, external access, scaling)
# needs `snow app deploy`.
APP_SPEC_KEYS = (
    "label",
    "description",
    "icon",
    "query_warehouse",
    "auto_resume",
    "auto_suspend_secs",
)
APP_CLI_ONLY_KEYS = (
    "secrets",
    "environment_variables",
    "external_access_integrations",
    "execute_as_role",
    "min_instances",
    "max_instances",
    "targets",
)


# --------------------------------------------------------------------------
# Session and paths
# --------------------------------------------------------------------------


def get_session():
    """The notebook's session in Snowsight; a CLI connection locally."""
    try:
        from snowflake.snowpark.context import get_active_session

        session = get_active_session()
        where = "Snowflake Workspace"
    except Exception:
        from snowflake.snowpark import Session

        name = os.getenv("SNOWFLAKE_CONNECTION_NAME")
        builder = (
            Session.builder.config("connection_name", name) if name else Session.builder
        )
        session = builder.create()
        where = f"local connection {name or '(default)'}"
    print(f"Connected via {where} as {session.get_current_role()}")
    return session


def repo_root(start: Path | None = None) -> Path:
    """The repository root: the nearest directory holding sql/ and demo/."""
    here = (start or Path.cwd()).resolve()
    for d in [here, *here.parents]:
        if (d / "sql" / "00_setup.sql").exists() and (d / "demo").is_dir():
            return d
    raise FileNotFoundError(
        "Could not find the repository root (a folder with sql/00_setup.sql). "
        "Open this notebook from the repository's demo/ folder."
    )


def _rows(session, sql: str, params: list | None = None):
    return session.sql(sql, params=params).collect()


# --------------------------------------------------------------------------
# Running the repo's SQL files
# --------------------------------------------------------------------------


def run_sql_file(session, root: Path, rel_path: str, stage: str = SETUP_STAGE):
    """Upload one SQL file and run it whole with EXECUTE IMMEDIATE FROM.

    Server-side execution keeps session variables, $$-quoted bodies and
    scripting blocks intact, which splitting the file client-side would not.
    Returns the rows of the file's last statement.
    """
    local = root / rel_path
    target = f"@{stage}/{Path(rel_path).parent.as_posix()}"
    session.file.put(str(local), target, auto_compress=False, overwrite=True)
    return _rows(session, f"EXECUTE IMMEDIATE FROM @{stage}/{rel_path}")


def create_database_and_warehouse(session):
    _rows(session, f"CREATE DATABASE IF NOT EXISTS {DATABASE}")
    _rows(
        session,
        f"""CREATE WAREHOUSE IF NOT EXISTS {WAREHOUSE}
        WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
        INITIALLY_SUSPENDED = TRUE""",
    )
    _rows(session, f"USE WAREHOUSE {WAREHOUSE}")
    # A small stage for the setup files themselves; PUBLIC exists in every database.
    _rows(
        session,
        f"CREATE STAGE IF NOT EXISTS {SETUP_STAGE} ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')",
    )
    print(f"{DATABASE} and {WAREHOUSE} ready")


def preflight(session, root: Path):
    """demo/preflight.sql: both models answer, grants are in place."""
    rows = run_sql_file(session, root, "demo/preflight.sql")
    failed = [r for r in rows if r["STATUS"] == "FAIL"]
    for r in rows:
        print(f"{r['STATUS']:8} {r['CHECK_NAME']:24} {r['DETAIL']}")
    if failed:
        raise RuntimeError(
            f"{len(failed)} preflight check(s) failed. Fix them (see demo/admin_setup.sql) "
            "and run this cell again."
        )
    return rows


def build_pipeline(session, root: Path):
    """sql/00 and 02-06. 01 (the synthetic data) runs next, in generate_demo_data."""
    for rel in PIPELINE_FILES:
        t0 = time.time()
        run_sql_file(session, root, rel)
        print(f"{rel:28} {time.time() - t0:5.1f}s")
    _rows(session, f"USE WAREHOUSE {WAREHOUSE}")


def generate_demo_data(session, root: Path, regenerate: bool = False) -> dict:
    """sql/01_synthetic_data.sql: the synthetic notes, design sample and gold set.

    About 1000 model calls. Skipped when NOTE_RAW already has notes, because
    regenerating overwrites the inputs and invalidates every gold label; pass
    regenerate=True to do it anyway.
    """
    notes = _rows(session, f"SELECT COUNT(*) FROM {PIPELINE}.NOTE_RAW")[0][0]
    if notes and not regenerate:
        print(
            f"NOTE_RAW already has {notes} notes; keeping them (regenerate=True to replace)"
        )
    else:
        t0 = time.time()
        run_sql_file(session, root, DATA_FILE)
        print(f"{DATA_FILE:28} {time.time() - t0:5.1f}s")
    _rows(session, f"USE WAREHOUSE {WAREHOUSE}")
    # Classification reads the dynamic table; don't wait out its target lag.
    _rows(session, f"ALTER DYNAMIC TABLE {PIPELINE}.ENCOUNTER_PREP REFRESH")
    row = _rows(
        session,
        f"""
        SELECT (SELECT COUNT(*) FROM {PIPELINE}.NOTE_RAW)         AS note_rows,
               (SELECT COUNT(*) FROM {PIPELINE}.ENCOUNTER_PREP)   AS encounters,
               (SELECT COUNT(*) FROM {PIPELINE}.DISCOVERY_SAMPLE) AS discovery_notes,
               (SELECT COUNT(*) FROM {PIPELINE}.GOLD_ENCOUNTER)   AS gold_encounters""",
    )[0]
    return row.as_dict()


def _call(session, proc: str, *args) -> str:
    """CALL a pipeline procedure with bound arguments; a REFUSED reply raises."""
    marks = ", ".join("?" for _ in args)
    t0 = time.time()
    msg = str(_rows(session, f"CALL {PIPELINE}.{proc}({marks})", list(args))[0][0])
    print(f"{proc:18} {time.time() - t0:5.1f}s  {msg}")
    if msg.startswith(("REFUSED", "GENERATION FAILED")):
        raise RuntimeError(f"{proc} did not complete: {msg}")
    return msg


def _bootstrapped(session) -> bool:
    """v001 and its champion exist with gold labels, whatever has been promoted
    since: demo/reset_webapp.sql puts them back in charge without model calls."""
    row = _rows(
        session,
        f"""
        SELECT (SELECT COUNT(*) FROM {PIPELINE}.CLASSIFIER_CONFIG
                 WHERE config_name = '{CHAMPION}' AND taxonomy_version_id = 'v001'),
               (SELECT COUNT(*) FROM {PIPELINE}.TAXONOMY_VERSION
                 WHERE version_id = 'v001' AND status IN ('APPROVED', 'SUPERSEDED')),
               (SELECT COUNT(*) FROM {PIPELINE}.GOLD_LABEL WHERE taxonomy_version_id = 'v001')""",
    )[0]
    return all(row)


def bootstrap(session, root: Path, rebuild: bool = False) -> dict:
    """The first production config, then demo/reset_webapp.sql for the warm start.

    Generates taxonomy v001 from the design sample, locks it, registers
    haiku_enum_v1 on it, evaluates it (which labels the gold set first) and
    promotes it: the README's bootstrap calls. Skipped when v001 is already in
    production with gold labels; pass rebuild=True to start over, which runs
    demo/reset_demo.sql first and repeats the model calls.
    """
    if _bootstrapped(session) and not rebuild:
        print(
            f"{CHAMPION} on v001 is already in production with gold labels; keeping it"
        )
    else:
        # PROPOSE_TAXONOMY numbers versions after the highest existing one, so
        # clear any half-finished attempt to get v001 again.
        run_sql_file(session, root, "demo/reset_demo.sql")
        user = session.get_current_user().strip('"').lower()
        draft = _call(session, "PROPOSE_TAXONOMY", SERVICE_LINE, LABELER_MODEL, user)
        version = re.search(r"DRAFT (v\d+)", draft).group(1)
        _call(session, "LOCK_TAXONOMY", version, user)
        _call(
            session,
            "REGISTER_CONFIG",
            CHAMPION,
            TEMPLATE,
            None,
            None,
            None,
            version,
            "First release",
        )
        _call(session, "EVALUATE_CONFIG", CHAMPION, LABELER_MODEL, False)
        _call(session, "PROMOTE_CONFIG", CHAMPION, user, None)
    run_sql_file(session, root, "demo/reset_webapp.sql")
    return verify_state(session)


# --------------------------------------------------------------------------
# Deploying the web app as a Snowflake App Runtime application service
# --------------------------------------------------------------------------
#
# The documented way to deploy is `snow app deploy` from webapp/, driven by
# webapp/app.yml. These functions run the same steps as SQL for a Snowsight
# Workspace, which has no CLI: upload the source to a stage, build it into an
# artifact repository, then create or update the application service from the
# built package. They read the ignore list and service settings from the same
# app.yml, so both paths deploy the same app. The build call is the system
# function the Snowflake CLI itself uses; it is not separately documented, so
# check the CLI's behaviour if a deploy here ever disagrees with it.


def load_app_manifest(root: Path) -> dict:
    """webapp/app.yml, checked against the names this module deploys to."""
    manifest = yaml.safe_load((root / "webapp" / "app.yml").read_text())
    where = (
        f"{manifest.get('database')}.{manifest.get('schema')}.{manifest.get('name')}"
    )
    if where.upper() != APP_SERVICE:
        raise ValueError(
            f"webapp/app.yml deploys to {where}, but this notebook deploys to "
            f"{APP_SERVICE}. Update APP_NAME/APP_SCHEMA in setup_lib.py to match."
        )
    cli_only = [k for k in APP_CLI_ONLY_KEYS if k in manifest]
    if cli_only:
        raise ValueError(
            f"webapp/app.yml sets {', '.join(cli_only)}, which this notebook does "
            "not apply. Deploy with `snow app deploy` from webapp/ instead."
        )
    return manifest


def _ignored(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def upload_webapp(session, root: Path) -> int:
    """Upload webapp/ to the app's code stage, minus app.yml's ignore list."""
    ignore = load_app_manifest(root).get("ignore") or []
    _rows(session, f"CREATE SCHEMA IF NOT EXISTS {APP_SCHEMA}")
    _rows(
        session,
        f"CREATE STAGE IF NOT EXISTS {APP_CODE_STAGE} ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE')",
    )
    # Clear old source so a deleted file does not survive into the next build.
    _rows(session, f"REMOVE @{APP_CODE_STAGE}")
    app_dir = root / "webapp"
    count = 0
    for dirpath, dirnames, filenames in os.walk(app_dir):
        dirnames[:] = [d for d in dirnames if not _ignored(d, ignore)]
        rel_dir = Path(dirpath).relative_to(app_dir).as_posix()
        target = f"@{APP_CODE_STAGE}" + ("" if rel_dir == "." else f"/{rel_dir}")
        for f in filenames:
            if _ignored(f, ignore):
                continue
            session.file.put(
                str(Path(dirpath) / f), target, auto_compress=False, overwrite=True
            )
            count += 1
    print(f"uploaded {count} web app files to @{APP_CODE_STAGE}")
    return count


def _service_status(session, job: str) -> str:
    try:
        rows = _rows(session, f"DESCRIBE SERVICE {job}")
    except Exception:
        return "IDLE"
    if not rows:
        return "IDLE"
    d = {k.lower(): v for k, v in rows[0].as_dict().items()}
    return str(d.get("status", "IDLE")).upper()


def build_webapp(session, timeout_s: int = 1800, poll_s: int = 15) -> str:
    """Build the uploaded source into the artifact repository. Returns the job name."""
    _rows(
        session,
        f"CREATE ARTIFACT REPOSITORY IF NOT EXISTS {APP_REPO} TYPE = APPLICATION",
    )
    # Run the build job in the app schema rather than the caller's personal
    # database, which some accounts restrict.
    config = json.dumps({"build_job_location": APP_SCHEMA})
    _rows(session, f"USE SCHEMA {APP_SCHEMA}")
    out = _rows(
        session,
        "SELECT SYSTEM$SPCS_TEST_BUILD_APP_ARTIFACT_REPO("
        f"'@{APP_CODE_STAGE}', '{APP_REPO}', '{APP_NAME}', '', '', '', '{config}')",
    )[0][0]
    m = re.search(r"Build job submitted:\s*(\S+)", out or "")
    if not m:
        raise RuntimeError(f"Build was not submitted: {out}")
    job = m.group(1)
    print(f"build job {job} submitted")

    t0 = time.time()
    status = ""
    while time.time() - t0 < timeout_s:
        status = _service_status(session, job)
        print(f"  {int(time.time() - t0):4d}s  {status}")
        if status == "DONE":
            return job
        if status in ("FAILED", "IDLE") and time.time() - t0 > 60:
            break
        time.sleep(poll_s)
    logs = build_logs(session, job)
    raise RuntimeError(f"Build ended {status or 'TIMEOUT'}. Last log lines:\n{logs}")


def build_logs(session, job: str, lines: int = 60) -> str:
    try:
        rows = _rows(session, f"SELECT * FROM TABLE({job}!SPCS_GET_LOGS())")
        text = [str(r.as_dict().get("LOG", r[-1])) for r in rows]
        return "\n".join(text[-lines:])
    except (
        Exception
    ) as e:  # logs are best effort; the status already says what happened
        return f"(could not read build logs: {e})"


def deploy_webapp_service(
    session, root: Path, timeout_s: int = 900, poll_s: int = 10
) -> str:
    """Create or update the application service from the latest build. Returns its URL."""
    manifest = load_app_manifest(root)
    spec = yaml.safe_dump(
        {k: manifest[k] for k in APP_SPEC_KEYS if k in manifest}, sort_keys=False
    ).strip()
    if "$$" in spec:
        raise ValueError("webapp/app.yml service settings must not contain '$$'.")
    _rows(
        session,
        f"""CREATE OR ALTER APPLICATION SERVICE {APP_SERVICE}
        FROM ARTIFACT REPOSITORY {APP_REPO} PACKAGE {APP_NAME}
        VERSION LATEST
        SPECIFICATION = $$
{spec}
$$""",
    )
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        rows = _rows(session, f"DESCRIBE APPLICATION SERVICE {APP_SERVICE}")
        d = {k.lower(): v for k, v in rows[0].as_dict().items()} if rows else {}
        url = str(d.get("url") or "").strip()
        upgrading = str(d.get("is_upgrading", "")).lower() in ("true", "1", "yes")
        status = str(d.get("status", "")).upper()
        print(
            f"  {int(time.time() - t0):4d}s  status={status or '?'} url={url or '(pending)'}"
        )
        if status == "FAILED":
            break
        if url and not upgrading and "provisioning" not in url.lower():
            return url if url.startswith("http") else f"https://{url}"
        time.sleep(poll_s)
    try:
        logs = _rows(
            session, f"CALL SYSTEM$GET_APPLICATION_SERVICE_LOGS('{APP_SERVICE}')"
        )
        logs = "\n".join(str(r[0]) for r in logs)[-4000:]
    except Exception as e:
        logs = f"(could not read service logs: {e})"
    raise RuntimeError(f"Application service did not become ready.\n{logs}")


def verify_state(session) -> dict:
    """The warm-start counts: v001 in production, gold labeled, nothing classified."""
    row = _rows(
        session,
        f"""
        SELECT (SELECT COUNT(*) FROM {DATABASE}.PIPELINE.NOTE_RAW)          AS note_rows,
               (SELECT COUNT(*) FROM {DATABASE}.PIPELINE.ENCOUNTER_PREP)    AS encounters,
               (SELECT COUNT(*) FROM {DATABASE}.PIPELINE.GOLD_LABEL)        AS gold_labels,
               (SELECT version_id  FROM {DATABASE}.PIPELINE.TAXONOMY_ACTIVE) AS active_taxonomy,
               (SELECT config_name FROM {DATABASE}.PIPELINE.ACTIVE_CONFIG)  AS champion,
               (SELECT COUNT(*) FROM {DATABASE}.PIPELINE.CLASSIFICATION)    AS classifications""",
    )[0]
    return row.as_dict()
