# M3 — Reporting period manager
**Purpose:** Open, lock, version, clone periods. **Depends on:** M2. **Screens:** Period dashboard, status bar.

## Parameters (spec 4.2)
Start/end date; status (Draft / In review / Approved / Issued); monitoring methodology; data version.

## Requirements
- M3-R1 Periods belong to one installation; no overlapping periods on the same installation.
- M3-R2 Calendar year default; other 12-month periods allowed only with a justification text.
- M3-R3 Status machine: Draft → In review → Approved → Issued; back-transitions only to Draft and only by consultant, logged with reason.
- M3-R4 Approved and Issued periods are read-only at API and DB level (G4).
- M3-R5 Change after Issue creates data version n+1; version n and its outputs stay retrievable.
- M3-R6 Clone copies set-up (processes, source-stream definitions, CN codes) but not activity data.
- M3-R7 Approval blocked while M11 has open critical issues.
- M3-R8 Dates handled as dates, not timestamps (no time-zone shift at boundaries).

## Acceptance tests
- AT1 Overlapping period → rejected.
- AT2 PATCH to a source stream in an Issued period via API → rejected.
- AT3 Clone 2026 → 2027 copies set-up, zero activity data.
- AT4 Period 2026-01-01 to 2026-12-31 displays identically for users in UTC+5:30 and UTC−5.
