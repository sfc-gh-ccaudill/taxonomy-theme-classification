/* ============================================================================
   PAN Lines Theme Extraction Pipeline: 05 GAP DETECTION & REVISION LOOP
   ----------------------------------------------------------------------------
   Finds what the taxonomy is missing, drafts a revision, and routes it back
   through evaluation and promotion:

     drift detection -> revision cycle -> evaluation -> artifact versioning

   THE DETECTION SIGNAL
   Two signals, unioned:
     NO_GOOD_MATCH     the model says outright that nothing fits
     LOW confidence    the model forced a fit and reported it was unsure

   Recall is deliberately not the goal: naming a missing concept takes a
   handful of clean examples, not every instance of it. Both signals are used
   because a smaller model under a strict enum rarely volunteers NO_GOOD_MATCH;
   LOW confidence is the higher-recall half of the pair.

   Because labels are constrained to the taxonomy, a missing concept surfaces
   here as an unplaceable encounter rather than as an invented label name.

   PREREQUISITE: 00-04, with a champion that has classified a production batch.
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;


/* ============================================================================
   1. TAXONOMY_GAP_REVIEW: what the taxonomy is missing, with evidence.

   Shows the note text and the model's own evidence string, so a reviewer can
   read the flagged rows and name the missing concept without trusting
   anything the model concluded.

   Reads ENCOUNTER_THEME, so only PRODUCTION output is mined. Evaluation runs of
   candidates never show up here.

   Is it a one-off or a pattern worth a taxonomy change? Count it:
     SELECT gap_signal, COUNT(*) FROM TAXONOMY_GAP_REVIEW GROUP BY ALL;
   A handful of scattered encounters is noise; a cluster is a gap.
============================================================================ */
CREATE OR REPLACE VIEW TAXONOMY_GAP_REVIEW AS
SELECT
    c.encounter_id,
    c.taxonomy_version_id,
    CASE WHEN c.subtheme = 'NO_GOOD_MATCH' THEN 'NO_GOOD_MATCH'
         ELSE 'LOW_CONFIDENCE' END              AS gap_signal,
    c.subtheme                                  AS forced_label,
    c.confidence,
    c.evidence,
    p.full_text                                 AS note_text
FROM ENCOUNTER_THEME c
JOIN ENCOUNTER_PREP p ON p.encounter_id = c.encounter_id
WHERE c.label_rank = 1
  AND (c.subtheme = 'NO_GOOD_MATCH' OR c.confidence = 'LOW');


