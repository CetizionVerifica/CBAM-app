# M12 — Report generator
**Purpose:** Official Excel template, PDF report, importer summary. **Depends on:** M10, M11. **Screens:** Preview, download, version history.

## Outputs (spec section 8)
EU Communication Template (.xlsx), CBAM emissions report (PDF), importer summary (PDF/.xlsx), calculation workbook (.xlsx), data export (JSON/CSV).

## Requirements
- M12-R1 Writes into the official template file (version from M4) cell for cell; does not rebuild the workbook from scratch; template formulas and protection kept.
- M12-R2 A documented field map links every template cell used to a DB field; unmapped required cells are listed as gaps.
- M12-R3 Only Approved periods can generate final outputs; drafts are watermarked "DRAFT".
- M12-R4 Each file carries report version, template version, library version, and a SHA-256 hash stored in DB.
- M12-R5 Numbers in outputs equal stored M10 results after the template's rounding; no recalculation during export.
- M12-R6 Importer summary filtered to the CN codes relevant to that importer.
- M12-R7 Generation runs as a background job; failures surface to the user and are logged.
- M12-R8 Previous versions downloadable and unchanged.

## Acceptance tests
- AT1 Open exported .xlsx in Excel: no repair prompt, template formulas intact, summary sheets match app results.
- AT2 Hash of downloaded file matches stored hash.
- AT3 Draft period → "DRAFT" on every page.
