/* ============================================================================
   PAN Lines Theme Extraction Pipeline - 01 SYNTHETIC DATA
   ----------------------------------------------------------------------------
   *** NOT PART OF THE PIPELINE. DEMO SCAFFOLDING ONLY. ***

   Builds its own schema, SYNTHETIC_DATA, generates synthetic nurse call notes
   there, and then writes them into the pipeline's three input tables in
   PIPELINE:

     PIPELINE.NOTE_RAW          note-level rows (the pipeline's source table)
                                800 unlabeled encounters -> the batch the pipeline runs
                                200 gold encounters      -> the evaluation baseline

     PIPELINE.DISCOVERY_SAMPLE  ~160 notes standing in for the sample a team
                                would pull to design the taxonomy. Deliberately
                                EXCLUDES the gap concept.
                                Real samples never cover everything; making that
                                explicit gives the gap-detection loop in 05
                                something real to find.

     PIPELINE.GOLD_ENCOUNTER    which 200 encounters are gold. Membership only.

   Nothing in PIPELINE reads this schema. With your own data, skip this file
   and load those three tables. The reverse is allowed: the two TEST_SCENARIO
   views below read pipeline OUTPUTS, so the demo can show how each kind of
   planted difficulty scored without the pipeline knowing they exist.

   Objects left in SYNTHETIC_DATA (the answer key, never seen by the pipeline):
     SEED_CONCEPT             concept list used to write the notes
     NOTE_SEED                per-encounter ground truth and scenario facts
     GEN_SPEC                 the note-writing prompts (view)
     NOTE_GEN                 raw note-writing output, kept so errors are inspectable
     TEST_SCENARIO            which planted difficulty each encounter carries (view)
     TEST_SCENARIO_SCORECARD  accuracy per eval per test scenario (view)

   TEST SCENARIOS ARE NOT EVALUATION SEGMENTS
   NOTE_SEED.slice (exposed as test_scenario) says how a note was BUILT:
   straightforward, a planted confusable pair, two concerns, a concept withheld
   from the taxonomy, or deliberately undecidable. Real notes carry no such tag.
   The pipeline evaluates on segments it can derive from real data (category,
   label count, note length; see 04). Test scenarios are shown alongside, as
   evidence that the test data is hard, never as an input to the gate.

   HOW GROUND TRUTH IS ESTABLISHED
   Notes are generated FROM a seeded scenario spec, not labeled after the fact.
   The seed is the ground truth, so a label cannot contradict the note text.
   Scenario facts are forced to be consistent with the target concept (a post-op
   concept always gets a recent procedure and <=30 days since discharge), so the
   routing rules in the rubric are actually decidable from the note.

   Diversity comes from the seed, not from sampling temperature. All pseudo-random
   choices are HASH-derived and therefore reproducible.

   PREREQUISITE: run 00_setup.sql first (it creates the three input tables).

   NAMES: PIPELINE tables are referenced by full name (PAN_DEMO_DB.PIPELINE.*)
   throughout this file. Find-replace those if you rename the database or schema.

   WARNING: running this file regenerates the corpus (~1000 model calls) and
   overwrites the input tables, which invalidates any gold labels. Run it once
   during setup. Between demos use demo/reset_demo.sql or demo/reset_webapp.sql.
============================================================================ */

USE DATABASE PAN_DEMO_DB;
CREATE SCHEMA IF NOT EXISTS SYNTHETIC_DATA;
USE SCHEMA SYNTHETIC_DATA;

/* Corpus size. 1000 is the demo default: 200 gold + 800 unlabeled.

   Lower it (e.g. 60) ONLY to smoke-test that the scripts run end to end. It is
   not a smaller valid demo: the gold strata are sized by absolute row position,
   and the discovery sample is drawn from rows 200-580, so at 60 rows every row
   is gold, the strata are empty, and DISCOVERY_SAMPLE has no rows at all, so
   PROPOSE_TAXONOMY invents a taxonomy from nothing. Anything below ~600 makes
   the evaluation meaningless. */
SET corpus_size = 1000;


/* ============================================================================
   1. SEED_CONCEPT: the reference concept list used ONLY to generate notes.

   This is NOT the taxonomy. The taxonomy is discovered by an LLM in 02 and may
   name things differently. Keeping this table around lets you show "here is what
   we seeded vs. what the model found", which is a useful aside but never the
   production artifact.

   Columns that do real work:
     REQUIRES_RECENT_SURGERY  forces scenario facts to support the label
     IS_GAP_CONCEPT           excluded from DISCOVERY_SAMPLE -> becomes the gap
     NEAR_NEIGHBOUR_OF        the confusable partner; drives the hard slice
============================================================================ */
CREATE OR REPLACE TABLE SEED_CONCEPT (
    concept_id              INT,
    category                VARCHAR,
    theme                   VARCHAR,
    subtheme                VARCHAR,
    description             VARCHAR,
    requires_recent_surgery BOOLEAN,
    is_gap_concept          BOOLEAN,
    near_neighbour_of       VARCHAR,
    /* Used for gap concepts only. Gap notes that could plausibly be absorbed
       into an existing subtheme (e.g. cost or insurance) produce a weak
       NO_GOOD_MATCH signal. The hint tells the generator to explicitly RULE OUT
       the adjacent concepts, so the gap is unmistakable. */
    exclusion_hint          VARCHAR
);

INSERT INTO SEED_CONCEPT
  (concept_id, category, theme, subtheme, description, requires_recent_surgery, is_gap_concept, near_neighbour_of)
