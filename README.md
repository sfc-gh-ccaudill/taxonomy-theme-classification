# PAN Lines Theme Extraction Pipeline

A Snowflake-native pipeline that classifies free-text post-discharge nurse call notes into a
controlled taxonomy of categories, themes and subthemes, and manages the taxonomy and prompts
behind it the way an ML model registry manages models: **register, evaluate, promote**.

Everything is ordinary Snowflake objects (tables, views, a dynamic table, a stream, a task and
stored procedures) using Cortex `AI_COMPLETE`. There is no external service to run.

## What it does

- **Classifies into the taxonomy, always.** The subtheme list is passed to `AI_COMPLETE` as an
  `enum` in the response schema, so every label the model returns is a valid subtheme. A
  `NO_GOOD_MATCH` option lets the model say "nothing fits", which becomes a signal for gaps in the
  taxonomy.
- **Versions the taxonomy.** Taxonomies are generated from a sample of notes, edited node by node
  as drafts, and locked before they can be evaluated.
- **Evaluates before it ships.** A config (prompt + model + taxonomy version) is scored on a gold
  set and compared to the config in production, overall and per segment. Promotion goes through
  a quality gate, with a logged override.
- **Runs incrementally.** A dynamic table, stream and task classify only new encounters, with
  measured credits and tokens per run.
- **Closes the loop.** Encounters the model couldn't place are reviewed as candidate gaps, and a
  model drafts the next taxonomy revision from them.

## Repository layout

```
sql/        The pipeline: 00, then 02 -> 06; 01 adds the demo data
  00_setup.sql            schema, input tables, classifier configs
  01_synthetic_data.sql   demo only: generates synthetic notes and a test answer key
  02_taxonomy.sql         taxonomy versions: propose, fork, edit, lock; gold labeling
  03_pipeline.sql         incremental prep, stream, task, classification
  04_evaluation.sql       scoring, quality gate, cost, register / evaluate / promote
  05_revision_loop.sql    gap review, revision proposals, regression alert
  06_app_support.sql      prompt preview and run status for the web app
demo/       Setup notebook, walkthrough notebook, reset scripts
  setup_notebook.ipynb    builds the account and deploys the web app, from a Snowsight Workspace
  setup_lib.py            the helpers the setup notebook calls
  admin_setup.sql         one-time ACCOUNTADMIN grants for a new account
  preflight.sql           checks models and grants before a build
  reset_webapp.sql        back to the web app's starting state
  reset_demo.sql          back to an unclassified corpus with no taxonomy
  pan_lines_walkthrough.ipynb  the classification step taken apart, one step at a time
webapp/     Next.js app that drives the whole flow; see webapp/README.md
  app.yml                 the app's deployment manifest, read by `snow app deploy` and the notebook
docs/       Design notes, measured results and the presentation deck
```

## Getting started

**Prerequisites:** a paid Snowflake account with Cortex AI functions (the build uses
`claude-haiku-4-5` and `openai-gpt-5.2`) and a role that can create a database, schema and
warehouse (SYSADMIN). The web app runs on Snowflake App Runtime, which isn't available on trial
accounts.

**0. One-time grants (new accounts).** As ACCOUNTADMIN, run `demo/admin_setup.sql`. It grants
SYSADMIN the three account-level privileges the build needs (`EXECUTE ALERT`, `EXECUTE TASK`, and
read access to `SNOWFLAKE.ACCOUNT_USAGE` for cost reporting), and has a commented line that enables
cross-region inference if a model isn't hosted in your region.

The build generates the synthetic notes, the first taxonomy and its gold labels with live model
calls (about 15 minutes with the web app, and a few credits). It ends where the web app demo
begins: taxonomy v001 in production, gold labeled, nothing classified yet. Run it from Snowsight
with the setup notebook, or from a terminal; both run the same files and procedure calls.

### From Snowsight (recommended)

Create a Workspace from this Git repository (Projects > Workspaces > From Git repository), open
`demo/setup_notebook.ipynb` and run it top to bottom with the SYSADMIN role. The workspace needs
an API integration for GitHub; if the account has none, an ACCOUNTADMIN runs this once in a
worksheet first (the same block is in `demo/admin_setup.sql`):

```sql
CREATE API INTEGRATION IF NOT EXISTS PAN_DEMO_GIT
  API_PROVIDER = git_https_api
  API_ALLOWED_PREFIXES = ('https://github.com/<owner>')
  ALLOWED_AUTHENTICATION_SECRETS = ALL
  ENABLED = TRUE;
GRANT USAGE ON INTEGRATION PAN_DEMO_GIT TO ROLE SYSADMIN;
```

For a private repository, choose "Personal access token" in the create-workspace dialog. The
notebook then:

1. creates `PAN_DEMO_DB` and `PAN_DEMO_WH`
2. runs `demo/preflight.sql`, which checks that both models answer and the grants are in place,
   and stops with the fix if not
