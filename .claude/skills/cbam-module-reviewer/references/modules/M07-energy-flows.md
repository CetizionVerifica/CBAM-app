# M7 — Energy flows
**Purpose:** Electricity, measurable heat, waste gases. **Depends on:** M5. **Screens:** Energy balance sheet.

## Parameters (spec 4.6)
Electricity consumed per process (MWh); source (grid/PPA/own); EF (tCO2/MWh) and basis; electricity exported (MWh); measurable heat imported/exported (TJ) + heat EF; non-measurable heat (TJ); waste gases imported/exported (TJ, NCV, EF).

## Requirements
- M7-R1 Grid EF defaults from M4 by country/year; PPA or own-plant EF requires evidence (G7).
- M7-R2 Exports cannot exceed generation/imports at installation level.
- M7-R3 Heat and waste-gas flows between processes of the same installation net to zero at installation level.
- M7-R4 Units: kWh/GWh → MWh; GJ → TJ (G5).
- M7-R5 Electricity consumption present for every process where indirect emissions are reported; zero must be entered explicitly, not left blank.

## Acceptance tests
- AT1 Installation in country X gets X's grid factor for the period year.
- AT2 Heat exported 50 TJ with 30 TJ produced → issue.
- AT3 5,000 MWh × 0.7 → 3,500 tCO2 indirect.
