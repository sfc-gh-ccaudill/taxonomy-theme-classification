/* ============================================================================
   PAN Lines Theme Extraction Pipeline: 04 EVALUATION, GATE, PROMOTION, COST
   ----------------------------------------------------------------------------
   Scored, segmented, gated evaluation of classifier configs. The evaluation
   is what decides what reaches production.

   THE LIFECYCLE (the same shape as an ML model registry)
     register   REGISTER_CONFIG: a config is the full recipe, prompt + model +
                taxonomy version. Immutable once registered.
     evaluate   EVALUATE_CONFIG: classify the gold set with that exact recipe,
                score it, gate it against the champion. Writes nothing the
                business sees.
     promote    PROMOTE_CONFIG: make it the champion. Refused unless its latest
                eval passes the gate, or a person records why they are
                overriding. Logged in PROMOTION_LOG either way.

   THE CHAMPION IS THE BASELINE
   A candidate is compared against the latest evaluation of the production
   config, not a hand-pinned run, so the baseline always describes production.

   GOLD RIDES THE PRODUCTION PIPELINE TOO
   A full BACKLOG run by the champion includes every gold encounter, so scoring
   it is a drift check against the champion's previous eval with no extra job.

   SCORED PER FIELD, NEVER BLENDED
   A single blended accuracy can hide a config that is weak on one field and
   strong on another. Subtheme, theme, and category are scored separately, and
   every metric is also broken out by segment.

   SEGMENTS COME FROM THE DATA, NOT FROM A TAG
   Every segment is derived only from the gold label and the note text, so it
   applies to any real gold set, not just the synthetic one.
     CATEGORY     category of the gold primary label (NO_GOOD_MATCH when the gold
                  labeler found no home for it in the taxonomy; that segment is
                  a taxonomy-gap signal in its own right)
     LABEL_COUNT  1 or 2 gold labels (the multi-label share)
     NOTE_LENGTH  SHORT / MEDIUM / LONG by characters of rolled-up note text;
                  short notes are a common place for an unnoticed regression

   Objects:
     EVAL_RUN / EVAL_METRIC     results, one row per (metric, segment)
     RUN_EVAL()                 score one run against the gold set
     EVAL_SCORECARD             the headline read, one row per eval; ordered by
                                evaluated_at it is the drift trend and the
                                candidate-vs-champion comparison
     EVAL_SEGMENT_DETAIL        per-segment breakdown, over time
     EVAL_GATE                  pass/fail vs the champion, incl. per-segment regression
     REGISTER_CONFIG()          add a candidate config (prompt + model + taxonomy)
     EVALUATE_CONFIG()          gold-label if needed, classify gold, score, gate
     PROMOTE_CONFIG()           the one door into production
     PROMOTION_LOG              who promoted what, on which eval, with which override
     RUN_COST                   measured tokens and credits per run

   PREREQUISITE: 00-03, a locked taxonomy, and a labeled gold set (EVALUATE_CONFIG
   labels it on first use).
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;


/* ============================================================================
   1. RESULT TABLES
============================================================================ */
CREATE TABLE IF NOT EXISTS EVAL_RUN (
    eval_id             VARCHAR       NOT NULL,
    run_id              VARCHAR       NOT NULL,
    taxonomy_version_id VARCHAR       NOT NULL,
    config_name         VARCHAR,
    model               VARCHAR,
    verified_only       BOOLEAN       NOT NULL,
    gold_encounters     INT,
    evaluated_at        TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT pk_eval_run PRIMARY KEY (eval_id)
);

/* Removes a column from earlier builds if present; the baseline is derived in
   EVAL_GATE. */
ALTER TABLE EVAL_RUN DROP COLUMN IF EXISTS is_baseline;

CREATE TABLE IF NOT EXISTS EVAL_METRIC (
    eval_id        VARCHAR NOT NULL,
    metric_name    VARCHAR NOT NULL,
    segment_name   VARCHAR NOT NULL,   -- ALL | CATEGORY | LABEL_COUNT | NOTE_LENGTH | RUN
    segment_value  VARCHAR NOT NULL,
    metric_value   FLOAT,
    n              INT,
    CONSTRAINT pk_eval_metric PRIMARY KEY (eval_id, metric_name, segment_name, segment_value)
);

/* Gate thresholds, in a table so they are inspectable and arguable rather than
   buried in a view definition. */
CREATE TABLE IF NOT EXISTS EVAL_GATE_CONFIG (
    gate_name               VARCHAR NOT NULL,
    min_primary_accuracy    FLOAT   NOT NULL,
    max_segment_regression  FLOAT   NOT NULL,
    max_error_rate          FLOAT   NOT NULL,
    min_segment_n           INT     NOT NULL,
    CONSTRAINT pk_eval_gate_config PRIMARY KEY (gate_name)
);

MERGE INTO EVAL_GATE_CONFIG t
USING (SELECT 'default' AS gate_name, 0.70 AS min_primary_accuracy,
              0.10 AS max_segment_regression, 0.01 AS max_error_rate,
              /* Segments smaller than this are reported but not gated. At n=10
                 one encounter is 10 points, so a 0.10 regression margin would
                 fail on a single coin flip. */
              20 AS min_segment_n) s
ON t.gate_name = s.gate_name
WHEN MATCHED THEN UPDATE SET
  t.min_primary_accuracy   = s.min_primary_accuracy,
  t.max_segment_regression = s.max_segment_regression,
  t.max_error_rate         = s.max_error_rate,
  t.min_segment_n          = s.min_segment_n
WHEN NOT MATCHED THEN INSERT
  (gate_name, min_primary_accuracy, max_segment_regression, max_error_rate, min_segment_n)
  VALUES (s.gate_name, s.min_primary_accuracy, s.max_segment_regression, s.max_error_rate, s.min_segment_n);


