/* ============================================================================
   RESET THE DEMO: back to "corpus loaded, nothing classified yet"
   ----------------------------------------------------------------------------
   Run this before each run-through so the demo is repeatable.

   KEEPS the expensive things:
     PIPELINE.NOTE_RAW and the input tables DISCOVERY_SAMPLE / GOLD_ENCOUNTER
     SYNTHETIC_DATA.* (the ~1000 generated notes and their answer key)

   CLEARS the things the demo produces live:
     taxonomy versions + nodes, gold labels, classifications, runs, evals,
     promotions, and every registered config except the default_rubric template

   So a reset makes no model calls, and the demo regenerates the taxonomy, gold
   labels and classifications live. After it there is no champion: the first
   one is registered, evaluated and promoted live (register from
   'default_rubric' once v001 is locked).

   Re-running 01_synthetic_data.sql instead would regenerate the whole corpus
   (~1 minute of model calls) and overwrite the input tables. Use this script,
   not that one.
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;

/* Stop the task before touching anything it reads. */
ALTER TASK IF EXISTS CLASSIFY_ENCOUNTERS SUSPEND;

/* Demo-only encounters added live to show the incremental path. */
DELETE FROM NOTE_RAW WHERE encounter_id LIKE 'ENC-9%';

/* Outputs. */
DELETE FROM CLASSIFICATION;
DELETE FROM CLASSIFICATION_RAW;
DELETE FROM PIPELINE_RUN;
DELETE FROM RECLASSIFY_QUEUE;
DELETE FROM EVAL_METRIC;
DELETE FROM EVAL_RUN;
DELETE FROM PROMOTION_LOG;

/* Every config is bound to a taxonomy version that is about to be deleted.
   Only the template survives; 00_setup.sql is its source of truth. */
DELETE FROM CLASSIFIER_CONFIG WHERE config_name <> 'default_rubric';
UPDATE CLASSIFIER_CONFIG SET is_active = FALSE, taxonomy_version_id = NULL;

/* Governance artifacts, regenerated live in Act 1. */
DELETE FROM GOLD_LABEL;
DELETE FROM TAXONOMY_NODE;
DELETE FROM TAXONOMY_VERSION;

/* Bring the dynamic table back in line with NOTE_RAW, then reset the stream so
   its offset starts clean. Order matters: refresh first, THEN recreate the
   stream, so the stream is not carrying the delete above as pending changes. */
ALTER DYNAMIC TABLE ENCOUNTER_PREP REFRESH;
CREATE OR REPLACE STREAM ENCOUNTER_PREP_STREAM ON DYNAMIC TABLE ENCOUNTER_PREP;

SELECT
    (SELECT COUNT(*) FROM NOTE_RAW)                      AS note_rows_kept,
    (SELECT COUNT(*) FROM ENCOUNTER_PREP)                AS encounters_kept,
    (SELECT COUNT(*) FROM DISCOVERY_SAMPLE)              AS discovery_sample,
    (SELECT COUNT(*) FROM TAXONOMY_VERSION)              AS taxonomy_versions,
    (SELECT COUNT(*) FROM CLASSIFICATION)                AS classifications,
    (SELECT COUNT(*) FROM GOLD_LABEL)                    AS gold_labels,
    (SELECT COUNT(*) FROM CLASSIFIER_CONFIG)             AS configs_kept,
    (SELECT COUNT(*) FROM ACTIVE_CONFIG)                 AS champions,
    SYSTEM$STREAM_HAS_DATA('ENCOUNTER_PREP_STREAM')      AS stream_has_data;
