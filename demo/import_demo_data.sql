/* ============================================================================
   IMPORT THE DEMO DATA FROM CSV
   ----------------------------------------------------------------------------
   Loads demo/data/*.csv into an account where the pipeline has been built
   (sql/00 and 02-06) but 01_synthetic_data.sql has NOT been run. Afterwards the
   account is in the warm-start state the web app demo begins from, the same
   one demo/reset_webapp.sql leaves:

     1260 notes / 1000 encounters, 163-note design sample, 200 gold encounters
     taxonomy v001 APPROVED (78 subthemes) and its 281 gold labels
     champion config haiku_enum_v1 on v001, plus the default_rubric template
     nothing classified, nothing evaluated, task and alert suspended

   No model calls. The CSVs replace the ~1000 note-writing calls in 01, the
   taxonomy-generation call and ~200 gold-labeling calls.

   HOW TO RUN
     CLI (recommended):  demo/setup_from_export.sh  does the whole build,
                         uploads the files and runs this script.
     Snowsight:          run sections 1 and 2 of this file, upload the 8 files
                         in demo/data/ to stage PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE
                         (Data > Databases > stage > + Files), then run the rest.

   RERUNNABLE. Every run replaces the input tables, taxonomy, gold labels and
   configs with the files' contents and clears all runs, classifications,
   evals and promotions. Do not run it in an account built with 01: there
   SYNTHETIC_DATA.TEST_SCENARIO is a view over the generator tables, and this
   script would fail replacing it. Use demo/reset_webapp.sql there.

   WHAT LANDS IN SYNTHETIC_DATA
   Only the test-scenario tags the app and notebook show in their amber "test
   data" panels (TEST_SCENARIO, here a table), the TEST_SCENARIO_SCORECARD
   view, and the stage and file format used to load. The generator tables and
   the answer key from 01 are not part of the export.
============================================================================ */


/* 1. Stage and file format. The format matches demo/export_demo_data.sql.
   Every load below names the format explicitly, so the stage needs none
   (setup_from_export.sh creates the same stage before uploading). */
USE DATABASE PAN_DEMO_DB;
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATA;
USE SCHEMA PAN_DEMO_DB.SYNTHETIC_DATA;

CREATE FILE FORMAT IF NOT EXISTS DEMO_CSV
  TYPE = CSV
  SKIP_HEADER = 1
  FIELD_OPTIONALLY_ENCLOSED_BY = '"'
  NULL_IF = ('\\N')
  EMPTY_FIELD_AS_NULL = FALSE;

CREATE STAGE IF NOT EXISTS DEMO_DATA_STAGE
  ENCRYPTION = (TYPE = 'SNOWFLAKE_SSE');


/* 2. Upload the files here if you are not using setup_from_export.sh.
   With the CLI, from the repository root:
     snow sql -q "PUT file://demo/data/*.csv @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
   In Snowsight, upload the 8 files through the stage's + Files button. */


/* 3. Stop before loading anything if a file is missing. Raises, so the CLI
   and a Snowsight "Run all" both halt here. (Querying a missing staged file
   returns zero rows rather than an error, so the loads below cannot be
   trusted to catch it.) */
EXECUTE IMMEDIATE $$
DECLARE
    found INT;
    missing_files EXCEPTION (-20001,
        'Not all 8 files from demo/data/ are on stage PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE. Upload them (section 2) and rerun.');
BEGIN
    LIST @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE;
    SELECT COUNT(DISTINCT REGEXP_SUBSTR("name", '[^/]+$'))
      INTO :found
      FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
     WHERE REGEXP_SUBSTR("name", '[^/]+$') IN
           ('note_raw.csv', 'discovery_sample.csv', 'gold_encounter.csv',
            'taxonomy_version.csv', 'taxonomy_node.csv', 'gold_label.csv',
            'classifier_config.csv', 'test_scenario.csv');
    IF (found < 8) THEN
        RAISE missing_files;
    END IF;
    RETURN 'All 8 files present.';
END;
$$;


/* 4. Load the pipeline. */
USE SCHEMA PAN_DEMO_DB.PIPELINE;

/* The task reads the stream; keep it stopped while its inputs change. */
ALTER TASK IF EXISTS CLASSIFY_ENCOUNTERS SUSPEND;