/* ============================================================================
   2. RUN_EVAL: score one pipeline run against the gold set.

   P_RUN_ID        a run_id, or 'LATEST' for the most recent completed run
   P_VERIFIED_ONLY TRUE restricts to HUMAN_VERIFIED gold rows. Model-generated
                   gold labels start unverified, so this is the switch to turn
                   on after an SME review pass.

   Encounters whose classification ERRORED have no CLASSIFICATION rows. They are
   driven off the GOLD list with a LEFT JOIN, so a missing prediction counts as
   WRONG rather than silently vanishing from the denominator.

   The same rule is why a run must have ATTEMPTED every gold encounter to be
   scored. A partial sample would score its unclassified gold encounters as
   wrong, and since the champion's latest eval is the baseline a candidate is
   gated against, one such eval would let any candidate through.

   Theme and category are looked up in the run's OWN taxonomy version, for both
   the prediction and the gold label. Scoring a candidate against the
   production taxonomy would mark its new subthemes as unmapped.
============================================================================ */
CREATE OR REPLACE PROCEDURE RUN_EVAL(P_RUN_ID VARCHAR, P_VERIFIED_ONLY BOOLEAN)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_run_id    VARCHAR;
    v_eval_id   VARCHAR;
    v_version   VARCHAR;
    v_config    VARCHAR;
    v_model     VARCHAR;
    v_completed TIMESTAMP_LTZ;
    v_gold_n    INT;
    v_covered   INT;
    v_acc       FLOAT;
