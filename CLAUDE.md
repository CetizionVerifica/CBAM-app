# CBAM Reporting App — project instructions for Claude Code

Multi-client web app for CETIZION consultants to calculate specific embedded emissions (SEE) for installations outside the EU and fill the official EU CBAM Communication Template for Installations.

## Source of truth
- Functional spec: `docs/cbam-spec.md` — entities, parameters (section 4), formulas (section 5), modules M1–M13 (section 6).
- UI design system: `docs/cbam-ui-design-system.md` — follow it for every screen and component.
- Official EU template(s): `templates/` — never edit these files; write copies at export time.
- Review skill: `.claude/skills/cbam-module-reviewer/` — use it to review any module (`/cbam-module-reviewer review M6`).

If code and spec disagree, stop and ask; do not silently change the spec or the formulas.

## Stack
- Front end: React + TypeScript, Vite, Tailwind (tokens from the design system), shadcn/ui (Radix), TanStack Table/Query, React Hook Form + Zod.
- API: Node.js + Express + TypeScript, REST, one router per module.
- Database: PostgreSQL, migrations in `db/migrations/`.
- Engine: pure TypeScript package with decimal arithmetic (decimal.js or big.js) — no JS floats for quantities or emissions.
- Reports: ExcelJS writing into the official template; headless-browser PDF.

## Repository layout
```
apps/web/            React front end
apps/api/            Express API (src/modules/m01-access, m02-registry, …)
packages/engine/     Calculation engine (M10), no DB or HTTP imports
packages/shared/     Zod schemas and types shared by web and api
db/migrations/       SQL migrations
templates/           Official EU CBAM Excel template(s)
docs/                Spec, design system, reviews
```

## Non-negotiable rules (spec G1–G10)
1. Every business table has `tenant_id` and `client_id`; enforce isolation with row-level security and in the API.
2. Every route checks role and assignment server-side. UI hiding is not access control.
3. Every create/update/delete writes an audit entry with old and new values.
4. Approved and issued periods are read-only at API and DB level; changes create a new data version.
5. Every numeric input stores value, unit, normalised SI value, data source, and provenance (measured / estimated / default).
6. Decimal arithmetic only; round only at display/export, per the template.
7. Validation lives in shared Zod schemas used by both API and forms.
8. Results store factor-library version, template version and engine version.
9. Regulatory rules (which goods count indirect emissions, relevant precursors per route) live in the reference library as configuration, never hard-coded.
10. No secrets in code; config via environment variables.

## UI rules (from the design system)
- Use CSS tokens from `apps/web/src/styles/tokens.css`; never raw hex values in components.
- IBM Plex Sans, tabular numerals, sentence case, units next to every number.
- Every calculated value opens the calculation trace drawer.
- Design empty, loading, error and locked states for every screen.
- Run section 13 of the design system before finishing any UI task.

## How to work
- Build module by module in the order of spec section 10 (Foundation → Calculation core → Review and outputs → Scale-up).
- Before coding a module, read its spec file in `.claude/skills/cbam-module-reviewer/references/modules/` and list the requirement IDs you will implement.
- Write tests with the code. The engine must pass `references/calculation-reference.md` (worked check and float trap test) and the official template's examples.
- After finishing a module, run `/cbam-module-reviewer review M<n>` and save the report to `docs/reviews/M<n>.md`. Fix Critical and High findings before moving on.
- Small commits, one module or feature per branch.

## Definition of done (per module)
- All requirement IDs for the module pass the review skill, with no Critical or High findings open.
- Unit tests for services and engine; API tests for access control and locked-period behaviour.
- Screens follow the design system checklist.
- Spec and review report updated in `docs/`.

## Commands
- Install: `pnpm install` (Node ≥ 22, pnpm 11)
- Local services (Postgres 17, MinIO, Mailpit): `cp .env.example .env`, fill it in, then `pnpm services:up`
- Migrate DB: `pnpm db:migrate` (runs as `cbam_owner`; new migration: `pnpm db:new <name>`)
- Dev (web + api): `pnpm dev` (web on :5173, proxies `/api` to the API on :4000)
- Test: `pnpm test` (API tests start their own Postgres via Testcontainers; Docker must be running)
- Typecheck: `pnpm typecheck`

## Database conventions
- Every business table: `id uuid`, `created_at/by`, `updated_at/by`, then `select app.register_business_table('<table>', '{<secret cols>}')` in the same migration (audit trigger, row metadata, forced RLS), plus its own RLS policies and grants to `cbam_app`.
- The API reads and writes only inside `withContext(db, ctx, fn)` (`apps/api/src/platform/db.ts`); writes without a context fail in the database.
