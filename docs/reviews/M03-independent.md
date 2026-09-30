# Review — M3 Reporting period manager (independent)

**Date:** 2026-09-30 · **Reviewer:** independent agent · **Artifact reviewed:** branch `m03-periods` @ `9a2a128` (M3 changes since `ce53b10`: `db/migrations/20260929000005_m03_periods.sql`, `apps/api/src/modules/m03-periods/*`, installation delete in `apps/api/src/modules/m02-registry/registry.router.ts`, `packages/shared/src/periods.ts`, `apps/web/src/features/periods/*`, `apps/web/src/lib/format.ts`, and tests)
**Verdict:** Ready. There are no Critical or High findings. Fix the two Medium findings (F1, F2) before M5 adds period data.
**Counts:** Critical 0 · High 0 · Medium 2 · Low 6 · Info 4

## Scope
- **Read:**
  - The skill's spec overview, and the M2, M3 and M4 module files.
  - Design system §4, §5.7, §6.3, §7 and §13.
  - `CLAUDE.md`, `docs/cbam-spec.md` §2, §3, §4.2, §7 and §9.
  - `docs/plans/phase-1.md`, decisions D1–D14.
  - The M3 migration, the M3 router, hooks and lock, and the shared period schema.
  - The web period screens.
  - The platform code M3 uses: `db.ts`, `errors.ts`, the foundation and M2 RLS helpers, the audit trigger and `db/init/01-roles.sh`.
- **Executed:**
  - `pnpm --filter @cbam/api test`: 9 files, **184 passed**.
  - `pnpm --filter @cbam/web test`: 6 files, **39 passed**.
  - `pnpm --filter @cbam/shared test`: 3 files, **24 passed**.
  - `pnpm typecheck`: clean.
  - `pnpm db:check`: migrations apply, roll back and re-apply cleanly.
  - Ten throwaway API probes (P1–P10) against the Testcontainers database, through the real app and as `cbam_app` under `withContext`.
  - One web probe that checks the AT4 time-zone test really changes the zone.
  - All probe files are deleted.
- **Not verified:**
  - Nothing was rendered in a browser, so contrast, keyboard path, the 1024 px layout and dark mode are unchecked.
  - Set-up copying (M5/M6) and M11 approval blocking do not exist yet (D6).
  - The Portfolio page (design system 6.1) was not examined.
  - The down migration was run only on an empty database, as `db:check` does.

## Requirement coverage
| ID | Requirement (short) | Verdict | Evidence |
|---|---|---|---|
| M3-R1 | One installation; no overlaps | Pass | EXCLUDE `reporting_period_no_overlap` (`migration:42-43`); composite FK to `installation` (`:29`); `guard_reporting_period` blocks moves (`:263`). The existing tests pass for AT1, the 3-way concurrent open and the move attempt. |
| M3-R2 | Calendar year default; other 12-month periods with a justification | Pass (see F4) | Shared `PeriodInput` (`periods.ts:88-106`) and DB checks `reporting_period_twelve_months`, `_range`, `_justified` (`migration:32-40`). P5: an array or a number in date or justification fields → 400. A 29 Feb start is accepted with a 27 Feb end (F4). |
| M3-R3 | Draft → In review → Approved → Issued; back to Draft only, by a consultant, with a reason | Pass (see F3) | `guard_period_version` (`migration:176-207`) and `PERIOD_TRANSITIONS` (`periods.ts:61-70`). P7: a reviewer's SQL reopen → 42501, a consultant's SQL in_review→issued → 55000, an admin's API reopen → 403, a recipient's SQL approve → 0 rows. P9: three parallel submits → 200, 409, 409. The history can be misordered under concurrency (F3). |
| M3-R4 | Approved and Issued read-only at API and DB | Pass | `assert_period_writable` / `guard_period_scoped` / `register_period_table` (`migration:302-347`), and `assertPeriodWritable` (`lock.ts`). The existing AT2 stand-in test passes for insert, update and delete, and for contributors. There is no safety net for future tables (F9). |
| M3-R5 | Change after issue → version n+1; version n retrievable | Pass (see F2) | `POST /periods/:id/versions` (`periods.router.ts:275-311`) and the DB insert guard (`migration:133-149`). Versions are listed and selectable with `?version=`. `versionCopiers` is empty, so version n+1 starts empty; nothing exists to copy yet. The DB does not enforce that n+1 keeps version n's pins (P3b, F2). |
| M3-R6 | Clone copies set-up, not activity data | Partial (planned, D6) | `POST /periods/:id/clone` runs `hooks.setupCopiers`, which is empty. The UI copy already promises copied set-up (F8). |
| M3-R7 | Approval blocked while M11 has open critical issues | Partial (planned, D6) | `hooks.approvalGuards` runs in the transition route (`periods.router.ts:357-362`), in the API only. Tested with a stand-in guard. |
| M3-R8 | Dates as dates | Pass | `date` columns; identity DATE parser (`platform/db.ts:7`). `formatDate` and `periodLabel` format in UTC. The web probe showed `vi.stubEnv('TZ')` really moves the offset (−330 → +300 → −840 min), so the AT4 test is meaningful: a naive `getDate()` of 2026-01-01 gives 31 in New York. |