BEGIN
    IF (UPPER(:P_RUN_ID) = 'LATEST') THEN
        SELECT MAX_BY(run_id, started_at) INTO :v_run_id FROM PIPELINE_RUN
         WHERE completed_at IS NOT NULL;
    ELSE
        v_run_id := :P_RUN_ID;
    END IF;

    SELECT MAX(taxonomy_version_id), MAX(config_name), MAX(model), MAX(completed_at)
      INTO :v_version, :v_config, :v_model, :v_completed
      FROM PIPELINE_RUN WHERE run_id = :v_run_id;

    IF (v_version IS NULL) THEN
        RETURN 'REFUSED: run ' || COALESCE(:v_run_id,'<null>') || ' not found in PIPELINE_RUN.';
    END IF;
    IF (v_completed IS NULL) THEN
        RETURN 'REFUSED: run ' || :v_run_id || ' has not completed.';
    END IF;

    SELECT COUNT(DISTINCT encounter_id) INTO :v_gold_n
      FROM GOLD_LABEL
     WHERE taxonomy_version_id = :v_version
       AND (NOT :P_VERIFIED_ONLY OR human_verified);

    IF (v_gold_n = 0) THEN
        RETURN 'REFUSED: no gold labels for taxonomy ' || :v_version
            || '. Run LABEL_GOLD_SET first (EVALUATE_CONFIG does it for you) -- gold '
            || 'labels are version-specific.';
    END IF;

    /* Attempted = has a CLASSIFICATION_RAW row, errored or not. */
    SELECT COUNT(DISTINCT gl.encounter_id) INTO :v_covered
      FROM GOLD_LABEL gl
      JOIN CLASSIFICATION_RAW cr
        ON cr.encounter_id = gl.encounter_id AND cr.run_id = :v_run_id
     WHERE gl.taxonomy_version_id = :v_version
       AND (NOT :P_VERIFIED_ONLY OR gl.human_verified);

    IF (v_covered < v_gold_n) THEN
        RETURN 'REFUSED: run ' || :v_run_id || ' attempted ' || :v_covered::VARCHAR || ' of '
            || :v_gold_n::VARCHAR || ' gold encounters. Scoring it would count the rest as '
            || 'wrong. Evaluate a GOLD run (EVALUATE_CONFIG) or a full BACKLOG run instead.';
    END IF;

    v_eval_id := 'eval_' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDD_HH24MISS_FF3');

    /* ---- Per-encounter comparison. One row per gold encounter. ---- */
    CREATE OR REPLACE TEMPORARY TABLE _pair AS
    WITH gold AS (
        SELECT encounter_id,
               MAX(CASE WHEN label_rank = 1 THEN subtheme END)          AS gold_primary,
               ARRAY_AGG(subtheme) WITHIN GROUP (ORDER BY label_rank)   AS gold_arr
        FROM GOLD_LABEL
        WHERE taxonomy_version_id = :v_version
          AND (NOT :P_VERIFIED_ONLY OR human_verified)
        GROUP BY encounter_id
    ),
    pred AS (
        SELECT encounter_id,
               MAX(CASE WHEN label_rank = 1 THEN subtheme END)          AS pred_primary,
               MAX(CASE WHEN label_rank = 1 THEN confidence END)        AS pred_confidence,
               ARRAY_AGG(subtheme) WITHIN GROUP (ORDER BY label_rank)   AS pred_arr
        FROM CLASSIFICATION
        WHERE run_id = :v_run_id
        GROUP BY encounter_id
    )
    SELECT
        g.encounter_id,
        /* Segments. Derived from the gold label and the note text only. */
        CASE WHEN g.gold_primary = 'NO_GOOD_MATCH' THEN 'NO_GOOD_MATCH'
             ELSE COALESCE(gn.category, 'UNMAPPED') END            AS seg_category,
        ARRAY_SIZE(g.gold_arr)::VARCHAR                             AS seg_label_count,
        CASE WHEN LENGTH(ep.full_text) < 300 THEN 'SHORT'
             WHEN LENGTH(ep.full_text) < 700 THEN 'MEDIUM'
             ELSE                                 'LONG' END        AS seg_note_length,
        g.gold_primary,
        p.pred_primary,
        p.pred_confidence,
        /* EQUAL_NULL so a NO_GOOD_MATCH on both sides counts as agreement on
           theme/category (both derive to NULL), while a genuine miss does not. */
        IFF(EQUAL_NULL(p.pred_primary,  g.gold_primary),  1, 0) AS correct_primary,
        IFF(EQUAL_NULL(pn.theme,        gn.theme),        1, 0) AS correct_theme,
        IFF(EQUAL_NULL(pn.category,     gn.category),     1, 0) AS correct_category,
        IFF(p.pred_primary IS NULL, 1, 0)                       AS missing_prediction,
        IFF(p.pred_primary = 'NO_GOOD_MATCH', 1, 0)             AS pred_ngm,
        IFF(g.gold_primary = 'NO_GOOD_MATCH', 1, 0)             AS gold_ngm,
        IFF(p.pred_confidence IN ('LOW','MEDIUM'), 1, 0)        AS low_or_med_conf,
        ARRAY_SIZE(g.gold_arr)                                  AS gold_labels,
        COALESCE(ARRAY_SIZE(p.pred_arr), 0)                     AS pred_labels,
        /* Multi-label set metrics. tp/fp/fn are per-encounter COUNTS so they can
           be SUMmed into a micro-averaged F1; averaging per-encounter F1 would
           weight a 1-label encounter the same as a 2-label one. */
        COALESCE(ARRAY_SIZE(ARRAY_INTERSECTION(p.pred_arr, g.gold_arr)), 0) AS tp
    FROM gold g
    JOIN ENCOUNTER_PREP ep           ON ep.encounter_id = g.encounter_id
    LEFT JOIN pred p                 ON p.encounter_id  = g.encounter_id
    LEFT JOIN TAXONOMY_NODE gn       ON gn.version_id   = :v_version AND gn.subtheme = g.gold_primary
    LEFT JOIN TAXONOMY_NODE pn       ON pn.version_id   = :v_version AND pn.subtheme = p.pred_primary;

    /* ---- Stack the segment dimensions so one GROUP BY covers them all. ---- */
    CREATE OR REPLACE TEMPORARY TABLE _segmented AS
    SELECT 'ALL'         AS segment_name, 'ALL'           AS segment_value, * FROM _pair
    UNION ALL
    SELECT 'CATEGORY',    seg_category,    * FROM _pair
    UNION ALL
    SELECT 'LABEL_COUNT', seg_label_count, * FROM _pair
    UNION ALL
    SELECT 'NOTE_LENGTH', seg_note_length, * FROM _pair;

    /* ---- Aggregate, then UNPIVOT metrics into rows.
            UNPIVOT uppercases the emitted name values, hence LOWER(). ---- */
    INSERT INTO EVAL_METRIC (eval_id, metric_name, segment_name, segment_value, metric_value, n)
    SELECT :v_eval_id, LOWER(metric_name), segment_name, segment_value, metric_value, n
    FROM (
        SELECT
            segment_name, segment_value, COUNT(*) AS n,
            /* Every metric cast to FLOAT: UNPIVOT requires a single uniform type
               across the list, and AVG() yields NUMBER while DIV0() yields FLOAT. */
            AVG(correct_primary)::FLOAT                             AS primary_subtheme_accuracy,
            AVG(correct_theme)::FLOAT                               AS theme_accuracy,
            AVG(correct_category)::FLOAT                            AS category_accuracy,
            AVG(missing_prediction)::FLOAT                          AS missing_prediction_rate,
            AVG(pred_ngm)::FLOAT                                    AS no_good_match_rate,
            AVG(low_or_med_conf)::FLOAT                             AS low_or_medium_confidence_rate,
            AVG(pred_labels)::FLOAT                                 AS mean_labels_per_encounter,
            /* Micro-averaged over the label sets. */
            DIV0(SUM(tp)::FLOAT, SUM(pred_labels))::FLOAT           AS label_set_precision,
            DIV0(SUM(tp)::FLOAT, SUM(gold_labels))::FLOAT           AS label_set_recall,
            DIV0(2.0 * SUM(tp), SUM(pred_labels) + SUM(gold_labels))::FLOAT AS label_set_micro_f1
        FROM _segmented
        GROUP BY segment_name, segment_value
    ) UNPIVOT (metric_value FOR metric_name IN (
        primary_subtheme_accuracy, theme_accuracy, category_accuracy,
        missing_prediction_rate, no_good_match_rate, low_or_medium_confidence_rate,
        mean_labels_per_encounter, label_set_precision, label_set_recall,
        label_set_micro_f1));

    /* ---- Operational metrics over the WHOLE run, not just the gold subset.
            These need no labels and tend to move first when something drifts.
            no_good_match_rate over a full run is a usable signal; over a
            handful of gold rows it would be noise. ---- */
    INSERT INTO EVAL_METRIC (eval_id, metric_name, segment_name, segment_value, metric_value, n)
    SELECT :v_eval_id, LOWER(metric_name), 'RUN', 'ALL', metric_value, n
    FROM (
        SELECT
            (SELECT COUNT(*) FROM CLASSIFICATION_RAW WHERE run_id = :v_run_id)  AS n,
            (SELECT DIV0(COUNT_IF(error IS NOT NULL)::FLOAT, COUNT(*))::FLOAT
               FROM CLASSIFICATION_RAW WHERE run_id = :v_run_id)                AS run_error_rate,
            (SELECT DIV0(COUNT_IF(subtheme = 'NO_GOOD_MATCH')::FLOAT,
                         COUNT(DISTINCT encounter_id))::FLOAT
               FROM CLASSIFICATION WHERE run_id = :v_run_id)                    AS run_no_good_match_rate,
            (SELECT DIV0(COUNT_IF(confidence IN ('LOW','MEDIUM'))::FLOAT, COUNT(*))::FLOAT
               FROM CLASSIFICATION WHERE run_id = :v_run_id AND label_rank = 1)  AS run_low_or_medium_confidence_rate,
            (SELECT DIV0(COUNT(*)::FLOAT, COUNT(DISTINCT encounter_id))::FLOAT
               FROM CLASSIFICATION WHERE run_id = :v_run_id)                    AS run_mean_labels_per_encounter,
            /* Out-of-taxonomy labels. Structurally zero because the subtheme list
               is an enum in response_format; this metric confirms that, and
               fails loudly if the schema ever stops being enforced.
               Checked against the run's own version. */
            (SELECT COUNT_IF(c.subtheme <> 'NO_GOOD_MATCH' AND n.subtheme IS NULL)::FLOAT
               FROM CLASSIFICATION c
               LEFT JOIN TAXONOMY_NODE n
                      ON n.version_id = c.taxonomy_version_id AND n.subtheme = c.subtheme
              WHERE c.run_id = :v_run_id)                                       AS run_out_of_taxonomy_labels
    ) UNPIVOT (metric_value FOR metric_name IN (
        run_error_rate, run_no_good_match_rate, run_low_or_medium_confidence_rate,
        run_mean_labels_per_encounter, run_out_of_taxonomy_labels));

    INSERT INTO EVAL_RUN
      (eval_id, run_id, taxonomy_version_id, config_name, model, verified_only, gold_encounters)
    VALUES (:v_eval_id, :v_run_id, :v_version, :v_config, :v_model, :P_VERIFIED_ONLY, :v_gold_n);

    SELECT metric_value INTO :v_acc FROM EVAL_METRIC
     WHERE eval_id = :v_eval_id AND metric_name = 'primary_subtheme_accuracy'
       AND segment_name = 'ALL';

    RETURN :v_eval_id || ': scored run ' || :v_run_id || ' (config ' || :v_config
        || ', taxonomy ' || :v_version || ') on ' || :v_gold_n::VARCHAR
        || ' gold encounters. Primary subtheme accuracy = '
        || ROUND(:v_acc, 4)::VARCHAR || '. See EVAL_SCORECARD and EVAL_GATE.';
