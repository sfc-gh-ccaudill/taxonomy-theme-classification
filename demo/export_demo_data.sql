/* ============================================================================
   EXPORT THE DEMO DATA TO CSV (maintainer only)
   ----------------------------------------------------------------------------
   Writes the "warm start" state of a built demo account to demo/data/*.csv so
   another account can load it with demo/import_demo_data.sql instead of
   running 01_synthetic_data.sql and bootstrapping a taxonomy.

   What the files save the importing account: ~1000 note-writing calls, the
   taxonomy-generation call and ~200 gold-labeling calls. The importing account
   opens in exactly the state demo/reset_webapp.sql leaves: taxonomy v001
   APPROVED, its gold labels, champion haiku_enum_v1, nothing classified.

   The queries below reshape rows into that state on the way out, so this can
   be run in the middle of a demo without resetting first:
     - only taxonomy v001, its nodes and its gold labels
     - v001 written as APPROVED
     - only the haiku_enum_v1 config, written as the active champion
       (default_rubric is not exported; 00_setup.sql seeds it)
     - no runs, classifications, evals or promotions

   RUN FROM THE REPOSITORY ROOT, with the Snowflake CLI, as one session (the
   temporary stage lives only for the session):
     snow sql -c <connection> -f demo/export_demo_data.sql

   Only rerun this when the source data changes on purpose (a regenerated
   corpus or a new v001). The CSVs are the contract with import_demo_data.sql:
   if a column changes here, change the matching SELECT there.
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;

/* Formats are pinned so the files do not depend on this session's output
   settings; import_demo_data.sql parses them with the same formats. */
CREATE TEMPORARY STAGE demo_export
  FILE_FORMAT = (TYPE = CSV
                 FIELD_OPTIONALLY_ENCLOSED_BY = '"'
                 NULL_IF = ('\\N')
                 EMPTY_FIELD_AS_NULL = FALSE
                 DATE_FORMAT = 'YYYY-MM-DD'
                 TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF3 TZHTZM'
                 COMPRESSION = NONE);

/* Input tables. ENC-9* rows are added live during a demo; never export them. */
COPY INTO @demo_export/note_raw.csv FROM (
    SELECT encounter_id, service_line, note_seq, note_text, discharge_date, call_date
    FROM NOTE_RAW
    WHERE encounter_id NOT LIKE 'ENC-9%'
    ORDER BY encounter_id, note_seq)
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

COPY INTO @demo_export/discovery_sample.csv FROM (
    SELECT encounter_id, note_text FROM DISCOVERY_SAMPLE ORDER BY encounter_id)
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

COPY INTO @demo_export/gold_encounter.csv FROM (
    SELECT encounter_id FROM GOLD_ENCOUNTER ORDER BY encounter_id)
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

/* Taxonomy v001, as the APPROVED version. The people columns are written as
   neutral values: created_by holds whoever built the source account, and
   review_notes describes whatever promotion happened last there. */
COPY INTO @demo_export/taxonomy_version.csv FROM (
    SELECT version_id, service_line, 'APPROVED' AS status, parent_version_id,
           generated_by_model, source_sample_size, generation_rationale,
           'demo-setup' AS created_by, created_at,
           'demo-setup' AS reviewed_by, reviewed_at,
           'First production taxonomy, approved with config haiku_enum_v1.' AS review_notes,
           locked_by, locked_at
    FROM TAXONOMY_VERSION
    WHERE version_id = 'v001')
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

COPY INTO @demo_export/taxonomy_node.csv FROM (
    SELECT version_id, category, theme, subtheme, description, routing_note
    FROM TAXONOMY_NODE
    WHERE version_id = 'v001'
    ORDER BY category, theme, subtheme)
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

COPY INTO @demo_export/gold_label.csv FROM (
    SELECT encounter_id, taxonomy_version_id, label_rank, subtheme, labeled_by,
           human_verified, labeled_at
    FROM GOLD_LABEL
    WHERE taxonomy_version_id = 'v001'
    ORDER BY encounter_id, label_rank)
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

/* The champion config, bound to v001 and active. */
COPY INTO @demo_export/classifier_config.csv FROM (
    SELECT config_name, model, classify_fn, prompt_template, max_labels,
           'v001' AS taxonomy_version_id, TRUE AS is_active, created_at, notes
    FROM CLASSIFIER_CONFIG
    WHERE config_name = 'haiku_enum_v1')
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

/* Test-data tags for the amber "test data" panels in the app and notebook.
   Exactly the columns of the SYNTHETIC_DATA.TEST_SCENARIO view; no seeded
   subtheme, so the answer key does not travel. */
COPY INTO @demo_export/test_scenario.csv FROM (
    SELECT encounter_id, is_gold, test_scenario, verbosity, confusable_with,
           in_discovery_sample
    FROM PAN_DEMO_DB.SYNTHETIC_DATA.TEST_SCENARIO
    ORDER BY encounter_id)
  HEADER = TRUE SINGLE = TRUE OVERWRITE = TRUE;

GET @demo_export file://demo/data/;

LIST @demo_export;
