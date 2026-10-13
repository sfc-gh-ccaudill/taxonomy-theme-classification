# Architecture

How the pipeline is put together and how a taxonomy or prompt change goes from idea to
production.

- [Design principles](#design-principles)
- [Schemas](#schemas)
- [Objects and data flow](#objects-and-data-flow)
- [The lifecycle](#the-lifecycle-register-evaluate-promote)
- [Evaluation](#evaluation)
- [The demo datasets](#the-demo-datasets)
- [Running on your own data](#running-on-your-own-data)
- [Changing names](#changing-names)

## Design principles

**Labels are always valid.** The subtheme list is passed to `AI_COMPLETE` as an `enum` in the
`response_format` schema, so the model can only return a subtheme that exists in the taxonomy
version being used. Every run in this build has returned zero out-of-taxonomy labels, and there
is no post-processing step to map labels back to the taxonomy.

**"Nothing fits" is a first-class answer.** The enum includes a `NO_GOOD_MATCH` option. When the
model picks it, or labels with low confidence, the encounter becomes a candidate taxonomy gap.
Those candidates feed the revision loop in `05`.

**The model picks the subtheme; the rest is looked up.** Theme and category are derived from the
taxonomy, so a label's theme always matches its subtheme. The prompt still carries the full
`[CATEGORY] Theme > Subtheme: description` hierarchy and routing rules, so the model has the
context it needs for close calls, such as a post-operative symptom vs the general one.

**One config is the unit of change.** A classifier config bundles the prompt template, model and
taxonomy version. Configs are immutable, every label is stamped with the config that produced it,
and exactly one config (the **champion**) runs in production.

## Schemas

Two schemas in `PAN_DEMO_DB`:

```
SYNTHETIC_DATA   demo only: generates notes            PIPELINE   the pipeline itself
--------------                                         --------
SEED_CONCEPT  ─┐                                       inputs   NOTE_RAW           the notes
NOTE_SEED     ─┼─> 01_synthetic_data.sql ── writes ──>          DISCOVERY_SAMPLE   notes to design the taxonomy from
GEN_SPEC      ─┤                                                GOLD_ENCOUNTER     which encounters are gold
NOTE_GEN      ─┘                                       everything else in 00, 02-06

TEST_SCENARIO            <── reads outputs ──  EVAL_RUN, CLASSIFICATION, GOLD_LABEL
TEST_SCENARIO_SCORECARD      (demo panels only)
```

Nothing in `PIPELINE` reads `SYNTHETIC_DATA`. With your own data you skip `01` and load the three
input tables, and the pipeline runs the same way. The synthetic answer key stays in
`SYNTHETIC_DATA`; the pipeline's gold labels come from `LABEL_GOLD_SET`.

The two `TEST_SCENARIO` views read pipeline outputs to show how each kind of synthetic test case
scored (see [The demo datasets](#the-demo-datasets)). Real notes don't carry those tags, so the
pipeline itself never uses them.

**The deployed web app** lives in a third schema, `APP`: the built packages
(`PAN_THEME_PIPELINE_REPO` artifact repository) and the application service `PAN_THEME_PIPELINE`,
both as declared in `webapp/app.yml`, plus a code stage that holds the uploaded source during a
build (`snow app deploy` drops it once the build is done). It reads and calls `PIPELINE`
objects only, and dropping `APP` removes the app without touching the pipeline.

## Objects and data flow

```
NOTE_RAW                     source table, one row per note
  └─> ENCOUNTER_PREP         DYNAMIC TABLE: notes rolled up per encounter, incremental, no LLM
        └─> STREAM (ON DYNAMIC TABLE)
              └─> TASK (scheduled, WHEN SYSTEM$STREAM_HAS_DATA)
                    └─> CLASSIFY_BATCH() -> RUN_CLASSIFIER(champion)   one set-based AI_COMPLETE
                          ├─> CLASSIFICATION_RAW   exact model output, for audit
                          ├─> CLASSIFICATION       one row per label, stamped with config + version
                          └─> PIPELINE_RUN         run log: query_id for cost, PRODUCTION or EVALUATION

ENCOUNTER_THEME              the business-facing view: latest production labels per encounter
```

| File | What it creates |
|---|---|
| `00_setup.sql` | `PIPELINE` schema, the three input tables, `CLASSIFIER_CONFIG` and the `default_rubric` template |
| `01_synthetic_data.sql` | Demo only. `SYNTHETIC_DATA` schema, generated notes, and the two `TEST_SCENARIO` views |
| `02_taxonomy.sql` | `TAXONOMY_VERSION`, `TAXONOMY_NODE`, the lifecycle procedures, `TAXONOMY_RENDERED`, `TAXONOMY_DIFF`, `LABEL_GOLD_SET` |
| `03_pipeline.sql` | `ENCOUNTER_PREP`, the stream and task, `RUN_CLASSIFIER`, `CLASSIFY_BATCH`, `ENCOUNTER_THEME` |
| `04_evaluation.sql` | `RUN_EVAL`, `EVAL_SCORECARD`, `EVAL_SEGMENT_DETAIL`, `EVAL_GATE`, `RUN_COST`, `REGISTER_CONFIG`, `EVALUATE_CONFIG`, `PROMOTE_CONFIG`, `PROMOTION_LOG` |
| `05_revision_loop.sql` | `TAXONOMY_GAP_REVIEW`, `PROPOSE_TAXONOMY_REVISION`, the champion regression alert |
| `06_app_support.sql` | `PREVIEW_PROMPT` and `APP_RUN_STATUS`, used by the web app |

**Why classification is a task, not a dynamic table.** The rollup in `ENCOUNTER_PREP` is
deterministic, so a dynamic table suits it. Classification is stamped with the config that
produced it, so if it were a dynamic table joined to the champion, promoting a new config would
re-classify the whole corpus automatically. Splitting at the stream makes that a deliberate step:
after a promotion, `BACKLOG` (encounters with no production label from the champion) is the
whole corpus, and you choose when to run it.

## The lifecycle: register, evaluate, promote

```
AUTHOR    PROPOSE_TAXONOMY / FORK_TAXONOMY -> DRAFT -> EDIT_TAXONOMY_NODE -> LOCK_TAXONOMY -> LOCKED
REGISTER  REGISTER_CONFIG: prompt + model + taxonomy version = a candidate config
EVALUATE  EVALUATE_CONFIG: LABEL_GOLD_SET if needed -> GOLD run -> RUN_EVAL -> EVAL_GATE vs champion
PROMOTE   PROMOTE_CONFIG: gate PASS (or a logged override) -> champion + APPROVED taxonomy + PROMOTION_LOG
MONITOR   re-evaluate the champion (drift), TAXONOMY_GAP_REVIEW on production output -> next DRAFT
```

1. **Author a taxonomy.** A model proposes one from `DISCOVERY_SAMPLE`, or you fork an existing
   version. Either way it starts as a DRAFT that you edit node by node. Locking freezes it and
   checks for blank, reserved or duplicate labels. Drafts and locked versions never touch
   production.
2. **Register a config.** Pick a prompt template, model and taxonomy version. A new config can
   inherit anything it doesn't change from an existing one.
3. **Evaluate it.** `EVALUATE_CONFIG` classifies the gold encounters with exactly that config as an
   EVALUATION run, which never shows up in business output. If the taxonomy version has no gold
   labels yet, it creates them first. Then it scores the run and compares it to the champion.
4. **Promote it.** `PROMOTE_CONFIG` requires a passing gate or an override reason. In one
   transaction it makes the config the champion, marks its taxonomy APPROVED (the previous one
   becomes SUPERSEDED), and records the verdict and baseline in `PROMOTION_LOG`. Promoting an
   older config is a rollback and goes through the same gate.
5. **Run production.** The task wakes on a schedule, checks the stream, and runs the champion only
   when there are new encounters. Each batch is one set-based statement; Cortex handles the
   parallelism. `RUN_COST` reports measured credits and tokens per run.
6. **Monitor and revise.** Re-evaluating the champion compares it to its own previous evaluation,
   which is the drift check, and a daily alert watches for that failing. Production encounters
   marked `NO_GOOD_MATCH` or low confidence are reviewed as candidate gaps, and
   `PROPOSE_TAXONOMY_REVISION` drafts an add-only revision from them, which starts again at step 1.

## Evaluation

**Scoring.** `RUN_EVAL` scores a gold run on primary subtheme accuracy, theme accuracy and
label-set F1, overall and per segment. Segments are things you can derive from real data: the
category of the gold label, how many gold labels the encounter has, and note length.

**The gate.** `EVAL_GATE` compares an evaluation to the champion's latest one (with the same
verified-only setting). It passes when accuracy is above a floor, the error rate is below a
ceiling, and no segment with at least 20 encounters drops by more than 0.10. The thresholds live in
`EVAL_GATE_CONFIG` and can be changed.

**Gold labels.** Gold labels are created per taxonomy version by a frontier model from a
different family than the classifier (`openai-gpt-5.2` labeling, `claude-haiku-4-5` classifying),
one encounter at a time with the full taxonomy. Once a version has gold labels they aren't
regenerated, so every evaluation of that version uses the same answer key. A prompt-only candidate
reuses its taxonomy's labels. The `HUMAN_VERIFIED` column marks labels an SME has reviewed, and
evaluation can be limited to verified labels only.

## The demo datasets

The synthetic notes are generated from a seeded scenario spec, so the true label for every note is
known by construction. Scenario facts are kept consistent with the label (for example, a post-op
concept always has a procedure and is within 30 days of discharge), so the routing rules can be
applied from the note text alone. All random choices are hash-derived and reproducible.

- **800 unlabeled encounters**: the production backlog, with an uneven subtheme distribution like
  real data.
- **200 gold encounters**, each built from one of five test scenarios so the gold set isn't all
  easy cases: 120 straightforward, 30 with a cue for a similar subtheme, 20 with two concerns, 15
  about a concept left out of the taxonomy, and 15 that are ambiguous between two subthemes. Note
  length varies from terse to long, and every relevant fact stays present at every length.

**Test scenarios are separate from evaluation segments.** Scenarios describe how a synthetic note
was built, which real data doesn't have, so the pipeline doesn't read them. The `TEST_SCENARIO`
views show them alongside the real segments as a check on the synthetic data.

**The taxonomy gap is planted.** The design sample used to generate v001 leaves out transportation
notes and notes that mention transportation in passing (otherwise the generator picks up the
concept from the hint). That gives gap detection a real gap to find.

## Running on your own data

1. Run `00`, then load the three input tables it creates:
   - `NOTE_RAW`: one row per note (`encounter_id`, `note_seq`, `note_text`, dates).
   - `DISCOVERY_SAMPLE`: a representative sample of notes to design the taxonomy from.
   - `GOLD_ENCOUNTER`: the encounters to use as the gold set.

   Load `NOTE_RAW` with `INSERT` rather than `CREATE OR REPLACE`, because the dynamic table is built
   on it.
2. Run `02` through `06`. Skip `01`.
3. Bootstrap the first champion as shown in the [README](../README.md#getting-started), then
   resume the task (`ALTER TASK CLASSIFY_ENCOUNTERS RESUME`) to classify new notes on a schedule.

`service_line` is carried through every table, so several service lines can share one build.

## Changing names

The build uses `PAN_DEMO_DB.PIPELINE` and `PAN_DEMO_DB.SYNTHETIC_DATA` with an XSMALL warehouse
`PAN_DEMO_WH`. To use other names:

- Change the `USE DATABASE` / `CREATE SCHEMA` block at the top of `00` and the `USE SCHEMA` line at
  the top of `01` to `06` and the reset scripts. `01` also writes to the input tables by full name.
- Find-and-replace `PAN_DEMO_WH`. The dynamic table, task and alert need a literal warehouse name.
- For the web app, set `database` and `query_warehouse` in `webapp/app.yml`, and `DATABASE` and
  `WAREHOUSE` at the top of `demo/setup_lib.py` if you deploy from the notebook. When running the
  app locally, `PAN_SCHEMA`, `PAN_TEST_DATA_SCHEMA` and `PAN_WAREHOUSE` in `webapp/.env.local`
  override the defaults (see [webapp/README.md](../webapp/README.md#configuration)).

AI token cost attribution works on any warehouse, since it's keyed on query ID.