END;
$$;


/* Obsolete procedure; the baseline is always the champion's latest eval. */
DROP PROCEDURE IF EXISTS SET_EVAL_BASELINE(VARCHAR);


/* ============================================================================
   3. READ SURFACES
============================================================================ */

/* The headline. One row per eval, carrying the config and taxonomy version it
   ran under.

   That makes this view do three jobs without separate objects:
     - the scorecard                 one eval
     - the leaderboard               candidates vs the champion (is_champion)
     - drift                         champion evals ordered by evaluated_at
   A promotion is justified by a measured movement, not by the fact that a
   model suggested the change. */
CREATE OR REPLACE VIEW EVAL_SCORECARD AS
WITH node_count AS (
    SELECT version_id, COUNT(*) AS subthemes FROM TAXONOMY_NODE GROUP BY version_id
)
SELECT
    er.eval_id, er.run_id, pr.mode AS run_scope, pr.purpose AS run_purpose,
    er.config_name, er.taxonomy_version_id, er.model,
    er.gold_encounters, er.verified_only,
    COALESCE(cc.is_active, FALSE) AS is_champion,
    er.evaluated_at,
    tv.status AS taxonomy_status, tv.parent_version_id, nc.subthemes,
    MAX(CASE WHEN m.metric_name='primary_subtheme_accuracy'          THEN m.metric_value END) AS subtheme_accuracy,
    MAX(CASE WHEN m.metric_name='theme_accuracy'                     THEN m.metric_value END) AS theme_accuracy,
    MAX(CASE WHEN m.metric_name='category_accuracy'                  THEN m.metric_value END) AS category_accuracy,
    MAX(CASE WHEN m.metric_name='label_set_micro_f1'                 THEN m.metric_value END) AS label_set_f1,
    MAX(CASE WHEN m.metric_name='run_mean_labels_per_encounter'      THEN m.metric_value END) AS labels_per_encounter,
    MAX(CASE WHEN m.metric_name='run_no_good_match_rate'             THEN m.metric_value END) AS no_good_match_rate,
    MAX(CASE WHEN m.metric_name='run_low_or_medium_confidence_rate'  THEN m.metric_value END) AS low_conf_rate,
    MAX(CASE WHEN m.metric_name='run_error_rate'                     THEN m.metric_value END) AS error_rate,
    MAX(CASE WHEN m.metric_name='run_out_of_taxonomy_labels'         THEN m.metric_value END) AS out_of_taxonomy_labels
FROM EVAL_RUN er
LEFT JOIN PIPELINE_RUN      pr ON pr.run_id     = er.run_id
LEFT JOIN CLASSIFIER_CONFIG cc ON cc.config_name = er.config_name
LEFT JOIN TAXONOMY_VERSION  tv ON tv.version_id = er.taxonomy_version_id
LEFT JOIN node_count        nc ON nc.version_id = er.taxonomy_version_id
LEFT JOIN EVAL_METRIC m
       ON m.eval_id = er.eval_id
      AND m.segment_name IN ('ALL','RUN')
GROUP BY ALL;


/* Per-segment breakdown. This is where the interesting failures show up: an
   aggregate number will not show that one category, or short notes, are
   the problem.

   GATED says whether EVAL_GATE checks this segment for regression (n at or
   above min_segment_n). Smaller segments are still reported.

   Ordered by evaluated_at it is also the trend. The CATEGORY = NO_GOOD_MATCH
   segment is worth watching across a taxonomy revision: it is the gold
   encounters the reference labeler could not place, and it should shrink when
   a gap is closed. */
CREATE OR REPLACE VIEW EVAL_SEGMENT_DETAIL AS
SELECT er.eval_id, er.run_id, er.config_name, er.model, er.taxonomy_version_id, er.evaluated_at,
       m.segment_name, m.segment_value, m.n,
       m.n >= cfg.min_segment_n AS gated,
       MAX(CASE WHEN m.metric_name='primary_subtheme_accuracy' THEN m.metric_value END) AS subtheme_accuracy,
       MAX(CASE WHEN m.metric_name='theme_accuracy'            THEN m.metric_value END) AS theme_accuracy,
       MAX(CASE WHEN m.metric_name='label_set_micro_f1'        THEN m.metric_value END) AS label_set_f1,
       MAX(CASE WHEN m.metric_name='no_good_match_rate'        THEN m.metric_value END) AS ngm_rate,
       MAX(CASE WHEN m.metric_name='low_or_medium_confidence_rate' THEN m.metric_value END) AS low_conf_rate
FROM EVAL_RUN er
JOIN EVAL_METRIC m ON m.eval_id = er.eval_id
CROSS JOIN (SELECT min_segment_n FROM EVAL_GATE_CONFIG WHERE gate_name = 'default') cfg
WHERE m.segment_name IN ('CATEGORY','LABEL_COUNT','NOTE_LENGTH')
GROUP BY ALL;