## Global rules
| Rule | Verdict | Evidence |
|---|---|---|
| G1 Tenant isolation | Pass | P1: a consultant and an admin of another tenant get 404 on GET period, GET installation periods, submit, clone, new version and PATCH. P2: a direct `select` of another tenant's version → 0 rows. The status oracle is F6. |
| G2 Role-based access | Partial | The API role checks hold (P6, P7). At DB level a reviewer can re-pin a draft version (P3, F2). Recipients see drafts (F5). The DB trusts the `app.user_role` GUC rather than `app_user.role` (F10, cross-cutting). |
| G3 Audit log | Pass (see F3) | P8: every version insert, status change and history row is audited with the business verb, and the reopen carries its reason. History order can be wrong under concurrency (F3); `audit_log.id` order is right. |
| G4 Locking and versioning | Pass (see F1) | See R4 and R5. D14's date lock can be raced (F1). |
| G5 Units / G6 Precision / G7 Provenance | N/A | M3 has no numeric inputs. |
| G8 Validation in the API | Pass | Shared Zod in the API and the forms. P5: 14 odd inputs give 400 or 404, never 500. |
| G9 Traceability | Partial | Every version stores published library and template pins. The DB lets pins drift in a draft and in version n+1 (F2). The template "current" rule is unclear (F11). |
| G10 Security basics | Pass (see F6) | No secrets; errors are generic. A cross-tenant status oracle exists (F6). |

## Acceptance tests
| ID | Result | Executed or traced | Notes |
|---|---|---|---|
| AT1 Overlapping period → rejected | Pass | Executed (existing suite) | 409 `overlap`. Holds under 3 concurrent opens. |
| AT2 PATCH to a source stream in an Issued period → rejected | Pass (stand-in) | Executed (existing suite) | A stand-in table registered with `register_period_table` gets 55000 for insert, update and delete after approve and after issue. Re-run against `source_stream` when M6 exists. |
| AT3 Clone 2026 → 2027 copies set-up, zero activity data | Partial | Executed (existing suite) | The period and version 1 are correct. There is no set-up to copy (D6). |
| AT4 Same display in UTC+5:30 and UTC−5 | Pass | Executed (existing suite + web probe) | The probe confirmed the TZ stub is effective, so the test would catch a regression. |
| M2 AT3 Delete installation with a period → blocked | Pass | Executed (existing suite) | API 409 `has_periods`; DB 23001. |

## Findings

### F1 — Editing dates races with "Submit for review": dates change after the version has left draft (Medium)
- **Ref:** D14 ("dates change only while the period has just version 1, in draft"), M3-R4/G4 intent, Beyond spec (concurrency)
- **Evidence:**
  - PATCH `/periods/:id` (`periods.router.ts:253-271`) locks the `reporting_period` row and reads the version statuses without a lock. `guard_reporting_period` (`migration:266-270`) also reads `period_version` without a lock.
  - The transition route (`:350`) locks only the `period_version` row. The two paths never contend for the same lock.
  - Probe P4: T1 locked the period, saw `draft` and updated the dates to 2027. T2 submitted through the API → **200** while T1 was still open. T1 then committed.
  - Final state: start `2027-01-01` and status `in_review`. The history shows the submit, but the dates were changed after it.
- **Expected:** once a version is in review, its dates cannot change.
- **Actual:** dates can change after submission, with nothing in the status history showing it. The audit log does show it.
- **Fix:** serialise both paths on one lock. Either:
  - have the transition route (and `guard_period_version` on a status change) take `select … from reporting_period where id = v.period_id for update` first; or
  - have `guard_reporting_period` and the PATCH route read the versions `for share` / `for update`.
