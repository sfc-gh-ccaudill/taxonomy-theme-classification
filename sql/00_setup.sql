/* ============================================================================
   PAN Lines Theme Extraction Pipeline - 00 SETUP
   ----------------------------------------------------------------------------
   Creates the PIPELINE schema, its three input tables, and the classifier
   config registry.

   TWO SCHEMAS
     PIPELINE        everything in 00, 02-06. The pipeline itself.
     SYNTHETIC_DATA  created by 01 only. Generates synthetic notes for the demo
                     and writes them into PIPELINE's three input tables. Nothing
                     in PIPELINE reads SYNTHETIC_DATA; drop it and the pipeline
                     still works. With your own data, load the input tables
                     directly. (Two demo-only views in SYNTHETIC_DATA read
                     pipeline outputs to show how each planted test scenario
                     scored.)

   TO USE A DIFFERENT DATABASE / SCHEMA / WAREHOUSE:
     1. Change the USE DATABASE / CREATE SCHEMA / USE SCHEMA block below, and
        the USE SCHEMA line at the top of 01-06 and demo/reset_*.sql. 01 also
        references PIPELINE tables by full name (PAN_DEMO_DB.PIPELINE.*).
     2. Find-replace the warehouse name  PAN_DEMO_WH  across 03/05
        (dynamic table + task + alert DDL require a literal warehouse identifier).

   A dedicated warehouse keeps warehouse credits attributable to this pipeline.
   AI token cost attribution is keyed on QUERY_ID, not the warehouse, so it
   works either way (see 04_evaluation.sql).
============================================================================ */

USE DATABASE PAN_DEMO_DB;
CREATE SCHEMA IF NOT EXISTS PIPELINE;
USE SCHEMA PIPELINE;


/* ============================================================================
   INPUTS: the only three things the pipeline needs from outside.

   In this demo 01_synthetic_data.sql fills them. With your own data, load
   these tables instead. CREATE TABLE IF NOT EXISTS so a re-run of this file
   never wipes loaded data.
============================================================================ */

/* The notes. One row per note; an encounter can have several. Only what a
   real note-level source exposes: ids, dates, free text. No labels. */
CREATE TABLE IF NOT EXISTS NOTE_RAW (
    encounter_id   VARCHAR       NOT NULL,
    service_line   VARCHAR,
    note_seq       INT           NOT NULL,
    note_text      VARCHAR,
    discharge_date DATE,
    call_date      DATE,
    loaded_at      TIMESTAMP_LTZ
);

/* The notes the team pulled to design the taxonomy from. PROPOSE_TAXONOMY in
   02 reads this. A sample never covers everything, which is why the revision
   loop in 05 exists. */
CREATE TABLE IF NOT EXISTS DISCOVERY_SAMPLE (
    encounter_id VARCHAR NOT NULL,
    note_text    VARCHAR
);

/* Which encounters are in the gold (evaluation) set. Membership only: a real
   team would pick these and have an SME label them. LABEL_GOLD_SET labels them;
   RUN_EVAL scores against them and derives its segments (category, label
   count, note length) from those labels and the note text, not from here. */
CREATE TABLE IF NOT EXISTS GOLD_ENCOUNTER (
    encounter_id VARCHAR NOT NULL,
    CONSTRAINT pk_gold_encounter PRIMARY KEY (encounter_id)
);


/* ----------------------------------------------------------------------------
   CLASSIFIER_CONFIG: the pipeline's control surface, and its model registry.

   A config is the COMPLETE recipe for a label: model, prompt template, max
   labels, AND the taxonomy version it classifies against. That bundle is the
   unit that gets evaluated against gold and promoted to production, the same
   way a model version is in an ML registry. Two consequences:
     - every eval score belongs to one exact prompt x taxonomy combination
     - rows are immutable once registered; a change is a new row

   Exactly one row is active: the CHAMPION, which production runs use. Rows are
   added with REGISTER_CONFIG and made active only by PROMOTE_CONFIG (04), which
   requires a passing evaluation or a recorded override.

   A row with NULL taxonomy_version_id is a TEMPLATE: a rubric to fork from, not
   something that can run. The seed below is one.
---------------------------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS CLASSIFIER_CONFIG (
    config_name         VARCHAR        NOT NULL,
    model               VARCHAR        NOT NULL,   -- must be a literal at call time; see RUN_CLASSIFIER
    classify_fn         VARCHAR        NOT NULL,   -- 'AI_COMPLETE_ENUM' | 'AI_CLASSIFY'
    prompt_template     VARCHAR        NOT NULL,   -- {{TAXONOMY}} and {{NOTE}} placeholders
    max_labels          INT            NOT NULL DEFAULT 2,
    taxonomy_version_id VARCHAR,                   -- NULL = template
    is_active           BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP_LTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    notes               VARCHAR,
    CONSTRAINT pk_classifier_config PRIMARY KEY (config_name)
);

/* Adds the column to a table created before the taxonomy binding existed.
   A no-op on a fresh build. */
ALTER TABLE CLASSIFIER_CONFIG ADD COLUMN IF NOT EXISTS taxonomy_version_id VARCHAR;


