# Library import files (M4-R4)

**Satisfies:** M4-R4 ("import of official EU default-value and CN-code files with a diff preview before publish")
**Decision:** D10 in `docs/plans/phase-1.md`: CSV files with the layouts below.
**Schemas:** `packages/shared/src/library.ts` (`IMPORT_COLUMNS`, `FactorInput`, `CnCodeRow`). The API and the form use the same rules.

## How an import works
1. The platform admin opens a **draft** library version and chooses **Import file**.
2. The API reads the whole file. **If any row is invalid, nothing is stored.** The answer lists every problem with its file line (the header is line 1), up to 200 of them (AT2).
3. When every row is valid, the API compares the file with the draft and shows the rows that would be added, changed and removed. Nothing changes yet.
4. **Apply to draft** replaces the rows. If the draft changed after the check, applying is refused, and the file must be checked again.
5. **Publish version** shows the full diff against the version the draft was based on.

What a file replaces:
- **Factors file:** every factor of the **kinds that appear in the file**. A file that holds only `grid_factor` rows replaces the grid factors and leaves the emission factors, NCVs, GWPs and default values alone.
- **CN-code file:** the whole CN-code list of the draft.

## Format
- UTF-8 (a BOM is fine), comma separator, RFC 4180 quoting (`"Flat-rolled, hot-rolled"`, `""` for a quote inside quotes).
- The first line is the header. Header names ignore case, and columns can be in any order. **Unknown columns are an error**, so a wrong file is not half-read.
- Decimals use a dot and no thousands separator (`0.716`, not `0,716`).
- Dates are `YYYY-MM-DD`.
- At most 20,000 rows and 8 MB per file.
- A factor key (`kind`, `subject`, `country_code`, `region`, `year`, `component`) or CN code can appear only once in a file.

## Factors file
| Column | Required | Values | Rule |
|---|---|---|---|
| `kind` | Yes | `emission_factor`, `ncv`, `gwp`, `grid_factor`, `default_see` | |
| `subject` | Yes | Fuel or material (`Natural gas`), gas (`N2O`), `electricity`, or CN code for `default_see` | `default_see`: 8-digit CN code |
| `country_code` | Grid: yes | ISO code from the template country list | Required for `grid_factor`. Optional for the others (for example, country-specific default values) |
| `region` | No | Free text | Only for `grid_factor` |
| `year` | Grid: yes | 1990–2100 | Required for `grid_factor` |
| `component` | Default: yes | `direct`, `indirect` | Only for `default_see`, and required there |
| `value` | Yes | ≥ 0 | Stored as given and converted to SI |
| `unit` | Yes | See below | Must match the kind |
| `valid_from` | Yes | Date | |
| `valid_to` | No | Date | On or after `valid_from` |
| `plausible_min`, `plausible_max` | No | ≥ 0, same unit as `value` | min ≤ max. Used by M11 plausibility checks (M4-R8) |
| `source` | Yes | Publication, table or legal act | |
| `notes` | No | Free text | |

Units per kind (unit ids from `packages/shared/src/units.ts`):
| Kind | Units | SI unit stored |
|---|---|---|
| `emission_factor` | `tCO2/TJ`, `kgCO2/GJ`, `tCO2/t`, `kgCO2/t`, `tCO2/Nm3`, `tCO2/kNm3` | `tCO2/TJ`, `tCO2/t` or `tCO2/Nm3` |
| `ncv` | `GJ/t`, `MJ/kg`, `TJ/t`, `GJ/Nm3`, `GJ/kNm3`, `TJ/Nm3` | `TJ/t` or `TJ/Nm3` |
| `gwp` | `tCO2e/tGHG` | `tCO2e/tGHG` |
| `grid_factor` | `tCO2/MWh`, `kgCO2/kWh`, `gCO2/kWh` | `tCO2/MWh` |
| `default_see` | `tCO2e/t`, `kgCO2e/t` | `tCO2e/t` |

Example:
```csv
kind,subject,country_code,region,year,component,value,unit,valid_from,valid_to,plausible_min,plausible_max,source,notes
ncv,Natural gas,,,,,48,GJ/t,2026-01-01,,44,50,"IPCC 2006 Guidelines, Vol. 2, Table 1.2",
grid_factor,electricity,IN,,2026,,0.716,tCO2/MWh,2026-01-01,2026-12-31,0.5,0.9,CEA CO2 Baseline Database v20,
default_see,72081000,CN,,,direct,2.1,tCO2e/t,2026-01-01,,,,Commission default values,
```

## CN-code file
| Column | Required | Rule |
|---|---|---|
| `cn_code` | Yes | 8 digits. Spaces are removed, so the template's `7208 10 00` is accepted |
| `description` | Yes | |
| `goods_category` | Yes | A goods-category code of the draft, like `crude_steel` (see the *Goods and routes* tab) |

## Not covered yet
- Reading the Commission's default-value workbook (.xlsx) directly. Save it as CSV in the layout above, or add an xlsx reader that maps onto this layout.
- Importing goods categories, routes, relevant precursors or qualifying parameters. These change rarely. They are edited in the draft (indirect-emission flags, relevant precursors) or come with a new template version.
