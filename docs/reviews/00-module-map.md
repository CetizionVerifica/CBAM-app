# Module map — M1 to M13

- **Date:** 2026-09-29 (M1 row updated on branch `m01-access`)
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
| M1 | Tenant and access | 1 Foundation | **Built** (R2 assignment API → M2); review: Ready | see below | see below | see below |
| M2 | Client and installation registry | 1 Foundation | **Built** (R3 defaults → M4/M9; R6 period check done in M3); review: Ready | see below | see below | see below |
| M3 | Reporting period manager | 1 Foundation | **Built** (R6 set-up copy → M5/M6; R7 guard → M11; D6); review: Ready (see `M03.md`) | see below | see below | see below |
| M4 | Reference library | 1 Foundation | **Built** (R3 period pinning done in M3; engine use of overrides → M10); review: see `M04.md` | see below | see below | see below |
| M5 | Process and goods set-up | 2 Calculation core | Missing | — | — | — |
| M6 | Direct emissions | 2 Calculation core | Missing | — | — | — |
| M7 | Energy flows | 2 Calculation core | Missing | — | — | — |
| M8 | Precursor chain | 2 Calculation core | Missing | — | — | — |
| M9 | Carbon price paid | 2 Calculation core | Missing | — | — | — |
| M10 | Calculation engine | 2 Calculation core | Missing | — | — | — |
| M11 | Validation and review | 3 Review and outputs | Missing | — | — | — |
| M12 | Report generator | 3 Review and outputs | Missing (template file only) | — | — | — |
| M13 | Evidence and audit | 1 Foundation | **Built** (malware scan not configured, D15); review: Ready with conditions → F1–F5, F7 fixed (see `M13.md`) | see below | see below | see below |

## M1 — as built

| Kind | Items |
|---|---|
| Files | `apps/api/src/modules/m01-access/` (`auth.router.ts`, `users.router.ts`, `passwords.ts`), `apps/api/src/platform/{auth,crypto,totp,mailer}.ts`, `apps/api/src/cli/bootstrap-admin.ts`, `packages/shared/src/access.ts`, `apps/web/src/features/access/`, `apps/web/src/features/settings/UsersPage.tsx`, `apps/web/src/app/{RequireSession,UserMenu}.tsx` |
| Routes | `POST /api/v1/auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/session`, `POST /auth/mfa/{setup,enable,verify}`, `GET /auth/invitations/:token`, `POST /auth/invitations/accept`; `GET /api/v1/users`, `GET /users/:id`, `POST /users/invitations`, `POST /users/:id/invitations`, `PATCH /users/:id`, `POST /users/:id/{deactivate,reactivate}` |
| Tables | `tenant`, `app_user`, `invitation`, `user_client_assignment`, `user_installation_assignment`; `auth.login_state`, `auth.session`, `auth.mfa_recovery_code`, `auth.auth_event` (migration `20260929000002_m01_access.sql`) |
| Screens | Sign-in, 2FA challenge, 2FA set-up, accept invitation, Users |
| Review | `docs/reviews/M01.md` |

## M2 — as built

| Kind | Items |
|---|---|
| Files | `apps/api/src/modules/m02-registry/` (`registry.router.ts`, `fields.ts`), `apps/api/src/platform/db-errors.ts`, `packages/shared/src/registry.ts`, `apps/web/src/features/registry/`, `apps/web/src/components/{RecordForm,ConfirmDialog}.tsx`, `docs/mappings/template-A_InstData.md` |
| Routes | `GET/POST /api/v1/clients`, `GET/PATCH/DELETE /clients/:id`, `POST /clients/:id/installations`, `GET/PATCH/DELETE /installations/:id`, `POST /clients/:id/importers`, `PATCH/DELETE /importers/:id`, `GET /clients/:id/team`, `PUT/DELETE /clients/:id/team/:userId`, `PUT/DELETE /installations/:id/team/:userId`, `GET /reference/countries` |
| Tables | `client`, `installation`, `eu_importer`, `ref_country` (M4 owns updates); FKs and policies on the M1 assignment tables (migration `20260929000003_m02_registry.sql`) |
| Screens | Portfolio, Add client, Client profile (importers, team), Add installation, Installation profile |
| Review | `docs/reviews/M02.md` |