3. builds the pipeline from `sql/00` and `02` to `06`
4. generates the demo data with `sql/01_synthetic_data.sql`, makes the bootstrap calls below,
   and runs `demo/reset_webapp.sql`
5. builds the web app in Snowflake and deploys it as an application service, then prints its URL

Each step runs the repository's own files unchanged, and every step can be rerun: step 4 keeps
notes and a taxonomy it already generated rather than paying for them again. The notebook also
works on a local Jupyter kernel with a Snowflake CLI connection.

### From a terminal

With the [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index) and a
connection for the SYSADMIN role. Create the database and warehouse:

```sql
CREATE DATABASE IF NOT EXISTS PAN_DEMO_DB;
CREATE WAREHOUSE IF NOT EXISTS PAN_DEMO_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60;
```

Check the account with `snow sql -c <connection> --warehouse PAN_DEMO_WH -f demo/preflight.sql`
(every row should say PASS), then build the pipeline and generate the data. `01` runs last
because its test-scenario scorecard view reads tables that `02` to `04` create:

```bash
for f in 00_setup 02_taxonomy 03_pipeline 04_evaluation 05_revision_loop 06_app_support \
         01_synthetic_data; do
  snow sql -c <connection> --warehouse PAN_DEMO_WH -f "sql/$f.sql" || break
done
```

To use a different database, schema or warehouse, see
[Changing names](docs/architecture.md#changing-names).

`01` generates the synthetic demo data (about 1000 model calls). To use your own notes, skip it
and load the three input tables instead; see
[Running on your own data](docs/architecture.md#running-on-your-own-data).

Then bootstrap a first production config. Generate a taxonomy, review it, and promote the first
config:

```sql
USE SCHEMA PAN_DEMO_DB.PIPELINE;
ALTER DYNAMIC TABLE ENCOUNTER_PREP REFRESH;                             -- pick up the new notes now
CALL PROPOSE_TAXONOMY('READMISSIONS', 'openai-gpt-5.2', 'your.name');   -- DRAFT v001
CALL LOCK_TAXONOMY('v001', 'your.name');
CALL REGISTER_CONFIG('haiku_enum_v1', 'default_rubric', NULL, NULL, NULL, 'v001', 'First release');
CALL EVALUATE_CONFIG('haiku_enum_v1', 'openai-gpt-5.2', FALSE);         -- labels the gold set first
CALL PROMOTE_CONFIG('haiku_enum_v1', 'your.name', NULL);
```

Each call returns a message; one that starts with `REFUSED` says what to fix. Finish with
`snow sql -c <connection> --warehouse PAN_DEMO_WH -f demo/reset_webapp.sql`, which clears that first evaluation and
promotion so the web app starts clean, and run the app locally (`cd webapp && npm install && npm
run dev`, open http://localhost:3000) or deploy it into Snowflake with `cd webapp && snow app
deploy`, which reads the app's manifest, `webapp/app.yml` (see
[Deploying into Snowflake](webapp/README.md#deploying-into-snowflake)). To classify the whole
corpus outside the app instead, `CALL CLASSIFY_BATCH('BACKLOG')`.

### Explore it

- **Web app:** `webapp/` walks through the whole flow in five pages, starting with the corpus
  before and after classification. See [webapp/README.md](webapp/README.md) for setup and a demo
  script.
- **Notebook:** `demo/pan_lines_walkthrough.ipynb` takes the classification step apart on a small
  sample, one step at a time.

Between demo run-throughs, reset with `demo/reset_webapp.sql` (production config and gold labels
kept, runs cleared) or `demo/reset_demo.sql` (back to an unclassified corpus with no taxonomy, to
regenerate it live). Neither makes model calls. Don't rerun `sql/01_synthetic_data.sql` to reset:
it regenerates the corpus and invalidates the gold labels.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the pipeline works: schemas, objects, the register/evaluate/promote lifecycle, the datasets, running on your own data |
| [docs/results.md](docs/results.md) | Measured accuracy, cost and gap-detection results, findings and known limitations |
| [docs/architecture_deck.html](docs/architecture_deck.html) | Presentation deck (open in a browser; speaker notes included) |
| [webapp/README.md](webapp/README.md) | Running the app, the demo script, page-by-page reference |

## Notes

- The demo notes are synthetic, generated in your account by `sql/01_synthetic_data.sql`, and
  contain no PHI. Cortex runs inside the Snowflake account.
- Model output varies slightly between runs, so measured numbers can move a point or so on a
  re-run. A new build also generates its own taxonomy v001, so its subtheme count and scores
  differ more than that from [docs/results.md](docs/results.md).

## Disclaimer

Copyright (c) 2026 Snowflake Inc. All rights reserved.

This is sample code provided for reference purposes only. It is not part of the Snowflake Service
and is not covered by Snowflake support or any warranties.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