VALUES
-- ---------------- POST-OP (8) ----------------
(1 ,'POST-OP','Surgical Site','Incision Redness Or Drainage','Patient reports redness, warmth, weeping or purulent drainage at a surgical incision.',TRUE ,FALSE,NULL),
(2 ,'POST-OP','Surgical Site','Incision Dehiscence','Patient reports the incision is opening, separating, or sutures/staples have come apart.',TRUE ,FALSE,NULL),
(3 ,'POST-OP','Surgical Site','Surgical Site Pain Uncontrolled','Pain localized to the operative site that is not controlled by the prescribed regimen.',TRUE ,FALSE,'Abdominal Pain Not Surgical'),
(4 ,'POST-OP','Surgical Site','Drain Or Tube Concern','Concern about a surgical drain, catheter, ostomy appliance or feeding tube.',TRUE ,FALSE,NULL),
(5 ,'POST-OP','Post-Op Recovery','Post-Op Nausea Vomiting','Nausea or vomiting attributed to recent surgery or anesthesia.',TRUE ,FALSE,'Nausea Vomiting Not Post-Op'),
(6 ,'POST-OP','Post-Op Recovery','Post-Op Constipation','No bowel movement or difficulty passing stool following surgery, often opioid-related.',TRUE ,FALSE,NULL),
(7 ,'POST-OP','Post-Op Recovery','Post-Op Mobility Limitation','Difficulty ambulating, transferring, or performing activity at the expected post-op stage.',TRUE ,FALSE,NULL),
(8 ,'POST-OP','Post-Op Recovery','Post-Op Diet Intolerance','Unable to tolerate the prescribed post-operative diet advancement.',TRUE ,FALSE,NULL),
-- ---------------- SYMPTOMS (12) ----------------
(9 ,'SYMPTOMS','GI Symptoms','Abdominal Pain Not Surgical','Abdominal pain with no recent surgery, or clearly unrelated to an operative site.',FALSE,FALSE,'Surgical Site Pain Uncontrolled'),
(10,'SYMPTOMS','GI Symptoms','Diarrhea','Loose or frequent stools, including suspected antibiotic-associated diarrhea.',FALSE,FALSE,NULL),
(11,'SYMPTOMS','GI Symptoms','Nausea Vomiting Not Post-Op','Nausea or vomiting unrelated to a recent surgical procedure.',FALSE,FALSE,'Post-Op Nausea Vomiting'),
(12,'SYMPTOMS','GI Symptoms','GI Bleeding','Blood in stool, melena, or hematemesis.',FALSE,FALSE,NULL),
(13,'SYMPTOMS','Cardiopulmonary Symptoms','Shortness Of Breath','New or worsening dyspnea at rest or on exertion.',FALSE,FALSE,NULL),
(14,'SYMPTOMS','Cardiopulmonary Symptoms','Chest Pain','Chest pain, pressure or tightness.',FALSE,FALSE,NULL),
(15,'SYMPTOMS','Cardiopulmonary Symptoms','Edema Or Swelling','Peripheral edema, weight gain, or new swelling.',FALSE,FALSE,NULL),
(16,'SYMPTOMS','Cardiopulmonary Symptoms','Palpitations','Irregular, racing or skipped heartbeats.',FALSE,FALSE,NULL),
(17,'SYMPTOMS','Neuro And General Symptoms','Dizziness Or Lightheadedness','Dizziness, lightheadedness, near-syncope or falls.',FALSE,FALSE,NULL),
(18,'SYMPTOMS','Neuro And General Symptoms','Fatigue Or Weakness','Generalized fatigue, deconditioning or weakness.',FALSE,FALSE,NULL),
(19,'SYMPTOMS','Neuro And General Symptoms','Fever Or Chills','Documented or subjective fever, chills or rigors.',FALSE,FALSE,NULL),
(20,'SYMPTOMS','Neuro And General Symptoms','Confusion Or Altered Mental Status','New confusion, disorientation or altered mental status.',FALSE,FALSE,NULL),
-- ---------------- MEDICATIONS (9) ----------------
(21,'MEDICATIONS','Medication Adherence','Medication Not Started','Patient has the medication but has not begun taking it as prescribed.',FALSE,FALSE,'Prescription Not Received At Pharmacy'),
(22,'MEDICATIONS','Medication Adherence','Medication Dose Confusion','Patient is unsure of the dose, frequency or timing of a medication they hold.',FALSE,FALSE,NULL),
(23,'MEDICATIONS','Medication Adherence','Duplicate Or Conflicting Medication','Patient is taking a duplicate therapy or a discharge med conflicts with a home med.',FALSE,FALSE,NULL),
(24,'MEDICATIONS','Medication Effects','Suspected Adverse Drug Reaction','New symptom the patient or nurse attributes to a medication.',FALSE,FALSE,NULL),
(25,'MEDICATIONS','Medication Effects','Pain Control Inadequate On Current Regimen','Pain not controlled despite taking the regimen as prescribed, not localized to an incision.',FALSE,FALSE,'Surgical Site Pain Uncontrolled'),
(26,'MEDICATIONS','Medication Effects','Anticoagulation Concern','Bruising, bleeding, or INR/monitoring questions on an anticoagulant.',FALSE,FALSE,NULL),
(27,'MEDICATIONS','Medication Supply','Prescription Not Received At Pharmacy','Prescription was never sent, never arrived, or the pharmacy has no record of it.',FALSE,FALSE,'Medication Not Started'),
(28,'MEDICATIONS','Medication Supply','Medication Cost Barrier','Patient cannot afford a prescribed medication, so it is unfilled or being rationed.',FALSE,FALSE,'Unable To Afford Copay Or Visit'),
(29,'MEDICATIONS','Medication Supply','Prior Authorization Delay','Medication is held up pending insurer prior authorization.',FALSE,FALSE,NULL),
-- ---------------- CARE COORDINATION (9) ----------------
(30,'CARE COORDINATION','Appointments','Follow-Up Appointment Not Scheduled','No post-discharge follow-up appointment has been made.',FALSE,FALSE,NULL),
(31,'CARE COORDINATION','Appointments','Follow-Up Appointment Conflict','An appointment exists but the patient cannot attend as scheduled.',FALSE,FALSE,'No Transportation To Follow-Up'),
(32,'CARE COORDINATION','Appointments','Specialist Referral Pending','A referral to a specialist has not been completed or scheduled.',FALSE,FALSE,NULL),
(33,'CARE COORDINATION','Home Services','Home Health Not Started','Ordered home health or visiting nurse services have not begun.',FALSE,FALSE,NULL),
(34,'CARE COORDINATION','Home Services','DME Not Delivered','Ordered durable medical equipment has not arrived or does not work.',FALSE,FALSE,NULL),
(35,'CARE COORDINATION','Home Services','Wound Care Service Gap','Ordered wound care visits or supplies are not in place.',FALSE,FALSE,'Wound Care Instruction Unclear'),
(36,'CARE COORDINATION','Provider Communication','Unable To Reach Provider Office','Patient could not get through to the surgeon, PCP or specialist office.',FALSE,FALSE,NULL),
(37,'CARE COORDINATION','Provider Communication','Conflicting Instructions Between Providers','Patient received contradictory guidance from two care team members.',FALSE,FALSE,NULL),
(38,'CARE COORDINATION','Provider Communication','Test Result Not Communicated','Patient is waiting on results that were never relayed.',FALSE,FALSE,NULL),
-- ---------------- PATIENT EDUCATION (7) ----------------
(39,'PATIENT EDUCATION','Discharge Instruction Clarity','Activity Restriction Unclear','Patient unsure what lifting, driving or activity limits apply.',FALSE,FALSE,NULL),
(40,'PATIENT EDUCATION','Discharge Instruction Clarity','Diet Instruction Unclear','Patient unsure what they may eat or drink.',FALSE,FALSE,NULL),
(41,'PATIENT EDUCATION','Discharge Instruction Clarity','Wound Care Instruction Unclear','Patient does not understand how to change a dressing or care for the wound.',FALSE,FALSE,'Wound Care Service Gap'),
(42,'PATIENT EDUCATION','Discharge Instruction Clarity','Warning Signs Not Understood','Patient cannot state which symptoms should prompt a call or ED visit.',FALSE,FALSE,NULL),
(43,'PATIENT EDUCATION','Self-Management Skills','Glucose Monitoring Difficulty','Difficulty checking glucose or interpreting readings.',FALSE,FALSE,NULL),
(44,'PATIENT EDUCATION','Self-Management Skills','Weight Or BP Monitoring Not Done','Prescribed daily weights or blood pressure checks are not happening.',FALSE,FALSE,NULL),
(45,'PATIENT EDUCATION','Self-Management Skills','Device Or Equipment Use Difficulty','Difficulty operating equipment such as a nebulizer, CPAP or walker.',FALSE,FALSE,NULL),
-- ---------------- ACCESS & SOCIAL (5) ----------------
(46,'ACCESS & SOCIAL','Financial Barriers','Insurance Coverage Question','Question about what insurance will cover for a service or item.',FALSE,FALSE,NULL),
(47,'ACCESS & SOCIAL','Financial Barriers','Unable To Afford Copay Or Visit','Patient cannot afford a visit, copay or service (not a medication).',FALSE,FALSE,'Medication Cost Barrier'),
(48,'ACCESS & SOCIAL','Caregiver And Home Support','Caregiver Unavailable','No caregiver available to provide needed assistance at home.',FALSE,FALSE,NULL),
(49,'ACCESS & SOCIAL','Caregiver And Home Support','Unsafe Or Unstable Housing','Housing is unsafe, unstable or unsuitable for recovery.',FALSE,FALSE,NULL),
(50,'ACCESS & SOCIAL','Caregiver And Home Support','Food Insecurity Affecting Recovery','Inadequate access to food appropriate for the prescribed diet.',FALSE,FALSE,NULL),
-- ---------------- ADMINISTRATIVE (6) ----------------
(51,'ADMINISTRATIVE','Call Disposition','No Answer Or Voicemail Left','Call not answered; voicemail left or no contact made.',FALSE,FALSE,NULL),
(52,'ADMINISTRATIVE','Call Disposition','Wrong Or Disconnected Number','Number on file is wrong, disconnected or belongs to someone else.',FALSE,FALSE,NULL),
(53,'ADMINISTRATIVE','Call Disposition','Patient Declined Call','Patient declined to participate or asked to be removed.',FALSE,FALSE,NULL),
(54,'ADMINISTRATIVE','Call Disposition','Call Completed No Concerns','Call completed, patient recovering as expected, no concerns raised.',FALSE,FALSE,NULL),
(55,'ADMINISTRATIVE','Data Quality','Duplicate Encounter Record','Encounter appears to duplicate another record.',FALSE,FALSE,NULL),
(56,'ADMINISTRATIVE','Data Quality','Incorrect Patient Contact Info','Contact information on file needs correction.',FALSE,FALSE,NULL);

