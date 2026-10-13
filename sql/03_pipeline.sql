/* ============================================================================
   PAN Lines Theme Extraction Pipeline: 03 CLASSIFICATION PIPELINE
   ----------------------------------------------------------------------------
   An incremental, declarative encounter rollup feeding a single set-based
   AI_COMPLETE call per batch.

     NOTE_RAW
       └─> DT: ENCOUNTER_PREP          incremental, deterministic, no LLM
             └─> STREAM (ON DYNAMIC TABLE)
                   └─> TASK (scheduled, WHEN SYSTEM$STREAM_HAS_DATA)
                         └─> CLASSIFY_BATCH('STREAM') -> RUN_CLASSIFIER()
                               ├─> CLASSIFICATION_RAW   exact model output (audit)
                               └─> CLASSIFICATION       one row per label
                                     + PIPELINE_RUN     run log w/ query_id, purpose

   ONE CLASSIFIER, TWO PURPOSES
   RUN_CLASSIFIER runs any registered config (prompt + model + taxonomy). What
   a run is FOR is derived from its scope, never passed in:
     PRODUCTION   BACKLOG / STREAM / RECLASSIFY, champion config only. These rows
                  are the business output (ENCOUNTER_THEME).
     EVALUATION   GOLD scope, any config with a LOCKED or shipped taxonomy. These
                  rows are scored by RUN_EVAL and never reach ENCOUNTER_THEME, so
                  trying a candidate cannot leak into production output.

   WHY HYBRID RATHER THAN ALL DYNAMIC TABLES
   The LLM step must stamp the config and taxonomy version on every row. If
   classification were itself a dynamic table joined to the champion config,
   promoting a new one would invalidate every row and silently trigger a full
   re-classification. Splitting at the stream makes re-classification an
   explicit, costed decision (BACKLOG after a promotion). The deterministic
   rollup stays fully declarative.

   TWO DOCUMENTED CONSTRAINTS THIS RESPECTS
   - Streams require ON DYNAMIC TABLE (ON TABLE errors), and the DT must resolve
     to REFRESH_MODE = INCREMENTAL. Checked below via SHOW DYNAMIC TABLES.
   - Triggered tasks do NOT work on dynamic-table streams. Hence a SCHEDULED
     task with a WHEN SYSTEM$STREAM_HAS_DATA() guard.

   OPERATIONAL GOTCHA
   NOTE_RAW is owned by PIPELINE (created in 00). Never CREATE OR REPLACE it:
   that drops its history, reinitializes the dynamic table, and can make the
   stream stale. Loaders (01_synthetic_data.sql in the demo) write into it with
   INSERT / INSERT OVERWRITE instead. If NOTE_RAW is ever replaced anyway,
   re-run this file afterwards.

   PREREQUISITE: 00 and 02 to build this file. To classify: the input tables
   loaded and a locked taxonomy version. Production scopes also need a champion
   config (PROMOTE_CONFIG in 04).
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;


/* ============================================================================
   1. ENCOUNTER_PREP: one row per encounter.

   Rolls note-level rows up to the encounter and concatenates multi-note
   encounters into a single text. Fully incremental: only changed encounters
   are recomputed.

   LISTAGG is compatible with incremental refresh (it resolves to
   INCREMENTAL, not a silent downgrade to FULL). That matters because a
   FULL-refresh dynamic table cannot carry a stream at all.
============================================================================ */
CREATE OR REPLACE DYNAMIC TABLE ENCOUNTER_PREP
    TARGET_LAG   = '1 minute'
    WAREHOUSE    = PAN_DEMO_WH
    REFRESH_MODE = INCREMENTAL
AS
SELECT
    encounter_id,
    service_line,
    COUNT(*)                                                       AS note_count,
    MIN(discharge_date)                                            AS discharge_date,
    MAX(call_date)                                                 AS last_call_date,
    LISTAGG(note_text, '\n') WITHIN GROUP (ORDER BY note_seq)       AS full_text
FROM NOTE_RAW
GROUP BY encounter_id, service_line;

