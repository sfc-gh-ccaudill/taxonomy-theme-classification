# PAN Lines Theme Pipeline: web app

A five-page Next.js app over the Snowflake pipeline in `../sql`. It drives the real procedures and
reads the real views: there is no mock data, and all behavior lives in Snowflake.

**Start here:** `npm install && npm run dev`, then open http://localhost:3000.

---

## The five pages

The pages follow the order the work happens: data, then build a config (taxonomy and prompt), evaluate and promote,
run production, then monitor and revise, which loops back to page 2. It is the register, evaluate,
promote loop of an ML model registry, where the unit is a **config** (prompt + model + taxonomy
version) and exactly one config, the **champion**, runs in production.

| # | Page | What it does | Backed by |
|---|---|---|---|
| 1 | Explore Data | **Before classification:** note browser, the encounter rollup, gold-set and design-sample membership, and (badged as test data) how the synthetic notes were made challenging. **After classification:** the production output, i.e. the champion's current labels per encounter: totals, encounters by category (click to filter), top subthemes, and an encounter browser filterable by category, subtheme, confidence and multi-label, with each label's quoted evidence highlighted in the note | `NOTE_RAW`, `ENCOUNTER_PREP`, `GOLD_ENCOUNTER`, `DISCOVERY_SAMPLE`, `ENCOUNTER_THEME` + test data `SYNTHETIC_DATA.TEST_SCENARIO` |
| 2 | Config Builder | The taxonomy is the workspace: version tabs (hover for lineage, bound configs and notes), propose a whole taxonomy from the sample, fork, a node editor for drafts (add, edit, rename, delete), lock, reject, changes vs the parent and the enum contract. Below it, a collapsed prompt and model section, then save the combination as a new config, preview it on 5 encounters (writing nothing) and hand it to evaluation | `TAXONOMY_VERSION`, `TAXONOMY_NODE`, `TAXONOMY_RENDERED`, `PROPOSE_TAXONOMY()`, `FORK_TAXONOMY()`, `EDIT_TAXONOMY_NODE()`, `LOCK_TAXONOMY()`, `REJECT_TAXONOMY()`, `TAXONOMY_DIFF()`, `CLASSIFIER_CONFIG`, `REGISTER_CONFIG()`, `PREVIEW_PROMPT()` |
| 3 | Evaluate & Promote | Candidate leaderboard vs the champion; evaluate on gold (labels gold first for a new taxonomy); gate verdict and segment-by-segment comparison with the champion; promote, with a required reason if the gate failed; the promotion log | `EVALUATE_CONFIG()`, `EVAL_SCORECARD`, `EVAL_SEGMENT_DETAIL`, `EVAL_GATE`, `PROMOTE_CONFIG()`, `PROMOTION_LOG` |
| 4 | Run Production | The champion and its backlog; bounded or full production runs, live progress, labels with evidence, out-of-taxonomy count, credits; score a full production run on gold | `RUN_CLASSIFIER()`, `PIPELINE_RUN`, `CLASSIFICATION`, `APP_RUN_STATUS`, `RUN_COST` |
| 5 | Monitor & Revise | Champion drift (its eval vs its previous eval), the gap queue from production output, propose a revision (lands as a DRAFT on page 2), reclassify flagged encounters, every eval, and (badged as test data) accuracy per test scenario | `EVAL_SCORECARD`, `EVAL_GATE`, `TAXONOMY_GAP_REVIEW`, `PROPOSE_TAXONOMY_REVISION()` + test data `SYNTHETIC_DATA.TEST_SCENARIO_SCORECARD` |

Every page names the SQL objects behind it, so it's easy to see what each panel reads and calls.

Everything the app scores, gates or acts on comes from the `PIPELINE` schema, so it behaves the
same on real data. The one exception is labeled: panels with an amber "Test data only" marker read
two views in `SYNTHETIC_DATA` to show how the synthetic notes were made challenging (similar
subthemes, concepts left out of the taxonomy, ambiguous notes) and how each kind scored. Real
notes don't have those tags, so nothing in the pipeline reads them.

---

## Two rules the code enforces

1. **No SQL in components.** Every statement lives in `lib/queries.ts` as a named entry. A page
   asks for `leaderboard`, never a string. That file is the complete list of what the UI can read
   and do.
2. **No business logic in TypeScript.** All writes go through `POST /api/action`, which refuses
   anything outside the `procs` allowlist. The app never runs an `INSERT`, `UPDATE` or `DELETE`,
   so it cannot promote past the gate, run a candidate in production, or edit a locked taxonomy.
   An override reason it collects lands in the same `PROMOTION_LOG` a SQL user writes to. A bogus
   procedure name returns 400; a guardrail firing returns 409 and is shown as a message, not an
   error.

