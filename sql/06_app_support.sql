/* ============================================================================
   PAN Lines Theme Extraction Pipeline: 06 APP SUPPORT
   ----------------------------------------------------------------------------
   The two objects the web app in webapp/ needs that 00-05 do not already
   expose. Everything with a rule in it (register, evaluate, promote, classify)
   lives in 03 and 04, so a notebook or a SQL worksheet gets the same guard
   rails as the app. Nothing in 00-05 depends on this file.

   No behavior lives in TypeScript: the UI calls procedures and reads SQL
   objects, so every number on screen is produced by SQL. Simple page-level
   aggregates live in webapp/lib/queries.ts rather than as views here.

   Objects:
     PREVIEW_PROMPT()       try a config (optionally on a DRAFT taxonomy) on N
                            encounters, writing nothing
     APP_RUN_STATUS         one row per run: progress, the zero-hallucination
                            check, cost and eval verdict

   PREREQUISITE: 00 through 05.
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;

/* Remove an obsolete procedure and a superseded PREVIEW_PROMPT overload, if
   present, so the CREATE below leaves a single signature. */
DROP PROCEDURE IF EXISTS CLASSIFY_SAMPLE(VARCHAR, INT);
DROP PROCEDURE IF EXISTS PREVIEW_PROMPT(VARCHAR, INT);


/* ============================================================================
   1. PREVIEW_PROMPT: a smoke test before running a full evaluation.

   Writes nothing. Returns the model's output for N encounters so a rubric
   edit, or a taxonomy still being edited, can be eyeballed before anything is
   locked, registered or scored.

   P_CONFIG_NAME          the prompt + model to try (a template works too)
   P_TAXONOMY_VERSION_ID  NULL for the config's own taxonomy, or any version,
                          including a DRAFT, to see how the prompt behaves on it
   P_LIMIT                encounters to try, capped at 25

   The enum constraint is live in the preview, so a preview cannot produce an
   out-of-taxonomy label any more than a real run can. Only the model name is
   concatenated into the dynamic SQL; the prompt and rendering are staged
   through bound SQL.
============================================================================ */
CREATE OR REPLACE PROCEDURE PREVIEW_PROMPT(
    P_CONFIG_NAME         VARCHAR,
    P_TAXONOMY_VERSION_ID VARCHAR,
    P_LIMIT               INT
)
RETURNS TABLE()
LANGUAGE SQL
AS
$$
DECLARE
    v_found   INT;
    v_model   VARCHAR;
    v_version VARCHAR;
    v_ready   INT;
    v_limit   INT;
    v_stmt    VARCHAR;
    res       RESULTSET;
