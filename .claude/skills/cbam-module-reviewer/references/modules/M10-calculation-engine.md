# M10 — Calculation engine
**Purpose:** Steps 1–4 (see calculation-reference.md), dependency resolution. **Depends on:** M4–M9. **Screens:** Results per process and per good.

## Requirements
- M10-R1 Implements all formulas in calculation-reference.md exactly, including GWP conversion.
- M10-R2 Decimal arithmetic throughout (G6); float trap test passes.
- M10-R3 Pure and deterministic: no DB or clock access inside formulas; inputs in, results out.
- M10-R4 Topological resolution of own precursors; cycles raise an error.
- M10-R5 AL = 0 or missing → no result, blocking issue.
- M10-R6 Indirect-in-SEE rule read from M4 config per goods category.
- M10-R7 Results stored per process and per CN code with library, template and engine version (G9).
- M10-R8 Recalculates on save; results marked stale while inputs change; issued results never recomputed in place.
- M10-R9 Every result is explainable: UI/export shows the inputs and intermediate values behind it.
- M10-R10 Unit tests cover each method, each sector route, and the official EU template examples to the last decimal.

## Acceptance tests
- AT1 Worked check → SEE_dir 1.4964, SEE_ind 1.79.
- AT2 Official template example reproduced exactly.
- AT3 Same inputs twice → identical output.
- AT4 Changing a factor-library version on an issued period → no change to its stored results.