```
webapp/
  app/page.tsx              1 Explore Data (before / after classification toggle)
  app/_components/classified-view.tsx  the after-classification view over ENCOUNTER_THEME
  app/build/page.tsx        2 Config Builder (taxonomy workspace, prompt, save config)
  app/build/_components/taxonomy-editor.tsx  the searchable category > theme > subtheme editor
  app/evaluate/page.tsx     3 Evaluate & Promote
  app/run/page.tsx          4 Run Production
  app/monitor/page.tsx      5 Monitor & Revise
  app/api/action/route.ts    the only write endpoint (allowlisted)
  app/api/{corpus,notes,classified,taxonomy,runs,classifications,eval,configs}/route.ts
  components/eval-widgets.tsx  gate badge, segment comparison table (pages 3 and 5)
  lib/queries.ts            every SQL statement + the procedure allowlist
  lib/data.ts               query execution, timestamp normalization, refusal detection
  lib/constants.ts          schema (pipeline + test data), warehouse, models, run presets, actor name
  smoke.sh                  checks all pages and routes
```

---

## Prerequisites

- The pipeline built, in the starting state the demo script expects: a champion config whose
  taxonomy has gold labels. The root README's build (the setup notebook, or the SQL files and
  bootstrap calls from a terminal) ends there: `haiku_enum_v1` on v001, 200 gold encounters
  labeled, nothing run. After a run-through, `demo/reset_webapp.sql` gets you back to it.
- A [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/index) connection
  with a role that can use the pipeline schema and warehouse.
- Node 20+.

### Configuration

None is needed if your default CLI connection points at the demo account and the build uses the
default names. The app reads the connection from `~/.snowflake/connections.toml` (the same file
the CLI uses) and defaults to `PAN_DEMO_DB.PIPELINE` and `PAN_DEMO_WH`.

To override any of that, create `webapp/.env.local` (gitignored):

```bash
SNOWFLAKE_CONNECTION_NAME=<your connection name>   # default: the CLI's default connection
PAN_SCHEMA=PAN_DEMO_DB.PIPELINE
PAN_WAREHOUSE=PAN_DEMO_WH
PAN_TEST_DATA_SCHEMA=PAN_DEMO_DB.SYNTHETIC_DATA
```

Credentials never go in the app.

Then install and start:

```bash
npm install
npm run dev 2>&1 | tee /tmp/pan_dev.log
```

and open http://localhost:3000. The first load of each page compiles on demand and takes a few
seconds.

### Environment variables that override the connection

If `SNOWFLAKE_USER`, `SNOWFLAKE_PASSWORD` or `SNOWFLAKE_TOKEN` are set in your shell, they take
precedence over the TOML connection, and queries fail with `An account must be specified.` The
`dev` and `start` scripts unset all three:

```json
"dev": "env -u SNOWFLAKE_USER -u SNOWFLAKE_PASSWORD -u SNOWFLAKE_TOKEN next dev"
```

Use `npm run dev:raw` only if you want those variables to apply.

---

## Demo script

Roughly 15 minutes end to end, all live. Reset first with `demo/reset_webapp.sql`. The app records
every lock, reject and promotion as `demo-app` (`DEMO_USER` in `lib/constants.ts`); the promote
form lets you type a different name.

The numbers below come from the reference build in [docs/results.md](../docs/results.md). Setup
generates taxonomy v001 live, so a new build has its own subtheme count, category names and
scores. One test build had 66 subthemes, a 0.91 baseline and 5 unplaceable gold encounters
instead of 9. The planted gap holds in every build: the design sample has no transportation
notes, so v001 has no transportation subtheme and step 3's candidate still fills a real hole,
but how much it gains varies. Read your build's numbers off the screen.

1. **Explore Data.** 1260 note rows roll up to 1000 encounters, 200 of them gold, and a design
   sample of 163 notes the taxonomy was built from. Then the amber panel: how the synthetic notes
   were made challenging. This is test-data design; real notes don't carry these tags.
2. **Evaluate & Promote: make the baseline.** The champion `haiku_enum_v1` has no eval yet.
   Select it, **Evaluate on gold** (~30s, one gold run, ~1 credit). 0.830, PASS on absolute
   checks only, because there is nothing to compare against yet. Everything after this is gated
   against it.
3. **Config Builder: author a candidate.** v001 is APPROVED (78 subthemes in the reference
   build). **Show enum contract**: the subtheme list is an `enum`, so an out-of-taxonomy label is
   impossible. Then **Fork v001 to edit**. **Add subtheme** `Transportation Barrier To Care` under
   the access and social barriers category (in the reference build, Access Social And Financial
   Barriers > Home And Social Environment), then **Lock v002**. The save panel at the
   bottom suggests a name (e.g. `haiku_v002_1`); **Save config**. Optionally **Try it on 5
   encounters** (writes nothing), then **Continue to evaluation**.
