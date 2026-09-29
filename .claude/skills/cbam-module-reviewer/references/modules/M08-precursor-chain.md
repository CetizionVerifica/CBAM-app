# M8 — Precursor chain
**Purpose:** Own and purchased precursors, supplier SEE. **Depends on:** M5. **Screens:** Precursor map.

## Parameters (spec 4.7)
Precursor good + CN code; origin (own/purchased); quantity consumed per process (t); supplier installation and country; precursor SEE direct and indirect (tCO2e/t); default-value flag.

## Requirements
- M8-R1 Only precursors relevant to the consuming route (per M4 config) can be linked.
- M8-R2 Own precursor links to a producing process in the same installation and period; its SEE is taken from M10, never typed.
- M8-R3 Purchased precursor requires supplier record and SEE with source (supplier communication file or default).
- M8-R4 Circular own-precursor links are rejected at save time.
- M8-R5 Precursor map visualises the chain and shows unresolved links.
- M8-R6 Supplier communication (EU template from supplier) can be imported to fill SEE values.

## Acceptance tests
- AT1 Process A consumes B, B consumes A → rejected.
- AT2 Own precursor SEE updates when producing process data changes.
- AT3 Purchased precursor without source → incomplete.
