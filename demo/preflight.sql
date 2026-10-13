/* ============================================================================
   PREFLIGHT: can this account and role run the demo?
   ----------------------------------------------------------------------------
   Run as the demo role with a warehouse in use, before the build.
   demo/setup_notebook.ipynb runs it for you. Needs no database and creates
   nothing.

   Returns one row per check with PASS or FAIL and what to do about a FAIL.
   Makes two tiny model calls (a few hundred tokens in total).

     MODEL claude-haiku-4-5  classifies every encounter (enum structured output)
     MODEL openai-gpt-5.2    labels gold for a new taxonomy, drafts revisions
     ACCOUNT_USAGE           the RUN_COST view in 04 reads
                             CORTEX_AISQL_USAGE_HISTORY; the build fails without it
     EXECUTE ALERT           05 creates an alert; CREATE ALERT requires it

   A FAIL on a model usually means the model is not hosted in this region:
   enable cross-region inference (see demo/admin_setup.sql). The other FAILs
   are grants, also in demo/admin_setup.sql.

   Wrapped in EXECUTE IMMEDIATE so the Snowflake CLI sends the block as one
   statement instead of splitting it on semicolons.
============================================================================ */

EXECUTE IMMEDIATE $$
DECLARE
    out ARRAY DEFAULT ARRAY_CONSTRUCT();
    r   VARCHAR;
    n   INT;
    s   VARCHAR;
    res RESULTSET;
BEGIN
    out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'CONTEXT', 'status', 'INFO',
        'detail', 'role=' || CURRENT_ROLE() || ' warehouse=' || COALESCE(CURRENT_WAREHOUSE(), '(none)')
                  || ' region=' || CURRENT_REGION()));

    IF (CURRENT_WAREHOUSE() IS NULL) THEN
        out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'WAREHOUSE', 'status', 'FAIL',
            'detail', 'No warehouse in use. Run USE WAREHOUSE PAN_DEMO_WH first.'));
    ELSE
        /* The same call shape as RUN_CLASSIFIER: response_format with an enum. */
        BEGIN
            SELECT AI_COMPLETE(
                       model  => 'claude-haiku-4-5',
                       prompt => 'Pick the label for: patient reports new rash after starting antibiotic.',
                       model_parameters => {'temperature': 0},
                       response_format  => {'type': 'json', 'schema': {'type': 'object',
                           'properties': {'label': {'type': 'string', 'enum': ['Medication Side Effect', 'Other']}},
                           'required': ['label']}})::VARCHAR
              INTO :r;
            out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'MODEL claude-haiku-4-5',
                'status', 'PASS', 'detail', LEFT(:r, 200)));
        EXCEPTION WHEN OTHER THEN
            out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'MODEL claude-haiku-4-5',
                'status', 'FAIL', 'detail', LEFT(:SQLERRM, 300)
                || ' -> enable cross-region inference or grant CORTEX_USER; see demo/admin_setup.sql'));
        END;

        BEGIN
            SELECT AI_COMPLETE(
                       model  => 'openai-gpt-5.2',
                       prompt => 'Pick the label for: patient reports new rash after starting antibiotic.',
                       response_format  => {'type': 'json', 'schema': {'type': 'object',
                           'properties': {'label': {'type': 'string', 'enum': ['Medication Side Effect', 'Other']}},
                           'required': ['label'], 'additionalProperties': FALSE}})::VARCHAR
              INTO :r;
            out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'MODEL openai-gpt-5.2',
                'status', 'PASS', 'detail', LEFT(:r, 200)));
        EXCEPTION WHEN OTHER THEN
            out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'MODEL openai-gpt-5.2',
                'status', 'FAIL', 'detail', LEFT(:SQLERRM, 300)
                || ' -> enable cross-region inference or grant CORTEX_USER; see demo/admin_setup.sql'));
        END;
    END IF;

    BEGIN
        SELECT COUNT(*) INTO :n
        FROM (SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY LIMIT 1);
        out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'ACCOUNT_USAGE', 'status', 'PASS',
            'detail', 'CORTEX_AISQL_USAGE_HISTORY is readable'));
    EXCEPTION WHEN OTHER THEN
        out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'ACCOUNT_USAGE', 'status', 'FAIL',
            'detail', LEFT(:SQLERRM, 300)
            || ' -> GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE; see demo/admin_setup.sql'));
    END;

    /* Direct or inherited: any role active in this session counts. */
    BEGIN
        EXECUTE IMMEDIATE 'SHOW GRANTS ON ACCOUNT';
        SELECT COUNT(*) INTO :n
        FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))
        WHERE "privilege" = 'EXECUTE ALERT'
          AND IS_ROLE_IN_SESSION("grantee_name");
        out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'EXECUTE ALERT',
            'status', IFF(:n > 0, 'PASS', 'FAIL'),
            'detail', IFF(:n > 0, 'held by a role in this session',
                          'not granted to any role in this session -> see demo/admin_setup.sql')));
    EXCEPTION WHEN OTHER THEN
        out := ARRAY_APPEND(out, OBJECT_CONSTRUCT('check_name', 'EXECUTE ALERT', 'status', 'UNKNOWN',
            'detail', 'could not list account grants (' || LEFT(:SQLERRM, 150)
            || '). If 05_revision_loop.sql fails at CREATE ALERT, run demo/admin_setup.sql'));
    END;

    s := TO_JSON(out);
    res := (SELECT value:check_name::VARCHAR AS check_name,
                   value:status::VARCHAR     AS status,
                   value:detail::VARCHAR     AS detail
            FROM TABLE(FLATTEN(INPUT => PARSE_JSON(:s)))
            ORDER BY index);
    RETURN TABLE(res);
END;
$$;