INSERT INTO SEED_CONCEPT
  (concept_id, category, theme, subtheme, description, requires_recent_surgery, is_gap_concept, near_neighbour_of, exclusion_hint)
VALUES
-- ======== THE GAP: Transportation availability. Excluded from DISCOVERY_SAMPLE. ========
-- Present in the notes, absent from taxonomy v1. This is what the NO_GOOD_MATCH
-- escape hatch surfaces, and what drives the revision loop in 05.
-- Each carries an exclusion_hint so the generated note explicitly rules out the
-- nearest existing subthemes (cost, insurance, scheduling, caregiver support).
-- Without that, these notes get defensibly absorbed and the gap goes quiet.
(57,'ACCESS & SOCIAL','Transportation Barriers','No Transportation To Follow-Up','Patient has no means of getting to a scheduled appointment.',FALSE,TRUE,NULL,
 'Make it unmistakable that the obstacle is the physical means of travel. The patient should explicitly say money is NOT the problem and that they are not asking about insurance or coverage. No car, no one to drive, no usable bus or transit option. The appointment time itself is fine -- rescheduling would not help.'),
(58,'ACCESS & SOCIAL','Transportation Barriers','Medical Transport Arrangement Needed','Patient requires wheelchair van, stretcher or ambulance transport to attend care and none is arranged.',FALSE,TRUE,NULL,
 'Make it unmistakable that the patient physically cannot travel by ordinary car (cannot sit upright, cannot transfer, bed-bound) and that no medical transport has been arranged. The patient should explicitly say this is not a question about cost, coverage or eligibility -- they need the transport itself arranged.'),
