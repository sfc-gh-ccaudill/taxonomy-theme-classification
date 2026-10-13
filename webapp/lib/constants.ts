/** App title, displayed in the nav header and browser tab */
export const APP_TITLE = "PAN Lines Theme Pipeline"

/** Path to the logo in /public (used in the header and as favicon) */
export const LOGO_SRC = "/icon.svg"

/**
 * The schema every query in lib/queries.ts targets.
 *
 * Override with PAN_SCHEMA in .env.local to point the app at a different build
 * without touching code. Must match the USE SCHEMA block at the top of
 * sql/00_setup.sql.
 *
 * Everything the app scores, gates or acts on comes from the pipeline schema,
 * so it behaves the same on any source data.
 */
export const PAN_SCHEMA =
  process.env.PAN_SCHEMA ?? "PAN_DEMO_DB.PIPELINE"

/**
 * Synthetic-data schema. Read ONLY by the queries marked TEST DATA in
 * lib/queries.ts, which show how the synthetic notes were made challenging
 * (confusable pairs, withheld concepts, ambiguous notes) and how each kind
 * scored. The UI badges every panel that reads it. Nothing the pipeline does
 * depends on it.
 */
export const TEST_DATA_SCHEMA =
  process.env.PAN_TEST_DATA_SCHEMA ?? "PAN_DEMO_DB.SYNTHETIC_DATA"

/**
 * Warehouse for app queries. The pipeline's dynamic table and task are
 * pinned to PAN_DEMO_WH in SQL (DDL requires a literal), so the app uses the
 * same one to keep credit attribution in one place.
 */
export const PAN_WAREHOUSE = process.env.PAN_WAREHOUSE ?? "PAN_DEMO_WH"

/**
 * Who the app records as the actor on lock, reject and promote. The procedures
 * require a name; a real deployment would take it from the signed-in user.
 */
export const DEMO_USER = "demo-app"

/**
 * Frontier model that labels the gold set for a new taxonomy version. A
 * different family from the classifier on purpose: a shared failure mode is
 * much less likely across families than within one.
 */
export const LABELER_MODEL = "openai-gpt-5.2"

/** Model that drafts taxonomies and revisions. */
export const TAXONOMY_MODEL = "openai-gpt-5.2"

/** Models offered in the config editor. Others work if registered through SQL. */
export const MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "openai-gpt-5.2",
  "llama3.1-70b",
  "mistral-large2",
]

/**
 * Production run presets for the Run page. Always the champion config; limit
 * 0 means unbounded. Gold-set runs are not here: scoring is an evaluation
 * (page 3), and evaluation runs never become production output.
 */
export const RUN_PRESETS = [
  {
    key: "sample",
    label: "Run 50",
    scope: "BACKLOG" as const,
    limit: 50,
    blurb: "~15s. Enough to watch the pipeline work.",
  },
  {
    key: "full",
    label: "Run all remaining",
    scope: "BACKLOG" as const,
    limit: 0,
    blurb: "~55s and ~5 credits per 1000. Representative full-batch cost.",
  },
]