- **Retest:** repeat P4. T2's submit blocks until T1 commits and then succeeds, or T1's update fails with 55000. Add a two-connection test.

### F2 — Pins are not protected in the DB: a reviewer can re-pin a draft, and version n+1 can pin other versions than n (Medium)
- **Ref:** D14 ("version n+1 … keeps version n's library and template pins"), G2, G9, M4-R3
- **Evidence:**
  - `period_version_update` lets reviewers update (`migration:372-376`).
  - `guard_period_version` checks only that a pin changes while in draft and that the library is published (`:168-174`). It checks no role, and it does not check the pins on INSERT against version n−1 (`:133-151`).
  - Probe P3: as `reviewer`, `update period_version set template_version_id = <other>` on a draft → **1 row updated**.
  - Probe P3b: as `consultant`, inserting version 2 with a different `template_version_id` than issued version 1 → **inserted**.
  - The API never does either, so this is a gap in the database's second line of defence. The migration header says "everything below is enforced here as well as in the API".
- **Expected:**
  - Only admin or consultant may change pins, if anyone may (the spec is silent; see the earlier F12).
  - Version n+1's pins equal version n's.
- **Fix:** in `guard_period_version`:
  - On UPDATE, require `v_role in ('platform_admin','consultant')` for a pin change (or forbid pin changes until the spec allows them).
  - On INSERT with `version_no > 1`, require `(library_version_id, template_version_id)` to equal version n−1's.
- **Retest:** the P3 and P3b probes → 42501 and 23514.

### F3 — Status history can show the wrong order when two status changes collide (Low)
- **Ref:** M3-R3 (log of back-transitions), G3
- **Evidence:**
  - History rows take `created_at = now()` from `set_row_meta`, which is the transaction start time. The transition route starts its transaction (`set_config`) before it waits on `FOR UPDATE`, and `periodDetail` orders by `created_at desc`.
  - Probe P10: T1 started, T2 approved and committed, then T1 reopened. The history shown newest first is `in_review→approved @…02.357`, `approved→draft @…02.344`.
  - So the period shows as returned to draft, while the history says the last event was the approval.
- **Expected:** the history shows the order in which the changes happened.
- **Fix:** set `created_at = clock_timestamp()` for `period_status_change` in `log_period_status`, or add a `bigint` sequence column and order by it.
- **Retest:** repeat P10; the order matches the real sequence.

### F4 — A period starting 29 February ends 27 February, and cloning it pre-fills an impossible date (Low)
- **Ref:** M3-R2, D14, Spec gap
- **Evidence:**
  - P5: `startDate 2032-02-29, endDate 2033-02-27` → **201**. D14's arithmetic gives 365 days that stop short of 28 Feb.
  - A contiguous next period would start 28 Feb and drift from then on.
  - `PeriodPage.tsx:34` `nextYearStart('2024-02-29')` → `2025-02-29`. JS rolls this over, so the button says "Clone to Mar 2025 – Feb 2026", and the dialog then refuses the pre-filled date with "Enter a real date."
- **Expected:** twelve-month periods tile without gaps.
- **Fix:** either:
  - restrict non-calendar periods to start on the 1st of a month (the usual financial year), which removes the case; or
  - define the end as the day before the same date next year, with 29 Feb → 1 Mar.

  In both cases, compute the clone default with `periodEndDate(end)+1` instead of string year arithmetic. Confirm the allowed starts against the CBAM implementing act.
- **Retest:** a shared unit test for 29 Feb, and a web test that the clone default of a 29 Feb period is a valid date.

### F5 — Report recipients see draft periods, their history and return-to-draft reasons (Low)
- **Ref:** Spec §2 (recipient: "view and download the approved report"), G2, Spec gap
- **Evidence:**
  - P6: a recipient assigned to the client gets `GET /periods/:id` → 200 with status `draft`, and `GET /installations/:id/periods` → 200.
  - The read policies (`migration:357-379`) use only `installation_visible`.
- **Fix:** decide whether recipients see periods before approval (record it in phase-1 decisions). If not, limit recipient reads to versions in `approved`/`issued`, and hide history reasons.
- **Retest:** a recipient gets 404 for a draft-only period.