(59,'ACCESS & SOCIAL','Transportation Barriers','Transportation Barrier To Recurring Treatment','Patient cannot reliably reach a recurring treatment series such as dialysis, infusion, wound clinic or physical therapy.',FALSE,TRUE,NULL,
 'Make it unmistakable that the problem is getting there repeatedly, several times a week, not a one-off. The patient should explicitly say they can afford it and are not asking about insurance -- the difficulty is arranging travel that often.');


/* ============================================================================
   2. NOTE_SEED: one row per encounter, carrying the ground truth and the
      scenario facts the note must be consistent with.

   Gold test-scenario mix (200). Stored in the slice column, exposed as
   TEST_SCENARIO.test_scenario (section 8), and never reaches PIPELINE:
     120 straightforward   the base rate
      30 near-neighbour    confusable pairs; surface similarity points the wrong way
      20 multi-label       seeded with two concerns
      15 gap               concept withheld from the design sample; drives 05
      15 ambiguous         written to be undecidable between two subthemes

   Unlabeled (800) is skewed so low-count themes actually exist, giving the
   "consolidate low-count themes" check something to detect.
============================================================================ */
CREATE OR REPLACE TABLE NOTE_SEED (
    encounter_id          VARCHAR,
    service_line          VARCHAR,
    is_gold               BOOLEAN,
    slice                 VARCHAR,     -- STRAIGHTFORWARD | NEAR_NEIGHBOUR | MULTI_LABEL | GAP | AMBIGUOUS
    verbosity             VARCHAR,     -- TERSE | NORMAL | RAMBLING
    primary_concept_id    INT,
    secondary_concept_id  INT,
    confusable_with       VARCHAR,     -- surface cue to plant, for NEAR_NEIGHBOUR/AMBIGUOUS
    procedure_name        VARCHAR,
    days_post_discharge   INT,
    age_band              VARCHAR,
    caller                VARCHAR,
    note_line_count       INT,
    in_discovery_sample   BOOLEAN
);

INSERT INTO NOTE_SEED
WITH seq AS (
    /* GENERATOR's ROWCOUNT must be a literal, so the size knob is applied as a
       filter. It has to be a WHERE over a subquery, not QUALIFY: QUALIFY
       requires a window function and SEQ4() is not one. */
    SELECT n FROM (SELECT SEQ4() + 1 AS n FROM TABLE(GENERATOR(ROWCOUNT => 1000)))
    WHERE n <= $corpus_size
),
/* Deterministic pseudo-random draws. HASH is stable, so regenerating this table
   reproduces the same corpus. */
base AS (
    SELECT n,
           n <= 200                                      AS is_gold,
           ABS(HASH(n, 'slice'))   % 1000                AS r_slice,
           ABS(HASH(n, 'verb'))    % 100                 AS r_verb,
           ABS(HASH(n, 'concept')) % 1000                AS r_concept,
           ABS(HASH(n, 'sec'))     % 100000              AS r_sec,
           ABS(HASH(n, 'proc'))    % 8                   AS r_proc,
           ABS(HASH(n, 'procflag'))% 12                  AS r_procflag,
           ABS(HASH(n, 'days'))    % 100                 AS r_days,
           ABS(HASH(n, 'age'))     % 5                   AS r_age,
           ABS(HASH(n, 'caller'))  % 10                  AS r_caller,
           ABS(HASH(n, 'lines'))   % 100                 AS r_lines
    FROM seq
),
sliced AS (
    SELECT b.*,
           CASE
             /* Gold: exact counts by position so the strata are guaranteed. */
             WHEN is_gold AND n <= 120 THEN 'STRAIGHTFORWARD'
             WHEN is_gold AND n <= 150 THEN 'NEAR_NEIGHBOUR'
             WHEN is_gold AND n <= 170 THEN 'MULTI_LABEL'
             WHEN is_gold AND n <= 185 THEN 'GAP'
             WHEN is_gold             THEN 'AMBIGUOUS'
             /* Unlabeled: proportional, roughly mirroring the gold mix. */
             WHEN r_slice < 620 THEN 'STRAIGHTFORWARD'
             WHEN r_slice < 760 THEN 'NEAR_NEIGHBOUR'
             WHEN r_slice < 860 THEN 'MULTI_LABEL'
             WHEN r_slice < 940 THEN 'GAP'
             ELSE                    'AMBIGUOUS'
           END AS slice
    FROM base b
),
/* ---- Candidate pools, numbered so a hash can index into them by equijoin.
        Correlated scalar subqueries are not supported here, so every pick below
        is a plain join against a numbered pool. ---- */