## M3 — as built

| Kind | Items |
|---|---|
| Files | `apps/api/src/modules/m03-periods/` (`periods.router.ts`, `lock.ts`, `hooks.ts`), `packages/shared/src/periods.ts`, `apps/web/src/features/periods/` |
| Routes | `GET/POST /api/v1/installations/:id/periods`, `GET/PATCH /periods/:id`, `POST /periods/:id/versions`, `POST /periods/:id/clone`, `POST /period-versions/:id/transitions` |
| Tables | `reporting_period`, `period_version`, `period_status_change`; functions `app.assert_period_writable`, `app.register_period_table` (the lock every later period table attaches to) (migration `20260929000005_m03_periods.sql`) |
| Screens | Reporting periods panel on the installation profile, Period overview (status, versions, history), open/clone/edit-dates and status dialogs |
| Review | `docs/reviews/M03.md` (Ready; re-review: F1, F2, F4, F6 fixed) |

## M13 — as built

| Kind | Items |
|---|---|
| Files | `apps/api/src/modules/m13-evidence/` (`evidence.router.ts`, `filecheck.ts`, `records.ts`, `verification.router.ts`, `audit.router.ts`, `copiers.ts`), `packages/shared/src/evidence.ts`, `apps/web/src/features/evidence/`, `apps/web/src/features/audit/AuditTrailPage.tsx`, `apps/web/src/features/periods/VerificationSection.tsx` |
| Routes | `POST/GET /api/v1/clients/:id/evidence`, `GET/PATCH/DELETE /evidence/:id`, `GET /evidence/:id/download`, `POST /evidence/:id/links`, `DELETE /evidence/:id/links/:linkId`, `GET /records/:type/:id/evidence`, `GET/PUT /period-versions/:id/verification`, `POST /period-versions/:id/verification/approvals`, `GET /audit`, `GET /audit.csv` |
| Tables | `evidence_document`, `evidence_link`, `verification`, `app.evidence_linkable`; audit trail read policy widened (migration `20260929000006_m13_evidence.sql`) |
| Screens | Evidence library (filters, detail pane), evidence panel on client, installation and period pages, verification section on the period page, audit trail (filters, CSV export) |
| Review | `docs/reviews/M13.md` (independent; F1, F2 High and F3–F5, F7 Medium fixed; F6 open for the product owner) |

## M4 — as built

| Kind | Items |
|---|---|
| Files | `apps/api/src/modules/m04-reference/` (`library.router.ts`, `overrides.router.ts`, `data.ts`, `import.ts`, `csv.ts`, `diff.ts`), `packages/shared/src/library.ts`, `packages/shared/src/fields.ts`, `apps/web/src/features/library/`, `docs/mappings/library-import.md` |
| Routes | `GET/POST /api/v1/library/versions`, `GET /library/versions/current`, `DELETE /library/versions/:id`, `GET /library/versions/:id/{diff,factors,cn-codes,goods}`, `POST /library/versions/:id/{factors,imports,publish}`, `PATCH/DELETE /library/factors/:id`, `PATCH /library/goods-categories/:id`, `PUT /library/goods-categories/:id/precursors`, `POST /library/imports/:id/apply`, `GET /library/templates`; `GET/POST /clients/:id/factor-overrides`, `POST /factor-overrides/:id/{approve,reject,withdraw}` |
| Tables | `template_version`, `library_version`, `goods_category`, `production_route`, `route_relevant_precursor`, `qualifying_parameter_def`, `cn_code`, `library_factor`, `library_import`, `client_factor_override` (migration `20260929000004_m04_reference.sql`) |
| Screens | Reference library (tabs: Emission factors, NCVs, Grid factors, GWPs, Default values, CN codes, Goods and routes, Templates; draft editing, import, publish), Factor overrides panel on the client profile |
| Review | `docs/reviews/M04.md` |

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
