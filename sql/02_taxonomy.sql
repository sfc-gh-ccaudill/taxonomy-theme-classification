/* ============================================================================
   PAN Lines Theme Extraction Pipeline - 02 TAXONOMY REGISTRY
   ----------------------------------------------------------------------------
   Taxonomy governance: a versioned registry with an explicit lifecycle.

   LIFECYCLE
     DRAFT       editable. Proposed by a model, forked from another version, or
                 both, then edited by hand.
     LOCKED      frozen. Can be gold-labeled, bound into a classifier config and
                 evaluated. Locking is what makes an evaluation mean something:
                 the thing scored is the thing that would ship.
     APPROVED    in production. Set ONLY by PROMOTE_CONFIG (04), when a config
                 bound to this version is promoted past the eval gate.
     SUPERSEDED  was in production. Promoting a config bound to it again is a
                 rollback.
     REJECTED    a recorded no.

   The pipeline reads TAXONOMY_ACTIVE, the one APPROVED version. A DRAFT or
   LOCKED version has zero effect on production no matter how good it looks,
   which is what makes the taxonomy safe to iterate on.

   Objects:
     TAXONOMY_VERSION / TAXONOMY_NODE   durable, versioned (never OR REPLACE)
     PROPOSE_TAXONOMY()                 LLM generates a DRAFT from a note sample
     FORK_TAXONOMY()                    copy any version into a new DRAFT
     EDIT_TAXONOMY_NODE()               add / update / delete a node in a DRAFT
     LOCK_TAXONOMY() / REJECT_...()     freeze for evaluation, or record a no
     TAXONOMY_RENDERED                  rubric text + enum response_format, per version
     TAXONOMY_ACTIVE                    the production contract: TAXONOMY_RENDERED
                                        filtered to the APPROVED version
     TAXONOMY_DIFF()                    what a reviewer reads: added / removed /
                                        reworded between versions
     LABEL_GOLD_SET()                   bootstraps gold labels for one version
     GOLD_LABEL                         the labels LABEL_GOLD_SET writes, per version

   PREREQUISITE: 00_setup.sql, with NOTE_RAW, DISCOVERY_SAMPLE and
   GOLD_ENCOUNTER loaded (in the demo, by 01_synthetic_data.sql).
============================================================================ */

USE SCHEMA PAN_DEMO_DB.PIPELINE;


/* ============================================================================
   1. REGISTRY TABLES

   CREATE TABLE IF NOT EXISTS, deliberately. These two tables ARE the durable
   asset: a CREATE OR REPLACE in a rerunnable setup script would silently
   destroy approval history.
============================================================================ */
CREATE TABLE IF NOT EXISTS TAXONOMY_VERSION (
    version_id          VARCHAR       NOT NULL,
    service_line        VARCHAR       NOT NULL,
    status              VARCHAR       NOT NULL,   -- DRAFT | LOCKED | APPROVED | SUPERSEDED | REJECTED
    parent_version_id   VARCHAR,                  -- set when this is a revision
    generated_by_model  VARCHAR,
    source_sample_size  INT,
    generation_rationale VARCHAR,
    created_by          VARCHAR       NOT NULL,
    created_at          TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    locked_by           VARCHAR,
    locked_at           TIMESTAMP_LTZ,
    reviewed_by         VARCHAR,                  -- who promoted it to production, or rejected it
    reviewed_at         TIMESTAMP_LTZ,
    review_notes        VARCHAR,
    CONSTRAINT pk_taxonomy_version PRIMARY KEY (version_id)
);

/* Adds the lock columns to a table created before LOCKED existed.
   No-ops on a fresh build. */
ALTER TABLE TAXONOMY_VERSION ADD COLUMN IF NOT EXISTS locked_by VARCHAR;
ALTER TABLE TAXONOMY_VERSION ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP_LTZ;

CREATE TABLE IF NOT EXISTS TAXONOMY_NODE (
    version_id   VARCHAR NOT NULL,
    category     VARCHAR NOT NULL,
    theme        VARCHAR NOT NULL,
    subtheme     VARCHAR NOT NULL,
    description  VARCHAR,
    routing_note VARCHAR,
    CONSTRAINT pk_taxonomy_node PRIMARY KEY (version_id, subtheme)
);