pools AS (
    SELECT 'GAP'  AS pool_name, concept_id,
           ROW_NUMBER() OVER (ORDER BY concept_id) AS rn
    FROM SEED_CONCEPT WHERE is_gap_concept
    UNION ALL
    SELECT 'NEAR', concept_id,
           ROW_NUMBER() OVER (ORDER BY concept_id)
    FROM SEED_CONCEPT WHERE NOT is_gap_concept AND near_neighbour_of IS NOT NULL
    UNION ALL
    SELECT 'ANY', concept_id,
           ROW_NUMBER() OVER (ORDER BY concept_id)
    FROM SEED_CONCEPT WHERE NOT is_gap_concept
),
pool_sizes AS (
    SELECT pool_name, MAX(rn) AS cnt FROM pools GROUP BY pool_name
),
routed AS (
    SELECT s.*,
           CASE WHEN s.slice = 'GAP'                            THEN 'GAP'
                WHEN s.slice IN ('NEAR_NEIGHBOUR','AMBIGUOUS')  THEN 'NEAR'
                ELSE                                                 'ANY'
           END AS pool_name
    FROM sliced s
),
indexed AS (
    SELECT r.*,
           /* Skew on the ANY pool: squaring the draw biases toward low
              concept_ids, so some subthemes end up genuinely rare. That is what
              makes the low-count-theme signal real rather than asserted. */
           CASE WHEN r.pool_name = 'ANY'
                THEN 1 + MOD(FLOOR(POWER(r.r_concept, 2) / 1000)::INT, ps.cnt)
                ELSE 1 + MOD(r.r_concept, ps.cnt)
           END AS pick_rn
    FROM routed r
    JOIN pool_sizes ps ON ps.pool_name = r.pool_name
),
picked AS (
    SELECT i.*, p.concept_id AS primary_concept_id
    FROM indexed i
    JOIN pools p ON p.pool_name = i.pool_name AND p.rn = i.pick_rn
),
prim AS (
    SELECT pk.*,
           c.category   AS primary_category,
           c.near_neighbour_of,
           c.requires_recent_surgery,
           /* Does this note's planted confusable cue point AT a gap concept?
              If so the note discusses gap-adjacent content (e.g. an appointment
              conflict caused by a ride falling through) and must stay OUT of the
              discovery sample. Otherwise the taxonomy generator can infer the
              gap concept from the cue, and the gap closes before the revision
              loop can find it. */
           gp.concept_id IS NOT NULL AS confusable_is_gap
    FROM picked pk
    JOIN SEED_CONCEPT c  ON c.concept_id = pk.primary_concept_id
    LEFT JOIN SEED_CONCEPT gp
           ON gp.subtheme = c.near_neighbour_of AND gp.is_gap_concept
),
/* ---- Secondary label pool: every non-gap concept OUTSIDE a given category,
        so the second label is materially distinct and never a restatement. ---- */
sec_pool AS (
    SELECT cat.category AS exclude_category, c2.concept_id,
           ROW_NUMBER() OVER (PARTITION BY cat.category ORDER BY c2.concept_id) AS rn
    FROM (SELECT DISTINCT category FROM SEED_CONCEPT) cat
    JOIN SEED_CONCEPT c2
      ON c2.category <> cat.category AND NOT c2.is_gap_concept
),
sec_sizes AS (
    SELECT exclude_category, MAX(rn) AS cnt FROM sec_pool GROUP BY exclude_category
),
sec_indexed AS (
    SELECT p.*,
           CASE WHEN p.slice = 'MULTI_LABEL'
                THEN 1 + MOD(p.r_sec, ss.cnt) END AS sec_pick_rn
    FROM prim p
    JOIN sec_sizes ss ON ss.exclude_category = p.primary_category
),
resolved AS (
    SELECT si.*, sp.concept_id AS secondary_concept_id
    FROM sec_indexed si
    LEFT JOIN sec_pool sp
      ON sp.exclude_category = si.primary_category
     AND sp.rn               = si.sec_pick_rn
)
SELECT
    'ENC-' || LPAD(n::VARCHAR, 5, '0')                       AS encounter_id,
    'READMISSIONS'                                           AS service_line,
    is_gold,
    slice,
    CASE WHEN r_verb < 20 THEN 'TERSE'
         WHEN r_verb < 80 THEN 'NORMAL'
         ELSE                  'RAMBLING' END                AS verbosity,
    primary_concept_id,
    secondary_concept_id,
    /* Plant the confusable partner as a surface cue on the hard slices only. */
    CASE WHEN slice IN ('NEAR_NEIGHBOUR','AMBIGUOUS') THEN near_neighbour_of END AS confusable_with,
    /* Scenario facts are forced consistent with the label: a post-op concept
       always gets a procedure and a recent discharge, so ROUTING RULE 1 is
       decidable from the note rather than a coin flip. Conversely a non-post-op
       concept that still mentions surgery is pushed past 30 days, so rule 1
       must NOT fire on it. */
    CASE WHEN requires_recent_surgery OR r_procflag < 6 THEN
           CASE r_proc WHEN 0 THEN 'colectomy'
                       WHEN 1 THEN 'cholecystectomy'
                       WHEN 2 THEN 'hernia repair'
                       WHEN 3 THEN 'CABG'
                       WHEN 4 THEN 'total knee arthroplasty'
                       WHEN 5 THEN 'hysterectomy'
                       WHEN 6 THEN 'appendectomy'
                       ELSE        'lumbar laminectomy' END
    END                                                      AS procedure_name,
    CASE WHEN requires_recent_surgery THEN 2  + MOD(r_days, 20)   -- 2..21  (<=30)
         WHEN r_procflag < 6          THEN 35 + MOD(r_days, 60)   -- 35..94 (>30)
         ELSE                              1  + MOD(r_days, 14)
    END                                                      AS days_post_discharge,
    CASE r_age WHEN 0 THEN '45-54' WHEN 1 THEN '55-64' WHEN 2 THEN '65-74'
               WHEN 3 THEN '75-84' ELSE '85+' END            AS age_band,
    CASE WHEN r_caller < 7 THEN 'patient' ELSE 'caregiver' END AS caller,
    /* ~25% of encounters get two call-attempt notes, so the rollup in 03 has
       genuine work to do rather than being a pass-through. */
    CASE WHEN r_lines < 25 THEN 2 ELSE 1 END                 AS note_line_count,
    /* Discovery sample: ~150 notes drawn from the UNLABELED pool.
       Excludes gap concepts AND gap-adjacent cues (see confusable_is_gap above),
       so taxonomy v1 ships with a genuine hole. */
    (NOT is_gold AND slice <> 'GAP' AND NOT confusable_is_gap
       AND n > 200 AND n <= 580 AND MOD(n, 2) = 0) AS in_discovery_sample