/* ----------------------------------------------------------------------------
   EVAL_GATE: would you ship this?

   Two independent checks:

     1. ABSOLUTE   overall subtheme accuracy clears the floor, the error rate is
                   under its ceiling, and no label escaped the enum.
     2. REGRESSION no individual segment dropped more than the allowed margin
                   versus the BASELINE. Only segments with at least
                   min_segment_n encounters in BOTH evals are checked.

   THE BASELINE IS THE CHAMPION. For a candidate it is the champion's latest
   eval. For an eval of the champion itself it is the champion's previous eval,
   which makes this the drift check. Same verified_only setting either way, so
   the two were scored against the same gold rows. With no champion eval yet
   (the very first promotion) only the absolute checks apply, and gate_note
   says so.

   The regression check matters because a candidate can clear the overall
   floor while one segment (e.g. short notes) drops sharply; an aggregate-only
   gate would ship it.

   Across a taxonomy change, CATEGORY membership can shift (a relabel moves
   gold encounters out of NO_GOOD_MATCH into a real category), and each side is
   scored against its own version's gold labels. The comparison is still the
   useful one ("is this category worse than it was"), but read
   regressed_detail with that in mind.

   This is a view, so its baseline moves when the champion changes. The verdict
   that actually let a promotion through is frozen in PROMOTION_LOG.
---------------------------------------------------------------------------- */
CREATE OR REPLACE VIEW EVAL_GATE AS
WITH cfg AS (SELECT * FROM EVAL_GATE_CONFIG WHERE gate_name = 'default'),
ev AS (
    SELECT er.eval_id, er.verified_only, er.evaluated_at,
           COALESCE(cc.is_active, FALSE) AS is_champion
    FROM EVAL_RUN er
    LEFT JOIN CLASSIFIER_CONFIG cc ON cc.config_name = er.config_name
),
pairs AS (
    SELECT e.eval_id,
           MAX_BY(b.eval_id, b.evaluated_at) AS baseline_eval_id
    FROM ev e
    LEFT JOIN ev b
      ON b.is_champion
     AND b.eval_id <> e.eval_id
     AND b.verified_only = e.verified_only
     AND (NOT e.is_champion OR b.evaluated_at < e.evaluated_at)
    GROUP BY e.eval_id
),
acc AS (
    SELECT eval_id, segment_name, segment_value, metric_value, n
    FROM EVAL_METRIC
    WHERE metric_name = 'primary_subtheme_accuracy'
      AND segment_name IN ('CATEGORY','LABEL_COUNT','NOTE_LENGTH')
),
regress AS (
    SELECT p.eval_id,
           COUNT_IF(c.metric_value < b.metric_value - cfg.max_segment_regression) AS segments_regressed,
           /* LISTAGG over all-NULL inputs returns '' rather than NULL. */
           NULLIF(LISTAGG(CASE WHEN c.metric_value < b.metric_value - cfg.max_segment_regression
                        THEN c.segment_name || '=' || c.segment_value
                             || ' (' || ROUND(b.metric_value,3)::VARCHAR
                             || ' -> ' || ROUND(c.metric_value,3)::VARCHAR || ')' END, ', '), '')
             AS regressed_detail
    FROM pairs p
    CROSS JOIN cfg
    JOIN acc c ON c.eval_id = p.eval_id
    JOIN acc b ON b.eval_id = p.baseline_eval_id
              AND b.segment_name = c.segment_name AND b.segment_value = c.segment_value
    WHERE c.n >= cfg.min_segment_n
      AND b.n >= cfg.min_segment_n
    GROUP BY p.eval_id
)
SELECT
    s.eval_id, s.run_id, s.config_name, s.taxonomy_version_id, s.model, s.is_champion,
    p.baseline_eval_id,
    bs.config_name                                          AS baseline_config_name,
    ROUND(s.subtheme_accuracy, 4)                           AS subtheme_accuracy,
    ROUND(bs.subtheme_accuracy, 4)                          AS baseline_subtheme_accuracy,
    cfg.min_primary_accuracy                                AS accuracy_floor,
    ROUND(s.error_rate, 4)                                  AS error_rate,
    cfg.max_error_rate                                      AS error_ceiling,
    COALESCE(r.segments_regressed, 0)                       AS segments_regressed,
    r.regressed_detail,
    s.out_of_taxonomy_labels,
    CASE WHEN p.baseline_eval_id IS NULL
         THEN 'No champion eval to compare against: absolute checks only.' END AS gate_note,
    CASE
      WHEN s.subtheme_accuracy      <  cfg.min_primary_accuracy THEN 'FAIL: accuracy below floor'
      WHEN s.error_rate             >  cfg.max_error_rate       THEN 'FAIL: error rate above ceiling'
      WHEN s.out_of_taxonomy_labels >  0                        THEN 'FAIL: out-of-taxonomy labels present'
      WHEN COALESCE(r.segments_regressed, 0) > 0                THEN 'FAIL: segment regression vs champion'
      ELSE 'PASS'
    END                                                     AS gate_result
FROM EVAL_SCORECARD s
CROSS JOIN cfg
LEFT JOIN pairs          p  ON p.eval_id  = s.eval_id
LEFT JOIN EVAL_SCORECARD bs ON bs.eval_id = p.baseline_eval_id
LEFT JOIN regress        r  ON r.eval_id  = s.eval_id;


/* ----------------------------------------------------------------------------
   RUN_COST: measured, not estimated.

   Joined on QUERY_ID, which PIPELINE_RUN captures from SQLID. (A proc cannot set
   its own QUERY_TAG because ALTER SESSION is not permitted inside one, so the
   query id is the only reliable handle.)

   ACCOUNT_USAGE is asynchronous. Expect a lag of minutes on a fresh run; the
   numbers backfill. Includes output tokens, which an input-side estimate
   cannot.
---------------------------------------------------------------------------- */
CREATE OR REPLACE VIEW RUN_COST AS
SELECT
    r.run_id, r.mode, r.purpose, r.config_name, r.model, r.taxonomy_version_id,
    r.encounters_in, r.labels_out,
    DATEDIFF(second, r.started_at, r.completed_at)             AS duration_sec,
    u.TOKENS                                                    AS tokens_total,
    u.TOKENS_GRANULAR:input::INT                                AS tokens_input,
    u.TOKENS_GRANULAR:output::INT                               AS tokens_output,
    u.TOKEN_CREDITS                                             AS token_credits,
    ROUND(DIV0(u.TOKENS::FLOAT,        r.encounters_in), 1)      AS tokens_per_encounter,
    ROUND(DIV0(u.TOKEN_CREDITS * 1000, r.encounters_in), 4)      AS credits_per_1k_encounters
FROM PIPELINE_RUN r
LEFT JOIN SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY u
       ON u.QUERY_ID = r.query_id;


/* ============================================================================
   4. THE LIFECYCLE: REGISTER -> EVALUATE -> PROMOTE

   The only path into production. Each step is a procedure with its rules in
   the body, so the app, a notebook and a SQL worksheet all get the same
   guard rails.
============================================================================ */

/* The durable record of every promotion. EVAL_GATE is a view whose baseline
   moves when the champion changes, so the verdict that actually let a config
   through is frozen here, along with any override and who gave it. */