/* Outputs. Everything the demo produces live; nothing here survives a load. */
DELETE FROM CLASSIFICATION;
DELETE FROM CLASSIFICATION_RAW;
DELETE FROM PIPELINE_RUN;
DELETE FROM RECLASSIFY_QUEUE;
DELETE FROM EVAL_METRIC;
DELETE FROM EVAL_RUN;
DELETE FROM PROMOTION_LOG;

/* Inputs. INSERT OVERWRITE, never CREATE OR REPLACE: the dynamic table in 03
   sits on NOTE_RAW and replacing the table would reinitialize it. */
INSERT OVERWRITE INTO NOTE_RAW
    (encounter_id, service_line, note_seq, note_text, discharge_date, call_date, loaded_at)
SELECT $1, $2, $3::INT, $4,
       TO_DATE($5, 'YYYY-MM-DD'), TO_DATE($6, 'YYYY-MM-DD'), CURRENT_TIMESTAMP()
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/note_raw.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

INSERT OVERWRITE INTO DISCOVERY_SAMPLE (encounter_id, note_text)
SELECT $1, $2
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/discovery_sample.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

INSERT OVERWRITE INTO GOLD_ENCOUNTER (encounter_id)
SELECT $1
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/gold_encounter.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

/* Taxonomy v001 and its gold labels. Replaces every version: a later version
   or its gold labels left behind would have no config and confuse the app. */
INSERT OVERWRITE INTO TAXONOMY_VERSION
    (version_id, service_line, status, parent_version_id, generated_by_model,
     source_sample_size, generation_rationale, created_by, created_at,
     reviewed_by, reviewed_at, review_notes, locked_by, locked_at)
