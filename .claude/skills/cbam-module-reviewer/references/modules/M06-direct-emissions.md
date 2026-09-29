# M6 — Direct emissions
**Purpose:** Source streams, CEMS sources, PFC and N2O. **Depends on:** M5. **Screens:** Source-stream grid, per-method forms.

## Parameters (spec 4.4, 4.5)
Calculation: stream name/type (combustion/process/mass balance), activity data (t, Nm³, TJ), NCV, EF, oxidation factor, conversion factor, carbon content, biomass fraction, tier/data source, allocation % per process.
Measurement/non-CO2: GHG concentration, flue gas flow, operating hours, corroborating calculation, N2O mass, PFC data (anode effect minutes per cell-day, slope coefficient or overvoltage), GWPs.

## Requirements
- M6-R1 Required fields depend on method: combustion {AD, NCV, EF, OF}; process {AD, EF, CF}; mass balance {AD, C}. Irrelevant fields hidden and ignored by the engine.
- M6-R2 Fractions (OF, CF, BF, allocation) in [0, 1]; AD ≥ 0 except mass-balance outputs, which are negative or flagged as output.
- M6-R3 Defaults pre-filled from M4 with provenance "default" (G7); overriding requires source and evidence.
- M6-R4 Shared stream allocation across processes sums to 100 %.
- M6-R5 Measurement-based sources require a corroborating calculation; deviation beyond threshold raises an issue.
- M6-R6 PFC inputs only for primary aluminium routes; N2O only for relevant fertiliser routes.
- M6-R7 Units captured and normalised (G5), e.g. GJ/t → TJ/t.
- M6-R8 Bulk grid entry and Excel import validate row by row with row-level errors.

## Acceptance tests
- AT1 Combustion stream without NCV → cannot save as complete.
- AT2 OF = 1.2 → rejected by API.
- AT3 Allocation 60 % + 30 % → issue.
- AT4 Worked check in calculation-reference.md reproduces 2,692.8 tCO2.
