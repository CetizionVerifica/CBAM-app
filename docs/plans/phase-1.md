# Phase 1 plan — Foundation (M1, M2, M3, M4, M13)

- **Approved:** 2026-09-29
- **Gate (spec §10):** a client with two installations and one open period can be set up end to end.

## Decisions

These are recorded here because they refine the spec. Spec sections 3, 4.1 and 4.2 have been updated to match.

| # | Decision |
|---|---|
| D1 | **Exceptions to G1.** `tenant`, `app_user`, `session`, `invitation`, `mfa_recovery_code` and `auth_event` carry only `tenant_id`, because users are not scoped to one client. The reference library (M4) is platform-wide: every role can read it and only the platform admins of the operator tenant can write to it (D12). Client-specific factor overrides do carry `tenant_id` and `client_id`. |
| D2 | **Period status is stored on `period_version`, not on `reporting_period`.** A period holds the installation and dates. Each version holds its own status, pinned library version and pinned template version. Version 1 can be Issued while version 2 is Draft. |
| D3 | **Sheet A has no operator fields.** The template's `A_InstData` sheet has no operator legal name, operator contact or EORI; these are kept in the app for the PDF report and the importer summary. The installation carries the sheet A fields: local and English names, street, P.O. box, post code, city, country, UN/LOCODE, coordinates of the main emission source, and authorised representative. Verifier details (sheet A section 3) are stored in M13 `verification`. |
| D4 | **Consultants, reviewers and recipients see only the clients assigned to them.** Contributors see only assigned installations. The platform admin sees every client in the tenant. |
| D5 | **One role per user.** |
| D6 | **Partial requirements.** M3-R6 (clone) copies only the period metadata until M5 exists. M3-R7 (approval gate) is an `ApprovalGuard` extension point with no rules until M11. Both will show as partial in the M3 review. |
| D7 | **One factor table (M4).** Emission factors, NCVs, GWPs, grid factors and default SEE values share `library_factor` with a `kind` column; the natural key is kind + subject + country + region + year + component, one row per key per version. Versioning, diff, import and overrides work the same way for every kind. This replaces the separate `emission_factor`, `ncv`, `gwp`, `grid_factor` and `default_see` tables listed below. |
| D8 | **Library versions (M4).** At most one draft at a time; it starts as a copy of the current published version. Publishing freezes the version (triggers refuse any change, SQLSTATE 55000). "Current" = the most recently published version; M3 pins its id when a period opens. |
| D9 | **Seed data (M4).** Version 2026.1 is seeded only with what the official template 2026-Q2 prints: 18 goods categories with indirect-emission flags, routes, relevant precursors, qualifying parameters, 569 CN codes, the three GWPs and the natural gas EF (56.1 tCO₂/TJ). NCVs, grid factors and default values are imported (spec §11: licensing still open). Validity dates of the seeded factors are set to 2026-01-01. |
| D10 | **Imports are CSV (M4-R4).** The Commission's default-value file is not in the repo, so imports use the documented CSV layouts in `docs/mappings/library-import.md`. A factors file replaces every factor of the kinds it contains; a CN-code file replaces the whole list. An xlsx reader for the official file can map onto the same layout later. |
| D11 | **Overrides need approval (M4-R5).** Consultants and admins propose client-specific overrides; only the platform admin approves or rejects. Values never change after the proposal (withdraw and propose again). The engine (M10) will use only approved overrides and mark the value as an override in the trace. |
| D12 | **Platform operator tenant (M4, review F2).** The library is shared by every tenant, but every tenant's first user is a platform admin. Only the platform admins of the one tenant flagged `tenant.is_platform_operator` may change the library; RLS (`app.is_library_admin()`) and the API both check it. At most one operator exists (unique index). It is set by the owner only: `bootstrap:admin … --platform-operator`, or `pnpm --filter @cbam/api set:platform-operator --slug <slug>`, and the change is audited. With no operator set, nobody can change the library. Library audit entries sit in the operator tenant's trail. |
| D13 | **Cloudinary instead of S3 for files (requested 2026-09-29).** Evidence (M13) and generated reports (M12) go to Cloudinary through `FileStore` (`apps/api/src/platform/storage.ts`). Every file is a `raw` resource with delivery type `authenticated`: never public and never transformed. Downloads are signed `private_download_url` links that expire after 5 minutes (M13-R2). Credentials come from `CLOUDINARY_URL` (G10), passed per call; there is one root folder per environment (`CLOUDINARY_FOLDER`). Tests use an in-memory store. MinIO is removed from docker-compose. **Check before production:** the data-residency region of the Cloudinary account (evidence holds client data), the plan's raw-file size limit against the upload limit, and backup/retention for the audit period. |
| D14 | **Period rules (M3).** A period is exactly 12 months: it ends the day before the same date next year, and a 29 February start ends on 28 February, so the next period starts on 1 March and periods tile without gaps. Starts are limited to 2023–2100. The API takes both dates and checks the end. A period is opened only on a live installation. Dates and justification can change only while the period has just version 1, in draft; the date check and status changes lock the same rows, so they cannot interleave. Periods and versions are never deleted. **Status steps and roles:** submit (draft → in review) by admin or consultant; approve (in review → approved) by admin, consultant or reviewer; issue (approved → issued) by admin or consultant; return to draft (from in review or approved) **only by a consultant**, with a reason (M3-R3 read literally, so not the admin). An issued version never changes; version n+1 needs version n issued, starts as a draft, and keeps version n's library and template pins, which the database checks (a new period pins the current ones). Only an admin or consultant may change a draft's pins; the API has no endpoint for it yet. The status history (`period_status_change`) is written by a trigger and is append-only. Period data tables call `app.register_period_table()`, which refuses writes to approved or issued versions with SQLSTATE 55000. |
| D15 | **Evidence, verification and audit rules (M13).** **Files:** PDF, PNG, JPEG, XLSX and CSV up to 25 MB, uploaded as the raw request body. The name must end in an accepted extension, and the type is checked from the file's bytes. An XLSX must be a real workbook: its ZIP structure is read and it must contain no macros. No malware scanner is configured (M13-R3 "at least content-type verification"); **plan one (ClamAV or a Cloudinary add-on) before production.** The same file twice for one client is refused and names the existing copy. Deleting evidence is soft: the file stays in Cloudinary for the audit period. **Visibility:** recipients see no evidence (they get approved outputs from M12). Contributors see and upload only files filed under their installations, and edit or delete only their own uploads. They may link any file they can see, but remove only the links they made. **Links:** linkable tables are configuration (`app.evidence_linkable`); each later module adds its tables there. The database resolves the link target under the caller's RLS and copies its installation and period version onto the link. Evidence linked to an approved or issued version cannot be changed, deleted, linked or unlinked. Links to the period itself carry over to version n+1, except links to deleted evidence; verification does not. **Verification:** one record per period version, locked with the period. Admins, consultants and reviewers edit it. The consultant approval comes from an admin or consultant, and the client approval from a contributor or recipient (spec 4.10 does not say who "the client" is). Any change to the details withdraws both approvals. **Audit trail:** admins read the tenant; consultants and reviewers read entries of their assigned clients. Entries with no client (users, library) are admin-only, and contributors and recipients have no access. Numbers keep their exact digits. The CSV export includes every matching entry (streamed page by page) and neutralises spreadsheet formulas. |

