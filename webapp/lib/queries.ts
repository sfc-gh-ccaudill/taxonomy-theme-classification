/**
 * Every SQL statement the app runs, in one place.
 *
 * Two rules this file enforces:
 *
 *  1. NO SQL IN COMPONENTS. A page asks for a named query ("scorecard"), never a
 *     string. That keeps the app auditable: this file is the complete list of
 *     what the UI can read and do.
 *
 *  2. NO BEHAVIOUR IN TYPESCRIPT. Writes go through the procedures defined in
 *     sql/02..06. The app does not INSERT, UPDATE or DELETE anything directly,
 *     so the eval gate, the promotion log and the other guard rails cannot be
 *     bypassed from the UI.
 *
 * User-supplied values are always passed via `binds` (`?` placeholders), never
 * string-concatenated.
 *
 * Reads target the pipeline schema (S). The few marked TEST DATA read the
 * synthetic-data schema (T) to show how the synthetic notes were built; the
 * pages badge those panels, and nothing scored or gated depends on them.
 */

import { PAN_SCHEMA, TEST_DATA_SCHEMA } from "./constants"

const S = PAN_SCHEMA
const T = TEST_DATA_SCHEMA

/**
 * What a bind value may be.
 *
 * The Snowflake Node SDK types `Bind` as `string | number` only, so a JS
 * boolean cannot be bound. Procedures taking a BOOLEAN are called with an
 * explicit `TO_BOOLEAN(?)` in the SQL against a 'TRUE'/'FALSE' string bind,
 * which `callProc` produces from a JS boolean. See `procs.runEval`.
 */
export type BindValue = string | number

export type Sql = { sql: string; binds?: BindValue[] }

/* ---------------------------------------------------------------------------
   READS
--------------------------------------------------------------------------- */

