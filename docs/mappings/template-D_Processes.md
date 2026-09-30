# Field map: processes and goods (template sheets `A_InstData` (a)/(b), `D_Processes`, `Summary_Products`)

**Template:** `templates/CBAM_Communication_Template_Installations_2026-Q2.xlsx`
**Satisfies:** M5 set-up in the template's own shape (phase 2 decisions D16–D18)
**Used by:** M12 report generator (writes these cells into a copy of the template)

Labels come from the `Translations` sheet, column C. Row numbers are those of the first block; `D_Processes` repeats one block of 65 rows per process (P1 starts at row 11, P2 at row 76, …).

## `A_InstData` (a) — goods categories and routes (rows 62–71, G1–G10)

Derived, not entered: the distinct categories of all processes of the period version (main and included), each with its routes. At most 10 (enforced when a process is saved, D16).

| Column | Template label | Source |
|---|---|---|
| E | Aggregated goods category | `goods_category.template_name` of `production_process.goods_category_code` or `process_included_category.goods_category_code` |
| I–N | Route 1–6 | `production_route.name` for the main category's `process_route.route_code` rows, or the included category's `route_codes` |

## `A_InstData` (b) — production processes (rows 83–92, P1–P10)

| Column | Template label | Source |
|---|---|---|
| D | ID (P1–P10) | `production_process.position` |
| E | Aggregated goods category | the main category's G-row from (a) |
| F–K | Included goods categories listed under (a), 1–6 | the main category and each `process_included_category`, as G-row IDs |
| L | Name | `production_process.name` |

## `D_Processes` — per process

| Row | Template label | Source |
|---|---|---|
| 16–23, col L | (a) Total production levels, amounts per route | `process_route.amount_si` (t, or MWh for electricity), in route order |
| 24, col L | Total production within installation (= denominator for SEE) | Σ route amounts — the activity level (formula in the template) |
| 27, col L | (b) i. Produced for the market | Σ `process_good.produced_si` (D17: derived, not entered) |
| 32–40, col L | (c) Consumed in other production processes, per process | `process_internal_use.amount_si` for the consumer at that row |
| 41, col L | (d) Consumed for non-CBAM goods | `production_process.non_cbam_si` |
| 42, col L | (e) Control | formula in the template; the app's check M5-C05 is the same sum with the library tolerance (D19) |

## `Summary_Products` — one row per good (from row 10)

| Column | Template label | Source |
|---|---|---|
| D | Production process from which the products arise | `production_process.name` |
| F | CN codes | `process_good.cn_code` |
| H | Product name | `process_good.product_name` |
| P–AD | Qualifying parameters | `process_good_parameter` by `position`; the column is the one whose header equals `qualifying_parameter_def.name`. Numbers are written as their SI value (fraction for %, t/t for ratios) — **M12 must confirm against the cells' number format** (the example row shows `0.1395` under "% Mn"); text and choices as entered |

Quantities sold to the EU and to other markets (`process_good.sold_eu_*`, `sold_other_*`) are not in the template; they feed the importer summary (spec §8).