/* ============================================================================
   2. PROPOSE_TAXONOMY_REVISION: turn the gap into a DRAFT revision.

   Copies EVERY node from the current approved version into a new DRAFT, then
   adds only what the model proposes. Two reasons that matters:
     - TAXONOMY_DIFF shows a reviewer only the added rows, not the whole
       taxonomy.
     - The new version is complete and standalone, so shipping it cannot
       accidentally drop existing subthemes.

   The draft is a starting point, not a decision: edit it (EDIT_TAXONOMY_NODE),
   LOCK_TAXONOMY it, bind it into a config and EVALUATE_CONFIG that. Only
   PROMOTE_CONFIG puts it in production.

   The model is explicitly forbidden from restructuring existing nodes. A
   revision that also reworded existing descriptions would be hard to review,
   and would invalidate the gold labels tied to the previous version.
============================================================================ */
CREATE OR REPLACE PROCEDURE PROPOSE_TAXONOMY_REVISION(
    P_MODEL      VARCHAR,
    P_CREATED_BY VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_parent     VARCHAR;
    v_new        VARCHAR;
    v_gap_n      INT;
    v_gap_notes  VARCHAR;
    v_tax_text   VARCHAR;
    v_prompt     VARCHAR;
    v_added      INT;
    v_copied     INT;
    v_err        VARCHAR;
BEGIN
    IF (NOT REGEXP_LIKE(COALESCE(:P_MODEL, ''), '[A-Za-z0-9._-]{1,64}')) THEN
        RETURN 'REFUSED: model ''' || COALESCE(:P_MODEL, '<null>') || ''' is not a valid model name.';
    END IF;

    SELECT version_id, taxonomy_text INTO :v_parent, :v_tax_text FROM TAXONOMY_ACTIVE;
    IF (v_parent IS NULL) THEN
        RETURN 'REFUSED: no APPROVED taxonomy version to revise.';
    END IF;

    SELECT COUNT(*) INTO :v_gap_n FROM TAXONOMY_GAP_REVIEW;
    IF (v_gap_n = 0) THEN
        RETURN 'Nothing to do: no gap candidates. Either the taxonomy covers the '
            || 'corpus, or no batch has been classified yet.';
    END IF;

    SELECT 'v' || LPAD((COALESCE(MAX(TRY_TO_NUMBER(SUBSTR(version_id, 2))), 0) + 1)::VARCHAR, 3, '0')
      INTO :v_new FROM TAXONOMY_VERSION;

    /* The unplaceable encounters, with the model's own account of why. */
    SELECT LISTAGG('--- encounter ' || rn::VARCHAR || ' [' || gap_signal || ']' || CHAR(10)
                   || 'NOTE: ' || note_text || CHAR(10)
                   || 'CLASSIFIER SAID: ' || COALESCE(evidence,'(none)'), '\n')
      INTO :v_gap_notes
      FROM (SELECT ROW_NUMBER() OVER (ORDER BY encounter_id) AS rn,
                   gap_signal, note_text, evidence
            FROM TAXONOMY_GAP_REVIEW);

    v_prompt := 'You maintain the classification taxonomy for a Patient Advisory Nurse '
      || 'post-discharge call program. A production batch has just been classified. The '
      || :v_gap_n::VARCHAR || ' encounters below could NOT be placed confidently: the '
      || 'classifier either reported NO_GOOD_MATCH or assigned a label with LOW confidence.'
      || CHAR(10) || CHAR(10)
      || 'CURRENT TAXONOMY (version ' || :v_parent || ')' || CHAR(10) || :v_tax_text
      || CHAR(10) || CHAR(10)
      || 'UNPLACEABLE ENCOUNTERS' || CHAR(10) || :v_gap_notes
      || CHAR(10) || CHAR(10)
      || 'YOUR TASK' || CHAR(10)
      || 'Decide whether these encounters reveal a genuine GAP -- a concept the taxonomy '
      || 'does not cover -- and if so propose the MINIMUM set of new subthemes that would '
      || 'cover them.' || CHAR(10) || CHAR(10)
      || 'RULES' || CHAR(10)
      || '- Propose ONLY additions. Do not rename, reword, re-parent or delete anything '
      || 'that already exists. Existing labels are in use and are tied to already-reviewed '
      || 'evaluation data.' || CHAR(10)
      || '- Add as few subthemes as genuinely cover the evidence. Two precise subthemes beat '
      || 'six speculative ones. If one is enough, propose one.' || CHAR(10)
      || '- You may place new subthemes under an EXISTING category and theme, or introduce a '
      || 'new theme within an existing category if the concept does not fit any current theme. '
      || 'Prefer reusing an existing category.' || CHAR(10)
      || '- Every new subtheme name must be unique against the whole current taxonomy, Title '
      || 'Case, 2 to 6 words, no abbreviations.' || CHAR(10)
      || '- Each needs a decisive one-sentence description, and a routing_note stating how it '
      || 'differs from the nearest EXISTING subtheme -- that boundary is what stops the new '
      || 'label from cannibalising an old one. Use an empty string only if there is genuinely '
      || 'no near neighbour.' || CHAR(10)
      || '- If these encounters do NOT reveal a real gap (they are merely thin or genuinely '
      || 'ambiguous notes), return an EMPTY nodes array and explain that in the rationale. '
      || 'Proposing nothing is a valid and sometimes correct answer.' || CHAR(10)
      || '- In the rationale, name the missing concept in plain language and say how many of '
      || 'the encounters it accounts for.';

    /* model must be a literal -> dynamic SQL. CTAS + split fields because
       return_error_details yields a typed OBJECT(value, error), not a VARIANT. */
    CREATE OR REPLACE TEMPORARY TABLE _rev_prompt AS SELECT :v_prompt AS p;

    EXECUTE IMMEDIATE
      'CREATE OR REPLACE TEMPORARY TABLE _rev AS '
      || 'SELECT r:value AS val, r:error::VARCHAR AS err FROM ('
      || '  SELECT AI_COMPLETE('
      || '    model  => ''' || :P_MODEL || ''','
      || '    prompt => p,'
      || '    model_parameters => {''temperature'': 0, ''max_tokens'': 8000},'
      || '    response_format  => PARSE_JSON(''{"type":"json","schema":{'
      || '       "type":"object","additionalProperties":false,'
      || '       "properties":{'
      || '         "rationale":{"type":"string"},'
      || '         "nodes":{"type":"array","items":{'
      || '           "type":"object","additionalProperties":false,'
      || '           "properties":{"category":{"type":"string"},"theme":{"type":"string"},'
      || '                         "subtheme":{"type":"string"},"description":{"type":"string"},'
      || '                         "routing_note":{"type":"string"}},'
      || '           "required":["category","theme","subtheme","description","routing_note"]}}},'
      || '       "required":["rationale","nodes"]}}''),'
      || '    return_error_details => TRUE) AS r'
      || '  FROM _rev_prompt)';

    SELECT err INTO :v_err FROM _rev;
    IF (v_err IS NOT NULL) THEN
        RETURN 'REVISION PROPOSAL FAILED: ' || :v_err;
    END IF;

    INSERT INTO TAXONOMY_VERSION
      (version_id, service_line, status, parent_version_id, generated_by_model,
       source_sample_size, generation_rationale, created_by)
    SELECT :v_new,
           (SELECT service_line FROM TAXONOMY_ACTIVE),
           'DRAFT', :v_parent, :P_MODEL, :v_gap_n,
           val:rationale::VARCHAR, :P_CREATED_BY
    FROM _rev;

    /* Carry the whole parent version forward unchanged (minus any blank node,
       which can't be a label). */
    INSERT INTO TAXONOMY_NODE (version_id, category, theme, subtheme, description, routing_note)
    SELECT :v_new, category, theme, subtheme, description, routing_note
    FROM TAXONOMY_NODE WHERE version_id = :v_parent
     AND TRIM(COALESCE(category, '')) <> ''
     AND TRIM(COALESCE(theme, '')) <> ''
     AND TRIM(COALESCE(subtheme, '')) <> '';
    v_copied := SQLROWCOUNT;

    /* Then add the proposals, skipping any name that already exists (the primary
       key would reject it anyway, and a rename is not an addition) and any blank
       node the model emits. */
    INSERT INTO TAXONOMY_NODE (version_id, category, theme, subtheme, description, routing_note)
    SELECT :v_new, category, theme, subtheme, description, routing_note
    FROM (
      SELECT TRIM(n.value:category::VARCHAR) AS category,
             TRIM(n.value:theme::VARCHAR)    AS theme,
             TRIM(n.value:subtheme::VARCHAR) AS subtheme,
             n.value:description::VARCHAR    AS description,
             n.value:routing_note::VARCHAR   AS routing_note,
             ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(n.value:subtheme::VARCHAR))
                                ORDER BY n.index) AS rn
      FROM _rev t, LATERAL FLATTEN(input => t.val:nodes) n
      WHERE TRIM(COALESCE(n.value:category::VARCHAR, '')) <> ''
        AND TRIM(COALESCE(n.value:theme::VARCHAR, '')) <> ''
        AND TRIM(COALESCE(n.value:subtheme::VARCHAR, '')) <> ''
    ) prop
    WHERE prop.rn = 1
      AND NOT EXISTS (SELECT 1 FROM TAXONOMY_NODE ex
                       WHERE ex.version_id = :v_new
                         AND LOWER(ex.subtheme) = LOWER(prop.subtheme));
    v_added := SQLROWCOUNT;

    IF (v_added = 0) THEN
        RETURN 'DRAFT ' || :v_new || ' created but proposes NO additions -- the model '
            || 'judged these ' || :v_gap_n::VARCHAR || ' encounters not to be a real gap. '
            || 'Read TAXONOMY_VERSION.generation_rationale, then REJECT_TAXONOMY if you agree.';
    END IF;

    RETURN 'DRAFT ' || :v_new || ' proposes ' || :v_added::VARCHAR || ' new subtheme(s) '
        || 'from ' || :v_gap_n::VARCHAR || ' unplaceable encounters (' || :v_copied::VARCHAR
        || ' existing carried forward). Review: SELECT * FROM TABLE(TAXONOMY_DIFF('''
        || :v_parent || ''',''' || :v_new || ''')); edit if needed, then LOCK_TAXONOMY('''
        || :v_new || ''', ''<your name>'').';
END;
$$;


/* ============================================================================
   3. QUEUE_GAP_ENCOUNTERS: for a targeted production re-run.

   Usually not needed. After a new config is PROMOTED, no encounter has a
   production label from it, so CLASSIFY_BATCH('BACKLOG') re-classifies the
   whole corpus. That is the right default because it keeps numbers
   comparable across versions.

   Use this when you want production to re-run only the previously unplaceable
   encounters. To judge a revision BEFORE shipping it, evaluate it instead
   (EVALUATE_CONFIG): that scores it on gold without touching production.
============================================================================ */
CREATE OR REPLACE PROCEDURE QUEUE_GAP_ENCOUNTERS(P_REASON VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_n INT;
BEGIN
    DELETE FROM RECLASSIFY_QUEUE;
    INSERT INTO RECLASSIFY_QUEUE (encounter_id, reason)
    SELECT DISTINCT encounter_id, :P_REASON FROM TAXONOMY_GAP_REVIEW;
    v_n := SQLROWCOUNT;
    RETURN :v_n::VARCHAR || ' encounter(s) queued. Next: CALL CLASSIFY_BATCH(''RECLASSIFY'');';
END;
$$;


/* ============================================================================
   4. DID THE REVISION ACTUALLY HELP?

   Answered BEFORE it ships: EVALUATE_CONFIG on a config bound to the revision
   puts it on EVAL_SCORECARD next to the champion, and EVAL_GATE judges it.
   No dedicated object is needed:

     SELECT config_name, taxonomy_version_id, is_champion, subtheme_accuracy,
            theme_accuracy, label_set_f1, no_good_match_rate
     FROM EVAL_SCORECARD ORDER BY evaluated_at;

   And where it moved. The signals that flagged the gap should fall: the
   NO_GOOD_MATCH rate, and the gold encounters the reference labeler could
   not place:

     SELECT config_name, taxonomy_version_id, segment_value, n, subtheme_accuracy, gated
     FROM EVAL_SEGMENT_DETAIL WHERE segment_name = 'CATEGORY'
     ORDER BY segment_value, evaluated_at;
============================================================================ */


/* ============================================================================
   5. OPTIONAL: alert on regression.

   Emails when an evaluation of the CHAMPION in the last day failed EVAL_GATE,
   i.e. production drifted against its own previous eval. A failing candidate
   is not an incident (refusing to promote it is the gate doing its job), so
   candidate evals are excluded. Created SUSPENDED because delivery needs an
   EMAIL notification integration and verified recipient addresses, which are
   account-specific. Both come from the alert's CONFIG, so enabling it takes
   a few statements rather than an edit to this file:

     CREATE NOTIFICATION INTEGRATION PAN_ALERT_EMAIL_INT
       TYPE = EMAIL ENABLED = TRUE;                       -- needs ACCOUNTADMIN
     ALTER ALERT QUALITY_REGRESSION_ALERT SET CONFIG =
       $${"integration": "PAN_ALERT_EMAIL_INT", "recipients": "you@example.com"}$$;
     ALTER ALERT QUALITY_REGRESSION_ALERT RESUME;

   Everything it needs is already in EVAL_GATE.
============================================================================ */
CREATE OR REPLACE ALERT QUALITY_REGRESSION_ALERT
    WAREHOUSE = PAN_DEMO_WH
    SCHEDULE  = '1440 MINUTE'
    CONFIG    = $${"integration": "PAN_ALERT_EMAIL_INT", "recipients": ""}$$
    IF (EXISTS (
        SELECT eval_id, config_name, gate_result FROM EVAL_GATE
        WHERE gate_result <> 'PASS'
          AND is_champion
          AND eval_id IN (SELECT eval_id FROM EVAL_RUN
                          WHERE evaluated_at > DATEADD(day, -1, CURRENT_TIMESTAMP()))
    ))
    THEN EXECUTE IMMEDIATE $$
    BEGIN
        LET v_integration VARCHAR := SYSTEM$GET_ALERT_CONFIG('integration');
        LET v_recipients  VARCHAR := SYSTEM$GET_ALERT_CONFIG('recipients');
        LET v_body        VARCHAR;
        SELECT LISTAGG(eval_id || ' (' || config_name || '): ' || gate_result, '\n')
          INTO :v_body
          FROM TABLE(RESULT_SCAN(SNOWFLAKE.ALERT.GET_CONDITION_QUERY_UUID()));
        CALL SYSTEM$SEND_EMAIL(
            :v_integration,
            :v_recipients,
            'PAN Lines: champion failed its evaluation gate',
            'These evaluations of the production config failed EVAL_GATE in the last day:\n\n' || :v_body);
    END;
    $$;

ALTER ALERT QUALITY_REGRESSION_ALERT SUSPEND;


SELECT 'Revision loop ready. Start with: SELECT * FROM TAXONOMY_GAP_REVIEW;' AS next_step;