FROM resolved;


/* Sanity: slice distribution and the consistency guarantee. */
SELECT is_gold, slice, COUNT(*) AS n,
       COUNT_IF(procedure_name IS NOT NULL) AS with_procedure,
       MIN(days_post_discharge) AS min_days, MAX(days_post_discharge) AS max_days
FROM NOTE_SEED GROUP BY ALL ORDER BY is_gold DESC, slice;


/* ============================================================================
   3. GEN_SPEC: assembles one generation prompt per encounter.

   Kept as a view so you can read the prompts before spending anything on
   generation. Two rules matter here:

   (a) The note must NEVER contain the subtheme name verbatim. If it does,
       classification degenerates into string matching and the demo proves
       nothing.
   (b) Verbosity is NOISE ONLY. Every rubric-relevant fact stays present at all
       three verbosity levels, otherwise terse rows are information-starved and
       scoring them measures unfairness rather than model quality.
============================================================================ */
CREATE OR REPLACE VIEW GEN_SPEC AS
SELECT
    s.encounter_id,
    s.slice,
    s.note_line_count,
    CONCAT(
'Write realistic free-text clinical note text as it would be typed by a Patient Advisory Nurse ',
'during a post-discharge follow-up telephone call. Write it the way a busy nurse actually types: ',
'terse, clinical, sentence fragments, standard abbreviations (pt, c/o, denies, s/p, PRN, VM, ROV). ',
'Not polished prose. No headings. No bullet points.

ENCOUNTER FACTS (all of these must be consistent with what you write)
- Caller: ', s.caller,
'\n- Patient age band: ', s.age_band,
'\n- Days since discharge: ', s.days_post_discharge::VARCHAR,
CASE WHEN s.procedure_name IS NOT NULL
     THEN CONCAT('\n- Recent procedure: ', s.procedure_name) ELSE '' END,
'\n\nWHAT THE CALL SURFACED (this is the substance of the note)
- ', pc.description,
CASE WHEN sc.description IS NOT NULL THEN CONCAT(
'\n- AND ALSO a second, clearly distinct concern: ', sc.description) ELSE '' END,
CASE WHEN s.slice = 'NEAR_NEIGHBOUR' AND s.confusable_with IS NOT NULL THEN CONCAT(
'\n\nIMPORTANT NUANCE. Include surface detail that could superficially suggest "', s.confusable_with,
'", but the facts you write must make clear that the concern is actually the one described above. ',
'A careful reader applying the encounter facts should land on the concern above, not on the ',
'superficially similar one. Do not make it a trick; make it require attention to the facts.') ELSE '' END,
CASE WHEN s.slice = 'AMBIGUOUS' AND s.confusable_with IS NOT NULL THEN CONCAT(
'\n\nIMPORTANT. Write this one so it is GENUINELY AMBIGUOUS between the concern above and "',
s.confusable_with, '". A reasonable reviewer could defend either reading. Do not resolve it.') ELSE '' END,
CASE WHEN COALESCE(pc.exclusion_hint,'') <> '' THEN CONCAT(
'\n\nDISAMBIGUATION REQUIREMENT. ', pc.exclusion_hint) ELSE '' END,
'\n\nSTYLE
- Length: ', CASE s.verbosity
    WHEN 'TERSE'    THEN 'very brief, 1-2 clipped sentences'
    WHEN 'NORMAL'   THEN '3-5 sentences'
    ELSE 'long and rambling, 6-10 sentences, including social chatter and irrelevant tangents (weather, family, unrelated complaints)'
  END,
'\n- CRITICAL: whatever the length, every fact needed to identify the concern must still be present. Brevity must not remove substance.
- CRITICAL: do NOT use the formal category label for the concern. Describe what the patient said in their own terms. Never write a phrase that looks like a taxonomy label.
- Do not state a diagnosis or classification. Just document the call.
',
CASE WHEN s.note_line_count = 2 THEN
'- Set note_line_1 to a SHORT earlier call-attempt note from this same encounter (e.g. no answer, VM left, call back requested). Set note_line_2 to the substantive note described above.'
ELSE
'- Set note_line_1 to the substantive note described above. Set note_line_2 to exactly the word NONE.' END,
'\n- Return plain note text in each field. Do not wrap the text in brackets, quotes, or JSON.'
    ) AS gen_prompt
FROM NOTE_SEED s
JOIN SEED_CONCEPT pc ON pc.concept_id = s.primary_concept_id
LEFT JOIN SEED_CONCEPT sc ON sc.concept_id = s.secondary_concept_id;


