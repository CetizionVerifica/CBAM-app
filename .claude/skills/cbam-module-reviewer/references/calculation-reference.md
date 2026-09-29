# Calculation reference (for M4, M6–M8, M10, M12)

## Step 1 — source-stream emissions (tCO2)
- Combustion: `Em = AD × NCV × EF × OF × (1 − BF)`  — AD in t or Nm³, NCV in TJ/t (convert from GJ/t ÷ 1000), EF tCO2/TJ, OF and BF fractions.
- Process: `Em = AD × EF × CF`
- Mass balance: `Em = 3.664 × Σ(AD_i × C_i)`, outputs with negative AD; C in tC/t. 3.664 = 44/12 (use the exact ratio or the template's constant — check which the template uses and match it).
- Non-CO2: `Em = mass of gas × GWP` (N2O, CF4, C2F6); GWPs from the versioned library.
- Measurement-based: Σ over hours of concentration × flue gas flow, converted to t; must be corroborated by a calculation.

## Step 2 — attributed direct emissions per process
`AttrEm_dir = DirEm + Em_H,imp − Em_H,exp + WG_imp − WG_exp − Em_el,exp`
Indirect: `Em_indir = electricity consumed (MWh) × EF_el (tCO2/MWh)`.

## Steps 3–4 — precursors and SEE (tCO2e/t)
`SEE_dir = (AttrEm_dir + Σ_p M_p × SEE_dir,p) / AL`
`SEE_ind = (Em_indir + Σ_p M_p × SEE_ind,p) / AL`
AL = activity level (t). Total SEE = SEE_dir + SEE_ind only for goods where indirect counts (configurable list); SEE_ind always reported.

## Engine rules to verify
1. Own precursors resolved in dependency order (topological sort); cycles rejected with a clear error.
2. Precursor consumed internally is not double counted in the producing process's goods output.
3. AL = 0 → no division; raise a blocking issue.
4. Allocation of a shared source stream across processes sums to 100 %.
5. Pure functions: same inputs + same library version → identical outputs, byte for byte.
6. Decimal library, not floats; rounding only at export.
7. Every result row stores library, template and engine version.

## Worked check (use to test any implementation)
Process: one natural gas combustion stream + 1 purchased precursor.
- AD = 1,000 t, NCV = 48 GJ/t → 0.048 TJ/t, EF = 56.1 tCO2/TJ, OF = 1, BF = 0
  → Em = 1,000 × 0.048 × 56.1 = 2,692.8 tCO2
- Heat, waste gas, electricity export: 0 → AttrEm_dir = 2,692.8
- Electricity 5,000 MWh × 0.7 tCO2/MWh → Em_indir = 3,500
- Precursor 200 t, SEE_dir,p = 1.5, SEE_ind,p = 0.4
- AL = 2,000 t
  → SEE_dir = (2,692.8 + 300) / 2,000 = **1.4964**
  → SEE_ind = (3,500 + 80) / 2,000 = **1.79**
Figures are illustrative test inputs, not real factors. The authoritative regression test is reproducing the official EU template's own examples to the last decimal.

## Float trap test
Enter AD = 0.1 and 0.2 on two streams with EF = 1, CF = 1. Total must be exactly 0.3, not 0.30000000000000004.
