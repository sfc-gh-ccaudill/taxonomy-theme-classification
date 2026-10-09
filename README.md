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
sql/        The pipeline, run in order 00 -> 06
  00_setup.sql            schema, input tables, classifier configs
  01_synthetic_data.sql   demo only: generates synthetic notes and a test answer key
  02_taxonomy.sql         taxonomy versions: propose, fork, edit, lock; gold labeling
  03_pipeline.sql         incremental prep, stream, task, classification
  04_evaluation.sql       scoring, quality gate, cost, register / evaluate / promote
  05_revision_loop.sql    gap review, revision proposals, regression alert
  06_app_support.sql      prompt preview and run status for the web app
demo/       Walkthrough notebook and reset scripts
webapp/     Next.js app that drives the whole flow; see webapp/README.md
docs/       Design notes, measured results and the presentation deck
```

## Getting started

**Prerequisites:** a Snowflake account with Cortex AI functions (the build uses
`claude-haiku-4-5` and `openai-gpt-5.2`), a role that can create a database, schema and warehouse,
and the [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index).

**1. Build the pipeline.** Create the database and warehouse, then run the SQL files in order:

```sql
CREATE DATABASE IF NOT EXISTS PAN_DEMO_DB;
CREATE WAREHOUSE IF NOT EXISTS PAN_DEMO_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60;
```

```bash
for f in sql/0*.sql; do snow sql -c <connection> -f "$f"; done
```

To use a different database, schema or warehouse, see
[Changing names](docs/architecture.md#changing-names).

`01` generates the synthetic demo data (about a minute of model calls). To use your own notes,
skip it and load the three input tables instead; see
[Running on your own data](docs/architecture.md#running-on-your-own-data).

**2. Bootstrap a first production config.** Generate a taxonomy, review it, and promote the first
config:

```sql
CALL PROPOSE_TAXONOMY('READMISSIONS', 'openai-gpt-5.2', 'your.name');   -- DRAFT v001
CALL LOCK_TAXONOMY('v001', 'your.name');
CALL REGISTER_CONFIG('haiku_enum_v1', 'default_rubric', NULL, NULL, NULL, 'v001', 'First release');
CALL EVALUATE_CONFIG('haiku_enum_v1', 'openai-gpt-5.2', FALSE);
CALL PROMOTE_CONFIG('haiku_enum_v1', 'your.name', NULL);
CALL CLASSIFY_BATCH('BACKLOG');
```

**3. Explore it.** Either:

- **Web app:** `webapp/` walks through the whole flow in six pages. See
  [webapp/README.md](webapp/README.md) for setup and a demo script.
- **Notebook:** `demo/pan_lines_walkthrough.ipynb` takes the classification step apart on a small
  sample, one step at a time.

Between demo run-throughs, reset with `demo/reset_webapp.sql` (production config and gold labels
kept, runs cleared) or `demo/reset_demo.sql` (back to an unclassified corpus).

## Documentation

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | How the pipeline works: schemas, objects, the register/evaluate/promote lifecycle, the datasets, running on your own data |
| [docs/results.md](docs/results.md) | Measured accuracy, cost and gap-detection results, findings and known limitations |
| [docs/architecture_deck.html](docs/architecture_deck.html) | Presentation deck (open in a browser; speaker notes included) |
| [webapp/README.md](webapp/README.md) | Running the app, the demo script, page-by-page reference |

## Notes

- The included notes are synthetic and contain no PHI. Cortex runs inside the Snowflake account.
- Model output varies slightly between runs, so measured numbers can move a point or so on a
  re-run.