export const reads = {
  /* --- Page 1: Explore Data --- */

  /**
   * TEST DATA. How the synthetic corpus was made challenging: encounters per
   * test scenario, gold and unlabeled. Production data carries no such tag.
   */
  testScenarioMix: (): Sql => ({
    sql: `SELECT ts.test_scenario,
                 COUNT_IF(g.encounter_id IS NOT NULL)  AS gold,
                 COUNT_IF(g.encounter_id IS NULL)      AS unlabeled
          FROM ${S}.ENCOUNTER_PREP p
          JOIN ${T}.TEST_SCENARIO ts       ON ts.encounter_id = p.encounter_id
          LEFT JOIN ${S}.GOLD_ENCOUNTER g  ON g.encounter_id  = p.encounter_id
          GROUP BY ts.test_scenario
          ORDER BY gold DESC`,
  }),

  corpusTotals: (): Sql => ({
    sql: `SELECT
            (SELECT COUNT(*) FROM ${S}.NOTE_RAW)                        AS note_rows,
            (SELECT COUNT(*) FROM ${S}.ENCOUNTER_PREP)                  AS encounters,
            (SELECT COUNT(*) FROM ${S}.GOLD_ENCOUNTER)                  AS gold_encounters,
            (SELECT COUNT(*) FROM ${S}.ENCOUNTER_PREP p
               WHERE NOT EXISTS (SELECT 1 FROM ${S}.GOLD_ENCOUNTER g
                                  WHERE g.encounter_id = p.encounter_id))  AS unlabeled_encounters,
            (SELECT COUNT(*) FROM ${S}.DISCOVERY_SAMPLE)                AS design_sample,
            (SELECT COUNT(*) FROM ${S}.GOLD_LABEL)                      AS gold_labels,
            (SELECT COUNT(*) FROM ${S}.GOLD_LABEL WHERE human_verified)  AS gold_verified,
            (SELECT COUNT(*) FROM ${S}.ENCOUNTER_PREP p
               WHERE NOT EXISTS (SELECT 1 FROM ${S}.ENCOUNTER_THEME t
                                  WHERE t.encounter_id = p.encounter_id))  AS never_classified`,
  }),

  /**
   * Note browser. Shows the rollup the dynamic table performs, plus gold-set
   * and design-sample membership. `filter` is ALL, GOLD, UNLABELED, or a test
   * scenario name. The test_scenario column is TEST DATA and is badged as such.
   */
  notes: (opts: { filter?: string; search?: string; limit: number }): Sql => {
    const where: string[] = []
    const binds: BindValue[] = []
    if (opts.filter === "GOLD") {
      where.push("g.encounter_id IS NOT NULL")
    } else if (opts.filter === "UNLABELED") {
      where.push("g.encounter_id IS NULL")
    } else if (opts.filter && opts.filter !== "ALL") {
      where.push("ts.test_scenario = ?")
      binds.push(opts.filter)
    }
    if (opts.search) {
      where.push("(p.full_text ILIKE ? OR p.encounter_id ILIKE ?)")
      binds.push(`%${opts.search}%`, `%${opts.search}%`)
    }
    binds.push(opts.limit)
    return {
      sql: `SELECT p.encounter_id, p.note_count, p.discharge_date, p.last_call_date,
                   DATEDIFF(day, p.discharge_date, p.last_call_date) AS days_post_discharge,
                   p.full_text,
                   LENGTH(p.full_text) AS note_chars,
                   g.encounter_id IS NOT NULL AS is_gold,
                   ts.test_scenario,
                   d.encounter_id IS NOT NULL AS in_discovery_sample
            FROM ${S}.ENCOUNTER_PREP p
            LEFT JOIN ${S}.GOLD_ENCOUNTER   g  ON g.encounter_id  = p.encounter_id
            LEFT JOIN ${S}.DISCOVERY_SAMPLE d  ON d.encounter_id  = p.encounter_id
            LEFT JOIN ${T}.TEST_SCENARIO    ts ON ts.encounter_id = p.encounter_id
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY p.encounter_id
            LIMIT ?`,
      binds,
    }
  },

  /* --- Page 1: Explore Data, after classification --- */

  /**
   * Headline numbers for the production output: the champion's latest labels
   * per encounter (ENCOUNTER_THEME), against the whole corpus.
   */
  classifiedTotals: (): Sql => ({
    sql: `WITH et AS (SELECT * FROM ${S}.ENCOUNTER_THEME),
          per_enc AS (
            SELECT encounter_id, COUNT(*) AS labels,
                   COUNT_IF(subtheme = 'NO_GOOD_MATCH') AS ngm
            FROM et GROUP BY encounter_id
          )
          SELECT
            (SELECT COUNT(*) FROM ${S}.ENCOUNTER_PREP)           AS encounters,
            (SELECT COUNT(*) FROM per_enc)                        AS classified,
            (SELECT COUNT(*) FROM et)                             AS labels,
            (SELECT COUNT_IF(labels > 1) FROM per_enc)            AS multi_label,
            (SELECT COUNT_IF(ngm > 0) FROM per_enc)               AS no_good_match,
            (SELECT COUNT_IF(confidence = 'HIGH') FROM et)        AS high_conf,
            (SELECT COUNT_IF(confidence = 'LOW') FROM et)         AS low_conf,
            (SELECT COUNT(DISTINCT subtheme) FROM et
               WHERE subtheme <> 'NO_GOOD_MATCH')                 AS subthemes_used,
            (SELECT LISTAGG(DISTINCT config_name, ', ') FROM et)  AS configs,
            (SELECT LISTAGG(DISTINCT taxonomy_version_id, ', ') FROM et) AS taxonomies,
            (SELECT MAX(classified_at) FROM et)                   AS last_classified_at`,
  }),

  /**
   * Encounters per category > theme > subtheme in the production output. An
   * encounter counts once per distinct subtheme it carries, so multi-label
   * encounters appear under each of their labels. NO_GOOD_MATCH has NULL
   * category and theme.
   */
  classifiedDistribution: (): Sql => ({
    sql: `SELECT COALESCE(category, 'NO_GOOD_MATCH') AS category,
                 COALESCE(theme, 'NO_GOOD_MATCH')    AS theme,
                 subtheme,
                 COUNT(DISTINCT encounter_id)        AS encounters,
                 COUNT_IF(confidence = 'LOW')        AS low_conf
          FROM ${S}.ENCOUNTER_THEME
          GROUP BY ALL
          ORDER BY encounters DESC, category, theme, subtheme`,
  }),

  /**
   * Classified-encounter browser: one row per label, for at most `limit`
   * encounters. An encounter matches when ANY of its labels matches the
   * category / theme / subtheme / confidence filters. Category and theme
   * 'NO_GOOD_MATCH' match the NULLs that label carries. The test_scenario
   * column is TEST DATA and is badged as such.
   */
  classifiedEncounters: (opts: {
    category?: string
    theme?: string
    subtheme?: string
    confidence?: string
    multiLabel?: boolean
    search?: string
    limit: number
  }): Sql => {
    const where: string[] = []
    const binds: BindValue[] = []
    if (opts.category) {
      where.push("COALESCE(et.category, 'NO_GOOD_MATCH') = ?")
      binds.push(opts.category)
    }
    if (opts.theme) {
      where.push("COALESCE(et.theme, 'NO_GOOD_MATCH') = ?")
      binds.push(opts.theme)
    }
    if (opts.subtheme) {
      where.push("et.subtheme = ?")
      binds.push(opts.subtheme)
    }
    if (opts.confidence) {
      where.push("et.confidence = ?")
      binds.push(opts.confidence)
    }
    if (opts.search) {
      where.push("(p.full_text ILIKE ? OR et.encounter_id ILIKE ? OR et.evidence ILIKE ?)")
      binds.push(`%${opts.search}%`, `%${opts.search}%`, `%${opts.search}%`)
    }
    binds.push(opts.limit)
    return {
      sql: `WITH matched AS (
              SELECT et.encounter_id
              FROM ${S}.ENCOUNTER_THEME et
              JOIN ${S}.ENCOUNTER_PREP p ON p.encounter_id = et.encounter_id
              ${where.length ? "WHERE " + where.join(" AND ") : ""}
              GROUP BY et.encounter_id
            ),
            enc AS (
              SELECT m.encounter_id
              FROM matched m
              JOIN ${S}.ENCOUNTER_THEME et ON et.encounter_id = m.encounter_id
              GROUP BY m.encounter_id
              ${opts.multiLabel ? "HAVING COUNT(*) > 1" : ""}
              ORDER BY m.encounter_id
              LIMIT ?
            )
            SELECT et.encounter_id, et.label_rank, et.category, et.theme, et.subtheme,
                   et.confidence, et.evidence, et.config_name, et.taxonomy_version_id,
                   et.run_id, et.classified_at,
                   p.note_count, p.full_text, LENGTH(p.full_text) AS note_chars,
                   g.encounter_id IS NOT NULL AS is_gold,
                   ts.test_scenario
            FROM enc
            JOIN ${S}.ENCOUNTER_THEME       et ON et.encounter_id = enc.encounter_id
            JOIN ${S}.ENCOUNTER_PREP        p  ON p.encounter_id  = enc.encounter_id
            LEFT JOIN ${S}.GOLD_ENCOUNTER   g  ON g.encounter_id  = enc.encounter_id
            LEFT JOIN ${T}.TEST_SCENARIO    ts ON ts.encounter_id = enc.encounter_id
            ORDER BY et.encounter_id, et.label_rank`,
      binds,
    }
  },

  /* --- Page 2: Config Builder (taxonomy) --- */

  /**
   * Each version with what depends on it: the configs bound to it, whether
   * its gold set is labeled, and the latest eval of any config on it.
   */
  taxonomyVersions: (): Sql => ({
    sql: `WITH nodes AS (
            SELECT version_id, COUNT(*) AS subthemes, COUNT(DISTINCT theme) AS themes,
                   COUNT(DISTINCT category) AS categories
            FROM ${S}.TAXONOMY_NODE GROUP BY version_id
          ),
          cfg AS (
            SELECT taxonomy_version_id AS version_id,
                   LISTAGG(config_name, ', ') WITHIN GROUP (ORDER BY config_name) AS configs
            FROM ${S}.CLASSIFIER_CONFIG WHERE taxonomy_version_id IS NOT NULL GROUP BY 1
          ),
          gold AS (
            SELECT taxonomy_version_id AS version_id, COUNT(DISTINCT encounter_id) AS gold_labeled
            FROM ${S}.GOLD_LABEL GROUP BY 1
          ),
          ev AS (
            SELECT taxonomy_version_id AS version_id,
                   MAX_BY(subtheme_accuracy, evaluated_at) AS latest_accuracy
            FROM ${S}.EVAL_SCORECARD GROUP BY 1
          )
          SELECT v.version_id, v.service_line, v.status, v.parent_version_id,
                 v.generated_by_model, v.source_sample_size, v.generation_rationale,
                 v.created_by, v.created_at, v.locked_by, v.locked_at,
                 v.reviewed_by, v.reviewed_at, v.review_notes,
                 COALESCE(n.subthemes, 0) AS subthemes, n.themes, n.categories,
                 cfg.configs, COALESCE(gold.gold_labeled, 0) AS gold_labeled,
                 ROUND(ev.latest_accuracy, 4) AS latest_accuracy
          FROM ${S}.TAXONOMY_VERSION v
          LEFT JOIN nodes n ON n.version_id = v.version_id
          LEFT JOIN cfg      ON cfg.version_id = v.version_id
          LEFT JOIN gold     ON gold.version_id = v.version_id
          LEFT JOIN ev       ON ev.version_id = v.version_id
          ORDER BY v.created_at DESC`,
  }),

  taxonomyNodes: (versionId: string): Sql => ({
    sql: `SELECT category, theme, subtheme, description, routing_note
          FROM ${S}.TAXONOMY_NODE WHERE version_id = ?
          ORDER BY category, theme, subtheme`,
    binds: [versionId],
  }),

  /** The production contract: what the champion's classifier receives. */
  taxonomyActive: (): Sql => ({
    sql: `SELECT version_id, service_line, generated_by_model, reviewed_by, reviewed_at,
                 category_count, theme_count, node_count,
                 LENGTH(taxonomy_text) AS taxonomy_chars
          FROM ${S}.TAXONOMY_ACTIVE`,
  }),

  /** The rubric text and enum for any version, so a draft's contract is visible too. */
  taxonomyRendered: (versionId: string): Sql => ({
    sql: `SELECT version_id, status, node_count, LENGTH(taxonomy_text) AS taxonomy_chars,
                 response_format
          FROM ${S}.TAXONOMY_RENDERED WHERE version_id = ?`,
    binds: [versionId],
  }),

  taxonomyDiff: (from: string, to: string): Sql => ({
    sql: `SELECT change_type, category, theme, subtheme, detail
          FROM TABLE(${S}.TAXONOMY_DIFF(?, ?))
          ORDER BY change_type, category, theme, subtheme`,
    binds: [from, to],
  }),

  /* --- Page 4: Run Production (and run history everywhere) --- */

  runs: (): Sql => ({
    sql: `SELECT run_id, mode, purpose, taxonomy_version_id, config_name, model,
                 started_at, completed_at, run_status, encounters_in, labels_out,
                 error_count, duration_sec, labels_per_encounter,
                 out_of_taxonomy_labels, no_good_match_labels,
                 tokens_total, tokens_input, tokens_output, token_credits,
                 tokens_per_encounter, credits_per_1k_encounters, cost_pending,
                 eval_id, subtheme_accuracy, theme_accuracy, label_set_f1, gate_result
          FROM ${S}.APP_RUN_STATUS
          ORDER BY started_at DESC
          LIMIT 50`,
  }),

  run: (runId: string): Sql => ({
    sql: `SELECT run_id, mode, purpose, taxonomy_version_id, config_name, model,
                 started_at, completed_at, run_status, encounters_in, labels_out,
                 error_count, duration_sec, labels_per_encounter,
                 out_of_taxonomy_labels, no_good_match_labels,
                 tokens_total, tokens_input, tokens_output, token_credits,
                 tokens_per_encounter, credits_per_1k_encounters, cost_pending,
                 eval_id, subtheme_accuracy, theme_accuracy, label_set_f1, gate_result
          FROM ${S}.APP_RUN_STATUS WHERE run_id = ?`,
    binds: [runId],
  }),

  /**
   * Where production stands: the champion, and how many encounters have no
   * production label from it (the BACKLOG scope, which a promotion resets).
   */
  productionStatus: (): Sql => ({
    // CTEs rather than a correlated NOT EXISTS inside a scalar subquery, which
    // Snowflake rejects ("Unsupported subquery type").
    sql: `WITH champ AS (
            SELECT config_name, model, taxonomy_version_id FROM ${S}.ACTIVE_CONFIG
          ),
          labeled AS (
            SELECT DISTINCT c.encounter_id
            FROM ${S}.CLASSIFICATION c
            JOIN ${S}.PIPELINE_RUN r ON r.run_id = c.run_id AND r.purpose = 'PRODUCTION'
            JOIN champ ON champ.config_name = c.config_name
          ),
          counts AS (
            SELECT COUNT(*) AS encounters, COUNT_IF(l.encounter_id IS NULL) AS backlog
            FROM ${S}.ENCOUNTER_PREP p
            LEFT JOIN labeled l ON l.encounter_id = p.encounter_id
          )
          SELECT champ.config_name AS champion, champ.model,
                 champ.taxonomy_version_id AS champion_taxonomy,
                 counts.backlog, counts.encounters,
                 (SELECT COUNT(DISTINCT encounter_id) FROM ${S}.ENCOUNTER_THEME) AS in_production_output
          FROM champ CROSS JOIN counts`,
  }),

  /** Labels for one run, with the note excerpt that produced them. */
  classifications: (runId: string, limit: number): Sql => ({
    sql: `SELECT c.encounter_id, c.label_rank, c.subtheme, c.theme, c.category,
                 c.confidence, c.evidence,
                 LEFT(p.full_text, 400) AS note_excerpt,
                 g.encounter_id IS NOT NULL AS is_gold
          FROM ${S}.CLASSIFICATION c
          JOIN ${S}.ENCOUNTER_PREP p      ON p.encounter_id = c.encounter_id
          LEFT JOIN ${S}.GOLD_ENCOUNTER g ON g.encounter_id = c.encounter_id
          WHERE c.run_id = ?
          ORDER BY c.encounter_id, c.label_rank
          LIMIT ?`,
    binds: [runId, limit],
  }),

  /** Errored encounters. Surfaced on purpose: these are the guardrail firing. */
  runErrors: (runId: string): Sql => ({
    sql: `SELECT encounter_id, error FROM ${S}.CLASSIFICATION_RAW
          WHERE run_id = ? AND error IS NOT NULL
          ORDER BY encounter_id`,
    binds: [runId],
  }),

  /* --- Pages 3 and 5: evaluation --- */

  scorecards: (): Sql => ({
    sql: `SELECT eval_id, run_id, run_scope, run_purpose, config_name, taxonomy_version_id,
                 model, gold_encounters, verified_only, is_champion, evaluated_at, subthemes,
                 ROUND(subtheme_accuracy,4) AS subtheme_accuracy,
                 ROUND(theme_accuracy,4)    AS theme_accuracy,
                 ROUND(category_accuracy,4) AS category_accuracy,
                 ROUND(label_set_f1,4)      AS label_set_f1,
                 ROUND(labels_per_encounter,3) AS labels_per_encounter,
                 ROUND(no_good_match_rate,4)   AS no_good_match_rate,
                 ROUND(low_conf_rate,4)        AS low_conf_rate,
                 ROUND(error_rate,4)           AS error_rate,
                 out_of_taxonomy_labels
          FROM ${S}.EVAL_SCORECARD ORDER BY evaluated_at DESC`,
  }),

  /** Segment rows for one or more evals, so a candidate can sit next to the champion. */
  evalSegments: (evalIds: string[]): Sql => ({
    sql: `SELECT eval_id, segment_name, segment_value, n, gated,
                 ROUND(subtheme_accuracy,4) AS subtheme_accuracy,
                 ROUND(theme_accuracy,4)    AS theme_accuracy,
                 ROUND(label_set_f1,4)      AS label_set_f1,
                 ROUND(ngm_rate,4)          AS ngm_rate,
                 ROUND(low_conf_rate,4)     AS low_conf_rate
          FROM ${S}.EVAL_SEGMENT_DETAIL
          WHERE eval_id IN (${evalIds.map(() => "?").join(", ")})
          ORDER BY segment_name, n DESC, segment_value`,
    binds: evalIds,
  }),

  evalGate: (): Sql => ({
    sql: `SELECT eval_id, run_id, config_name, taxonomy_version_id, model, is_champion,
                 baseline_eval_id, baseline_config_name, subtheme_accuracy,
                 baseline_subtheme_accuracy, accuracy_floor, error_rate, error_ceiling,
                 segments_regressed, regressed_detail, out_of_taxonomy_labels,
                 gate_note, gate_result
          FROM ${S}.EVAL_GATE ORDER BY eval_id DESC`,
  }),

  gateConfig: (): Sql => ({
    sql: `SELECT gate_name, min_primary_accuracy, max_segment_regression,
                 max_error_rate, min_segment_n
          FROM ${S}.EVAL_GATE_CONFIG WHERE gate_name = 'default'`,
  }),

  /**
   * The candidate leaderboard: every runnable config (prompt + model +
   * taxonomy) with its latest evaluation and that eval's verdict against the
   * champion. Templates are excluded because they cannot run.
   */
  leaderboard: (): Sql => ({
    sql: `WITH latest AS (
            SELECT * FROM ${S}.EVAL_SCORECARD
            QUALIFY ROW_NUMBER() OVER (PARTITION BY config_name ORDER BY evaluated_at DESC) = 1
          ),
          gold AS (
            SELECT taxonomy_version_id, COUNT(DISTINCT encounter_id) AS gold_labeled
            FROM ${S}.GOLD_LABEL GROUP BY 1
          ),
          evals AS (
            SELECT config_name, COUNT(*) AS eval_count FROM ${S}.EVAL_RUN GROUP BY 1
          )
          SELECT c.config_name, c.model, c.taxonomy_version_id, tv.status AS taxonomy_status,
                 c.is_active, c.notes, c.created_at, LENGTH(c.prompt_template) AS rubric_chars,
                 COALESCE(gold.gold_labeled, 0) AS gold_labeled,
                 COALESCE(evals.eval_count, 0)  AS eval_count,
                 l.eval_id, l.evaluated_at, l.verified_only,
                 ROUND(l.subtheme_accuracy,4)   AS subtheme_accuracy,
                 ROUND(l.theme_accuracy,4)      AS theme_accuracy,
                 ROUND(l.label_set_f1,4)        AS label_set_f1,
                 ROUND(l.no_good_match_rate,4)  AS no_good_match_rate,
                 ROUND(l.error_rate,4)          AS error_rate,
                 l.out_of_taxonomy_labels,
                 g.gate_result, g.gate_note, g.baseline_eval_id, g.baseline_config_name,
                 g.baseline_subtheme_accuracy, g.segments_regressed, g.regressed_detail
          FROM ${S}.CLASSIFIER_CONFIG c
          LEFT JOIN ${S}.TAXONOMY_VERSION tv ON tv.version_id = c.taxonomy_version_id
          LEFT JOIN gold  ON gold.taxonomy_version_id = c.taxonomy_version_id
          LEFT JOIN evals ON evals.config_name = c.config_name
          LEFT JOIN latest l ON l.config_name = c.config_name
          LEFT JOIN ${S}.EVAL_GATE g ON g.eval_id = l.eval_id
          WHERE c.taxonomy_version_id IS NOT NULL
          ORDER BY c.is_active DESC, l.subtheme_accuracy DESC NULLS LAST, c.created_at DESC`,
  }),

  /** Every promotion, with the verdict it was let through on and any override. */
  promotionLog: (): Sql => ({
    sql: `SELECT promotion_id, config_name, taxonomy_version_id, previous_config_name,
                 previous_taxonomy_version_id, eval_id, baseline_eval_id,
                 ROUND(subtheme_accuracy,4) AS subtheme_accuracy,
                 ROUND(baseline_subtheme_accuracy,4) AS baseline_subtheme_accuracy,
                 gate_result, override_reason, promoted_by, promoted_at
          FROM ${S}.PROMOTION_LOG ORDER BY promoted_at DESC`,
  }),

  /**
   * Per eval, what a taxonomy revision should move: how many gold encounters
   * the reference labeler could not place (the CATEGORY = NO_GOOD_MATCH
   * segment, absent once a gap is closed), and the weakest gated segment.
   */
  segmentSummary: (): Sql => ({
    sql: `SELECT eval_id,
                 COALESCE(SUM(IFF(segment_name = 'CATEGORY' AND segment_value = 'NO_GOOD_MATCH', n, 0)), 0)
                                                            AS unplaceable_gold,
                 MIN_BY(segment_name || '=' || segment_value,
                        IFF(gated, subtheme_accuracy, NULL)) AS weakest_segment,
                 ROUND(MIN(IFF(gated, subtheme_accuracy, NULL)), 4) AS weakest_accuracy
          FROM ${S}.EVAL_SEGMENT_DETAIL
          GROUP BY eval_id`,
  }),

  /** TEST DATA. Accuracy per eval per engineered test scenario. */
  testScenarioScorecard: (): Sql => ({
    sql: `SELECT eval_id, taxonomy_version_id, evaluated_at, test_scenario, n,
                 ROUND(subtheme_accuracy,4) AS subtheme_accuracy,
                 ROUND(low_conf_rate,4)     AS low_conf_rate
          FROM ${T}.TEST_SCENARIO_SCORECARD
          ORDER BY evaluated_at, test_scenario`,
  }),

  gapReview: (): Sql => ({
    sql: `SELECT encounter_id, taxonomy_version_id, gap_signal, forced_label,
                 confidence, evidence, note_text
          FROM ${S}.TAXONOMY_GAP_REVIEW
          ORDER BY gap_signal, encounter_id`,
  }),

  /* --- Page 2: Config Builder (configs) --- */

  /** Every config, templates included, with its taxonomy and latest verdict. */
  configs: (): Sql => ({
    sql: `WITH latest AS (
            SELECT * FROM ${S}.EVAL_SCORECARD
            QUALIFY ROW_NUMBER() OVER (PARTITION BY config_name ORDER BY evaluated_at DESC) = 1
          )
          SELECT cc.config_name, cc.model, cc.max_labels, cc.is_active, cc.created_at, cc.notes,
                 cc.taxonomy_version_id, tv.status AS taxonomy_status,
                 cc.taxonomy_version_id IS NULL     AS is_template,
                 LENGTH(cc.prompt_template)          AS rubric_chars,
                 ROUND(l.subtheme_accuracy, 4)       AS latest_subtheme_accuracy,
                 g.gate_result
          FROM ${S}.CLASSIFIER_CONFIG cc
          LEFT JOIN ${S}.TAXONOMY_VERSION tv ON tv.version_id = cc.taxonomy_version_id
          LEFT JOIN latest l                 ON l.config_name = cc.config_name
          LEFT JOIN ${S}.EVAL_GATE g         ON g.eval_id     = l.eval_id
          ORDER BY cc.is_active DESC, is_template, cc.created_at DESC`,
  }),

  configDetail: (configName: string): Sql => ({
    sql: `SELECT config_name, model, classify_fn, prompt_template, max_labels,
                 taxonomy_version_id, is_active, created_at, notes
          FROM ${S}.CLASSIFIER_CONFIG WHERE config_name = ?`,
    binds: [configName],
  }),
}