### F6 — `app.assert_period_writable` tells any tenant the status of any version id (Low)
- **Ref:** G1, G10
- **Evidence:**
  - The function is SECURITY DEFINER owned by `cbam_auth` (BYPASSRLS), with EXECUTE granted to `cbam_app` (`migration:302-320, 389-391`).
  - P2: in tenant B's context, calling it with tenant A's approved version id raises **"This period is approved and read-only…"** (55000), while a random uuid raises 23503 "does not exist". A direct `select` of the same row returns 0 rows.
  - It is only reachable with a known UUID and through code that runs SQL, so the practical risk is low.
- **Fix:**
  - Inside the function, treat versions outside `app.current_tenant_id()` (or not `installation_visible`) as nonexistent, while still checking contributors' own writes.
  - Or revoke direct EXECUTE from `cbam_app` and keep it callable only via the trigger function, owned by the same definer.
- **Retest:** repeat P2; both calls give the same 23503.

### F7 — The database accepts a period on a soft-deleted installation (Low)
- **Ref:** M2-R6, Beyond spec
- **Evidence:**
  - P7: after `DELETE /installations/:id` → 204, a direct insert into `reporting_period` as a consultant → **inserted**.
  - The API refuses with 404, because `loadInstallation` filters `deleted_at`.
  - The period then hides behind a deleted installation, and the delete guard (`migration:278-290`) can no longer run.
- **Fix:** in the `reporting_period_insert` policy, or a BEFORE INSERT trigger, require the installation and client to be live.
- **Retest:** the P7 insert fails.

### F8 — Period screen: small UI state and design-checklist gaps (Low)
- **Ref:** Design system §5.7, §7, §13
- **Evidence:**
  - One-click "Submit for review" and "Create new version" (`PeriodPage.tsx:85-95, 138-146`) have no busy or disabled state. A double click sends two requests: the second gets 409 and shows an error under the success toast. P9 confirmed the server answers 200 then 409.
  - The version-number columns are left-aligned (`PeriodsPanel.tsx:73`, `PeriodPage.tsx:215`); §13 asks for right-aligned numbers.
  - The end-date error has no critical marker, unlike the other fields (`PeriodDialogs.tsx:88`).
  - The clone dialog says the new period "gets this period's set-up (processes, source streams, CN codes)" (`PeriodPage.tsx:270`), but nothing is copied until M5 (D6).
  - The Team panel from design system 6.3 is missing (also the earlier F7).
- **Fix:**
  - Add `busy` to the one-click actions.
  - Right-align the numeric columns.
  - Reuse the `Field` error pattern for the end date.
  - Word the clone description by what is actually copied, or keep it and add a test when M5 lands.
- **Retest:** web tests for double-click and alignment classes.

### F9 — No safety net that every period-data table registers the lock (Info)
- **Ref:** M3-R4, G4
- **Evidence:**
  - The lock works only if each later migration calls `app.register_period_table` (`migration:339-347`). Nothing checks that a table with a `period_version_id` column carries `guard_period_scoped`.
  - There is also no TRUNCATE guard.
- **Fix:** add a test (or a step in `db:check`) that queries `information_schema.columns` for `period_version_id` and asserts the trigger exists on each such table. Never grant TRUNCATE to `cbam_app`.

### F10 — The database trusts the `app.user_role` GUC, not the user's stored role (Info, cross-cutting M1)
- **Evidence:** P7: a reviewer's user id with `app.user_role = 'consultant'` passed the reopen rule (1 row). Every role check in M3's trigger and policies relies on the API setting the GUC honestly.
- **Note:** this is acceptable because only the API connects as `cbam_app`. For stronger defence in depth, derive the role in `app.current_user_role()` from `app_user` for `app.user_id` (a SECURITY DEFINER lookup), or assert the two match in `withContext`.

### F11 — Which template version a new period pins is loosely defined (Info, Spec gap)
- **Evidence:** `currentPins` picks the newest `template_version` by `released_on` (`periods.router.ts:116-122`). It has no status, and it would pick a template registered ahead of its release date.
- **Note:** give templates a published/current flag (as M4 has for library versions) or pin by effective date.

### F12 — Spec items not placed in M3 (Info, Spec gap)
- Spec §4.2 lists "Monitoring methodology" as a period parameter. It is per source stream and belongs to M5, so move it in the spec.
- There is no rule on whether non-calendar periods must start on the 1st of a month (see F4).
- Decision D14 reads M3-R3 so literally that a platform admin cannot return a period to draft (P7: 403). Confirm this with the product owner.