CREATE TABLE IF NOT EXISTS PROMOTION_LOG (
    promotion_id                 VARCHAR       NOT NULL,
    config_name                  VARCHAR       NOT NULL,
    taxonomy_version_id          VARCHAR       NOT NULL,
    previous_config_name         VARCHAR,
    previous_taxonomy_version_id VARCHAR,
    eval_id                      VARCHAR       NOT NULL,
    baseline_eval_id             VARCHAR,
    subtheme_accuracy            FLOAT,
    baseline_subtheme_accuracy   FLOAT,
    gate_result                  VARCHAR       NOT NULL,
    override_reason              VARCHAR,      -- non-NULL only when gate_result <> 'PASS'
    promoted_by                  VARCHAR       NOT NULL,
    promoted_at                  TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT pk_promotion_log PRIMARY KEY (promotion_id)
);

/* Drop superseded signatures so each procedure below has a single overload. */
DROP PROCEDURE IF EXISTS REGISTER_CONFIG(VARCHAR, VARCHAR, VARCHAR, INT, VARCHAR);
DROP PROCEDURE IF EXISTS PROMOTE_CONFIG(VARCHAR);


/* ----------------------------------------------------------------------------
   REGISTER_CONFIG: add a candidate. Always lands inactive.

   P_BASE_CONFIG  optional config (or template) to fork from. Any of model,
                  template, max labels and taxonomy left NULL is inherited from
                  it, so "same prompt, new taxonomy" is one short call:
                    CALL REGISTER_CONFIG('haiku_v1_tax_v002', 'haiku_enum_v1',
                                         NULL, NULL, NULL, 'v002', 'Adds transport');

   The taxonomy may still be a DRAFT, so PREVIEW_PROMPT can be tried while the
   taxonomy is being edited; evaluation waits until it is LOCKED.
---------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE REGISTER_CONFIG(
    P_CONFIG_NAME         VARCHAR,
    P_BASE_CONFIG         VARCHAR,
    P_MODEL               VARCHAR,
    P_PROMPT_TEMPLATE     VARCHAR,
    P_MAX_LABELS          INT,
    P_TAXONOMY_VERSION_ID VARCHAR,
    P_NOTES               VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_exists     INT;
    v_base_found INT;
    v_model      VARCHAR;
    v_template   VARCHAR;
    v_max_labels INT;
    v_version    VARCHAR;
    v_tax_status VARCHAR;
    v_gold       INT;
BEGIN
    /* Names and models end up in run ids, messages and (for the model) a
       dynamic SQL literal, so both are restricted to a plain identifier. */
    IF (NOT REGEXP_LIKE(COALESCE(:P_CONFIG_NAME, ''), '[A-Za-z0-9_.-]{1,64}')) THEN
        RETURN 'REFUSED: config name must be 1-64 characters of letters, digits, '
            || 'underscore, dot or hyphen.';
    END IF;

    SELECT COUNT(*) INTO :v_exists FROM CLASSIFIER_CONFIG WHERE config_name = :P_CONFIG_NAME;
    IF (v_exists > 0) THEN
        RETURN 'REFUSED: config ''' || :P_CONFIG_NAME || ''' already exists. '
            || 'Config rows are an audit trail -- pick a new name rather than editing one.';
    END IF;

    IF (:P_BASE_CONFIG IS NOT NULL) THEN
        SELECT COUNT(*), MAX(model), MAX(prompt_template), MAX(max_labels), MAX(taxonomy_version_id)
          INTO :v_base_found, :v_model, :v_template, :v_max_labels, :v_version
          FROM CLASSIFIER_CONFIG WHERE config_name = :P_BASE_CONFIG;
        IF (v_base_found = 0) THEN
            RETURN 'REFUSED: base config ''' || :P_BASE_CONFIG || ''' does not exist.';
        END IF;
    END IF;

    v_model      := COALESCE(:P_MODEL, :v_model);
    v_template   := COALESCE(:P_PROMPT_TEMPLATE, :v_template);
    v_max_labels := COALESCE(:P_MAX_LABELS, :v_max_labels, 2);
    v_version    := COALESCE(:P_TAXONOMY_VERSION_ID, :v_version);

    IF (NOT REGEXP_LIKE(COALESCE(:v_model, ''), '[A-Za-z0-9._-]{1,64}')) THEN
        RETURN 'REFUSED: model ''' || COALESCE(:v_model, '<null>') || ''' is not a valid model name.';
    END IF;
    IF (v_template IS NULL OR POSITION('{{TAXONOMY}}', :v_template) = 0) THEN
        RETURN 'REFUSED: prompt_template must contain {{TAXONOMY}}. Without it the '
            || 'model never sees the taxonomy and the enum would be the only constraint.';
    END IF;
    IF (POSITION('{{NOTE}}', :v_template) = 0) THEN
        RETURN 'REFUSED: prompt_template must contain {{NOTE}}. Without it every '
            || 'encounter would get the same prompt.';
    END IF;
    IF (v_max_labels < 1) THEN
        RETURN 'REFUSED: max_labels must be at least 1.';
    END IF;
    IF (v_version IS NULL) THEN
        RETURN 'REFUSED: bind a taxonomy version. A config is prompt + model + taxonomy; '
            || 'without the taxonomy there is nothing to evaluate or promote.';
    END IF;

    SELECT MAX(status) INTO :v_tax_status FROM TAXONOMY_VERSION WHERE version_id = :v_version;
    IF (COALESCE(v_tax_status, 'REJECTED') = 'REJECTED') THEN
        RETURN 'REFUSED: taxonomy ' || :v_version || ' '
            || CASE WHEN v_tax_status IS NULL THEN 'does not exist.' ELSE 'was rejected.' END;
    END IF;

    INSERT INTO CLASSIFIER_CONFIG
      (config_name, model, classify_fn, prompt_template, max_labels,
       taxonomy_version_id, is_active, notes)
    VALUES (:P_CONFIG_NAME, :v_model, 'AI_COMPLETE_ENUM', :v_template, :v_max_labels,
            :v_version, FALSE, :P_NOTES);

    SELECT COUNT(DISTINCT encounter_id) INTO :v_gold FROM GOLD_LABEL
     WHERE taxonomy_version_id = :v_version;

    RETURN 'Registered ''' || :P_CONFIG_NAME || ''' (' || :v_model || ', taxonomy '
        || :v_version || ' [' || :v_tax_status || '], ' || LENGTH(:v_template)::VARCHAR
        || ' rubric chars), inactive. '
        || CASE WHEN v_tax_status = 'DRAFT'
                THEN 'Preview it with PREVIEW_PROMPT; LOCK_TAXONOMY(''' || :v_version
                     || ''') before evaluating.'
                WHEN v_gold > 0
                THEN 'Next: EVALUATE_CONFIG. Gold labels for ' || :v_version
                     || ' already exist, so it costs one gold classification run.'
                ELSE 'Next: EVALUATE_CONFIG. ' || :v_version || ' has no gold labels yet, '
                     || 'so the first eval labels the gold set first.' END;
END;
$$;


/* ----------------------------------------------------------------------------
   EVALUATE_CONFIG: score a config on the gold set, without shipping it.

   1. If its taxonomy version has no gold labels, label them (LABEL_GOLD_SET).
      Prompt-only candidates reuse the champion's labels and skip this.
   2. Classify every gold encounter with exactly this config (GOLD scope, an
      EVALUATION run: nothing reaches ENCOUNTER_THEME).
   3. RUN_EVAL, then report the EVAL_GATE verdict against the champion.

   Works on the champion too: that is how the first baseline gets made, and
   how drift is checked on demand.
---------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE EVALUATE_CONFIG(
    P_CONFIG_NAME   VARCHAR,
    P_LABELER_MODEL VARCHAR,
    P_VERIFIED_ONLY BOOLEAN
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_found      INT;
    v_version    VARCHAR;
    v_tax_status VARCHAR;
    v_gold       INT;
    v_label_msg  VARCHAR;
    v_cls_msg    VARCHAR;
    v_eval_msg   VARCHAR;
    v_run_id     VARCHAR;
    v_eval_id    VARCHAR;
    v_gate       VARCHAR;
    v_detail     VARCHAR;
    v_acc        FLOAT;
    v_base_acc   FLOAT;
    v_base_cfg   VARCHAR;
    v_labeled    BOOLEAN DEFAULT FALSE;
BEGIN
    SELECT COUNT(*), MAX(taxonomy_version_id) INTO :v_found, :v_version
      FROM CLASSIFIER_CONFIG WHERE config_name = :P_CONFIG_NAME;
    IF (v_found = 0) THEN
        RETURN 'REFUSED: config ''' || COALESCE(:P_CONFIG_NAME, '<null>') || ''' does not exist.';
    END IF;
    IF (v_version IS NULL) THEN
        RETURN 'REFUSED: ''' || :P_CONFIG_NAME || ''' is a template. Register a config from it '
            || 'with a taxonomy bound.';
    END IF;

    SELECT MAX(status) INTO :v_tax_status FROM TAXONOMY_VERSION WHERE version_id = :v_version;
    IF (COALESCE(v_tax_status, 'MISSING') NOT IN ('LOCKED', 'APPROVED', 'SUPERSEDED')) THEN
        RETURN 'REFUSED: ''' || :P_CONFIG_NAME || ''' is bound to ' || :v_version || ', which is '
            || COALESCE(:v_tax_status, 'MISSING') || '. LOCK_TAXONOMY it first: an evaluation '
            || 'of something that can still change is not evidence for shipping it.';
    END IF;

    SELECT COUNT(DISTINCT encounter_id) INTO :v_gold FROM GOLD_LABEL
     WHERE taxonomy_version_id = :v_version;
    IF (v_gold = 0) THEN
        CALL LABEL_GOLD_SET(:v_version, :P_LABELER_MODEL) INTO :v_label_msg;
        IF (STARTSWITH(:v_label_msg, 'REFUSED')) THEN
            RETURN v_label_msg;
        END IF;
        v_labeled := TRUE;
    END IF;

    CALL RUN_CLASSIFIER(:P_CONFIG_NAME, 'GOLD', NULL) INTO :v_cls_msg;
    IF (STARTSWITH(:v_cls_msg, 'REFUSED')) THEN
        RETURN v_cls_msg;
    END IF;
    v_run_id := SPLIT_PART(:v_cls_msg, ':', 1);

    CALL RUN_EVAL(:v_run_id, COALESCE(:P_VERIFIED_ONLY, FALSE)) INTO :v_eval_msg;
    IF (STARTSWITH(:v_eval_msg, 'REFUSED')) THEN
        RETURN v_eval_msg;
    END IF;
    v_eval_id := SPLIT_PART(:v_eval_msg, ':', 1);

    SELECT MAX(gate_result), MAX(regressed_detail), MAX(subtheme_accuracy),
           MAX(baseline_subtheme_accuracy), MAX(baseline_config_name)
      INTO :v_gate, :v_detail, :v_acc, :v_base_acc, :v_base_cfg
      FROM EVAL_GATE WHERE eval_id = :v_eval_id;

    RETURN :v_eval_id || ': ' || :P_CONFIG_NAME || ' on taxonomy ' || :v_version
        || CASE WHEN v_labeled THEN ' (gold labeled for ' || :v_version || ' first)' ELSE '' END
        || '. Subtheme accuracy ' || ROUND(:v_acc, 3)::VARCHAR
        || CASE WHEN v_base_cfg IS NULL THEN ', no champion eval to compare against'
                ELSE ' vs champion ' || :v_base_cfg || ' ' || ROUND(:v_base_acc, 3)::VARCHAR END
        || '. Gate: ' || :v_gate
        || CASE WHEN v_detail IS NOT NULL THEN ' [' || :v_detail || ']' ELSE '' END || '.';
END;
$$;


/* ----------------------------------------------------------------------------
   PROMOTE_CONFIG: the one door into production.

   Requires an evaluation of this exact config. If its latest eval does not
   PASS the gate against the current champion, promotion is refused unless
   P_OVERRIDE_REASON says why a person is shipping it anyway. That reason, the
   verdict and the baseline it was judged against go into PROMOTION_LOG.

   In one transaction: the config's taxonomy becomes APPROVED (the previous one
   SUPERSEDED), the config becomes the champion, and the log row is written.
   Promoting a config whose taxonomy is SUPERSEDED is a rollback and works the
   same way.

   It does not re-classify anything. The returned message says how many
   encounters have no production label from the new champion; running BACKLOG
   for them is a separate, costed decision.
---------------------------------------------------------------------------- */
CREATE OR REPLACE PROCEDURE PROMOTE_CONFIG(
    P_CONFIG_NAME     VARCHAR,
    P_PROMOTED_BY     VARCHAR,
    P_OVERRIDE_REASON VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_found      INT;
    v_active     BOOLEAN;
    v_version    VARCHAR;
    v_tax_status VARCHAR;
    v_eval_id    VARCHAR;
    v_gate       VARCHAR;
    v_base_eval  VARCHAR;
    v_acc        FLOAT;
    v_base_acc   FLOAT;
    v_override   VARCHAR;
    v_prev_cfg   VARCHAR;
    v_prev_tax   VARCHAR;
    v_promo_id   VARCHAR;
    v_backlog    INT;
BEGIN
    IF (TRIM(COALESCE(:P_PROMOTED_BY, '')) = '') THEN
        RETURN 'REFUSED: P_PROMOTED_BY is required. A promotion is a decision someone owns.';
    END IF;

    SELECT COUNT(*), BOOLOR_AGG(is_active), MAX(taxonomy_version_id)
      INTO :v_found, :v_active, :v_version
      FROM CLASSIFIER_CONFIG WHERE config_name = :P_CONFIG_NAME;
    IF (v_found = 0) THEN
        RETURN 'REFUSED: config ''' || COALESCE(:P_CONFIG_NAME, '<null>') || ''' does not exist.';
    END IF;
    IF (v_active) THEN
        RETURN 'REFUSED: ''' || :P_CONFIG_NAME || ''' is already the champion.';
    END IF;
    IF (v_version IS NULL) THEN
        RETURN 'REFUSED: ''' || :P_CONFIG_NAME || ''' is a template and cannot run.';
    END IF;

    SELECT MAX(status) INTO :v_tax_status FROM TAXONOMY_VERSION WHERE version_id = :v_version;
    IF (COALESCE(v_tax_status, 'MISSING') NOT IN ('LOCKED', 'APPROVED', 'SUPERSEDED')) THEN
        RETURN 'REFUSED: taxonomy ' || :v_version || ' is ' || COALESCE(:v_tax_status, 'MISSING')
            || '. Only a LOCKED (or previously shipped) version can go to production.';
    END IF;

    SELECT MAX_BY(eval_id, evaluated_at) INTO :v_eval_id
      FROM EVAL_RUN WHERE config_name = :P_CONFIG_NAME;
    IF (v_eval_id IS NULL) THEN
        RETURN 'REFUSED: ''' || :P_CONFIG_NAME || ''' has never been evaluated. Run '
            || 'EVALUATE_CONFIG first; an override cannot stand in for evidence that does not exist.';
    END IF;

    SELECT MAX(gate_result), MAX(baseline_eval_id), MAX(subtheme_accuracy), MAX(baseline_subtheme_accuracy)
      INTO :v_gate, :v_base_eval, :v_acc, :v_base_acc
      FROM EVAL_GATE WHERE eval_id = :v_eval_id;

    v_override := NULLIF(TRIM(COALESCE(:P_OVERRIDE_REASON, '')), '');
    IF (v_gate <> 'PASS' AND v_override IS NULL) THEN
        RETURN 'REFUSED: latest eval ' || :v_eval_id || ' did not pass the gate (' || :v_gate
            || '). Fix the candidate, or promote with an override reason, which is recorded '
            || 'in PROMOTION_LOG.';
    END IF;
    IF (v_gate = 'PASS') THEN
        v_override := NULL;   -- nothing was overridden
    END IF;

    SELECT MAX(config_name), MAX(taxonomy_version_id) INTO :v_prev_cfg, :v_prev_tax
      FROM ACTIVE_CONFIG;

    v_promo_id := 'promo_' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDD_HH24MISS_FF3');

    BEGIN TRANSACTION;

    /* Exactly one APPROVED version, and it is the champion's. */
    UPDATE TAXONOMY_VERSION
       SET status = 'SUPERSEDED'
     WHERE status = 'APPROVED' AND version_id <> :v_version;

    UPDATE TAXONOMY_VERSION
       SET status = 'APPROVED', reviewed_by = :P_PROMOTED_BY, reviewed_at = CURRENT_TIMESTAMP(),
           review_notes = 'Promoted with config ' || :P_CONFIG_NAME || ' on ' || :v_eval_id
                          || ' (' || :v_gate || ')'
     WHERE version_id = :v_version AND status <> 'APPROVED';

    /* Exactly one champion. One statement, so there is never a moment with two
       active rows or none. */
    UPDATE CLASSIFIER_CONFIG SET is_active = (config_name = :P_CONFIG_NAME);

    INSERT INTO PROMOTION_LOG
      (promotion_id, config_name, taxonomy_version_id, previous_config_name,
       previous_taxonomy_version_id, eval_id, baseline_eval_id, subtheme_accuracy,
       baseline_subtheme_accuracy, gate_result, override_reason, promoted_by)
    VALUES (:v_promo_id, :P_CONFIG_NAME, :v_version, :v_prev_cfg, :v_prev_tax, :v_eval_id,
            :v_base_eval, :v_acc, :v_base_acc, :v_gate, :v_override, :P_PROMOTED_BY);

    COMMIT;

    SELECT COUNT(*) INTO :v_backlog FROM ENCOUNTER_PREP p
     WHERE NOT EXISTS (SELECT 1 FROM CLASSIFICATION c
                         JOIN PIPELINE_RUN r ON r.run_id = c.run_id AND r.purpose = 'PRODUCTION'
                        WHERE c.encounter_id = p.encounter_id
                          AND c.config_name = :P_CONFIG_NAME);

    RETURN :v_promo_id || ': ' || :P_CONFIG_NAME || ' (taxonomy ' || :v_version
        || ') is the champion'
        || CASE WHEN v_prev_cfg IS NULL THEN '' ELSE ', replacing ' || :v_prev_cfg END
        || '. Gate on ' || :v_eval_id || ': ' || :v_gate
        || CASE WHEN v_override IS NOT NULL THEN ' -- OVERRIDDEN by ' || :P_PROMOTED_BY
                     || ': ' || RTRIM(:v_override, '.') ELSE '' END
        || '. ' || :v_backlog::VARCHAR || ' encounter(s) have no production label from it yet; '
        || 'CALL CLASSIFY_BATCH(''BACKLOG'') to backfill.';
EXCEPTION
    WHEN OTHER THEN
        ROLLBACK;
        RAISE;
END;
$$;


SELECT 'Evaluation and promotion ready. Next: CALL EVALUATE_CONFIG(''<config>'', '
    || '''openai-gpt-5.2'', FALSE), then PROMOTE_CONFIG.' AS next_step;