/* ----------------------------------------------------------------------------
   Scale check before the batch.

   AI_COUNT_TOKENS does not return a count for every model, so prompt
   characters below are a rough proxy only: about 4 chars per token for
   English, and OUTPUT tokens bill on top of input.

   Actual measured consumption (input AND output, per run, per config) is
   reported by the RUN_COST view in 04_evaluation.sql, sourced from
   SNOWFLAKE.ACCOUNT_USAGE.CORTEX_AISQL_USAGE_HISTORY. Use that figure for cost
   reporting, because it is measured rather than estimated.
---------------------------------------------------------------------------- */
SELECT COUNT(*)                          AS calls,
       ROUND(AVG(LENGTH(gen_prompt)))    AS avg_prompt_chars,
       SUM(LENGTH(gen_prompt))           AS total_prompt_chars
FROM GEN_SPEC;


/* ============================================================================
   4. GENERATE THE NOTE TEXT  (~1000 AI_COMPLETE calls)

   WARNING: re-running this file regenerates the corpus and incurs the
   generation cost again. Run 01 once during setup, not during the demo.

   NOTE_GEN is kept as a separate landing table so a generation error is
   inspectable rather than silently producing a short corpus.
   return_error_details => TRUE is what makes that possible: without it a
   failure is an indistinguishable NULL.
============================================================================ */
CREATE OR REPLACE TABLE NOTE_GEN AS
SELECT
    g.encounter_id,
    AI_COMPLETE(
        model  => 'claude-haiku-4-5',
        prompt => g.gen_prompt,
        /* Two fixed scalar fields, NOT an array. With an array schema a small
           share of calls fail validation ('type should be array, got string')
           because the model emits a single string that looks like an array.
           Fixed scalar fields for a small known count are more reliable in
           json mode. */
        response_format => PARSE_JSON('{"type":"json","schema":{
            "type":"object","additionalProperties":false,
            "properties":{"note_line_1":{"type":"string"},
                          "note_line_2":{"type":"string"}},
            "required":["note_line_1","note_line_2"]}}'),
        return_error_details => TRUE
    ) AS res
FROM GEN_SPEC g;

/* Generation health. Anything non-zero in gen_errors needs looking at before
   you trust the corpus. */
SELECT COUNT(*)                                                       AS encounters,
       COUNT_IF(res:error IS NOT NULL)                                AS gen_errors,
       COUNT_IF(res:value:note_line_2::VARCHAR NOT IN ('NONE',''))    AS two_line_encounters
FROM NOTE_GEN;


/* ============================================================================
   5. LOAD PIPELINE.NOTE_RAW: the source table the pipeline reads.

   Deliberately contains ONLY what a real note-level source table would expose:
   identifiers, dates, and free text. No labels, no slice flags, no structured
   procedure column. Everything the classifier needs must come out of the note
   text, which is the harder and more realistic test.

   (A production deployment might also pass structured encounter context such
   as procedure code alongside the note. That would make the post-op routing
   rule easier, not harder, so this is the conservative setup.)

   INSERT OVERWRITE rather than CREATE OR REPLACE: the table belongs to
   PIPELINE (created in 00), and replacing it would reinitialize the dynamic
   table built on it in 03.
============================================================================ */
INSERT OVERWRITE INTO PAN_DEMO_DB.PIPELINE.NOTE_RAW
    (encounter_id, service_line, note_seq, note_text, discharge_date, call_date, loaded_at)
WITH lines AS (
    SELECT encounter_id, 1 AS note_seq, res:value:note_line_1::VARCHAR AS note_text
    FROM NOTE_GEN WHERE res:error IS NULL
    UNION ALL
    SELECT encounter_id, 2, res:value:note_line_2::VARCHAR
    FROM NOTE_GEN
    WHERE res:error IS NULL
      AND res:value:note_line_2::VARCHAR NOT IN ('NONE','')
)
SELECT
    l.encounter_id,
    s.service_line,
    l.note_seq,
    l.note_text,
    DATEADD(day, -s.days_post_discharge, CURRENT_DATE())  AS discharge_date,
    CURRENT_DATE()                                        AS call_date,
    CURRENT_TIMESTAMP()                                   AS loaded_at
FROM lines l
JOIN NOTE_SEED s ON s.encounter_id = l.encounter_id;


/* ============================================================================
   6. LOAD PIPELINE.DISCOVERY_SAMPLE: the notes used to design the taxonomy.

   Excludes the gap concept by construction (see in_discovery_sample in
   NOTE_SEED). This mirrors how taxonomy gaps arise in practice: a design
   sample never covers everything, so v1 ships with a hole and the loop in 05
   has something genuine to find.

   TWO LAYERS OF EXCLUSION, and both are required:

     1. CONCEPT level (in_discovery_sample): drops GAP-slice encounters and
        gap-adjacent ones (confusable_is_gap).

     2. TEXT level (below): drops encounters whose generated note text
        volunteers transportation access even though the note was seeded as a
        different concept (e.g. a food-insecurity note that mentions trouble
        getting to the market). One such note can be enough for the generator
        to infer a transportation subtheme, which closes the gap before 05 can
        find it.

   Layer 2 cannot be folded into layer 1, because layer 1 keys on the seeded
   concept and the leak happens in the text the note-writing model produced.
   Deliberately narrow: it matches transportation ACCESS terms only, so a
   post-op note about lifting or driving restrictions correctly stays in the
   sample. Over-excluding here would distort the design sample.

   Both layers live here, in the synthetic-data file, because they are how the
   demo creates the gap. The pipeline just reads whatever sample it is given.
============================================================================ */
INSERT OVERWRITE INTO PAN_DEMO_DB.PIPELINE.DISCOVERY_SAMPLE (encounter_id, note_text)
WITH rolled AS (
    SELECT r.encounter_id,
           LISTAGG(r.note_text, ' ') WITHIN GROUP (ORDER BY r.note_seq) AS note_text
    FROM PAN_DEMO_DB.PIPELINE.NOTE_RAW r
    JOIN NOTE_SEED s ON s.encounter_id = r.encounter_id
    WHERE s.in_discovery_sample
    GROUP BY r.encounter_id
)
SELECT encounter_id, note_text
FROM rolled
WHERE NOT (note_text ILIKE '%transport%'
        OR note_text ILIKE '%ride to%'   OR note_text ILIKE '%get a ride%'
        OR note_text ILIKE '%ride from%' OR note_text ILIKE '%no ride%'
        OR note_text ILIKE '% bus %'     OR note_text ILIKE '%bus fare%'
        OR note_text ILIKE '%taxi%'      OR note_text ILIKE '%uber%'
        OR note_text ILIKE '%lyft%'      OR note_text ILIKE '%paratransit%'
        OR note_text ILIKE '%no way to get%');