SELECT $1, $2, $3, $4, $5, $6::INT, $7, $8,
       TO_TIMESTAMP_LTZ($9,  'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM'),
       $10,
       TO_TIMESTAMP_LTZ($11, 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM'),
       $12, $13,
       TO_TIMESTAMP_LTZ($14, 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM')
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/taxonomy_version.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

INSERT OVERWRITE INTO TAXONOMY_NODE
    (version_id, category, theme, subtheme, description, routing_note)
SELECT $1, $2, $3, $4, $5, $6
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/taxonomy_node.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

INSERT OVERWRITE INTO GOLD_LABEL
    (encounter_id, taxonomy_version_id, label_rank, subtheme, labeled_by,
     human_verified, labeled_at)
SELECT $1, $2, $3::INT, $4, $5, $6::BOOLEAN,
       TO_TIMESTAMP_LTZ($7, 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM')
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/gold_label.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

/* Configs. 00_setup.sql owns the default_rubric template; everything else is
   replaced by the exported champion. */
DELETE FROM CLASSIFIER_CONFIG WHERE config_name <> 'default_rubric';
UPDATE CLASSIFIER_CONFIG SET is_active = FALSE, taxonomy_version_id = NULL;

INSERT INTO CLASSIFIER_CONFIG
    (config_name, model, classify_fn, prompt_template, max_labels,
     taxonomy_version_id, is_active, created_at, notes)
SELECT $1, $2, $3, $4, $5::INT, $6, $7::BOOLEAN,
       TO_TIMESTAMP_LTZ($8, 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM'), $9
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/classifier_config.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

/* Bring the dynamic table up to date with NOTE_RAW, THEN recreate the stream,
   so the stream starts clean instead of carrying the load as pending changes.
   Existing encounters are classified with the BACKLOG scope; the stream is for
   encounters added later. */
ALTER DYNAMIC TABLE ENCOUNTER_PREP REFRESH;
CREATE OR REPLACE STREAM ENCOUNTER_PREP_STREAM ON DYNAMIC TABLE ENCOUNTER_PREP;


/* 5. Test-data tags, read only by the amber "test data" panels in the app and
   the notebook. The same columns as the TEST_SCENARIO view in 01; here a table,
   because the generator tables it is built from are not exported. */
USE SCHEMA PAN_DEMO_DB.SYNTHETIC_DATA;

CREATE OR REPLACE TABLE TEST_SCENARIO AS
SELECT $1::VARCHAR AS encounter_id,
       $2::BOOLEAN AS is_gold,
       $3::VARCHAR AS test_scenario,
       $4::VARCHAR AS verbosity,
       $5::VARCHAR AS confusable_with,
       $6::BOOLEAN AS in_discovery_sample
FROM @PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_DATA_STAGE/test_scenario.csv
     (FILE_FORMAT => 'PAN_DEMO_DB.SYNTHETIC_DATA.DEMO_CSV');

/* Identical to the view in 01_synthetic_data.sql; keep the two in step. */
CREATE OR REPLACE VIEW TEST_SCENARIO_SCORECARD AS
WITH gold AS (
    SELECT er.eval_id, gl.encounter_id,
           MAX(CASE WHEN gl.label_rank = 1 THEN gl.subtheme END) AS gold_primary
    FROM PAN_DEMO_DB.PIPELINE.EVAL_RUN er
    JOIN PAN_DEMO_DB.PIPELINE.GOLD_LABEL gl
      ON gl.taxonomy_version_id = er.taxonomy_version_id
     AND (NOT er.verified_only OR gl.human_verified)
    GROUP BY er.eval_id, gl.encounter_id
),
pred AS (
    SELECT run_id, encounter_id,
           MAX(CASE WHEN label_rank = 1 THEN subtheme   END) AS pred_primary,
           MAX(CASE WHEN label_rank = 1 THEN confidence END) AS pred_confidence
    FROM PAN_DEMO_DB.PIPELINE.CLASSIFICATION
    GROUP BY run_id, encounter_id
)
SELECT er.eval_id, er.run_id, er.taxonomy_version_id, er.model, er.evaluated_at,
       ts.test_scenario,
       COUNT(*)                                                          AS n,
       AVG(IFF(EQUAL_NULL(p.pred_primary, g.gold_primary), 1, 0))::FLOAT AS subtheme_accuracy,
       AVG(IFF(p.pred_primary = 'NO_GOOD_MATCH', 1, 0))::FLOAT           AS ngm_rate,
       AVG(IFF(p.pred_confidence IN ('LOW','MEDIUM'), 1, 0))::FLOAT      AS low_conf_rate
FROM gold g
JOIN PAN_DEMO_DB.PIPELINE.EVAL_RUN er ON er.eval_id = g.eval_id
JOIN TEST_SCENARIO ts                ON ts.encounter_id = g.encounter_id
LEFT JOIN pred p                     ON p.run_id = er.run_id AND p.encounter_id = g.encounter_id
GROUP BY ALL;


/* 6. Verify. Expected: 1260, 1000, 163, 200, v001, 78, 281, haiku_enum_v1,
   v001, 2, 0, 0, 1000, FALSE. */
USE SCHEMA PAN_DEMO_DB.PIPELINE;

SELECT
    (SELECT COUNT(*)    FROM NOTE_RAW)                       AS note_rows,
    (SELECT COUNT(*)    FROM ENCOUNTER_PREP)                 AS encounters,
    (SELECT COUNT(*)    FROM DISCOVERY_SAMPLE)               AS discovery_notes,
    (SELECT COUNT(*)    FROM GOLD_ENCOUNTER)                 AS gold_encounters,
    (SELECT version_id  FROM TAXONOMY_ACTIVE)                AS active_taxonomy,
    (SELECT node_count  FROM TAXONOMY_ACTIVE)                AS subthemes,
    (SELECT COUNT(*)    FROM GOLD_LABEL)                     AS gold_labels,
    (SELECT config_name FROM ACTIVE_CONFIG)                  AS champion,
    (SELECT taxonomy_version_id FROM ACTIVE_CONFIG)          AS champion_taxonomy,
    (SELECT COUNT(*)    FROM CLASSIFIER_CONFIG)              AS configs,
    (SELECT COUNT(*)    FROM CLASSIFICATION)                 AS classifications,
    (SELECT COUNT(*)    FROM EVAL_RUN)                       AS evals,
    (SELECT COUNT(*)    FROM PAN_DEMO_DB.SYNTHETIC_DATA.TEST_SCENARIO) AS test_scenario_rows,
    SYSTEM$STREAM_HAS_DATA('ENCOUNTER_PREP_STREAM')          AS stream_has_data;