/* ---------------------------------------------------------------------------
   WRITES: allowlisted procedure calls only.

   Each entry names the procedure and declares how many arguments it takes.
   The API route refuses anything not in this map, so the UI cannot reach an
   arbitrary statement even if a request is forged.
--------------------------------------------------------------------------- */

export type ProcName = keyof typeof procs

/*
 * Argument conventions. The SDK cannot bind NULL or a JS boolean through
 * callProc, so:
 *   - an "unset" string is sent as '' and turned into NULL in the CALL with
 *     NULLIF(?, '') where the procedure treats NULL as "inherit" or "own"
 *   - an "unbounded" limit is sent as 0 and turned into NULL with NULLIF(?, 0)
 *   - booleans are sent as 'TRUE'/'FALSE' and wrapped in TO_BOOLEAN(?)
 */
export const procs = {
  /* --- Taxonomy authoring (page 2, Config Builder) --- */
  proposeTaxonomy: {
    sql: `CALL ${S}.PROPOSE_TAXONOMY(?, ?, ?)`,
    args: ["serviceLine", "model", "createdBy"] as const,
    long: true,
  },
  forkTaxonomy: {
    sql: `CALL ${S}.FORK_TAXONOMY(?, ?, NULLIF(?, ''))`,
    args: ["sourceVersionId", "createdBy", "notes"] as const,
    long: false,
  },
  /**
   * action is ADD | UPDATE | DELETE; unused fields are sent as ''.
   * originalSubtheme is passed through as-is (not NULLIF'd) so a node with a
   * blank subtheme can still be fixed.
   */
  editTaxonomyNode: {
    sql: `CALL ${S}.EDIT_TAXONOMY_NODE(?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "versionId",
      "action",
      "originalSubtheme",
      "category",
      "theme",
      "subtheme",
      "description",
      "routingNote",
    ] as const,
    long: false,
  },
  lockTaxonomy: {
    sql: `CALL ${S}.LOCK_TAXONOMY(?, ?)`,
    args: ["versionId", "lockedBy"] as const,
    long: false,
  },
  rejectTaxonomy: {
    sql: `CALL ${S}.REJECT_TAXONOMY(?, ?, ?)`,
    args: ["versionId", "reviewer", "reason"] as const,
    long: false,
  },

  /* --- Configs (page 2, Config Builder) --- */
  /** Empty model / template / taxonomy inherit from baseConfig; maxLabels 0 inherits too. */
  registerConfig: {
    sql: `CALL ${S}.REGISTER_CONFIG(?, NULLIF(?, ''), NULLIF(?, ''), NULLIF(?, ''),
                                    NULLIF(?, 0), NULLIF(?, ''), NULLIF(?, ''))`,
    args: [
      "configName",
      "baseConfig",
      "model",
      "promptTemplate",
      "maxLabels",
      "taxonomyVersionId",
      "notes",
    ] as const,
    long: false,
  },
  /** Writes nothing. taxonomyVersionId '' = the config's own taxonomy. */
  previewPrompt: {
    sql: `CALL ${S}.PREVIEW_PROMPT(?, NULLIF(?, ''), ?)`,
    args: ["configName", "taxonomyVersionId", "limit"] as const,
    long: true,
  },

  /* --- Evaluate & promote (page 3) --- */
  /**
   * Labels gold for the config's taxonomy if it has none (~200 frontier-model
   * calls, a couple of minutes), then classifies the gold set and scores it.
   */
  evaluateConfig: {
    sql: `CALL ${S}.EVALUATE_CONFIG(?, ?, TO_BOOLEAN(?))`,
    args: ["configName", "labelerModel", "verifiedOnly"] as const,
    long: true,
  },
  /** overrideReason '' = no override; refused if the gate did not pass. */
  promoteConfig: {
    sql: `CALL ${S}.PROMOTE_CONFIG(?, ?, ?)`,
    args: ["configName", "promotedBy", "overrideReason"] as const,
    long: false,
  },

  /* --- Production (page 4) --- */
  /** Always the champion. limit 0 = unbounded. */
  runClassifier: {
    sql: `CALL ${S}.RUN_CLASSIFIER(NULL, ?, NULLIF(?, 0))`,
    args: ["scope", "limit"] as const,
    long: true,
  },
  runEval: {
    sql: `CALL ${S}.RUN_EVAL(?, TO_BOOLEAN(?))`,
    args: ["runId", "verifiedOnly"] as const,
    long: true,
  },

  /* --- Monitor & revise (page 5) --- */
  proposeTaxonomyRevision: {
    sql: `CALL ${S}.PROPOSE_TAXONOMY_REVISION(?, ?)`,
    args: ["model", "createdBy"] as const,
    long: true,
  },
  queueGapEncounters: {
    sql: `CALL ${S}.QUEUE_GAP_ENCOUNTERS(?)`,
    args: ["reason"] as const,
    long: false,
  },
} as const

/**
 * The SQL object each page reads from, shown in the UI so every panel's source
 * is visible.
 * `testData` objects live in the synthetic schema and are listed separately.
 */
export const SOURCES = {
  explore: ["NOTE_RAW", "ENCOUNTER_PREP", "GOLD_ENCOUNTER", "DISCOVERY_SAMPLE"],
  exploreClassified: ["ENCOUNTER_THEME", "ENCOUNTER_PREP", "GOLD_ENCOUNTER"],
  build: [
    "TAXONOMY_VERSION",
    "TAXONOMY_NODE",
    "TAXONOMY_RENDERED",
    "PROPOSE_TAXONOMY()",
    "FORK_TAXONOMY()",
    "EDIT_TAXONOMY_NODE()",
    "LOCK_TAXONOMY()",
    "REJECT_TAXONOMY()",
    "TAXONOMY_DIFF()",
    "CLASSIFIER_CONFIG",
    "REGISTER_CONFIG()",
    "PREVIEW_PROMPT()",
  ],
  evaluate: [
    "EVALUATE_CONFIG()",
    "EVAL_SCORECARD",
    "EVAL_SEGMENT_DETAIL",
    "EVAL_GATE",
    "PROMOTE_CONFIG()",
    "PROMOTION_LOG",
  ],
  run: ["RUN_CLASSIFIER()", "PIPELINE_RUN", "CLASSIFICATION", "APP_RUN_STATUS", "RUN_COST"],
  monitor: ["EVAL_SCORECARD", "EVAL_GATE", "TAXONOMY_GAP_REVIEW", "PROPOSE_TAXONOMY_REVISION()"],
} as const

export const TEST_DATA_SOURCES = {
  explore: ["SYNTHETIC_DATA.TEST_SCENARIO"],
  monitor: ["SYNTHETIC_DATA.TEST_SCENARIO_SCORECARD"],
} as const