/* ============================================================================
   7. LOAD PIPELINE.GOLD_ENCOUNTER: which encounters are gold.

   Membership only: no label, no test scenario. The labels the pipeline grades
   against are produced in 02 by LABEL_GOLD_SET; the segments it scores by are
   derived in 04 from those labels and the note text.
============================================================================ */
INSERT OVERWRITE INTO PAN_DEMO_DB.PIPELINE.GOLD_ENCOUNTER (encounter_id)
SELECT encounter_id
FROM NOTE_SEED
WHERE is_gold;


/* ============================================================================
   8. TEST SCENARIOS: how the test data was made hard, and how each kind scored.

   Read by the demo app and notebook only, and always labeled as test-data
   design. They show the synthetic data is not trivially clean:

     STRAIGHTFORWARD  the base rate
     NEAR_NEIGHBOUR   the note plants a cue for a confusable subtheme
     MULTI_LABEL      seeded with two distinct concerns (more gold encounters
                      end up with two labels than this; the gold labeler
                      decides, not the seed)
     GAP              the concept was withheld from DISCOVERY_SAMPLE, so v001
                      cannot contain it
     AMBIGUOUS        written to be genuinely undecidable between two subthemes

   No seeded subtheme is exposed here, so the answer key stays out of the app.
============================================================================ */
CREATE OR REPLACE VIEW TEST_SCENARIO AS
SELECT encounter_id,
       is_gold,
       slice               AS test_scenario,
       verbosity,
       confusable_with,
       in_discovery_sample
FROM NOTE_SEED;

/* Same per-encounter rule as RUN_EVAL (gold drives the join, so a missing
   prediction counts as wrong), recomputed here so PIPELINE never has to carry
   the scenario column. Primary subtheme only, which is the gated metric. */
CREATE OR REPLACE VIEW TEST_SCENARIO_SCORECARD AS
WITH gold AS (
    SELECT er.eval_id, gl.encounter_id,
           MAX(CASE WHEN gl.label_rank = 1 THEN gl.subtheme END) AS gold_primary
    FROM PAN_DEMO_DB.PIPELINE.EVAL_RUN er
    JOIN PAN_DEMO_DB.PIPELINE.GOLD_LABEL gl
      ON gl.taxonomy_version_id = er.taxonomy_version_id
     AND (NOT er.verified_only OR gl.human_verified)
    GROUP BY er.eval_id, gl.encounter_id
),
pred AS (
    SELECT run_id, encounter_id,
           MAX(CASE WHEN label_rank = 1 THEN subtheme   END) AS pred_primary,
           MAX(CASE WHEN label_rank = 1 THEN confidence END) AS pred_confidence
    FROM PAN_DEMO_DB.PIPELINE.CLASSIFICATION
    GROUP BY run_id, encounter_id
)
SELECT er.eval_id, er.run_id, er.taxonomy_version_id, er.model, er.evaluated_at,
       ts.test_scenario,
       COUNT(*)                                                          AS n,
       AVG(IFF(EQUAL_NULL(p.pred_primary, g.gold_primary), 1, 0))::FLOAT AS subtheme_accuracy,
       AVG(IFF(p.pred_primary = 'NO_GOOD_MATCH', 1, 0))::FLOAT           AS ngm_rate,
       AVG(IFF(p.pred_confidence IN ('LOW','MEDIUM'), 1, 0))::FLOAT      AS low_conf_rate
FROM gold g
JOIN PAN_DEMO_DB.PIPELINE.EVAL_RUN er ON er.eval_id = g.eval_id
JOIN TEST_SCENARIO ts                ON ts.encounter_id = g.encounter_id
LEFT JOIN pred p                     ON p.run_id = er.run_id AND p.encounter_id = g.encounter_id
GROUP BY ALL;


SELECT (SELECT COUNT(*) FROM PAN_DEMO_DB.PIPELINE.NOTE_RAW)                      AS note_rows,
       (SELECT COUNT(DISTINCT encounter_id) FROM PAN_DEMO_DB.PIPELINE.NOTE_RAW)  AS encounters,
       (SELECT COUNT(*) FROM PAN_DEMO_DB.PIPELINE.DISCOVERY_SAMPLE)              AS discovery_notes,
       (SELECT COUNT(*) FROM PAN_DEMO_DB.PIPELINE.GOLD_ENCOUNTER)                AS gold_encounters,
       (SELECT ROUND(AVG(LENGTH(note_text))) FROM PAN_DEMO_DB.PIPELINE.NOTE_RAW) AS avg_note_chars;
