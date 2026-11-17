# Health score (formula hs-1)

The score is published so that a patient or a pathologist can recompute it. It is non-diagnostic: it is a weighted summary of how many results are in range. It is not a diagnosis and not medical advice.

## Settings

Set in the library editor, Settings & score tab. The approving pathologist accepts or changes the defaults. All values are whole numbers; credits are in basis points (10000 = 100 %).

| Parameter | Default | Meaning |
|---|---|---|
| `score_enabled` | true | false hides the score |
| `credit_in_range_bp` | 10000 | credit for an in-range result |
| `credit_borderline_bp` | 5000 | credit for a borderline result |
| `credit_out_of_range_bp` | 0 | credit for an out-of-range result |
| `credit_critical_bp` | 0 | credit for a critical result |
| group `score_weight` | 1 | weight 0 to 10; 0 = tile shown, group not scored |
| `include_in_score` | true | per analyte; false = shown but not scored |
| `min_groups_scored` | 2 | fewer scored groups means no score |
| `band_good_min` | 80 | score at or above this is Good |
| `band_fair_min` | 60 | at or above this is Fair, otherwise needs_attention |
| `critical_forces_needs_attention` | true | any critical scored result gives needs_attention |

Credits must not increase from critical up to in range: in range is at least borderline, which is at least out of range, which is at least critical.

## Steps

1. Scored results of a group are those with `include_in_score` on, in shown groups with weight above 0. Call the count n.
2. Group sub-score = sum of credits / n, rounded half up.
3. If fewer groups than `min_groups_scored` are scored, no score is shown.
4. Score = sum of (weight x sub-score) / (100 x sum of weights), rounded half up, a whole number from 0 to 100.
5. Band: needs attention if the critical rule applies; otherwise Good from 80, Fair from 60, else needs attention.
6. The summary stores the code hs-1. A future formula gets a new code (hs-2) and old summaries keep theirs.

Rounded half up means 0.5 rounds up, never to the nearest even number.

## Worked example

Group A (weight 1): three results: in range, in range, borderline. Credits 10000 + 10000 + 5000 = 25000, divided by 3 = 8333.3, rounded to 8333.

Group B (weight 2): two results: in range, out of range. Credits 10000 + 0 = 10000, divided by 2 = 5000.

Score = (1 x 8333 + 2 x 5000) / (100 x 3) = 18333 / 300 = 61.1, rounded to 61. No critical result, and 61 is at least 60, so the band is Fair.
