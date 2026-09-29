# Module map — M1 to M13

- **Date:** 2026-09-29
- **Commit:** `c3d703c` (main) plus the untracked file `templates/CBAM_Communication_Template_Installations_2026-Q2.xlsx`
- **Scope:** Maps the code to modules only. This is not a review, so there are no findings or severities.

## Summary

**No application code exists yet.** The repository contains only the starter kit:

| Path | What it is |
|---|---|
| `CLAUDE.md`, `README.md` | Project instructions and starter-kit setup notes |
| `docs/cbam-spec.md` | Functional spec (entities, parameters, formulas, modules, phases) |
| `docs/cbam-ui-design-system.md` | UI design system |
| `docs/reviews/README.md` | Where review reports go |
| `.claude/skills/cbam-module-reviewer/` | Review skill: module requirement files M01–M13, calculation reference, report template |
| `templates/README.md` | Instructions for the official template |
| `templates/CBAM_Communication_Template_Installations_2026-Q2.xlsx` | Official EU template (**untracked**; not committed yet) |

None of these exist yet: `apps/web`, `apps/api`, `packages/engine`, `packages/shared`, `db/migrations`, `package.json`, and any tests. The Commands section of `CLAUDE.md` is also still placeholders.

So all 13 modules are **Missing**: no files, no routes, no tables. Nothing is partly built.

## Status by module

| # | Module | Phase (spec §10) | Status | Files | Routes | Tables |
|---|---|---|---|---|---|---|
| M1 | Tenant and access | 1 Foundation | Missing | — | — | — |
| M2 | Client and installation registry | 1 Foundation | Missing | — | — | — |
| M3 | Reporting period manager | 1 Foundation | Missing | — | — | — |
| M4 | Reference library | 1 Foundation | Missing (template file only) | — | — | — |
| M5 | Process and goods set-up | 2 Calculation core | Missing | — | — | — |
| M6 | Direct emissions | 2 Calculation core | Missing | — | — | — |
| M7 | Energy flows | 2 Calculation core | Missing | — | — | — |
| M8 | Precursor chain | 2 Calculation core | Missing | — | — | — |
| M9 | Carbon price paid | 2 Calculation core | Missing | — | — | — |
| M10 | Calculation engine | 2 Calculation core | Missing | — | — | — |
| M11 | Validation and review | 3 Review and outputs | Missing | — | — | — |
| M12 | Report generator | 3 Review and outputs | Missing (template file only) | — | — | — |
| M13 | Evidence and audit | 1 Foundation | Missing | — | — | — |

## Expected locations (planned, not found)

This table is a checklist for building the modules. It follows the layout in `CLAUDE.md` and the entities in spec §3. The names are suggestions. Update this table with the real paths once code exists.

| # | API module | Likely tables (from spec §3 entities) | Web screens (from module files) |
|---|---|---|---|
| M1 | `apps/api/src/modules/m01-access` | tenant, user, user_client_assignment, user_installation_assignment, invitation, session | Users, roles, invitations |
| M2 | `…/m02-registry` | client, installation, eu_importer, client_importer | Client list, installation profile |
| M3 | `…/m03-periods` | reporting_period (status, data_version, lock) | Period dashboard, status bar |
| M4 | `…/m04-reference` | library_version, emission_factor, grid_factor, gwp, cn_code, goods_category, production_route, template_version, regulatory rule config | Factor tables, EU file import |
| M5 | `…/m05-process` | production_process, good (CN code, qualifying parameters) | Process builder |
| M6 | `…/m06-direct` | source_stream, stream_allocation, emission_source (CEMS), pfc_data, n2o_data | Source-stream grid, method forms |
| M7 | `…/m07-energy` | energy_flow | Energy balance sheet |
| M8 | `…/m08-precursors` | precursor_link, supplier_installation | Precursor map |
| M9 | `…/m09-carbon-price` | carbon_price_paid, fx_rate | Carbon price form |
| M10 | `packages/engine` (pure) + `…/m10-calculation` | calculation_result (per process and per CN code, with library, template and engine versions) | Results per process and per good, trace drawer |
| M11 | `…/m11-validation` | validation_rule, validation_issue, review_finding, finding_reply, sign_off | Issues list, review queue |
| M12 | `…/m12-reports` | report_version (file, hash, versions), report_job, template field map | Preview, download, version history |
| M13 | `…/m13-evidence` | evidence_document, evidence_link, audit_log (append-only), verification | Document library, audit trail |

Every module also needs the shared Zod schemas in `packages/shared`, migrations with `tenant_id`/`client_id` and RLS in `db/migrations/`, and tests (G1–G10).

## Notes before building

1. **Commit the template.** `templates/CBAM_Communication_Template_Installations_2026-Q2.xlsx` is untracked. M4 and M12 depend on it.
2. **Start with Phase 1.** Per spec §10 and `CLAUDE.md`, build M1, M2, M3, M4 and M13 first (this includes the audit log), and scaffold the repo before that.
3. **Fill in the Commands in `CLAUDE.md`** once the repo is scaffolded.
4. **Re-run this map** after each module lands, so the reviews have correct file, route and table lists.