## Spec gaps
1. Allowed start days for non-calendar periods, and the 29 February case (F4, F12).
2. Recipient visibility of unapproved periods (F5).
3. Who may change a draft's pins, and whether they may at all (F2).
4. How "current template version" is defined (F11).
5. Where "Monitoring methodology" belongs, and whether an admin may reopen (F12).

## Next steps
1. Fix F1 (one shared lock for date edits and status changes) and F2 (pin rules in `guard_period_version`) before M5 adds period data. Both are migration changes with two-connection and direct-SQL tests.
2. Fix F3 (history order) and F7 (live-installation check) in the same migration.
3. Fix F6 when convenient; fix F8 in the next UI pass.
4. Take F4, F5, F11 and F12 to the product owner and record the answers as decisions.
5. Add the F9 check before the first `register_period_table` caller (M5).

## Comparison with the earlier review (`docs/reviews/M03.md`)
This section was written after the findings above were complete.

- **Confirmed:**
  - The fixes for its F1 (history forgery), F2 (date range) and F4 (based-on check) hold. Its tests pass, and P5 found no 500s.
  - Its F6 (banner wording) is fixed.
  - Its F7 (team panel, switchers) is still open; the team panel is repeated here in F8.
  - Its F8 (approval guard in the API only) and F11 (admin cannot reopen) stand.
  - Its F9 (recipients see drafts) is confirmed by P6. I rate it Low rather than Info, because the spec's role table is explicit.
  - Its F10 (writable-check oracle) is confirmed. P2 adds that it works **across tenants**, so I rate it Low.
- **Not re-verified:**
  - Its F3 (Portfolio columns): I did not examine the Portfolio page.
  - Its F5 (hidden actor names): the code matches it (`leftJoin app_user` under RLS), but I did not run a probe.
- **Disputed:** none.
- **Missed by the earlier review:**
  - F1 (the date-edit versus submit race).
  - F2 (reviewer re-pinning and n+1 pin drift at DB level). Its F12 raises only the spec question, not the missing guard.
  - F3 (history misordering).
  - F4 (29 February drift and clone pre-fill).
  - F7 (period on a deleted installation via SQL).
  - F8 (busy states, alignment, clone copy text).
  - F9 (no register-table safety net).
  - F10 (GUC-trusted role).

## Fix verification (building session, after this review)

This section was added by the session that built M3, not by the independent reviewer.

- **Executed:**
  - `pnpm --filter @cbam/api test`: 9 files, **189 passed**, including 40 in `m03-periods.test.ts`.
  - `pnpm --filter @cbam/web test`: **40 passed**.
  - Shared: **25 passed**.
  - `pnpm typecheck`: clean.
  - `pnpm db:check`: clean.
- The fixes are in migration `20260929000005_m03_periods.sql` itself; the branch has not been pushed or applied anywhere.

| Finding | Status | Evidence |
|---|---|---|
| F1 | Fixed | `guard_reporting_period` share-locks the period's versions before checking them, and the PATCH route does the same before its own check. Test "a date edit and Submit for review at the same time cannot both succeed" repeats P4 on two connections: the submit waits for the open date edit, then runs, and later date edits fail with 55000. With the lock removed, the test fails ("the submit must wait for the date edit"). |
| F2 | Fixed | `guard_period_version`: on UPDATE, only an admin or consultant may change a pin (42501); on INSERT, version n+1 must keep version n's library and template versions (23514). Test "pins: version n+1 keeps version n's…" repeats P3 and P3b. |
| F4 | Fixed | A 29 February start now ends on 28 February (DB check and `periodEndDate`), so the next period starts 1 March. Clone defaults to `nextPeriodStart(end)`, the day after the end. Tests: shared 29 Feb and next-start cases, API 29 Feb open and a refused 27 Feb end, web "cloning a 29 February period suggests… 1 March". Decision D14 is updated. |
| F6 | Fixed | `app.assert_period_writable` only sees versions in the caller's tenant and visible installations; any other id → 23503, the same as a random id. Test "the lock check reveals nothing…" repeats P2 for another tenant and for an unassigned consultant. |
| F7 | Fixed | `guard_reporting_period` on INSERT requires a live installation and client (23514). Test "the database refuses a period on a deleted installation" repeats P7. |

**Still open:** F3, F5 and F8 (Low), and F9–F12 (Info / spec gaps; F10 concerns M1).