4. **Evaluate & Promote: the payoff.** Select the candidate, **Evaluate on gold**. It labels gold
   for the new version first (~2-3 min, ~200 gpt-5.2 calls), then scores: about 0.885 vs 0.830,
   PASS. In the segment table, Access goes 0.750 to ~0.889 and its n grows (the formerly
   unplaceable encounters moved into it); `NO_GOOD_MATCH` goes from 9 to ~1. Nothing in
   production changed. **Promote to production**.
5. **Run Production.** The backlog is now all 1000: promotion resets it, by design.
   **Run 50** (~15s): zero out-of-taxonomy labels, measured credits. Select the run and **Score
   this run on gold**: refused, a 50-encounter run can't be scored without counting 150 gold
   encounters as wrong. Run all remaining if you want the full-corpus number (~55s, ~5 credits).
   Then **Explore Data > After classification** shows what the business sees: labels per
   encounter, the category mix, and each label's evidence highlighted in the note. Click a
   category bar or a subtheme to filter; MULTI-LABEL and LOW narrow it further.
6. **Evaluate & Promote: rollback.** Select `haiku_enum_v1` again. Its eval now FAILs against the
   new champion, naming the Access regression. The button wants a reason; type one and **Promote
   with override**. The promotion log shows both promotions and the override.
7. **Monitor & Revise.** **Re-evaluate the champion** to show drift: it is gated against its own
   previous eval. After a full production run the gap queue fills with `NO_GOOD_MATCH` / `LOW`
   encounters; **Propose revision** drafts the next version, which goes back to step 3.

A prompt-only candidate is the quicker path: in the Config Builder, start from `haiku_enum_v1` and
stay on v001, open **Prompt and model**, edit the rubric, save, evaluate. It reuses v001's gold
labels, so it costs one gold run.

Version IDs are the next number after the highest existing version, so after
`reset_webapp.sql` (which deletes everything after v001) the first fork is v002 again.

---

## Measured results

Accuracy, gate, gap-detection and cost numbers from the runs this demo script is based on are in
[docs/results.md](../docs/results.md).

---

## Reset

| Script | Use it when | Cost |
|---|---|---|
| `demo/reset_webapp.sql` | Between app run-throughs. Keeps v001 (APPROVED) and its gold labels, the champion `haiku_enum_v1` and the `default_rubric` template; clears runs, evals, promotions, later versions and other configs. | Free, seconds |
| `demo/reset_demo.sql` | For a from-scratch build, which regenerates the taxonomy live. Also drops gold labels and every config but the template, so there is no champion afterwards. | A taxonomy call + ~200 gold-labeling calls to recover |

Do not use `sql/01_synthetic_data.sql` to reset. It regenerates the whole corpus and overwrites
the pipeline's input tables, which invalidates the gold labels.

---

## Deploying into Snowflake

The project is a Snowflake App Runtime app: a Next.js app that runs inside Snowflake as an
`APPLICATION SERVICE`, next to the data. Everything about how it deploys is in one file,
[`app.yml`](app.yml), the app's manifest:

| Section | What it controls |
|---|---|
| `version: 2` | Tells the Snowflake CLI this file holds the deployment config. Without it every key below except the build phases is ignored |
| `name`, `database`, `schema`, `query_warehouse` | The service `PAN_DEMO_DB.APP.PAN_THEME_PIPELINE` and the warehouse its queries run on |
| `ignore` | What is not uploaded: dependencies, build output, `.env*` files, logs |
| `label`, `description`, `icon` | How the app appears in Snowsight |
| `auto_resume`, `auto_suspend_secs` | Suspend after an hour idle, resume on the next request |
| `install`, `build`, `run` | The `npm` commands Snowflake runs to build the app and start it |

The file was generated with `snow app setup` and then extended, so it follows the CLI's own
layout. It ends with commented examples of secrets and of separate dev and prod targets.

### With the Snowflake CLI

Needs Snowflake CLI 3.26 or later (`snow app deploy --help` lists `--target`) and the `APP`
schema (the notebook creates it; otherwise `CREATE SCHEMA IF NOT EXISTS PAN_DEMO_DB.APP;`).
From this folder:

```bash
snow app validate --connection <name>          # bundles the project, checks database and schema
snow app deploy --verbose --connection <name>  # upload, build in Snowflake, create or update
snow app open --connection <name>              # open the deployed app
snow app events --connection <name>            # live service logs
```

`snow app deploy` runs three phases:

1. **Upload.** Bundles this folder minus `ignore` and uploads it to a code stage in
   `PAN_DEMO_DB.APP`.
