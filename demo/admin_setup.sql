/* ============================================================================
   ADMIN SETUP: one-time account-level grants for the demo role
   ----------------------------------------------------------------------------
   Run ONCE as ACCOUNTADMIN, before demo/setup_notebook.ipynb or the SQL build.
   Everything else runs as the demo role.

   Why these are needed. A new account's SYSADMIN can create the database,
   schemas, warehouse, tables, views, procedures, dynamic table and task, but
   not these three:

     EXECUTE ALERT        CREATE ALERT requires it (05_revision_loop.sql
                          creates QUALITY_REGRESSION_ALERT, suspended).
     EXECUTE TASK         only needed to RESUME the incremental task in 03.
                          The demo leaves it suspended; granted so the
                          incremental path can be shown.
     IMPORTED PRIVILEGES  on the SNOWFLAKE database: the RUN_COST view in 04
                          reads SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY,
                          and the view cannot be created without access to it.
                          This also grants read access to the other
                          ACCOUNT_USAGE views.

   Cortex: the SNOWFLAKE.CORTEX_USER database role is granted to PUBLIC by
   default. It is granted explicitly below in case an admin has revoked that.

   If the demo will run as a role other than SYSADMIN, replace SYSADMIN below.
============================================================================ */

USE ROLE ACCOUNTADMIN;

GRANT EXECUTE ALERT ON ACCOUNT TO ROLE SYSADMIN;
GRANT EXECUTE TASK  ON ACCOUNT TO ROLE SYSADMIN;
GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE SYSADMIN;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE SYSADMIN;

/* Only if demo/preflight.sql reports a model as unavailable in this region.
   The demo calls claude-haiku-4-5 (classification) and openai-gpt-5.2 (gold
   labeling and taxonomy revisions). Cross-region inference routes the call
   to a region that hosts the model; data stays within Snowflake. Uncomment to
   allow it:

ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';
*/

/* Only to create a Snowsight Workspace from the Git repository (how
   demo/setup_notebook.ipynb is meant to be opened). Run this BEFORE creating
   the workspace; the README has the same statements to paste into a
   worksheet, since this file isn't in the account until the workspace exists.
   Set the prefix to the GitHub owner or organization that holds the repo. A
   public repo needs nothing else; for a private one, choose "Personal access
   token" in the create-workspace dialog and create the secret there.

CREATE API INTEGRATION IF NOT EXISTS PAN_DEMO_GIT
  API_PROVIDER = git_https_api
  API_ALLOWED_PREFIXES = ('https://github.com/<owner>')
  ALLOWED_AUTHENTICATION_SECRETS = ALL
  ENABLED = TRUE;
GRANT USAGE ON INTEGRATION PAN_DEMO_GIT TO ROLE SYSADMIN;
*/

SHOW GRANTS TO ROLE SYSADMIN;