/* ============================================================================
   2. PROPOSE_TAXONOMY: LLM generates a taxonomy from the discovery sample.

   Writes a DRAFT. Never touches what the pipeline is using.

   Dynamic SQL is required for exactly one reason: AI_COMPLETE's `model`
   argument MUST be a string literal. It cannot come from a parameter or a
   config column any other way. (response_format, by contrast, accepts a
   VARIANT column reference, which is why TAXONOMY_ACTIVE can drive the
   classifier without any dynamic SQL at all.)

   The prompt covers four things: coverage domains, structural rules, quality
   requirements, and an explicit anti-anchoring instruction.
============================================================================ */
CREATE OR REPLACE PROCEDURE PROPOSE_TAXONOMY(
    P_SERVICE_LINE VARCHAR,
    P_MODEL        VARCHAR,
    P_CREATED_BY   VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_version_id  VARCHAR;
    v_sample_size INT;
    v_notes       VARCHAR;
    v_prompt      VARCHAR;
    v_node_count  INT;
    v_blank       INT;
    v_err         VARCHAR;
BEGIN
    /* The model name is concatenated into dynamic SQL below, so it must be a
       plain identifier. */
    IF (NOT REGEXP_LIKE(COALESCE(:P_MODEL, ''), '[A-Za-z0-9._-]{1,64}')) THEN
        RETURN 'REFUSED: model ''' || :P_MODEL || ''' is not a valid model name.';
    END IF;

    /* Next version id: v001, v002, ... */
    SELECT 'v' || LPAD((COALESCE(MAX(TRY_TO_NUMBER(SUBSTR(version_id, 2))), 0) + 1)::VARCHAR, 3, '0')
      INTO :v_version_id
      FROM TAXONOMY_VERSION;

    SELECT COUNT(*) INTO :v_sample_size FROM DISCOVERY_SAMPLE;

    /* The sample the taxonomy is designed from. Numbered so the model can be
       told to cover all of them.
       Two constraints collide here: a window function may not appear inside
       LISTAGG (hence the subquery), and LISTAGG's delimiter must be a literal
       constant (hence '\n' rather than CHAR(10)). */
    SELECT LISTAGG('--- note ' || rn::VARCHAR || ' ---' || CHAR(10) || note_text, '\n')
      INTO :v_notes
      FROM (SELECT ROW_NUMBER() OVER (ORDER BY encounter_id) AS rn, note_text
            FROM DISCOVERY_SAMPLE);

    v_prompt := 'You are designing a controlled classification taxonomy for a Patient Advisory Nurse '
      || '(PAN) post-discharge telephone follow-up program, service line: ' || :P_SERVICE_LINE || '.\n\n'
      || 'Below is a representative sample of ' || :v_sample_size::VARCHAR || ' free-text call notes. '
      || 'Design a taxonomy that a team of nurse analysts could apply consistently to tens of '
      || 'thousands of these notes per year.\n\n'
      || 'STRUCTURAL RULES\n'
      || '- Three tiers: CATEGORY > THEME > SUBTHEME.\n'
      || '- Produce 6 to 8 categories, 15 to 20 themes, and 45 to 65 subthemes in total.\n'
      || '- Every subtheme belongs to exactly one theme, and every theme to exactly one category.\n'
      || '- Subtheme names: Title Case, 2 to 6 words, no abbreviations, no punctuation.\n'
      || '- Subtheme names must be unique across the WHOLE taxonomy, not just within a theme.\n'
      || '- Every node needs a non-empty category, theme AND subtheme. Do not emit a theme-level '
      || 'row with an empty subtheme to describe the theme itself.\n\n'
      || 'QUALITY REQUIREMENTS\n'
      || '- Each subtheme needs a one-sentence description stating plainly what belongs in it. '
      || 'These descriptions are the operational definition analysts will rely on, so make them '
      || 'decisive rather than vague.\n'
      || '- Subthemes must be as close to mutually exclusive as the domain allows. Where two could '
      || 'plausibly overlap, use routing_note on at least one of them to state which wins and why. '
      || 'Leave routing_note as an empty string when there is no overlap worth noting.\n'
      || '- Include categories for clinical symptoms, post-operative concerns, medication issues, '
      || 'care coordination, patient education, and access or social barriers, IF the notes support '
      || 'them. Also include an administrative category for calls where no substantive concern was '
      || 'discussed (no answer, wrong number, declined, nothing to report) -- these appear in the '
      || 'sample and need somewhere to go.\n'
      || '- Distinguish post-operative presentations of a symptom from the general presentation of '
      || 'that same symptom where the notes justify it. That distinction drives clinical routing.\n\n'
      || 'ANTI-ANCHORING\n'
      || '- Do NOT mirror the order, wording, or proportions of the sample. Generalize. The sample '
      || 'is evidence of what occurs, not a template to copy.\n'
      || '- Do NOT create a subtheme to fit a single unusual note. Aim for categories that will '
      || 'still be populated next quarter.\n'
      || '- Do NOT include a catch-all "Other" or "Miscellaneous" subtheme. Unclassifiable notes are '
      || 'handled separately and a catch-all would hide taxonomy gaps.\n\n'
      || 'CALL NOTES\n' || :v_notes;

    /* model must be a literal -> dynamic SQL. Land raw output first so a
       failure is inspectable instead of vanishing.

       NOTE on shape: return_error_details => TRUE changes the return TYPE to
       OBJECT(value VARIANT, error VARCHAR): a typed struct, not a VARIANT.
       Inserting it into a VARIANT column fails with "expecting VARIANT but got
       OBJECT(value ..., error ...)". So the two fields are split out at write
       time and the landing table is built by CTAS so types are inferred.
       Passing the prompt via a temp table rather than a bind keeps the DDL
       free of bind parameters. */
    CREATE OR REPLACE TEMPORARY TABLE _tax_prompt AS SELECT :v_prompt AS p;

    EXECUTE IMMEDIATE
      'CREATE OR REPLACE TEMPORARY TABLE _tax_gen AS '
      || 'SELECT r:value AS val, r:error::VARCHAR AS err FROM ('
      || '  SELECT AI_COMPLETE('
      || '    model  => ''' || :P_MODEL || ''','
      || '    prompt => p,'
      || '    model_parameters => {''temperature'': 0, ''max_tokens'': 32000},'
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
      || '  FROM _tax_prompt)';

    SELECT err INTO :v_err FROM _tax_gen;
    IF (v_err IS NOT NULL) THEN
        RETURN 'GENERATION FAILED: ' || v_err;
    END IF;

    INSERT INTO TAXONOMY_VERSION
      (version_id, service_line, status, generated_by_model, source_sample_size,
       generation_rationale, created_by)
    SELECT :v_version_id, :P_SERVICE_LINE, 'DRAFT', :P_MODEL, :v_sample_size,
           val:rationale::VARCHAR, :P_CREATED_BY
    FROM _tax_gen;

    /* Blank nodes never land. The model sometimes ignores the rule above and
       writes a theme-level row with an empty subtheme, and a blank would
       become a legal enum value. Counted so the message says what was dropped
       instead of losing it silently. */
    SELECT COUNT_IF(TRIM(COALESCE(n.value:category::VARCHAR, '')) = ''
                 OR TRIM(COALESCE(n.value:theme::VARCHAR, '')) = ''
                 OR TRIM(COALESCE(n.value:subtheme::VARCHAR, '')) = '')
      INTO :v_blank
      FROM _tax_gen t, LATERAL FLATTEN(input => t.val:nodes) n;

    /* DISTINCT on subtheme: the model occasionally repeats a subtheme name
       across two themes, which would violate the primary key. Keeping the first
       occurrence is the right call: a duplicate name is unusable as a label
       either way, and the reviewer sees the node count in the draft review. */
    INSERT INTO TAXONOMY_NODE (version_id, category, theme, subtheme, description, routing_note)
    SELECT :v_version_id, category, theme, subtheme, description, routing_note
    FROM (
      SELECT TRIM(n.value:category::VARCHAR) AS category,
             TRIM(n.value:theme::VARCHAR)    AS theme,
             TRIM(n.value:subtheme::VARCHAR) AS subtheme,
             n.value:description::VARCHAR    AS description,
             n.value:routing_note::VARCHAR   AS routing_note,
             ROW_NUMBER() OVER (PARTITION BY LOWER(TRIM(n.value:subtheme::VARCHAR))
                                ORDER BY n.index) AS rn
      FROM _tax_gen t, LATERAL FLATTEN(input => t.val:nodes) n
      WHERE TRIM(COALESCE(n.value:category::VARCHAR, '')) <> ''
        AND TRIM(COALESCE(n.value:theme::VARCHAR, '')) <> ''
        AND TRIM(COALESCE(n.value:subtheme::VARCHAR, '')) <> ''
    ) WHERE rn = 1;

    SELECT COUNT(*) INTO :v_node_count FROM TAXONOMY_NODE WHERE version_id = :v_version_id;

    RETURN 'DRAFT ' || :v_version_id || ' created with ' || :v_node_count::VARCHAR
        || ' subthemes'
        || IFF(:v_blank > 0, ' (' || :v_blank::VARCHAR || ' blank node(s) from the model dropped)', '')
        || '. Review with SELECT * FROM TAXONOMY_NODE WHERE version_id = '''
        || :v_version_id || ''', edit with EDIT_TAXONOMY_NODE, then CALL LOCK_TAXONOMY('''
        || :v_version_id || ''', ''<your name>'') to freeze it for evaluation.';
END;
$$;


/* ============================================================================
   3. AUTHORING: fork, edit, lock, reject

   Nothing here touches production. A version only reaches production when a
   classifier config bound to it is promoted past the eval gate (04).
============================================================================ */

/* Copy any version into a new DRAFT, parented on its source. The usual way to
   start a hand edit, or to try a variation of a version already in use. */
CREATE OR REPLACE PROCEDURE FORK_TAXONOMY(
    P_SOURCE_VERSION_ID VARCHAR,
    P_CREATED_BY        VARCHAR,
    P_NOTES             VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_exists INT;
    v_new    VARCHAR;
    v_copied INT;
BEGIN
    SELECT COUNT(*) INTO :v_exists FROM TAXONOMY_VERSION WHERE version_id = :P_SOURCE_VERSION_ID;
    IF (v_exists = 0) THEN
        RETURN 'REFUSED: version ' || COALESCE(:P_SOURCE_VERSION_ID, '<null>') || ' does not exist.';
    END IF;

    SELECT 'v' || LPAD((COALESCE(MAX(TRY_TO_NUMBER(SUBSTR(version_id, 2))), 0) + 1)::VARCHAR, 3, '0')
      INTO :v_new FROM TAXONOMY_VERSION;

    INSERT INTO TAXONOMY_VERSION
      (version_id, service_line, status, parent_version_id, generated_by_model,
       source_sample_size, generation_rationale, created_by)
    SELECT :v_new, service_line, 'DRAFT', version_id, NULL, NULL,
           COALESCE(:P_NOTES, 'Forked from ' || version_id), :P_CREATED_BY
      FROM TAXONOMY_VERSION WHERE version_id = :P_SOURCE_VERSION_ID;

    /* Blank nodes are not carried forward, so a fork can never inherit one. */
    INSERT INTO TAXONOMY_NODE (version_id, category, theme, subtheme, description, routing_note)
    SELECT :v_new, category, theme, subtheme, description, routing_note
      FROM TAXONOMY_NODE WHERE version_id = :P_SOURCE_VERSION_ID
       AND TRIM(COALESCE(category, '')) <> ''
       AND TRIM(COALESCE(theme, '')) <> ''
       AND TRIM(COALESCE(subtheme, '')) <> '';
    v_copied := SQLROWCOUNT;

    RETURN 'DRAFT ' || :v_new || ' forked from ' || :P_SOURCE_VERSION_ID || ' with '
        || :v_copied::VARCHAR || ' subthemes. Edit with EDIT_TAXONOMY_NODE, then LOCK_TAXONOMY.';
END;
$$;


/* One node edit on a DRAFT.
     P_ACTION  ADD     insert a new subtheme (P_ORIGINAL_SUBTHEME ignored)
               UPDATE  change the node currently named P_ORIGINAL_SUBTHEME;
                       renaming is allowed
               DELETE  remove the node named P_ORIGINAL_SUBTHEME
   The checks are the ones the enum depends on: a subtheme name is the label,
   so it must be non-blank, unique ignoring case, and must not collide with the
   two reserved enum values. */
CREATE OR REPLACE PROCEDURE EDIT_TAXONOMY_NODE(
    P_VERSION_ID        VARCHAR,
    P_ACTION            VARCHAR,
    P_ORIGINAL_SUBTHEME VARCHAR,
    P_CATEGORY          VARCHAR,
    P_THEME             VARCHAR,
    P_SUBTHEME          VARCHAR,
    P_DESCRIPTION       VARCHAR,
    P_ROUTING_NOTE      VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_status    VARCHAR;
    v_action    VARCHAR;
    v_category  VARCHAR;
    v_theme     VARCHAR;
    v_subtheme  VARCHAR;
    v_desc      VARCHAR;
    v_route     VARCHAR;
    v_found     INT;
    v_clash     INT;
BEGIN
    SELECT status INTO :v_status FROM TAXONOMY_VERSION WHERE version_id = :P_VERSION_ID;
    IF (v_status IS NULL) THEN
        RETURN 'REFUSED: version ' || COALESCE(:P_VERSION_ID, '<null>') || ' does not exist.';
    END IF;
    IF (v_status <> 'DRAFT') THEN
        RETURN 'REFUSED: version ' || :P_VERSION_ID || ' is ' || :v_status
            || '. Only a DRAFT can be edited; fork it with FORK_TAXONOMY to change it.';
    END IF;

    v_action := UPPER(TRIM(COALESCE(:P_ACTION, '')));

    IF (v_action = 'DELETE') THEN
        DELETE FROM TAXONOMY_NODE
         WHERE version_id = :P_VERSION_ID AND subtheme = :P_ORIGINAL_SUBTHEME;
        IF (SQLROWCOUNT = 0) THEN
            RETURN 'REFUSED: no subtheme ''' || COALESCE(:P_ORIGINAL_SUBTHEME, '<null>')
                || ''' in ' || :P_VERSION_ID || '.';
        END IF;
        RETURN 'Deleted ''' || :P_ORIGINAL_SUBTHEME || ''' from ' || :P_VERSION_ID || '.';
    END IF;

    IF (v_action NOT IN ('ADD', 'UPDATE')) THEN
        RETURN 'REFUSED: unknown action ''' || COALESCE(:P_ACTION, '<null>')
            || '''. Use ADD, UPDATE or DELETE.';
    END IF;

    v_category := TRIM(COALESCE(:P_CATEGORY, ''));
    v_theme    := TRIM(COALESCE(:P_THEME, ''));
    v_subtheme := TRIM(COALESCE(:P_SUBTHEME, ''));
    /* Computed here rather than inline: a VALUES clause rejects expressions
       over bind variables. */
    v_desc     := NULLIF(TRIM(COALESCE(:P_DESCRIPTION, '')), '');
    v_route    := TRIM(COALESCE(:P_ROUTING_NOTE, ''));

    IF (v_category = '' OR v_theme = '' OR v_subtheme = '') THEN
        RETURN 'REFUSED: category, theme and subtheme are all required. A blank '
            || 'subtheme would become a legal enum value.';
    END IF;
    IF (UPPER(v_subtheme) IN ('NO_GOOD_MATCH', 'NONE')) THEN
        RETURN 'REFUSED: ''' || :v_subtheme || ''' is reserved. NO_GOOD_MATCH and NONE '
            || 'are added to the enum automatically.';
    END IF;

    /* Unique ignoring case, excluding the node being updated. */
    SELECT COUNT(*) INTO :v_clash FROM TAXONOMY_NODE
     WHERE version_id = :P_VERSION_ID
       AND LOWER(subtheme) = LOWER(:v_subtheme)
       AND NOT (:v_action = 'UPDATE' AND subtheme = :P_ORIGINAL_SUBTHEME);
    IF (v_clash > 0) THEN
        RETURN 'REFUSED: a subtheme named ''' || :v_subtheme || ''' already exists in '
            || :P_VERSION_ID || '. Subtheme names are labels, so they must be unique.';
    END IF;

    IF (v_action = 'ADD') THEN
        INSERT INTO TAXONOMY_NODE (version_id, category, theme, subtheme, description, routing_note)
        VALUES (:P_VERSION_ID, :v_category, :v_theme, :v_subtheme, :v_desc, :v_route);
        RETURN 'Added ''' || :v_subtheme || ''' to ' || :P_VERSION_ID || '.';
    END IF;

    UPDATE TAXONOMY_NODE
       SET category     = :v_category,
           theme        = :v_theme,
           subtheme     = :v_subtheme,
           description  = :v_desc,
           routing_note = :v_route
     WHERE version_id = :P_VERSION_ID AND subtheme = :P_ORIGINAL_SUBTHEME;
    v_found := SQLROWCOUNT;
    IF (v_found = 0) THEN
        RETURN 'REFUSED: no subtheme ''' || COALESCE(:P_ORIGINAL_SUBTHEME, '<null>')
            || ''' in ' || :P_VERSION_ID || '.';
    END IF;
    RETURN 'Updated ''' || :P_ORIGINAL_SUBTHEME || ''''
        || CASE WHEN :P_ORIGINAL_SUBTHEME <> :v_subtheme
                THEN ' (renamed to ''' || :v_subtheme || ''')' ELSE '' END
        || ' in ' || :P_VERSION_ID || '.';
END;
$$;


/* Freeze a DRAFT for evaluation. Validates the whole version first, because
   once it is locked it can be gold-labeled and evaluated, and both of those
   must refer to a version that will never change underneath them. */
CREATE OR REPLACE PROCEDURE LOCK_TAXONOMY(
    P_VERSION_ID VARCHAR,
    P_LOCKED_BY  VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_status   VARCHAR;
    v_nodes    INT;
    v_blank    INT;
    v_reserved INT;
    v_dupes    INT;
BEGIN
    SELECT status INTO :v_status FROM TAXONOMY_VERSION WHERE version_id = :P_VERSION_ID;
    IF (v_status IS NULL) THEN
        RETURN 'REFUSED: version ' || COALESCE(:P_VERSION_ID, '<null>') || ' does not exist.';
    END IF;
    IF (v_status <> 'DRAFT') THEN
        RETURN 'REFUSED: version ' || :P_VERSION_ID || ' is ' || :v_status
            || '. Only a DRAFT can be locked.';
    END IF;

    SELECT COUNT(*),
           COUNT_IF(TRIM(COALESCE(subtheme,'')) = '' OR TRIM(COALESCE(theme,'')) = ''
                    OR TRIM(COALESCE(category,'')) = ''),
           COUNT_IF(UPPER(TRIM(subtheme)) IN ('NO_GOOD_MATCH', 'NONE')),
           COUNT(*) - COUNT(DISTINCT LOWER(subtheme))
      INTO :v_nodes, :v_blank, :v_reserved, :v_dupes
      FROM TAXONOMY_NODE WHERE version_id = :P_VERSION_ID;

    IF (v_nodes = 0) THEN
        RETURN 'REFUSED: version ' || :P_VERSION_ID || ' has no nodes.';
    END IF;
    IF (v_blank > 0) THEN
        RETURN 'REFUSED: ' || :v_blank::VARCHAR || ' node(s) in ' || :P_VERSION_ID
            || ' have a blank category, theme or subtheme. Fix them with EDIT_TAXONOMY_NODE first.';
    END IF;
    IF (v_reserved > 0) THEN
        RETURN 'REFUSED: ' || :P_VERSION_ID || ' uses a reserved subtheme name (NO_GOOD_MATCH or NONE).';
    END IF;
    IF (v_dupes > 0) THEN
        RETURN 'REFUSED: ' || :P_VERSION_ID || ' has ' || :v_dupes::VARCHAR
            || ' subtheme name(s) that differ only by case.';
    END IF;

    UPDATE TAXONOMY_VERSION
       SET status = 'LOCKED', locked_by = :P_LOCKED_BY, locked_at = CURRENT_TIMESTAMP()
     WHERE version_id = :P_VERSION_ID;

    RETURN 'LOCKED ' || :P_VERSION_ID || ' (' || :v_nodes::VARCHAR || ' subthemes). It can '
        || 'now be bound into a config with REGISTER_CONFIG and evaluated with EVALUATE_CONFIG.';
END;
$$;


CREATE OR REPLACE PROCEDURE REJECT_TAXONOMY(
    P_VERSION_ID VARCHAR,
    P_REVIEWER   VARCHAR,
    P_REASON     VARCHAR
)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_status VARCHAR;
BEGIN
    SELECT status INTO :v_status FROM TAXONOMY_VERSION WHERE version_id = :P_VERSION_ID;
    /* APPROVED is in production and SUPERSEDED is a rollback target, so only
       versions that never shipped can be rejected. */
    IF (COALESCE(v_status, 'MISSING') NOT IN ('DRAFT', 'LOCKED')) THEN
        RETURN 'REFUSED: version ' || :P_VERSION_ID || ' has status '
            || COALESCE(:v_status, 'MISSING') || '. Only a DRAFT or LOCKED version can be rejected.';
    END IF;

    UPDATE TAXONOMY_VERSION
       SET status = 'REJECTED', reviewed_by = :P_REVIEWER,
           reviewed_at = CURRENT_TIMESTAMP(), review_notes = :P_REASON
     WHERE version_id = :P_VERSION_ID;

    RETURN 'REJECTED ' || :P_VERSION_ID || '. Nothing in production changed.';
END;
$$;

/* There is deliberately no direct-approval procedure: a version reaches
   production only through PROMOTE_CONFIG, behind the eval gate. Dropped if
   present. */
DROP PROCEDURE IF EXISTS APPROVE_TAXONOMY(VARCHAR, VARCHAR, VARCHAR);


/* ============================================================================
   4. TAXONOMY_RENDERED / TAXONOMY_ACTIVE: what the classifier is given.

   One row per version. Carries both things the classifier needs:

     TAXONOMY_TEXT    the rubric body: [CATEGORY] Theme > Subtheme: description
     RESPONSE_FORMAT  a JSON-schema VARIANT whose enum IS the subtheme list

   Rendered for EVERY version, not just the approved one, so a LOCKED candidate
   can be classified and scored with exactly the rubric and enum it would ship
   with. TAXONOMY_ACTIVE is this filtered to the APPROVED version.

   The enum is the key design choice. An out-of-taxonomy subtheme is not
   unlikely, it is impossible, so labels never need mapping back to the
   taxonomy.

   NO_GOOD_MATCH is a deliberate enum member. When nothing fits, the model
   says so instead of forcing a label, which turns poor fits into a countable
   taxonomy-gap signal that the revision loop (05) can mine.
============================================================================ */
CREATE OR REPLACE VIEW TAXONOMY_RENDERED AS
WITH v AS (
    SELECT * FROM TAXONOMY_VERSION
),
n AS (
    SELECT tn.version_id,
           COUNT(*)                                  AS node_count,
           COUNT(DISTINCT tn.theme)                  AS theme_count,
           COUNT(DISTINCT tn.category)               AS category_count,
           ARRAY_AGG(tn.subtheme) WITHIN GROUP (ORDER BY tn.subtheme) AS subthemes,
           LISTAGG('[' || tn.category || '] ' || tn.theme || ' > ' || tn.subtheme
                   || ': ' || tn.description
                   || CASE WHEN COALESCE(tn.routing_note,'') <> ''
                           THEN '  (ROUTING: ' || tn.routing_note || ')' ELSE '' END,
                   '\n')
             WITHIN GROUP (ORDER BY tn.category, tn.theme, tn.subtheme)  AS taxonomy_text
    FROM TAXONOMY_NODE tn
    GROUP BY tn.version_id
)
SELECT
    v.version_id,
    v.status,
    v.service_line,
    v.generated_by_model,
    v.reviewed_by,
    v.reviewed_at,
    n.category_count,
    n.theme_count,
    n.node_count,
    n.taxonomy_text,
    OBJECT_CONSTRUCT(
      'type',  'json',
      'schema', OBJECT_CONSTRUCT(
         'type', 'object',
         'additionalProperties', FALSE,   -- required by OpenAI models; ignored by Claude.
                                          -- Always set, so one schema is portable across families.
         'properties', OBJECT_CONSTRUCT(
            'primary_subtheme',   OBJECT_CONSTRUCT('type','string',
                                    'enum', ARRAY_APPEND(n.subthemes, 'NO_GOOD_MATCH')),
            'secondary_subtheme', OBJECT_CONSTRUCT('type','string',
                                    'enum', ARRAY_APPEND(n.subthemes, 'NONE')),
            'confidence',         OBJECT_CONSTRUCT('type','string',
                                    'enum', ARRAY_CONSTRUCT('HIGH','MEDIUM','LOW')),
            'evidence',           OBJECT_CONSTRUCT('type','string')
         ),
         'required', ARRAY_CONSTRUCT('primary_subtheme','secondary_subtheme','confidence','evidence')
      )
    ) AS response_format
FROM v JOIN n ON n.version_id = v.version_id;


/* The production contract: exactly the approved version. */
CREATE OR REPLACE VIEW TAXONOMY_ACTIVE AS
SELECT * FROM TAXONOMY_RENDERED WHERE status = 'APPROVED';


/* Deterministic theme/category derivation. The model is asked ONLY for a
   subtheme; theme and category come from TAXONOMY_NODE joined on the version
   the label was produced under (never on whatever is active now). That is why
   theme/subtheme mismatch is structurally zero rather than something to
   measure. An active-version-only node lookup would derive a candidate's
   themes from the production taxonomy, which is wrong, so none exists. */
DROP VIEW IF EXISTS TAXONOMY_ACTIVE_NODE;


/* ============================================================================
   5. REVIEW SURFACE

   A first draft is reviewed straight from TAXONOMY_NODE (filter on its
   version_id). A revision is reviewed as a delta against its parent:
============================================================================ */

/* What a reviewer actually wants between two versions: the delta, not 60 rows.
   Returns ADDED / REMOVED / DESCRIPTION_CHANGED / REPARENTED. */
CREATE OR REPLACE FUNCTION TAXONOMY_DIFF(P_FROM VARCHAR, P_TO VARCHAR)
RETURNS TABLE (change_type VARCHAR, category VARCHAR, theme VARCHAR,
               subtheme VARCHAR, detail VARCHAR)
AS
$$
WITH f AS (SELECT * FROM TAXONOMY_NODE WHERE version_id = P_FROM),
     t AS (SELECT * FROM TAXONOMY_NODE WHERE version_id = P_TO)
SELECT 'ADDED', t.category, t.theme, t.subtheme, t.description
FROM t LEFT JOIN f ON f.subtheme = t.subtheme WHERE f.subtheme IS NULL
UNION ALL
SELECT 'REMOVED', f.category, f.theme, f.subtheme, f.description
FROM f LEFT JOIN t ON t.subtheme = f.subtheme WHERE t.subtheme IS NULL
UNION ALL
SELECT 'REPARENTED', t.category, t.theme, t.subtheme,
       'was [' || f.category || '] ' || f.theme
FROM f JOIN t ON t.subtheme = f.subtheme
WHERE f.theme <> t.theme OR f.category <> t.category
UNION ALL
SELECT 'DESCRIPTION_CHANGED', t.category, t.theme, t.subtheme,
       'was: ' || f.description
FROM f JOIN t ON t.subtheme = f.subtheme
WHERE COALESCE(f.description,'') <> COALESCE(t.description,'')
$$;


/* ============================================================================
   6. LABEL_GOLD_SET: bootstrap gold labels for one taxonomy version.

   Labels the gold encounters against a LOCKED (or already shipped) version.
   EVALUATE_CONFIG (04) calls this automatically the first time a version is
   evaluated, so a prompt-only candidate reuses the champion's gold labels and
   costs nothing extra here, while a taxonomy candidate pays for one labeling
   pass.

   WHAT THIS IS. Without an SME-labeled gold set, this bootstraps one with a
   frontier model as an SME stand-in. It is model-vs-model, and three things
   make it a defensible baseline rather than a rubber stamp:

     1. DIFFERENT MODEL FAMILY from the classifier (pass opus or gpt-5 here,
        while the pipeline runs haiku). A shared failure mode is much less
        likely across families than within one.
     2. RICHER CONTEXT: one encounter at a time, full descriptions and routing
        notes, and explicitly instructed to deliberate.
     3. HUMAN_VERIFIED is a real column. A nurse SME pass sets it, and the
        evaluation in 04 can filter to verified-only rows.

   In production the SME owns this. What is being demonstrated is the mechanism.

   Which encounters get labeled comes from GOLD_ENCOUNTER (an input table). The
   labels land in GOLD_LABEL, keyed by taxonomy version, because a gold label
   only means anything relative to a specific taxonomy. RUN_EVAL in 04 refuses a
   run whose version has no gold labels.

   Refuses a DRAFT (its nodes could still change under the labels) and refuses
   a version that already has labels: re-labeling silently moves the yardstick
   every existing eval of that version was scored against. To re-label on
   purpose, delete that version's GOLD_LABEL rows first.
============================================================================ */
CREATE TABLE IF NOT EXISTS GOLD_LABEL (
    encounter_id        VARCHAR       NOT NULL,
    taxonomy_version_id VARCHAR       NOT NULL,
    label_rank          INT           NOT NULL,   -- 1 = primary, 2 = secondary
    subtheme            VARCHAR       NOT NULL,
    labeled_by          VARCHAR       NOT NULL,
    human_verified      BOOLEAN       NOT NULL DEFAULT FALSE,
    labeled_at          TIMESTAMP_LTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT pk_gold_label PRIMARY KEY (encounter_id, taxonomy_version_id, label_rank)
);

/* Gold labels always name a specific version; drop the one-argument overload
   if present. */
DROP PROCEDURE IF EXISTS LABEL_GOLD_SET(VARCHAR);

CREATE OR REPLACE PROCEDURE LABEL_GOLD_SET(P_VERSION_ID VARCHAR, P_LABELER_MODEL VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
DECLARE
    v_version_id VARCHAR;
    v_status     VARCHAR;
    v_existing   INT;
    v_labeled    INT;
    v_errors     INT;
BEGIN
    v_version_id := :P_VERSION_ID;
    SELECT status INTO :v_status FROM TAXONOMY_VERSION WHERE version_id = :v_version_id;
    IF (v_status IS NULL) THEN
        RETURN 'REFUSED: version ' || COALESCE(:v_version_id, '<null>') || ' does not exist.';
    END IF;
    IF (v_status NOT IN ('LOCKED', 'APPROVED', 'SUPERSEDED')) THEN
        RETURN 'REFUSED: version ' || :v_version_id || ' is ' || :v_status
            || '. Gold labels need a version that can no longer change: LOCK_TAXONOMY it first.';
    END IF;
    IF (NOT REGEXP_LIKE(COALESCE(:P_LABELER_MODEL, ''), '[A-Za-z0-9._-]{1,64}')) THEN
        RETURN 'REFUSED: model ''' || :P_LABELER_MODEL || ''' is not a valid model name.';
    END IF;

    SELECT COUNT(*) INTO :v_existing FROM GOLD_LABEL WHERE taxonomy_version_id = :v_version_id;
    IF (v_existing > 0) THEN
        RETURN 'REFUSED: ' || :v_version_id || ' already has ' || :v_existing::VARCHAR
            || ' gold labels. Re-labeling would change the answer key under every existing '
            || 'eval of this version. Delete them first if that is really intended.';
    END IF;

    /* Build one deliberation prompt per gold encounter. The version's
       response_format rides along so the dynamic SQL below needs no
       concatenated identifiers beyond the model name. */
    CREATE OR REPLACE TEMPORARY TABLE _gold_prompt AS
    SELECT e.encounter_id, t.response_format,
           'You are a senior nurse analyst establishing GROUND TRUTH labels for a '
        || 'classification quality benchmark. Accuracy matters more than speed. Think '
        || 'carefully before answering.' || CHAR(10) || CHAR(10)
        || 'TAXONOMY' || CHAR(10) || t.taxonomy_text || CHAR(10) || CHAR(10)
        || 'RULES' || CHAR(10)
        || '- Assign the single best primary subtheme, plus a secondary ONLY if the note '
        || 'documents a second materially distinct concern. Otherwise secondary is NONE.' || CHAR(10)
        || '- If the patient is within 30 days of a surgical procedure and the concern could '
        || 'relate to that surgery, prefer the post-operative subtheme over the general one.' || CHAR(10)
        || '- If a medication is not being taken because it was never received or cannot be '
        || 'afforded, label the supply or cost barrier, not the adherence failure.' || CHAR(10)
        || '- Use NO_GOOD_MATCH only when the note documents a real, substantive concern that '
        || 'genuinely has no home in the taxonomy above. Say in the evidence field what concept '
        || 'is missing. Do not use it for notes that are merely brief or vague.' || CHAR(10) || CHAR(10)
        || 'NOTE' || CHAR(10) || e.note_text AS gold_prompt
    FROM (SELECT r.encounter_id,
                 /* LISTAGG's delimiter must be a literal constant, not CHAR(10). */
                 LISTAGG(r.note_text, '\n') WITHIN GROUP (ORDER BY r.note_seq) AS note_text
          FROM NOTE_RAW r
          JOIN GOLD_ENCOUNTER g ON g.encounter_id = r.encounter_id
          GROUP BY r.encounter_id) e
    CROSS JOIN (SELECT * FROM TAXONOMY_RENDERED WHERE version_id = :v_version_id) t;

    /* model must be a literal -> dynamic SQL. response_format is read as a
       VARIANT column of this version's rendering, so gold labels are
       constrained to exactly the vocabulary that version's classifier can emit.
       CTAS + split fields, for the same typed-struct reason as PROPOSE_TAXONOMY. */
    EXECUTE IMMEDIATE
      'CREATE OR REPLACE TEMPORARY TABLE _gold_res AS '
      || 'SELECT encounter_id, r:value AS val, r:error::VARCHAR AS err FROM ('
      || '  SELECT p.encounter_id, AI_COMPLETE('
      || '     model => ''' || :P_LABELER_MODEL || ''','
      || '     prompt => p.gold_prompt,'
      || '     model_parameters => {''temperature'': 0},'
      || '     response_format => p.response_format,'
      || '     return_error_details => TRUE) AS r'
      || '  FROM _gold_prompt p)';

    INSERT INTO GOLD_LABEL
      (encounter_id, taxonomy_version_id, label_rank, subtheme, labeled_by, human_verified)
    SELECT encounter_id, :v_version_id, 1,
           val:primary_subtheme::VARCHAR, :P_LABELER_MODEL || ' (SME stand-in)', FALSE
    FROM _gold_res WHERE err IS NULL
    UNION ALL
    SELECT encounter_id, :v_version_id, 2,
           val:secondary_subtheme::VARCHAR, :P_LABELER_MODEL || ' (SME stand-in)', FALSE
    FROM _gold_res
    WHERE err IS NULL
      AND val:secondary_subtheme::VARCHAR NOT IN ('NONE','');

    SELECT COUNT(*) INTO :v_labeled FROM GOLD_LABEL WHERE taxonomy_version_id = :v_version_id;
    SELECT COUNT_IF(err IS NOT NULL) INTO :v_errors FROM _gold_res;

    RETURN 'Gold set labeled against ' || :v_version_id || ': ' || :v_labeled::VARCHAR
        || ' labels, ' || :v_errors::VARCHAR || ' errors. Labeler: ' || :P_LABELER_MODEL
        || '. HUMAN_VERIFIED is FALSE on all rows: this is a bootstrap, not SME adjudication.';
END;
$$;


SELECT 'Taxonomy registry ready. Next: CALL PROPOSE_TAXONOMY(''READMISSIONS'', ''openai-gpt-5.2'', ''your.name''), '
    || 'review and edit the DRAFT, then LOCK_TAXONOMY.' AS next_step;
