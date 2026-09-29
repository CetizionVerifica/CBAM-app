# M4 — Reference library
**Purpose:** Default values, NCVs, emission factors, grid factors, GWPs, CN-code list, template versions — versioned. **Depends on:** — **Screens:** Factor tables, import from EU files.

## Requirements
- M4-R1 Every factor has value, unit, source/reference, valid-from/to, and library version.
- M4-R2 Library versions are immutable once published; changes create a new version.
- M4-R3 Periods and results record which library version they used (G9); publishing a new version never silently changes an issued result.
- M4-R4 Import of official EU default-value and CN-code files with a diff preview before publish.
- M4-R5 Only platform admin can publish; consultants can propose client-specific overrides that are flagged as such.
- M4-R6 Grid factors keyed by country (and region where applicable) and year.
- M4-R7 Rules that are regulatory (which goods count indirect emissions, relevant precursors per route) live here as configuration, not in engine code.
- M4-R8 Each factor has plausible range bands used by M11.

## Acceptance tests
- AT1 Publish new EF for natural gas → existing issued report still shows old EF and old SEE.
- AT2 Import file with a malformed row → whole import rejected with row number.
- AT3 Consultant cannot publish a library version.
