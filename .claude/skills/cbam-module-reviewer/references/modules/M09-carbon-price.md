# M9 — Carbon price paid
**Purpose:** Instruments, prices, rebates, FX. **Depends on:** M3. **Screens:** Carbon price form.

## Parameters (spec 4.8)
Country and instrument (tax/ETS); price effectively paid (local currency per tCO2e); rebates/free allocation/compensation; emissions covered (tCO2e) and goods; exchange rate and date; legal act reference and evidence.

## Requirements
- M9-R1 Effective price = paid − rebates/compensation, never negative.
- M9-R2 Covered emissions linked to goods; cannot exceed the goods' embedded emissions.
- M9-R3 FX rate stored with date and source; EUR value computed, not typed.
- M9-R4 Legal reference and evidence required before approval.
- M9-R5 "No carbon price paid" is an explicit choice, not an empty form.

## Acceptance tests
- AT1 Rebate larger than paid → rejected or floored at 0 with issue.
- AT2 Covered 5,000 t on goods with 3,000 t embedded → issue.