/* Confirm the resolved mode. If refresh_mode comes back FULL, the stream below
   cannot be created and this pipeline needs the plain-table fallback. */
SHOW DYNAMIC TABLES LIKE 'ENCOUNTER_PREP';


/* ============================================================================
   2. OUTPUT TABLES

   CLASSIFICATION_RAW keeps the exact model output per encounter. It is the
   audit trail ("show me what the model actually returned"), and it decouples
   stream consumption from row expansion, so a failure in expansion is
   replayable rather than lost.
============================================================================ */
CREATE TABLE IF NOT EXISTS CLASSIFICATION_RAW (
    run_id              VARCHAR       NOT NULL,
    encounter_id        VARCHAR       NOT NULL,
    taxonomy_version_id VARCHAR       NOT NULL,
    config_name         VARCHAR       NOT NULL,
    model               VARCHAR       NOT NULL,
    result              VARIANT,                   -- the model's structured output
    error               VARCHAR,                   -- non-null => the call failed
    classified_at       TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

/* Append-only. One row per (encounter, label). THEME and CATEGORY are derived
   by join, never asked of the model, so a theme/subtheme mismatch is
   structurally impossible rather than a metric to watch. */
CREATE TABLE IF NOT EXISTS CLASSIFICATION (
    run_id              VARCHAR       NOT NULL,
    encounter_id        VARCHAR       NOT NULL,
    label_rank          INT           NOT NULL,   -- 1 = primary, 2 = secondary
    subtheme            VARCHAR       NOT NULL,   -- always in-taxonomy or NO_GOOD_MATCH
    theme               VARCHAR,                  -- NULL when NO_GOOD_MATCH
    category            VARCHAR,                  -- NULL when NO_GOOD_MATCH
    confidence          VARCHAR,
    evidence            VARCHAR,
    taxonomy_version_id VARCHAR       NOT NULL,
    config_name         VARCHAR       NOT NULL,
    model               VARCHAR       NOT NULL,
    classified_at       TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

/* Run log. QUERY_ID is the join key for cost attribution in 04.
   It is captured from SQLID after EXECUTE IMMEDIATE because ALTER SESSION is
   not permitted inside a stored procedure: a proc cannot set its own
   QUERY_TAG, and only the caller could tag it. */
CREATE TABLE IF NOT EXISTS PIPELINE_RUN (
    run_id              VARCHAR       NOT NULL,
    mode                VARCHAR       NOT NULL,   -- BACKLOG | STREAM | RECLASSIFY | GOLD
    purpose             VARCHAR,                  -- PRODUCTION | EVALUATION (derived from mode)
    started_at          TIMESTAMP_LTZ NOT NULL,
    completed_at        TIMESTAMP_LTZ,
    taxonomy_version_id VARCHAR,
    config_name         VARCHAR,
    model               VARCHAR,
    encounters_in       INT,
    labels_out          INT,
    error_count         INT,
    query_id            VARCHAR,
    CONSTRAINT pk_pipeline_run PRIMARY KEY (run_id)
);

/* Adds purpose to an existing PIPELINE_RUN that lacks it; a no-op otherwise. */
ALTER TABLE PIPELINE_RUN ADD COLUMN IF NOT EXISTS purpose VARCHAR;


/* Queue used by RECLASSIFY mode (driven from 05). */
CREATE TABLE IF NOT EXISTS RECLASSIFY_QUEUE (
    encounter_id VARCHAR NOT NULL,
    queued_at    TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    reason       VARCHAR
);


/* ============================================================================
   3. THE STREAM

   Standard (delta) type: APPEND_ONLY is not supported on dynamic table
   streams, so the task filters METADATA$ACTION = 'INSERT' instead.

   A stream's offset starts at CREATION, so it sees nothing that already
   existed. Hence two entry points: BACKLOG for existing encounters, and the
   task for everything that arrives afterwards.
============================================================================ */
CREATE OR REPLACE STREAM ENCOUNTER_PREP_STREAM ON DYNAMIC TABLE ENCOUNTER_PREP;


/* ============================================================================
   4. RUN_CLASSIFIER: the one place classification happens.

   P_CONFIG_NAME  a registered config, or NULL for the champion (ACTIVE_CONFIG)
   P_SCOPE        which encounters:
                    BACKLOG     no production label from the champion yet
                    STREAM      whatever the stream has (consumed atomically by the CTAS)
                    RECLASSIFY  encounters listed in RECLASSIFY_QUEUE (used by 05)
                    GOLD        the gold encounters, for evaluation
   P_LIMIT        NULL for all, or a bound for demo pacing. Refused for STREAM:
                  the CTAS that lands results also advances the stream offset,
                  so a LIMIT would consume the whole stream while classifying
                  part of it and silently drop the rest.

   PURPOSE IS DERIVED, NOT PASSED
   GOLD is always EVALUATION. Every other scope is PRODUCTION and only the
   champion may run it. So a candidate can be scored as often as you like, but
   the only way its labels become business output is PROMOTE_CONFIG.

   BACKLOG MEANS "NO PRODUCTION LABEL FROM THE CHAMPION"
   Keyed on the config, not just the taxonomy, because the config is the whole
   recipe. After a promotion, BACKLOG is the full corpus: re-classifying is an
   explicit, costed run, never implicit. Until it runs, ENCOUNTER_THEME keeps
   showing the previous labels if they were produced under the same approved
   taxonomy.

   Dynamic SQL is needed for exactly one reason: AI_COMPLETE's `model` must be a
   string literal. Nothing else is concatenated: the config, its prompt and its
   taxonomy rendering are staged in a temp table through bound SQL, and
   response_format is passed as a plain VARIANT column from it.
============================================================================ */
CREATE OR REPLACE PROCEDURE RUN_CLASSIFIER(P_CONFIG_NAME VARCHAR, P_SCOPE VARCHAR, P_LIMIT INT)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_scope      VARCHAR;
    v_config     VARCHAR;
    v_found      INT;
    v_model      VARCHAR;
    v_version    VARCHAR;
    v_tax_status VARCHAR;
    v_active     BOOLEAN;
    v_purpose    VARCHAR;
    v_source     VARCHAR;
    v_limit      VARCHAR;
    v_run_id     VARCHAR;
    v_in         INT;
    v_out        INT;
    v_errors     INT;
    v_query_id   VARCHAR;
BEGIN
    v_scope := UPPER(TRIM(COALESCE(:P_SCOPE, '')));
    IF (v_scope NOT IN ('BACKLOG', 'STREAM', 'RECLASSIFY', 'GOLD')) THEN
        RETURN 'REFUSED: unknown scope ''' || COALESCE(:P_SCOPE, '<null>')
            || '''. Use BACKLOG, STREAM, RECLASSIFY or GOLD.';
    END IF;
    IF (:P_LIMIT IS NOT NULL AND :P_LIMIT < 1) THEN
        RETURN 'REFUSED: P_LIMIT must be NULL or >= 1.';
    END IF;
    IF (v_scope = 'STREAM' AND :P_LIMIT IS NOT NULL) THEN
        RETURN 'REFUSED: STREAM cannot be bounded. The CTAS that lands results also '
            || 'advances the stream offset, so a LIMIT would consume the whole stream '
            || 'while classifying only part of it and silently drop the rest.';
    END IF;

    /* NULL means the champion. Aggregates rather than a bare SELECT INTO, so an
       empty ACTIVE_CONFIG yields NULL instead of an error. */
    IF (:P_CONFIG_NAME IS NULL) THEN
        SELECT MAX(config_name) INTO :v_config FROM ACTIVE_CONFIG;
        IF (v_config IS NULL) THEN
            RETURN 'REFUSED: no champion config. Register, evaluate and promote one first.';
        END IF;
    ELSE
        v_config := :P_CONFIG_NAME;
    END IF;

    SELECT COUNT(*), MAX(model), MAX(taxonomy_version_id), BOOLOR_AGG(is_active)
      INTO :v_found, :v_model, :v_version, :v_active
      FROM CLASSIFIER_CONFIG WHERE config_name = :v_config;
    IF (v_found = 0) THEN
        RETURN 'REFUSED: config ''' || :v_config || ''' does not exist.';
    END IF;
    IF (v_version IS NULL) THEN
        RETURN 'REFUSED: ''' || :v_config || ''' is a template (no taxonomy). Register a '
            || 'config from it with REGISTER_CONFIG, binding a taxonomy version.';
    END IF;
    IF (NOT REGEXP_LIKE(COALESCE(:v_model, ''), '[A-Za-z0-9._-]{1,64}')) THEN
        RETURN 'REFUSED: model ''' || COALESCE(:v_model, '<null>') || ''' is not a valid model name.';
    END IF;

    SELECT MAX(status) INTO :v_tax_status FROM TAXONOMY_VERSION WHERE version_id = :v_version;
    IF (COALESCE(v_tax_status, 'MISSING') NOT IN ('LOCKED', 'APPROVED', 'SUPERSEDED')) THEN
        RETURN 'REFUSED: ''' || :v_config || ''' is bound to taxonomy ' || :v_version || ', which is '
            || COALESCE(:v_tax_status, 'MISSING') || '. Only a LOCKED or shipped version can be '
            || 'classified against (PREVIEW_PROMPT works on drafts and writes nothing).';
    END IF;

    IF (v_scope = 'GOLD') THEN
        v_purpose := 'EVALUATION';
    ELSE
        v_purpose := 'PRODUCTION';
        IF (NOT v_active) THEN
            RETURN 'REFUSED: ''' || :v_config || ''' is not the champion, so it cannot write '
                || 'production output (' || :v_scope || '). Score it with the GOLD scope or '
                || 'EVALUATE_CONFIG, and PROMOTE_CONFIG it if it should ship.';
        END IF;
        IF (v_tax_status <> 'APPROVED') THEN
            RETURN 'REFUSED: the champion is bound to ' || :v_version || ', which is '
                || :v_tax_status || ', not APPROVED. Re-promote a config to repair the registry.';
        END IF;
    END IF;

    /* Stage the recipe through bound SQL: one row with the prompt and this
       version's rendered rubric + enum. The dynamic statement reads it by name. */
    CREATE OR REPLACE TEMPORARY TABLE _cls_ctx AS
    SELECT c.config_name, c.prompt_template, t.version_id, t.taxonomy_text, t.response_format
      FROM CLASSIFIER_CONFIG c
      JOIN TAXONOMY_RENDERED t ON t.version_id = c.taxonomy_version_id
     WHERE c.config_name = :v_config;

    v_limit := CASE WHEN :P_LIMIT IS NULL THEN ''
                    ELSE ' ORDER BY p.encounter_id LIMIT ' || :P_LIMIT::VARCHAR END;

    /* Row selection per scope. Everything downstream is identical. */
    CASE (v_scope)
      WHEN 'BACKLOG' THEN
        v_source := 'SELECT p.encounter_id, p.full_text FROM ENCOUNTER_PREP p '
                 || 'WHERE NOT EXISTS (SELECT 1 FROM CLASSIFICATION c '
                 || '  JOIN PIPELINE_RUN r ON r.run_id = c.run_id AND r.purpose = ''PRODUCTION'' '
                 || '  JOIN _cls_ctx x ON x.config_name = c.config_name '
                 || '  WHERE c.encounter_id = p.encounter_id)' || v_limit;
      WHEN 'STREAM' THEN
        v_source := 'SELECT s.encounter_id, s.full_text FROM ENCOUNTER_PREP_STREAM s '
                 || 'WHERE s.METADATA$ACTION = ''INSERT''';
      WHEN 'RECLASSIFY' THEN
        v_source := 'SELECT p.encounter_id, p.full_text FROM ENCOUNTER_PREP p '
                 || 'JOIN RECLASSIFY_QUEUE q ON q.encounter_id = p.encounter_id' || v_limit;
      WHEN 'GOLD' THEN
        v_source := 'SELECT p.encounter_id, p.full_text FROM ENCOUNTER_PREP p '
                 || 'JOIN GOLD_ENCOUNTER g ON g.encounter_id = p.encounter_id' || v_limit;
    END CASE;

    /* Milliseconds in the id: two runs can start in the same second (evaluate
       twice in a row) and Snowflake does not enforce the primary key. */
    v_run_id := 'run_' || TO_VARCHAR(CURRENT_TIMESTAMP(), 'YYYYMMDD_HH24MISS_FF3')
             || '_' || LOWER(v_scope);

    INSERT INTO PIPELINE_RUN
      (run_id, mode, purpose, started_at, taxonomy_version_id, config_name, model)
    VALUES (:v_run_id, :v_scope, :v_purpose, CURRENT_TIMESTAMP(), :v_version, :v_config, :v_model);

    /* One set-based statement over the whole batch. Cortex parallelizes a
       set-based call internally, so there is no batch size or partition count
       to tune.

       The CTAS is also what CONSUMES the stream in STREAM mode: a stream
       advances its offset only when used in a DML transaction, and CTAS counts.
       One statement means the offset advances exactly when the rows land. */
    EXECUTE IMMEDIATE
       'CREATE OR REPLACE TEMPORARY TABLE _cls AS '
    || 'SELECT src.encounter_id, r:value AS result, r:error::VARCHAR AS error FROM ('
    || '  SELECT src.encounter_id, AI_COMPLETE('
    || '     model  => ''' || :v_model || ''','
    || '     prompt => REPLACE(REPLACE(x.prompt_template, ''{{TAXONOMY}}'', x.taxonomy_text),'
    || '                       ''{{NOTE}}'', src.full_text),'
    || '     model_parameters => {''temperature'': 0},'
    || '     response_format  => x.response_format,'
    || '     return_error_details => TRUE) AS r'
    || '  FROM (' || :v_source || ') src'
    || '  CROSS JOIN _cls_ctx x) src';

    v_query_id := SQLID;   -- procs cannot ALTER SESSION to set a query tag, so record the query id

    INSERT INTO CLASSIFICATION_RAW
      (run_id, encounter_id, taxonomy_version_id, config_name, model, result, error)
    SELECT :v_run_id, encounter_id, :v_version, :v_config, :v_model, result, error FROM _cls;

    /* Expand to one row per label. Secondary only when the model actually
       returned a distinct second concern. */
    INSERT INTO CLASSIFICATION
      (run_id, encounter_id, label_rank, subtheme, theme, category,
       confidence, evidence, taxonomy_version_id, config_name, model)
    SELECT :v_run_id, c.encounter_id, lbl.label_rank, lbl.subtheme,
           n.theme, n.category,
           c.result:confidence::VARCHAR, c.result:evidence::VARCHAR,
           :v_version, :v_config, :v_model
    FROM _cls c
    JOIN (
        SELECT encounter_id, 1 AS label_rank, result:primary_subtheme::VARCHAR AS subtheme
        FROM _cls WHERE error IS NULL
        UNION ALL
        SELECT encounter_id, 2, result:secondary_subtheme::VARCHAR
        FROM _cls
        WHERE error IS NULL AND result:secondary_subtheme::VARCHAR NOT IN ('NONE','')
    ) lbl ON lbl.encounter_id = c.encounter_id
    /* Deterministic theme/category derivation, from THIS run's taxonomy
       version. No match => NO_GOOD_MATCH => NULL. */
    LEFT JOIN TAXONOMY_NODE n ON n.version_id = :v_version AND n.subtheme = lbl.subtheme
    WHERE c.error IS NULL;

    SELECT COUNT(*), COUNT_IF(error IS NOT NULL) INTO :v_in, :v_errors FROM _cls;
    SELECT COUNT(*) INTO :v_out FROM CLASSIFICATION WHERE run_id = :v_run_id;

    UPDATE PIPELINE_RUN
       SET completed_at = CURRENT_TIMESTAMP(), encounters_in = :v_in,
           labels_out = :v_out, error_count = :v_errors, query_id = :v_query_id
     WHERE run_id = :v_run_id;

    RETURN :v_run_id || ': ' || :v_in::VARCHAR || ' encounters in, '
        || :v_out::VARCHAR || ' labels out, ' || :v_errors::VARCHAR || ' errors, '
        || :v_purpose || ' run of config ' || :v_config || ' (taxonomy ' || :v_version
        || ', model ' || :v_model || ').';
END;
$$;


/* The production entry point the task calls: the champion, one scope, no
   bound. Kept as its own name so the task DDL and the runbook read naturally. */
CREATE OR REPLACE PROCEDURE CLASSIFY_BATCH(P_MODE VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_msg VARCHAR;
BEGIN
    IF (UPPER(COALESCE(:P_MODE, '')) NOT IN ('BACKLOG', 'STREAM', 'RECLASSIFY')) THEN
        RETURN 'REFUSED: CLASSIFY_BATCH runs production scopes only (BACKLOG, STREAM, '
            || 'RECLASSIFY). Evaluate a config with EVALUATE_CONFIG.';
    END IF;
    CALL RUN_CLASSIFIER(NULL, :P_MODE, NULL) INTO :v_msg;
    RETURN v_msg;
END;
$$;


/* ============================================================================
   5. THE TASK

   Scheduled + WHEN guard, not triggered: triggered tasks do not work on
   dynamic-table streams. With the WHEN clause, a refresh that changes nothing
   costs nothing because the task does not fire.

   Created SUSPENDED so setup does not start consuming credits. Resume it to
   start processing new notes.
============================================================================ */
CREATE OR REPLACE TASK CLASSIFY_ENCOUNTERS
    WAREHOUSE = PAN_DEMO_WH
    SCHEDULE  = '1 MINUTE'
    WHEN SYSTEM$STREAM_HAS_DATA('ENCOUNTER_PREP_STREAM')
AS
    CALL CLASSIFY_BATCH('STREAM');

ALTER TASK CLASSIFY_ENCOUNTERS SUSPEND;


/* ============================================================================
   6. READ SURFACE

   ENCOUNTER_THEME is the business-facing output: the current label(s) per
   encounter from PRODUCTION runs under the APPROVED taxonomy. Evaluation runs
   (gold scoring of candidates, or of the champion) never appear here, so
   trying a candidate cannot change what the business sees.

   The encounter's latest production run wins, and ALL its labels come from
   that run. Ranking per label_rank instead would let a stale secondary label
   from an older run survive under a newer primary. History stays in
   CLASSIFICATION.

   Finding low-count themes (candidates for consolidation) is a GROUP BY on
   this view, not an object of its own:
     SELECT category, theme, COUNT(DISTINCT encounter_id) AS encounters
     FROM ENCOUNTER_THEME WHERE theme IS NOT NULL GROUP BY ALL ORDER BY encounters;
============================================================================ */
CREATE OR REPLACE VIEW ENCOUNTER_THEME AS
SELECT c.encounter_id, p.service_line, p.last_call_date, p.note_count,
       c.label_rank, c.category, c.theme, c.subtheme,
       c.confidence, c.evidence, c.taxonomy_version_id, c.config_name,
       c.run_id, c.classified_at
FROM CLASSIFICATION c
JOIN PIPELINE_RUN r
  ON r.run_id = c.run_id AND r.purpose = 'PRODUCTION'
JOIN TAXONOMY_VERSION tv
  ON tv.version_id = c.taxonomy_version_id AND tv.status = 'APPROVED'
JOIN ENCOUNTER_PREP p ON p.encounter_id = c.encounter_id
QUALIFY DENSE_RANK() OVER (PARTITION BY c.encounter_id
                           ORDER BY r.started_at DESC, c.run_id DESC) = 1;


SELECT 'Pipeline built. Next: register a config bound to a locked taxonomy, '
    || 'EVALUATE_CONFIG and PROMOTE_CONFIG it (04), then CALL CLASSIFY_BATCH(''BACKLOG'').' AS next_step;
