# Field map: template sheet `A_InstData`

**Template:** `templates/CBAM_Communication_Template_Installations_2026-Q2.xlsx`
**Satisfies:** M2-R2 ("mapped one-to-one to template sheet A fields; document the mapping")
**Used by:** M12 report generator (writes these cells into a copy of the template)

## How the cells work
- Each input is a merged range `I<row>:N<row>`. The value goes in the top-left cell `I<row>`; the other cells in the range stay empty.
- Labels are formulas pointing to the `Translations` sheet. The English text in the table below comes from `Translations` column C.
- **Country (I26)** has a list validation (`CNTR_ListCountriesName` = `c_CodeLists!G11:G277`). The cell takes the **country name**, not the ISO code. We store the code (`installation.country_code`) and write `ref_country.name`, which was seeded from that same list.

## Section 2 — About the installation (M2)
| Cell | Template label | API field | DB column | Required in app | Notes |
|---|---|---|---|---|---|
| I19 | Name of the installation (optional) | `nameLocal` | `installation.name_local` | No | Local-language name |
| I20 | Name of the installation (English name) | `nameEn` | `installation.name_en` | Yes | Unique within a client (M2-R5) |
| I21 | Street, Number | `street` | `installation.street` | Yes | |
| I22 | Economic activity | `economicActivity` | `installation.economic_activity` | No | Free text |
| I23 | Post code | `postcode` | `installation.postcode` | No | |
| I24 | P.O. Box | `poBox` | `installation.po_box` | No | |
| I25 | City | `city` | `installation.city` | Yes | |
| I26 | Country | `countryCode` | `installation.country_code` → `ref_country.name` | Yes | Written as the template's country name |
| I27 | UNLOCODE | `unLocode` | `installation.un_locode` | No | 5 characters, must start with the country code |
| I28 | Coordinates of the main emission source (latitude) | `latitude` | `installation.latitude` | No, but required together with longitude | −90 to 90, at most 6 decimals |
| I29 | Coordinates of the main emission source (longitude) | `longitude` | `installation.longitude` | No, but required together with latitude | −180 to 180, at most 6 decimals |
| I30 | Name of authorized representative | `authRepName` | `installation.auth_rep_name` | No | |
| I31 | Email | `authRepEmail` | `installation.auth_rep_email` | No | |
| I32 | Telephone | `authRepPhone` | `installation.auth_rep_phone` | No | |

## Other sections of sheet A (owned by later modules)
| Cells | Content | Module |
|---|---|---|
| I9, L9 | Reporting period start and end (date validation ≥ 2000-01-01) | M3 |
| I37–I41 | Verifier: company name, street, city, postcode, country | M13 (`verification`) |
| I45–I48 | Verifier's authorised representative: name, email, telephone, fax | M13 |
| I51–I53 | Accreditation: member state, accreditation body, registration number | M13 |
| E62:N71 | Aggregated goods categories and routes (G1–G10) | M5 |
| D83:N92 | Relevant production processes (P1–P10) | M5 |
| D102:N121 | Purchased precursors (PP1–PP20), with country codes | M8 |

## Stored but not in the template
| Field | Why it is kept |
|---|---|
| `installation.permit_no` | Spec 4.1, "Installation ID / permit number"; used in the PDF report |
| Every `client.*` field (operator) | Decision D3: the template has no operator block; used in the PDF report and importer summary |
| Every `eu_importer.*` field | Used in the importer summary (M12) |

## Retest
M2 AT4 ("exported sheet A matches entered values exactly") runs in M12: generate the template for an installation that has every field above filled in, then read back I19–I32 and compare.