## Stack choices
- pnpm workspaces, Node ≥ 22, TypeScript strict, Vitest.
- **API:** Express 5, Kysely + pg (types generated by `kysely-codegen`), with Zod schemas from `packages/shared`.
- **Migrations:** dbmate, plain SQL files in `db/migrations`.
- **Numbers:** Postgres `numeric` with no precision limit. The `pg` driver returns them as strings, which the app handles with decimal.js. JSON carries decimals as strings.
- **Auth:** database-backed sessions with an httpOnly cookie. Passwords hashed with argon2id. TOTP 2FA via otplib, with the secret encrypted by a key held in an environment variable. Failed logins are rate-limited and accounts lock out.
- **Files:** Cloudinary (decision D13). Uploads go through the API, which checks size and content type and computes SHA-256. Files are stored as private `raw` resources (`type: authenticated`). Downloads use signed links that expire after 5 minutes (`private_download_url`).
- **Dev services** (docker-compose): postgres:17, mailpit. Files use a Cloudinary account (a `cbam-dev` folder) in development too.
- **API tests:** Testcontainers Postgres runs the real migrations and connects as `cbam_app`, so RLS is exercised.

## Database foundations
- **Roles.** `cbam_owner` owns the schema and runs migrations. `cbam_app` is the API role: it does not own tables and has no BYPASSRLS.
- **Request context.** Each request runs in one transaction with `app.tenant_id`, `app.user_id`, `app.request_id` and `app.action` set via `set_config(..., true)`.
- **RLS.** Policies use the helper functions `app.can_access_client(uuid)` and `app.can_access_installation(uuid)`, which are SECURITY DEFINER and STABLE. A composite FK `(client_id, tenant_id) → client(id, tenant_id)` prevents rows that pair a client with the wrong tenant.
- **Audit.** One generic row trigger writes every business-table change to `audit.audit_log`. It raises an error when `app.user_id` is unset and redacts secret columns. The audit log is append-only: `cbam_app` has only INSERT and SELECT on it, and a trigger blocks UPDATE, DELETE and TRUNCATE.
- **Locking.** `app.assert_period_writable(period_version_id)` is attached to every table scoped to a period.
- **Conventions**
  - uuid primary keys.
  - `created_at/by` and `updated_at/by` on every table.
  - Soft delete where the spec asks for it, with `ON DELETE RESTRICT`.
  - Business dates are `date`, never `timestamptz`.
- **Quantity column group (G5/G7):** `<x>_value, <x>_unit, <x>_si, <x>_source, <x>_provenance, <x>_default_ref`.

## Tables
- **M1:** `tenant`, `app_user`, `user_client_assignment`, `user_installation_assignment`, `invitation`, `session`, `mfa_recovery_code`, `auth_event`.
- **M2:** `client`, `installation`, `eu_importer`.
- **M3:** `reporting_period` (an EXCLUDE constraint blocks overlaps), `period_version`, `period_status_change`.
- **M4:** `library_version`, `ref_country`, `goods_category`, `production_route`, `route_relevant_precursor`, `qualifying_parameter_def`, `cn_code`, `library_factor` (D7), `template_version`, `library_import`, `client_factor_override`.
- **M13:** `evidence_document`, `evidence_link`, `verification`, `audit.audit_log`.

## Build order
Each step is its own branch, and each is reviewed with `/cbam-module-reviewer` when it's done.

1. `scaffold`: workspaces, docker-compose, database roles, RLS helper functions, audit trigger, lock helper, tokens, app shell.
2. M1.
3. M2.
4. M4.
5. M3.
6. M13 (evidence and the audit trail screen).