BEGIN
    v_limit := LEAST(GREATEST(COALESCE(:P_LIMIT, 5), 1), 25);

    SELECT COUNT(*), MAX(model), COALESCE(:P_TAXONOMY_VERSION_ID, MAX(taxonomy_version_id))
      INTO :v_found, :v_model, :v_version
      FROM CLASSIFIER_CONFIG WHERE config_name = :P_CONFIG_NAME;
    IF (v_found = 0) THEN
        res := (SELECT 'REFUSED: config ' || COALESCE(:P_CONFIG_NAME, '<null>')
                       || ' does not exist.' AS message);
        RETURN TABLE(res);
    END IF;
    IF (v_version IS NULL) THEN
        res := (SELECT 'REFUSED: ' || :P_CONFIG_NAME || ' is a template; pass a taxonomy '
                       || 'version to preview it against.' AS message);
        RETURN TABLE(res);
    END IF;
    IF (NOT REGEXP_LIKE(COALESCE(:v_model, ''), '[A-Za-z0-9._-]{1,64}')) THEN
        res := (SELECT 'REFUSED: model is not a valid model name.' AS message);
        RETURN TABLE(res);
    END IF;

    CREATE OR REPLACE TEMPORARY TABLE _prev_ctx AS
    SELECT c.prompt_template, t.version_id, t.taxonomy_text, t.response_format
      FROM CLASSIFIER_CONFIG c
      JOIN TAXONOMY_RENDERED t ON t.version_id = :v_version
     WHERE c.config_name = :P_CONFIG_NAME;

    SELECT COUNT(*) INTO :v_ready FROM _prev_ctx;
    IF (v_ready = 0) THEN
        res := (SELECT 'REFUSED: taxonomy ' || :v_version || ' does not exist or has no nodes.' AS message);
        RETURN TABLE(res);
    END IF;

    v_stmt :=
       'SELECT src.encounter_id,'
    || '       src.is_gold,'
    || '       src.version_id                        AS taxonomy_version_id,'
    || '       LEFT(src.full_text, 240)              AS note_excerpt,'
    || '       r:value:primary_subtheme::VARCHAR     AS primary_subtheme,'
    || '       r:value:secondary_subtheme::VARCHAR   AS secondary_subtheme,'
    || '       r:value:confidence::VARCHAR           AS confidence,'
    || '       r:value:evidence::VARCHAR             AS evidence,'
    || '       r:error::VARCHAR                      AS error'
    || '  FROM ('
    || '   SELECT p.encounter_id, g.encounter_id IS NOT NULL AS is_gold, p.full_text, x.version_id,'
    || '     AI_COMPLETE('
    || '       model  => ''' || :v_model || ''','
    || '       prompt => REPLACE(REPLACE(x.prompt_template, ''{{TAXONOMY}}'', x.taxonomy_text),'
    || '                         ''{{NOTE}}'', p.full_text),'
    || '       model_parameters => {''temperature'': 0},'
    || '       response_format  => x.response_format,'
    || '       return_error_details => TRUE) AS r'
    || '   FROM (SELECT * FROM ENCOUNTER_PREP ORDER BY encounter_id LIMIT ' || :v_limit::VARCHAR || ') p'
    || '   LEFT JOIN GOLD_ENCOUNTER g ON g.encounter_id = p.encounter_id'
    || '   CROSS JOIN _prev_ctx x'
    || '  ) src ORDER BY src.encounter_id';

    res := (EXECUTE IMMEDIATE :v_stmt);
    RETURN TABLE(res);
END;
$$;


/* ============================================================================
   2. APP_RUN_STATUS: one object for the whole run panel.

   The UI polls this single view while a run is in flight rather than stitching
   PIPELINE_RUN, RUN_COST, EVAL_SCORECARD and EVAL_GATE together client-side.

   OUT-OF-TAXONOMY is the pipeline's core guarantee, measured per run. It is
   checked against the taxonomy version that PRODUCED each run, not the one
   active now: a v001 run must be judged by v001's node list, or promoting v002
   would retroactively make old rows look out-of-taxonomy. NO_GOOD_MATCH is
   excluded because it is a legitimate enum member (the escape hatch that
   makes gap detection possible), not a hallucination.

   ACCOUNT_USAGE is asynchronous, so token and credit columns are NULL for a
   few minutes after a run finishes and then backfill. cost_pending lets the
   app show that as "pending" rather than as a misleading zero.
============================================================================ */
CREATE OR REPLACE VIEW APP_RUN_STATUS AS
WITH oot AS (
    SELECT
        c.run_id,
        COUNT_IF(c.subtheme = 'NO_GOOD_MATCH')                         AS no_good_match_labels,
        COUNT_IF(c.subtheme <> 'NO_GOOD_MATCH' AND n.subtheme IS NULL) AS out_of_taxonomy_labels
    FROM CLASSIFICATION c
    LEFT JOIN TAXONOMY_NODE n
           ON n.version_id = c.taxonomy_version_id
          AND n.subtheme   = c.subtheme
    GROUP BY c.run_id
)
SELECT
    r.run_id,
    r.mode,
    r.purpose,
    r.taxonomy_version_id,
    r.config_name,
    r.model,
    r.started_at,
    r.completed_at,
    CASE WHEN r.completed_at IS NULL THEN 'RUNNING' ELSE 'COMPLETE' END AS run_status,
    r.encounters_in,
    r.labels_out,
    r.error_count,
    DATEDIFF(second, r.started_at, COALESCE(r.completed_at, CURRENT_TIMESTAMP())) AS duration_sec,
    ROUND(DIV0(r.labels_out::FLOAT, r.encounters_in), 3) AS labels_per_encounter,
    oot.out_of_taxonomy_labels,
    oot.no_good_match_labels,
    cost.tokens_total,
    cost.tokens_input,
    cost.tokens_output,
    cost.token_credits,
    cost.tokens_per_encounter,
    cost.credits_per_1k_encounters,
    CASE WHEN r.completed_at IS NOT NULL AND cost.tokens_total IS NULL
         THEN TRUE ELSE FALSE END AS cost_pending,
    ev.eval_id,
    ev.subtheme_accuracy,
    ev.theme_accuracy,
    ev.label_set_f1,
    g.gate_result
FROM PIPELINE_RUN r
LEFT JOIN oot                    ON oot.run_id  = r.run_id
LEFT JOIN RUN_COST         cost  ON cost.run_id = r.run_id
LEFT JOIN EVAL_SCORECARD   ev    ON ev.run_id   = r.run_id
LEFT JOIN EVAL_GATE        g     ON g.eval_id   = ev.eval_id
/* A run can be evaluated more than once (e.g. once all-gold, once
   verified-only). Keep the latest eval so the panel has one row per run. */
QUALIFY ROW_NUMBER() OVER (PARTITION BY r.run_id ORDER BY ev.evaluated_at DESC NULLS LAST) = 1;


SELECT 'App support ready. PREVIEW_PROMPT + APP_RUN_STATUS.' AS next_step;
