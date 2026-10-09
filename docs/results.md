# Measured results

Numbers from the verification runs on 2026-10-09, using `claude-haiku-4-5` to classify and
`openai-gpt-5.2` to create gold labels and propose the revision. Model output varies a little
between runs, so a re-run can move these by a point or so. For how the pipeline works, see
[architecture.md](architecture.md).

## Closing a taxonomy gap

v001 is the generated taxonomy; the revision is the version `PROPOSE_TAXONOMY_REVISION` drafted
from the gap review (v003 in that run).

| Metric | v001 | Revision |
|---|---|---|
| Subthemes | 78 | 79 (+Transportation Barrier To Care) |
| Primary subtheme accuracy | 0.830 | **0.885** |
| Theme accuracy | 0.870 | **0.915** |
| Label-set micro F1 | 0.778 | **0.820** |
| Gold encounters with no fitting subtheme (`NO_GOOD_MATCH`) | 9 | **0** |
| Weakest gated segment | Access Social And Financial Barriers, 0.750 | Note length SHORT, 0.809 |
| Quality gate | PASS | PASS, no segments regressed |
| Out-of-taxonomy labels | 0 | 0 |
| Low or medium confidence rate (gold run) | 0.155 | 0.100 |
| 800 backlog encounters, wall clock | 52s | |
| Credits per 1000 encounters | 5.34 | |

Per segment (subtheme accuracy). Segments with n of 20 or more are gated.

| Segment | v001 | Revision |
|---|---|---|
| CATEGORY = Access Social And Financial Barriers | 0.750 (n=24) | **0.917** (n=36) |
| CATEGORY = Clinical Symptoms And Red Flags | 0.891 (n=55) | 0.857 (n=56) |
| CATEGORY = Care Coordination And Follow Up | 0.821 (n=28) | 0.846 (n=26) |
| CATEGORY = Medication Issues | 0.926 (n=27) | 0.923 (n=26) |
| CATEGORY = Postoperative Wound And Device Concerns | 0.955 (n=22) | 1.000 (n=22) |
| LABEL_COUNT = 1 / 2 | 0.824 / 0.840 | 0.890 / 0.878 |
| NOTE_LENGTH = SHORT / MEDIUM / LONG | 0.809 / 0.844 / 0.818 | 0.809 / 0.890 / 0.955 |

By test scenario (synthetic test data only, never gated): GAP 0.200 to **1.000**, NEAR_NEIGHBOUR
0.733 to 0.800, STRAIGHTFORWARD 0.917 to 0.917, MULTI_LABEL 0.950 to 0.850, AMBIGUOUS 0.800 to
0.733. At n=15 to 20 one encounter is 5 to 7 points, so the two small declines are within noise.

**Two real-data signals pointed to the same gap.** Under v001 the gold labeler couldn't place 9
encounters, and the weakest category was Access Social And Financial Barriers at 0.750. After the
revision, those 9 have a home and Access rises to 0.917 as it takes them in (n 24 to 36). Neither
signal depends on the synthetic test tags.

**The synthetic test cases confirm it.** The 15 notes built around the left-out concept scored
**0.200 under v001 and 1.000 under the revision**, while overall accuracy moved 5.5 points. This
is why the evaluation reports per-segment scores: a targeted fix can be large even when the
overall number moves modestly.

**The gate is sensitive.** Clinical Symptoms And Red Flags moved from 0.891 to 0.857 (n=55),
inside the 0.10 margin. Tightening the margin to 0.02 makes the gate fail on that segment.

**Gap detection.** `NO_GOOD_MATCH` or `LOW` confidence flagged 5 of the 1000 encounters, all
genuinely transportation notes (100% precision). Recall was about 6%, which is enough: a revision
needs a few clean examples to name the missing concept, not every instance. Classify the full
backlog before proposing a revision, since the 200 gold encounters alone surface too few.

## Evaluating candidates before they ship

Same 200 gold encounters, compared to the champion `haiku_enum_v1` on v001 (0.830). The taxonomy
candidate is v001 edited by hand (Transportation Barrier To Care added, and a blank node that v001
had at the time removed).

| Candidate | Accuracy | Gate | Notes |
|---|---|---|---|
| `haiku_v2_tax_v001`: stricter second-label rule, same taxonomy | **0.840** | PASS | Reused v001's gold labels: one gold run, about 1.07 credits |
| `haiku_v1_tax_v002`: same prompt, edited taxonomy | **0.885** | PASS | Gold labeled for v002 first. Unplaceable gold 9 to 1, Access 0.750 to 0.889, gap scenario 0.200 to 1.000 |
| Roll back to `haiku_enum_v1` after promoting v002 | 0.830 vs 0.885 | FAIL: Access regressed | Promoted with a logged override reason |

Re-evaluating the champion at temperature 0 reproduced 0.830 exactly.

Each candidate's gold run was an EVALUATION run, so `ENCOUNTER_THEME` showed only the champion's
production labels throughout.

## Cost

200 encounters classified in 18 to 33s and 800 in 52s, at about 5.3 credits per 1000 encounters.
That's about 8.2K tokens per encounter, mostly input (about 30:1), because the ~21,600-character rubric
and the 78-value enum go with every call. Taxonomy size is the main cost lever: an earlier build
with a 55-subtheme, ~12,000-character taxonomy measured 3.67 credits per 1000 encounters. The whole
verification loop (1200 classifications, 200 gold labels, one revision proposal) used about 8
credits.

## Findings

- **The rubric matters more than the model.** On a comparable task, writing the decision rules into
  the rubric was worth 45 to 49 accuracy points; switching models with the same rubric was worth
  about 1. Effort is best spent on subtheme descriptions and routing rules, which is what the
  evaluation gate protects. It's also why a smaller model works well here.
- **A small model under a strict enum rarely picks "no match" on its own** (6 of 80 gap
  encounters). Pairing `NO_GOOD_MATCH` with low confidence catches more. Softening rubric wording
  that discouraged `NO_GOOD_MATCH` raised it from 1 to 6 with no effect on the other test
  scenarios.
- **Fixed fields work better than arrays in JSON mode** for small known counts. An array field
  failed schema validation on about 1.5% of calls; two fixed fields brought that to zero.
- **The 2 or 3 errors per run are the schema doing its job.** For example, the model once tried to
  return a `Theme > Subtheme` path instead of a subtheme name, and the response schema rejected it.
- **`RUN_COST` reads measured usage** from `CORTEX_AISQL_USAGE_HISTORY`, which includes output
  tokens. `AI_COUNT_TOKENS` returned NULL for every model tested in this account.

## Known limitations

- **No automatic retry.** Encounters whose call errored get no label. Re-running
  `CLASSIFY_BATCH('BACKLOG')` picks them up, since the backlog is every encounter without a
  production label from the champion.
- **`max_labels` is stored but not enforced.** The response schema always allows a primary and a
  secondary label.
- **Taxonomy size.** v001 has 78 subthemes; a full production taxonomy could be two to three times
  that. The design doesn't change, but the enum, the rubric and input tokens grow with it.
- **One service line seeded.** `service_line` is carried through every table for adding others.
- **Small segments are noisy.** At n=20 one encounter is 5 points, so segments under 20 are
  reported but not gated.
- **Category membership shifts across a revision.** Gold labels for a new version can move
  encounters between categories (here, 9 moved from `NO_GOOD_MATCH` into Access). Keep that in mind
  when reading a change in a category that grew or shrank.
- **Synthetic notes, no PHI.** Cortex runs in the account. `AI_REDACT` and masking policies are
  available for real note text; this build doesn't create any governance objects.
