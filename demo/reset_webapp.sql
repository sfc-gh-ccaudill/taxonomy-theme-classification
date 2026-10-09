/* ============================================================================
   RESET FOR THE WEB APP: back to "champion on v001, gold labeled, nothing run"
   ----------------------------------------------------------------------------
   Use this between run-throughs of the webapp/ demo.

   Why a second reset script exists alongside demo/reset_demo.sql:

     reset_demo.sql       drops the taxonomy and gold labels too, so the SQL
                          runbook can regenerate them live in Act 1. That is
                          right for the SQL demo, but it leaves the app's
                          Taxonomy page empty and costs a taxonomy-generation
                          call plus ~200 gold-labeling calls to get back.

     reset_webapp.sql     keeps v001 APPROVED and its gold labels, and clears
                          only what a demo run produces. Takes seconds and
                          makes no model calls.

   KEEPS:  the corpus, taxonomy v001 (APPROVED) and its gold labels, the
           champion config haiku_enum_v1 (bound to v001) and the
           default_rubric template
   CLEARS: every classification, run, eval, promotion, reclassify queue entry,
           every taxonomy version after v001, and every other config

   After this the app opens on: v001 in production through haiku_enum_v1,
   200 gold encounters labeled, 1000 encounters staged, zero
   classifications and zero evals. The first live step is evaluating the
   champion, which makes the baseline every candidate is gated against.
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;

/* Stop the task before touching anything it reads. */
ALTER TASK IF EXISTS CLASSIFY_ENCOUNTERS SUSPEND;

/* Outputs the demo produces live. */
DELETE FROM CLASSIFICATION;
DELETE FROM CLASSIFICATION_RAW;
DELETE FROM PIPELINE_RUN;
DELETE FROM RECLASSIFY_QUEUE;
DELETE FROM EVAL_METRIC;
DELETE FROM EVAL_RUN;
DELETE FROM PROMOTION_LOG;

/* Drop any version created after v001, and its version-specific gold labels.
   Order matters: nodes and gold labels reference the version id. */
DELETE FROM GOLD_LABEL
 WHERE taxonomy_version_id IN (SELECT version_id FROM TAXONOMY_VERSION
                                WHERE version_id <> 'v001');
DELETE FROM TAXONOMY_NODE
 WHERE version_id IN (SELECT version_id FROM TAXONOMY_VERSION
                       WHERE version_id <> 'v001');
DELETE FROM TAXONOMY_VERSION WHERE version_id <> 'v001';

/* Put v001 back in charge. A promotion of a later version superseded it, and
   exactly one row may be APPROVED at a time. */
UPDATE TAXONOMY_VERSION
   SET status = 'APPROVED'
 WHERE version_id = 'v001';

/* Keep the champion and the template; everything registered during a demo
   goes, which is safe because the classifications and evals that referenced
   them were just deleted. A direct write is fine here: this is a reset, not a
   promotion, and PROMOTION_LOG was cleared with it. */
DELETE FROM CLASSIFIER_CONFIG WHERE config_name NOT IN ('haiku_enum_v1', 'default_rubric');
UPDATE CLASSIFIER_CONFIG
   SET is_active           = (config_name = 'haiku_enum_v1'),
       taxonomy_version_id = IFF(config_name = 'haiku_enum_v1', 'v001', NULL);

/* Reset the stream offset so the incremental path can be shown again. */
ALTER DYNAMIC TABLE ENCOUNTER_PREP REFRESH;
CREATE OR REPLACE STREAM ENCOUNTER_PREP_STREAM ON DYNAMIC TABLE ENCOUNTER_PREP;

SELECT
    (SELECT COUNT(*)  FROM ENCOUNTER_PREP)                      AS encounters,
    (SELECT version_id FROM TAXONOMY_ACTIVE)                    AS active_taxonomy,
    (SELECT node_count FROM TAXONOMY_ACTIVE)                    AS subthemes,
    (SELECT COUNT(*)  FROM GOLD_LABEL)                          AS gold_labels,
    (SELECT config_name FROM ACTIVE_CONFIG)                     AS champion,
    (SELECT taxonomy_version_id FROM ACTIVE_CONFIG)             AS champion_taxonomy,
    (SELECT COUNT(*)  FROM CLASSIFIER_CONFIG)                   AS configs,
    (SELECT COUNT(*)  FROM CLASSIFICATION)                      AS classifications,
    (SELECT COUNT(*)  FROM EVAL_RUN)                            AS evals,
    (SELECT COUNT(*)  FROM PROMOTION_LOG)                       AS promotions,
    SYSTEM$STREAM_HAS_DATA('ENCOUNTER_PREP_STREAM')             AS stream_has_data;