/* ----------------------------------------------------------------------------
   The rubric.

   This is the highest-value artifact in the pipeline. Supplying an explicit
   decision policy typically moves accuracy far more than switching model or
   AI function. The taxonomy-with-descriptions and the routing rules below are
   the asset; the model is close to interchangeable.

   Structure:
     - role framing
     - the full [CATEGORY] Theme > Subtheme: description hierarchy  ({{TAXONOMY}})
     - ROUTING PRIORITY   -> the post-op rule the model cannot infer on its own
     - LABEL COUNT        -> when 2 labels are warranted vs 1
     - NO_GOOD_MATCH      -> tight criteria, so it stays a signal, not a dumping ground
     - CONFIDENCE         -> calibration guidance
     - EVIDENCE           -> must quote the note, which makes review possible
---------------------------------------------------------------------------- */
SET rubric = $$You are a clinical quality analyst triaging free-text notes from post-discharge
Patient Advisory Nurse (PAN) telephone calls. Assign each encounter to the controlled
taxonomy below. Your output is used for readmission-pattern analysis, so consistency
matters more than nuance.

TAXONOMY (format: [CATEGORY] Theme > Subtheme: description)
{{TAXONOMY}}

ROUTING PRIORITY RULES — apply in order, these override semantic similarity:
1. POST-OP PRIORITY. If the note indicates the patient is within 30 days of a
   surgical procedure AND the concern could plausibly relate to that surgery,
   choose the POST-OP subtheme over the general SYMPTOMS subtheme. Example:
   abdominal pain 6 days after a colectomy is post-operative surgical site pain,
   NOT the general "Abdominal Pain Not Surgical" subtheme.
2. SUPPLY BEFORE ADHERENCE. If a medication is not being taken because the patient
   never received it or could not pay for it, classify the supply or cost barrier,
   not the adherence failure. Adherence subthemes are for patients who have the
   medication in hand.
3. SPECIFIC BEFORE GENERAL. Prefer the most specific subtheme that the note's
   evidence actually supports. Do not choose a broader subtheme merely because it
   is safer.
4. CLINICAL BEFORE ADMINISTRATIVE. If the call surfaced any clinical or access
   concern, classify that concern. Administrative subthemes describe the call
   itself and apply only when no substantive concern was discussed.

LABEL COUNT
Return a primary subtheme always. Return a secondary subtheme ONLY when the note
documents a second, materially distinct concern that a reviewer would want counted
separately. Do not return a second label that restates the primary one, and do not
pad to two. Most encounters have exactly one concern; set secondary_subtheme to
"NONE" in that case.

NO_GOOD_MATCH
Use "NO_GOOD_MATCH" as the primary_subtheme when the note documents a specific,
substantive concern and NO subtheme above describes that concern, even approximately.
This is an expected and useful outcome, not a failure. It is how gaps in the taxonomy
get found and fixed, so do not avoid it and do not force a label you do not believe.
The one thing to rule out first: if the note is merely brief, vague or thin, but the
concern it describes is recognisable in the taxonomy, pick the closest supportable
subtheme instead. The test is whether the CONCEPT is missing, not whether the note is
detailed. When you do use NO_GOOD_MATCH, state plainly in the evidence field what
concept the taxonomy is missing.

CONFIDENCE
HIGH   — the note states the concern explicitly and one subtheme clearly fits.
MEDIUM — the concern is clear but two subthemes compete, or it is implied not stated.
LOW    — the note is thin, internally inconsistent, or you are largely inferring.

EVIDENCE
Quote the specific phrase(s) from the note that drove the primary label, then name
the rule above if a routing rule decided it. Keep it under 300 characters.

NOTE TO CLASSIFY
{{NOTE}}$$;

/* Seed the default rubric as a TEMPLATE (no taxonomy, never active). MERGE so
   this script stays rerunnable and 00_setup.sql stays the source of truth for
   the default rubric. Updating a template in place is safe: registered configs
   copy the text when they are created, so editing it here never rewrites a
   config that has already been evaluated or run.

   The first runnable config is registered from it once a taxonomy is locked:
     CALL REGISTER_CONFIG('haiku_enum_v1', 'default_rubric', NULL, NULL, NULL,
                          'v001', 'First release');  */
MERGE INTO CLASSIFIER_CONFIG t
USING (SELECT 'default_rubric'     AS config_name,
              'claude-haiku-4-5'   AS model,
              'AI_COMPLETE_ENUM'   AS classify_fn,
              $rubric              AS prompt_template,
              2                    AS max_labels,
              'Template. Enum-enforced structured output: an out-of-taxonomy subtheme is impossible by construction. Fork it with REGISTER_CONFIG.' AS notes) s
ON t.config_name = s.config_name
WHEN MATCHED THEN UPDATE SET
  t.model = s.model, t.classify_fn = s.classify_fn,
  t.prompt_template = s.prompt_template, t.max_labels = s.max_labels, t.notes = s.notes
WHEN NOT MATCHED THEN INSERT
  (config_name, model, classify_fn, prompt_template, max_labels, taxonomy_version_id, is_active, notes)
  VALUES (s.config_name, s.model, s.classify_fn, s.prompt_template, s.max_labels, NULL, FALSE, s.notes);


/* ----------------------------------------------------------------------------
   The champion: the one active config. Production runs read it. Empty on a
   fresh build until the first PROMOTE_CONFIG.
---------------------------------------------------------------------------- */
CREATE OR REPLACE VIEW ACTIVE_CONFIG AS
SELECT * FROM CLASSIFIER_CONFIG WHERE is_active;


SELECT config_name, model, classify_fn, max_labels, taxonomy_version_id, is_active,
       LENGTH(prompt_template) AS rubric_chars
FROM CLASSIFIER_CONFIG
ORDER BY is_active DESC, config_name;