2. **Build.** Runs `install` and `build` from `app.yml` in a short-lived Snowflake container
   and stores the result as a new version in the artifact repository
   `PAN_DEMO_DB.APP.PAN_THEME_PIPELINE_REPO`. About 4 minutes.
3. **Apply.** `CREATE OR ALTER APPLICATION SERVICE` from the latest version, with the settings in
   `app.yml`. The URL stays the same across deploys.

Phase 3 is declarative: the service ends up matching `app.yml` exactly. A setting changed by hand
with `ALTER APPLICATION SERVICE ... SET` is reverted on the next deploy, so make lasting changes
in `app.yml`.

The deploying role needs `USAGE` on `PAN_DEMO_DB`, `PAN_DEMO_DB.APP` and `PAN_DEMO_WH`, plus
`CREATE APPLICATION SERVICE`, `CREATE ARTIFACT REPOSITORY` and `CREATE STAGE` on the `APP` schema.
A redeploy also needs ownership of the service. SYSADMIN, which creates the database, has all of
these.

### From a Snowsight Workspace (no CLI)

Step 5 of `demo/setup_notebook.ipynb` runs the same three phases as SQL, reading the ignore list
and service settings from the same `app.yml` (`upload_webapp`, `build_webapp` and
`deploy_webapp_service` in `demo/setup_lib.py`). It applies only the settings shown in the table
above; if `app.yml` gains secrets, external access integrations, scaling or targets, the notebook
stops and asks you to deploy with the CLI. Its build step calls the system function the CLI uses
(`SYSTEM$SPCS_TEST_BUILD_APP_ARTIFACT_REPO`), which isn't separately documented, so if the two
paths ever behave differently, trust the CLI.

Things to know about the deployed app:

- **It runs as the service's owning role.** Every user who opens the URL acts as that role
  (normally SYSADMIN). `lib/snowflake.ts` supports caller's rights via `{ callersRights: true }`,
  but no query in `lib/queries.ts` requests it. For a shared app you'll likely want caller's rights
  on the read paths so each user's grants apply; that is a per-query change plus caller grants on
  the app's owning role.
- **The actor name is a constant.** Locks, rejects and promotions are recorded as `DEMO_USER`
  (the promote form can override it). A deployed app should take it from the signed-in user.
- **`next.config.mjs` pins the workspace root.** Do not remove it, and do not add a lockfile in
  a parent directory of `webapp/`, or Turbopack re-roots the project and `/` starts 404ing.

---

## Verifying

```bash
./smoke.sh                     # all 5 pages, 10 API routes, allowlist rejection, log scan
npx tsc --noEmit               # npm run build skips type checking
npm test                       # vitest, template's example tests
```

`smoke.sh` expects the dev server on port 3000. It passes when every page and route returns 200,
a bogus procedure name returns 400, and the dev log has no compile errors. `tsc` reports errors
only in the template's own `__tests__/lib/snowflake.test.ts`, which predate this app.

---

## Known limitations

- **Long runs block their HTTP request.** `RUN_CLASSIFIER` and `EVALUATE_CONFIG` are called
  through `querySnowflakeLongRunning`, so a full-batch run or a first evaluation of a new taxonomy
  (gold labeling, a few minutes) holds the connection for the duration. The UI shows a stopwatch
  and polls `APP_RUN_STATUS` alongside it, which is enough at demo scale but is not a job queue.
  A production build would submit asynchronously and poll by `query_id` only. When the app runs
  as an application service, requests pass through the Snowflake endpoint, and holding one open
  for the few minutes a first evaluation takes has not been tested there. If the page reports a
  failure but the work continues, `APP_RUN_STATUS` and the evaluation list show the result once
  it lands.
- **Promotion takes several seconds.** `PROMOTE_CONFIG` reads `EVAL_GATE`, a view that recomputes
  every eval's verdict. Fine at this scale; materialize it if the eval history grows large.
- **Cost shows "pending" for a minute or two.** `RUN_COST` reads
  `SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY`, which lags slightly, so the app shows
  "pending" until the numbers arrive.
- **`verifiedOnly` will refuse until labels are reviewed.** `HUMAN_VERIFIED` is `FALSE` on every
  gold row because the gold set is labeled by a frontier model. Once an SME reviews labels and sets
  the flag, verified-only evaluation works.
- **No automatic retry.** Encounters whose call errored (usually the response schema rejecting a
  malformed label) get no labels and are shown as errors. They stay in the backlog, so the next
  BACKLOG run picks them up.
- **The run page caps at 200 labels** per view. The full result set lives in `CLASSIFICATION`.
- **Model picker is a fixed list** (`MODELS` in `lib/constants.ts`), not a live capability query.
  Models outside that list still work if you register the config through SQL.
