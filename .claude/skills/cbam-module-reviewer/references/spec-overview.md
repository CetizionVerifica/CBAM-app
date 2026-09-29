# Spec overview — CBAM Reporting Web Application

Source: "CBAM Reporting Web Application — Modular Build Plan" (living doc). Bundled copy; the living doc wins where they differ.

## Purpose
A consultant (CETIZION) onboards many clients — operators of installations outside the EU — captures their production and emissions data, calculates specific embedded emissions (SEE) per good, and exports the EU CBAM Communication Template for Installations plus a verification-ready report.

Stack: React front end, Node.js/Express REST API, PostgreSQL, calculation engine as an isolated TypeScript package with decimal arithmetic.

## Roles
| Role | Can do |
|---|---|
| Platform admin | Tenants, users, emission factor library, template versions |
| Consultant (lead) | Create clients/installations, configure processes, review, calculate, issue reports |
| Data contributor | Enter data, upload evidence, answer queries — assigned installations only |
| Reviewer / verifier | Read everything, raise findings, sign off a period |
| Report recipient | View and download approved outputs |

## Entity chain
Tenant → Client → Installation → Reporting period → Production process → {Source streams, Emission sources, Energy flows, Precursor links, Goods (CN codes)}. Supporting: EU importer, Supplier installation, Emission factor library (versioned), Carbon price paid, Evidence document, Review finding, Report version, Audit log, User.

The production process in one reporting period is the calculation unit.

## Modules
| # | Module | Depends on |
|---|---|---|
| M1 | Tenant and access | — |
| M2 | Client and installation registry | M1 |
| M3 | Reporting period manager | M2 |
| M4 | Reference library | — |
| M5 | Process and goods set-up | M3, M4 |
| M6 | Direct emissions | M5 |
| M7 | Energy flows | M5 |
| M8 | Precursor chain | M5 |
| M9 | Carbon price paid | M3 |
| M10 | Calculation engine | M4–M9 |
| M11 | Validation and review | M10 |
| M12 | Report generator | M10, M11 |
| M13 | Evidence and audit | All |

## Workflow
1 Onboard (M2) → 2 Open period (M3) → 3 Configure (M5) → 4 Collect data (M6–M9, M13) → 5 Calculate (M10) → 6 Validate (M11) → 7 Review and sign off (M11) → 8 Generate (M12) → 9 Issue and lock (M3/M12). Steps 4–7 loop until no open findings.

## Global rules (apply to every module)
- **G1 Tenant and client isolation** — every business row carries tenant_id and client_id; PostgreSQL row-level security or equivalent enforced in the API; no query can return another client's data, including via IDs guessed in URLs.
- **G2 Role-based access** — every route checks role and assignment server-side; UI hiding is not access control. Contributors see only assigned installations.
- **G3 Audit log** — every create, update, delete writes who, when, record, old value, new value. No code path writes business data without it.
- **G4 Locking and versioning** — approved/issued periods are read-only at the API and DB level; a change after issue creates a new data version.
- **G5 Units** — every numeric input stores value, unit and the normalised SI value; conversions are centralised and tested.
- **G6 Precision** — decimal arithmetic for all emissions and quantities (no JS float); rounding only at display/export, per the template's rules.
- **G7 Data provenance** — every numeric parameter stores data source and a flag: measured / estimated / default.
- **G8 Validation in the API** — request schemas validate type, range and required fields; UI validation is additive only.
- **G9 Traceability of outputs** — results store factor-library version, template version and engine version used.
- **G10 Security basics** — encryption in transit and at rest, no secrets in code, 2FA for consultants/admins, errors do not leak other records.

## Regulatory caveat
Regulatory points (definitive period from 1 Jan 2026, sectors cement, iron and steel, aluminium, fertilisers, hydrogen, electricity; indirect emissions counted in SEE only for some goods) are from general knowledge. Code must keep such rules in configuration, not hard-coded.
